import type { CompiledTrackJson, VehicleSettings } from "@/model/contracts";
import {
  centerlineSpec,
  evaluateLineFrame,
  lineDistancesAtParameters,
} from "@/renderer/ph-tessellate";
import {
  type LateralCorridorSample,
} from "@/optimizer/periodic-bspline";
import {
  buildHybridPeriodicBasis,
  decodeBoundedHybridField,
  projectHybridResidual,
  type HybridPeriodicBasis,
} from "@/optimizer/hybrid-basis";
import {
  buildFourierKernelSpine,
  evaluateFourierKernel,
  type FourierKernelSpine,
} from "@/optimizer/fourier-kernel";
import { fitRealFourier, selectFourierModeRange } from "@/optimizer/fourier";

type Vec2 = readonly [number, number];

const BINOMIAL = [
  [1],
  [1, 1],
  [1, 2, 1],
  [1, 3, 3, 1],
  [1, 4, 6, 4, 1],
] as const;

function choose(n: number, k: number): number {
  return BINOMIAL[n]?.[k] ?? 0;
}

function add(a: Vec2, b: Vec2): Vec2 {
  return [a[0] + b[0], a[1] + b[1]];
}

function scale(a: Vec2, value: number): Vec2 {
  return [a[0] * value, a[1] * value];
}

function dot(a: Vec2, b: Vec2): number {
  return a[0] * b[0] + a[1] * b[1];
}

function cross(a: Vec2, b: Vec2): number {
  return a[0] * b[1] - a[1] * b[0];
}

function rotateLeft(a: Vec2): Vec2 {
  return [-a[1], a[0]];
}

function scalarProduct(a: ArrayLike<number>, b: ArrayLike<number>, order: number): Float64Array {
  const out = new Float64Array(order + 1);
  for (let n = 0; n <= order; n++) {
    for (let k = 0; k <= n; k++) {
      out[n] = out[n]! + choose(n, k) * (a[k] ?? 0) * (b[n - k] ?? 0);
    }
  }
  return out;
}

function inverseJet(value: ArrayLike<number>, order: number): Float64Array {
  if (!(Math.abs(value[0] ?? 0) > 1e-14)) throw new Error("singular reference derivative");
  const out = new Float64Array(order + 1);
  out[0] = 1 / (value[0] ?? 1);
  for (let n = 1; n <= order; n++) {
    let sum = 0;
    for (let k = 1; k <= n; k++) {
      sum += choose(n, k) * (value[k] ?? 0) * out[n - k]!;
    }
    out[n] = -sum / (value[0] ?? 1);
  }
  return out;
}

function sqrtJet(value: ArrayLike<number>, order: number): Float64Array {
  if (!((value[0] ?? 0) > 0)) throw new Error("nonregular reference spine");
  const out = new Float64Array(order + 1);
  out[0] = Math.sqrt(value[0] ?? 0);
  for (let n = 1; n <= order; n++) {
    let known = 0;
    for (let k = 1; k < n; k++) known += choose(n, k) * out[k]! * out[n - k]!;
    out[n] = ((value[n] ?? 0) - known) / (2 * out[0]!);
  }
  return out;
}

function vectorNormJet(value: Vec2[], order: number): Float64Array {
  const squared = new Float64Array(order + 1);
  for (let n = 0; n <= order; n++) {
    for (let k = 0; k <= n; k++) {
      squared[n] = squared[n]! + choose(n, k) * dot(value[k]!, value[n - k]!);
    }
  }
  return sqrtJet(squared, order);
}

export type ReferenceSpine = FourierKernelSpine;

const referenceSpineCache = new WeakMap<CompiledTrackJson, ReferenceSpine>();

/** V2 Fourier kernel chart. Kept under the prior public name for callers. */
export function buildReferenceSpine(track: CompiledTrackJson): ReferenceSpine {
  const cached = referenceSpineCache.get(track);
  if (cached !== undefined) return cached;
  const spine = buildFourierKernelSpine(track);
  referenceSpineCache.set(track, spine);
  return spine;
}

export function buildLateralBasis(
  track: CompiledTrackJson,
  residualControlCount: number,
  fourierModes = selectFourierModeRange(track.lapLengthM).maximum,
): HybridPeriodicBasis {
  return buildHybridPeriodicBasis(fourierModes, residualControlCount);
}

function evaluateReference(spine: ReferenceSpine, u: number): Vec2[] {
  return evaluateFourierKernel(spine, u, 5);
}

/** Packed station-major c, c', c'', n, n', n'' data for coarse GPU scoring. */
export function buildReferenceGeometryTable(
  track: CompiledTrackJson,
  stationCount: number,
): Float32Array {
  if (!Number.isInteger(stationCount) || stationCount <= 0) {
    throw new RangeError("stationCount must be positive");
  }
  const spine = buildReferenceSpine(track);
  const table = new Float32Array(stationCount * 12);
  for (let station = 0; station < stationCount; station++) {
    const c = evaluateReference(spine, station / stationCount);
    const cPrime = c.slice(1, 4);
    const speed = vectorNormJet(cPrime, 2);
    const inverseSpeed = inverseJet(speed, 2);
    const tangent: Vec2[] = [];
    for (let derivative = 0; derivative <= 2; derivative++) {
      let value: Vec2 = [0, 0];
      for (let k = 0; k <= derivative; k++) {
        value = add(value, scale(
          c[k + 1]!, choose(derivative, k) * inverseSpeed[derivative - k]!,
        ));
      }
      tangent.push(value);
    }
    const normal = tangent.map(rotateLeft);
    table.set([
      c[0]![0], c[0]![1], c[1]![0], c[1]![1],
      c[2]![0], c[2]![1], normal[0]![0], normal[0]![1],
      normal[1]![0], normal[1]![1], normal[2]![0], normal[2]![1],
    ], 12 * station);
  }
  return table;
}

export interface SafeCorridor extends LateralCorridorSample {
  betaSafeRad: number;
  fallback: boolean;
}

function lateralRectangleExtent(halfLength: number, halfWidth: number, beta: number): number {
  return halfLength * Math.abs(Math.sin(beta)) + halfWidth * Math.abs(Math.cos(beta));
}

/** Conservative constant-width robust generation corridor for the current track contract. */
export function buildSafeCorridor(
  track: CompiledTrackJson,
  vehicle: VehicleSettings,
  betaSafeRad = Math.PI / 12,
): SafeCorridor {
  if (!(vehicle.massKg > 0) || !(vehicle.lengthM > 0) || !(vehicle.widthM > 0) ||
      !(vehicle.safetyMarginM >= 0) || !Number.isFinite(betaSafeRad) ||
      betaSafeRad < 0 || betaSafeRad > Math.PI / 2) {
    throw new RangeError("invalid vehicle rectangle or safe-yaw range");
  }
  const halfLength = vehicle.lengthM / 2 + vehicle.safetyMarginM;
  const halfWidth = vehicle.widthM / 2 + vehicle.safetyMarginM;
  const chartError = buildReferenceSpine(track).maxFitErrorM + 1e-4;
  const critical = Math.atan2(halfLength, halfWidth);
  const robustExtent = chartError + Math.max(
    lateralRectangleExtent(halfLength, halfWidth, 0),
    lateralRectangleExtent(halfLength, halfWidth, betaSafeRad),
    critical <= betaSafeRad ? lateralRectangleExtent(halfLength, halfWidth, critical) : 0,
  );
  let lower = -track.source.rightWidthM + robustExtent;
  let upper = track.source.leftWidthM - robustExtent;
  let fallback = false;
  if (lower > upper) {
    const radius = Math.hypot(halfLength, halfWidth);
    lower = -track.source.rightWidthM + radius;
    upper = track.source.leftWidthM - radius;
    fallback = true;
  }
  if (!(lower <= upper)) throw new Error("track has no rectangle-safe center corridor");
  return { lower, upper, betaSafeRad, fallback };
}

/** Preserve a Fourier-only lateral path while widening its decoder corridor. */
export function remapFourierCorridor(
  basis: HybridPeriodicBasis,
  coefficients: ArrayLike<number>,
  source: SafeCorridor,
  target: SafeCorridor,
): Float64Array {
  if (basis.residualControlCount !== 0 || !(target.upper > target.lower)) {
    throw new RangeError("corridor continuation requires a Fourier-only basis");
  }
  const sampleCount = Math.max(128, 8 * basis.fourierModes);
  const targetMidpoint = 0.5 * (target.lower + target.upper);
  const targetHalfWidth = 0.5 * (target.upper - target.lower);
  const latent = new Float64Array(sampleCount);
  for (let sample = 0; sample < sampleCount; sample++) {
    const u = sample / sampleCount;
    const displacement = decodeBoundedHybridField(
      basis, coefficients, u, source, 0,
    )[0]!;
    const normalized = Math.max(
      -1 + 1e-12,
      Math.min(1 - 1e-12, (displacement - targetMidpoint) / targetHalfWidth),
    );
    latent[sample] = Math.atanh(normalized);
  }
  return fitRealFourier(latent, basis.fourierModes);
}

export interface RacingLineFrame {
  u: number;
  x: number;
  y: number;
  tx: number;
  ty: number;
  q: number;
  d: number;
  kappa: number;
  kappaL: number;
  kappaLL: number;
  progress: number;
  relativeYaw: number;
  clearanceM: number;
}

/** Analytic path geometry through curvature second derivative. */
export function evaluateRacingLineFrame(
  spine: ReferenceSpine,
  basis: HybridPeriodicBasis,
  coefficients: ArrayLike<number>,
  corridor: SafeCorridor,
  track: CompiledTrackJson,
  vehicle: VehicleSettings,
  u: number,
  preparedProjection?: ArrayLike<number>,
): RacingLineFrame {
  const c = evaluateReference(spine, u);
  const cPrime = c.slice(1, 6);
  const referenceSpeed = vectorNormJet(cPrime, 4);
  const inverseReferenceSpeed = inverseJet(referenceSpeed, 4);
  const tangent: Vec2[] = [];
  for (let n = 0; n <= 4; n++) {
    let value: Vec2 = [0, 0];
    for (let k = 0; k <= n; k++) {
      value = add(value, scale(c[k + 1]!, choose(n, k) * inverseReferenceSpeed[n - k]!));
    }
    tangent.push(value);
  }
  const normal = tangent.map(rotateLeft);
  const d = decodeBoundedHybridField(
    basis, coefficients, u, corridor, 4, preparedProjection,
  );
  const r: Vec2[] = [];
  for (let n = 0; n <= 4; n++) {
    let offset: Vec2 = [0, 0];
    for (let k = 0; k <= n; k++) {
      offset = add(offset, scale(normal[n - k]!, choose(n, k) * d[k]!));
    }
    r.push(add(c[n]!, offset));
  }
  const pathPrime = r.slice(1, 4);
  const pathSpeed = vectorNormJet(pathPrime, 2);
  const inversePathSpeed = inverseJet(pathSpeed, 2);
  const speedCubed = scalarProduct(pathSpeed, scalarProduct(pathSpeed, pathSpeed, 2), 2);
  const inverseSpeedCubed = inverseJet(speedCubed, 2);
  const numerator = new Float64Array(3);
  for (let n = 0; n <= 2; n++) {
    for (let k = 0; k <= n; k++) {
      numerator[n] = numerator[n]! + choose(n, k) * cross(r[k + 1]!, r[n - k + 2]!);
    }
  }
  const curvature = scalarProduct(numerator, inverseSpeedCubed, 2);
  const pathTangent = scale(r[1]!, inversePathSpeed[0]!);
  const progress = dot(pathTangent, tangent[0]!);
  const relativeYaw = Math.atan2(cross(tangent[0]!, pathTangent), progress);
  const halfLength = vehicle.lengthM / 2 + vehicle.safetyMarginM;
  const halfWidth = vehicle.widthM / 2 + vehicle.safetyMarginM;
  const extent = lateralRectangleExtent(halfLength, halfWidth, relativeYaw);
  const clearanceM = Math.min(
    track.source.leftWidthM - (d[0]! + extent),
    track.source.rightWidthM - (-d[0]! + extent),
  );
  const kappaL = curvature[1]! * inversePathSpeed[0]!;
  const kappaLL = curvature[2]! * inversePathSpeed[0]! ** 2 -
    curvature[1]! * pathSpeed[1]! * inversePathSpeed[0]! ** 3;
  return {
    u: ((u % 1) + 1) % 1,
    x: r[0]![0],
    y: r[0]![1],
    tx: pathTangent[0],
    ty: pathTangent[1],
    q: pathSpeed[0]!,
    d: d[0]!,
    kappa: curvature[0]!,
    kappaL,
    kappaLL,
    progress,
    relativeYaw,
    clearanceM,
  };
}

export function sampleRacingLine(
  track: CompiledTrackJson,
  vehicle: VehicleSettings,
  basis: HybridPeriodicBasis,
  coefficients: ArrayLike<number>,
  stationCount: number,
  corridor = buildSafeCorridor(track, vehicle),
): RacingLineFrame[] {
  const spine = buildReferenceSpine(track);
  const projection = projectHybridResidual(basis, coefficients);
  return Array.from({ length: stationCount }, (_, station) =>
    evaluateRacingLineFrame(
      spine, basis, coefficients, corridor, track, vehicle, station / stationCount, projection,
    ),
  );
}

/** Convert a lateral field to the existing 64-gate PH certification input. */
export function lateralFieldGenotype(
  track: CompiledTrackJson,
  vehicle: VehicleSettings,
  basis: HybridPeriodicBasis,
  coefficients: ArrayLike<number>,
  corridor = buildSafeCorridor(track, vehicle),
): Float64Array {
  const spine = buildReferenceSpine(track);
  const projection = projectHybridResidual(basis, coefficients);
  const center = centerlineSpec(track);
  const genotype = new Float64Array(64);
  const gateParameters = Float64Array.from({ length: 64 }, (_, gate) => gate);
  const gateDistances = lineDistancesAtParameters(center, gateParameters);
  for (let gate = 0; gate < genotype.length; gate++) {
    const arcFraction = gateDistances.distances[gate]! / gateDistances.totalLength;
    const path = evaluateRacingLineFrame(
      spine, basis, coefficients, corridor, track, vehicle, arcFraction, projection,
    );
    const frame = evaluateLineFrame(center, gate);
    genotype[gate] = (path.x - frame.x) * -frame.ty + (path.y - frame.y) * frame.tx;
  }
  return genotype;
}

/** Build a PH preimage warm start in the same tangent/metric basin as the
 * lateral discovery path. The C99 projector remains authoritative. */
export function lateralFieldPreimage(
  track: CompiledTrackJson,
  vehicle: VehicleSettings,
  basis: HybridPeriodicBasis,
  coefficients: ArrayLike<number>,
  corridor = buildSafeCorridor(track, vehicle),
): Float64Array {
  const spine = buildReferenceSpine(track);
  const projection = projectHybridResidual(basis, coefficients);
  const center = centerlineSpec(track);
  const parameters = Float64Array.from(
    { length: 128 },
    (_, control) => 0.5 * (control + 0.5),
  );
  const measured = lineDistancesAtParameters(center, parameters);
  const source = Float64Array.from(track.centerPreimageControls.flat());
  const preimage = new Float64Array(source.length);
  for (let control = 0; control < 128; control++) {
    const u = measured.distances[control]! / measured.totalLength;
    const reference = evaluateReference(spine, u);
    const referenceMetric = Math.hypot(reference[1]![0], reference[1]![1]);
    const referenceTx = reference[1]![0] / referenceMetric;
    const referenceTy = reference[1]![1] / referenceMetric;
    const path = evaluateRacingLineFrame(
      spine, basis, coefficients, corridor, track, vehicle, u, projection,
    );
    const relativeYaw = Math.atan2(
      referenceTx * path.ty - referenceTy * path.tx,
      referenceTx * path.tx + referenceTy * path.ty,
    );
    const half = 0.5 * relativeYaw;
    const cosine = Math.cos(half);
    const sine = Math.sin(half);
    const scaleFactor = Math.sqrt(Math.max(path.q / referenceMetric, 1e-12));
    const real = source[2 * control]!;
    const imaginary = source[2 * control + 1]!;
    preimage[2 * control] = scaleFactor * (cosine * real - sine * imaginary);
    preimage[2 * control + 1] = scaleFactor * (sine * real + cosine * imaginary);
  }
  return preimage;
}

export function racingLinePolyline(frames: RacingLineFrame[]): Float32Array {
  const points = new Float32Array(2 * (frames.length + 1));
  for (let i = 0; i <= frames.length; i++) {
    const frame = frames[i % frames.length]!;
    points[2 * i] = frame.x;
    points[2 * i + 1] = frame.y;
  }
  return points;
}
