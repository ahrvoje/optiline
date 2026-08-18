import {
  buildHybridPeriodicBasis,
  evaluateHybridField,
  hybridCoefficientCount,
  type HybridPeriodicBasis,
} from "@/optimizer/hybrid-basis";
import {
  evaluateFourierSeries,
  fitRealFourier,
  fourierCoefficientCount,
} from "@/optimizer/fourier";
import {
  fitPeriodicSplineSamples,
  periodicBasisSample,
} from "@/optimizer/periodic-bspline";
import type { FinalCurvatureRepresentationJson } from "@/model/contracts";

const TWO_PI = 2 * Math.PI;

export interface CurvatureSourceSample {
  x: number;
  y: number;
  tx: number;
  ty: number;
  kappa: number;
  /** |dr/du| for source samples at uniform u. */
  q: number;
}

export type ClosureMode =
  | { kind: "constant" }
  | { kind: "cos" | "sin"; harmonic: number }
  | { kind: "bspline"; controlCount: number; index: number };

export interface ClosureResiduals {
  turn: number;
  x: number;
  y: number;
  maxAbs: number;
}

export interface CurvatureRepresentation {
  schemaVersion: 2;
  pathLengthM: number;
  winding: -1 | 1;
  basis: HybridPeriodicBasis;
  /** Free Fourier coefficients followed by the high-pass spline controls. */
  coefficients: Float64Array;
  correctionModes: [ClosureMode, ClosureMode, ClosureMode];
  correctionCoefficients: Float64Array;
  rotationRad: number;
  translation: [number, number];
  seamPhase: number;
  closureResiduals: ClosureResiduals;
  closureIterations: number;
  closureCondition: number;
}

/** Restore the authoritative V2 representation without a PH conversion. */
export function curvatureRepresentationFromJson(
  value: FinalCurvatureRepresentationJson,
): CurvatureRepresentation {
  const basis = buildHybridPeriodicBasis(value.fourierModes, value.residualControlCount);
  const coefficients = Float64Array.from([
    ...value.fourierCoefficients,
    ...value.residualCoefficients,
  ]);
  if (coefficients.length !== hybridCoefficientCount(basis) ||
      value.closureModes.length !== 3 || value.closureCoefficients.length !== 3 ||
      !(value.pathLengthM > 0) || !Number.isFinite(value.pathLengthM)) {
    throw new RangeError("invalid V2 curvature representation");
  }
  return {
    schemaVersion: 2,
    pathLengthM: value.pathLengthM,
    winding: value.winding,
    basis,
    coefficients,
    correctionModes: value.closureModes.map(mode => ({ ...mode })) as
      [ClosureMode, ClosureMode, ClosureMode],
    correctionCoefficients: Float64Array.from(value.closureCoefficients),
    rotationRad: value.rigidTransform.rotationRad,
    translation: [...value.rigidTransform.translationM],
    seamPhase: value.seamPhase,
    closureResiduals: { ...value.closureResiduals },
    closureIterations: 0,
    closureCondition: Infinity,
  };
}

/** Serialize the exact authoritative curvature object after closure projection. */
export function curvatureRepresentationToJson(
  representation: CurvatureRepresentation,
): FinalCurvatureRepresentationJson {
  const fourierCount = fourierCoefficientCount(representation.basis.fourierModes);
  return {
    schemaVersion: 2,
    pathLengthM: representation.pathLengthM,
    winding: representation.winding,
    fourierModes: representation.basis.fourierModes,
    fourierCoefficients: Array.from(representation.coefficients.slice(0, fourierCount)),
    residualControlCount: representation.basis.residualControlCount,
    residualCoefficients: Array.from(representation.coefficients.slice(fourierCount)),
    closureModes: representation.correctionModes.map(mode => ({ ...mode })),
    closureCoefficients: Array.from(representation.correctionCoefficients),
    rigidTransform: {
      rotationRad: representation.rotationRad,
      translationM: [...representation.translation],
    },
    seamPhase: representation.seamPhase,
    closureResiduals: { ...representation.closureResiduals },
  };
}

export interface ClosureProjectionOptions {
  tolerance?: number;
  sampleCount?: number;
  maximumIterations?: number;
  maximumCondition?: number;
  /** Reuse the parent's already conditioned mode pair for trust-region probes. */
  selectCorrectionModes?: boolean;
}

interface ClosureSystem {
  residuals: ClosureResiduals;
  jacobian: Float64Array;
  condition: number;
  theta: Float64Array;
}

function wrap01(value: number): number {
  const wrapped = value % 1;
  return wrapped < 0 ? wrapped + 1 : wrapped;
}

function modeValue(mode: ClosureMode, tau: number, derivative = 0): number {
  if (mode.kind === "constant") return derivative === 0 ? 1 : 0;
  if (mode.kind === "bspline") {
    const sample = periodicBasisSample(5, mode.controlCount, wrap01(tau), derivative);
    for (let active = 0; active < 6; active++) {
      if (sample.indices[active] === mode.index) return sample.weights[derivative]![active]!;
    }
    return 0;
  }
  const omega = TWO_PI * mode.harmonic;
  const phase = omega * tau + derivative * Math.PI / 2;
  return omega ** derivative * (mode.kind === "cos" ? Math.cos(phase) : Math.sin(phase));
}

export function evaluateCurvatureRepresentation(
  representation: CurvatureRepresentation,
  tau: number,
  maxDerivative = 0,
): Float64Array {
  const shifted = wrap01(tau + representation.seamPhase);
  const result = evaluateHybridField(
    representation.basis,
    representation.coefficients,
    shifted,
    maxDerivative,
  );
  for (let mode = 0; mode < 3; mode++) {
    for (let derivative = 0; derivative <= maxDerivative; derivative++) {
      result[derivative] = result[derivative]! +
        representation.correctionCoefficients[mode]! *
        modeValue(representation.correctionModes[mode]!, shifted, derivative);
    }
  }
  return result;
}

function solve3(matrix: ArrayLike<number>, rhs: ArrayLike<number>): Float64Array | null {
  const augmented = new Float64Array(12);
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      augmented[4 * row + column] = matrix[3 * row + column] ?? 0;
    }
    augmented[4 * row + 3] = rhs[row] ?? 0;
  }
  for (let column = 0; column < 3; column++) {
    let pivot = column;
    for (let row = column + 1; row < 3; row++) {
      if (Math.abs(augmented[4 * row + column]!) >
          Math.abs(augmented[4 * pivot + column]!)) pivot = row;
    }
    if (!(Math.abs(augmented[4 * pivot + column]!) > 1e-14)) return null;
    if (pivot !== column) {
      for (let j = column; j < 4; j++) {
        const temporary = augmented[4 * column + j]!;
        augmented[4 * column + j] = augmented[4 * pivot + j]!;
        augmented[4 * pivot + j] = temporary;
      }
    }
    const diagonal = augmented[4 * column + column]!;
    for (let j = column; j < 4; j++) {
      const index = 4 * column + j;
      augmented[index] = augmented[index]! / diagonal;
    }
    for (let row = 0; row < 3; row++) {
      if (row === column) continue;
      const factor = augmented[4 * row + column]!;
      for (let j = column; j < 4; j++) {
        const index = 4 * row + j;
        augmented[index] = augmented[index]! - factor * augmented[4 * column + j]!;
      }
    }
  }
  return Float64Array.of(augmented[3]!, augmented[7]!, augmented[11]!);
}

function matrixInfinityNorm(matrix: ArrayLike<number>): number {
  let norm = 0;
  for (let row = 0; row < 3; row++) {
    let sum = 0;
    for (let column = 0; column < 3; column++) sum += Math.abs(matrix[3 * row + column] ?? 0);
    norm = Math.max(norm, sum);
  }
  return norm;
}

function condition3(matrix: ArrayLike<number>): number {
  const inverse = new Float64Array(9);
  for (let column = 0; column < 3; column++) {
    const rhs = Float64Array.of(column === 0 ? 1 : 0, column === 1 ? 1 : 0, column === 2 ? 1 : 0);
    const solution = solve3(matrix, rhs);
    if (solution === null) return Infinity;
    for (let row = 0; row < 3; row++) inverse[3 * row + column] = solution[row]!;
  }
  return matrixInfinityNorm(matrix) * matrixInfinityNorm(inverse);
}

function closureSystem(
  representation: CurvatureRepresentation,
  sampleCount: number,
): ClosureSystem {
  const step = 1 / sampleCount;
  const theta = new Float64Array(sampleCount + 1);
  const curvature = new Float64Array(sampleCount + 1);
  const curvatureMid = new Float64Array(sampleCount);
  const curvatureQuarter = new Float64Array(sampleCount);
  const phi = Array.from({ length: 3 }, () => new Float64Array(sampleCount + 1));
  const phiMid = Array.from({ length: 3 }, () => new Float64Array(sampleCount));
  const phiQuarter = Array.from({ length: 3 }, () => new Float64Array(sampleCount));
  const integratedPhi = Array.from({ length: 3 }, () => new Float64Array(sampleCount + 1));
  for (let station = 0; station <= sampleCount; station++) {
    const tau = station / sampleCount;
    curvature[station] = evaluateCurvatureRepresentation(representation, tau, 0)[0]!;
    for (let mode = 0; mode < 3; mode++) {
      phi[mode]![station] = modeValue(
        representation.correctionModes[mode]!,
        wrap01(tau + representation.seamPhase),
      );
    }
  }
  for (let station = 0; station < sampleCount; station++) {
    const midpoint = (station + 0.5) / sampleCount;
    const quarter = (station + 0.25) / sampleCount;
    curvatureMid[station] = evaluateCurvatureRepresentation(
      representation, midpoint, 0,
    )[0]!;
    curvatureQuarter[station] = evaluateCurvatureRepresentation(
      representation, quarter, 0,
    )[0]!;
    for (let mode = 0; mode < 3; mode++) {
      phiMid[mode]![station] = modeValue(
        representation.correctionModes[mode]!,
        wrap01(midpoint + representation.seamPhase),
      );
      phiQuarter[mode]![station] = modeValue(
        representation.correctionModes[mode]!,
        wrap01(quarter + representation.seamPhase),
      );
    }
    theta[station + 1] = theta[station]! + step / 6 *
      (curvature[station]! + 4 * curvatureMid[station]! + curvature[station + 1]!);
    for (let mode = 0; mode < 3; mode++) {
      integratedPhi[mode]![station + 1] = integratedPhi[mode]![station]! + step / 6 *
        (phi[mode]![station]! + 4 * phiMid[mode]![station]! + phi[mode]![station + 1]!);
    }
  }
  let x = 0;
  let y = 0;
  const jacobian = new Float64Array(9);
  for (let station = 0; station < sampleCount; station++) {
    const thetaMid = theta[station]! + step / 12 *
      (curvature[station]! + 4 * curvatureQuarter[station]! + curvatureMid[station]!);
    x += step / 6 * (
      Math.cos(theta[station]!) + 4 * Math.cos(thetaMid) + Math.cos(theta[station + 1]!)
    );
    y += step / 6 * (
      Math.sin(theta[station]!) + 4 * Math.sin(thetaMid) + Math.sin(theta[station + 1]!)
    );
    for (let mode = 0; mode < 3; mode++) {
      const integratedMid = integratedPhi[mode]![station]! + step / 12 *
        (phi[mode]![station]! + 4 * phiQuarter[mode]![station]! + phiMid[mode]![station]!);
      jacobian[3 + mode] = jacobian[3 + mode]! - step / 6 * (
        Math.sin(theta[station]!) * integratedPhi[mode]![station]! +
        4 * Math.sin(thetaMid) * integratedMid +
        Math.sin(theta[station + 1]!) * integratedPhi[mode]![station + 1]!
      );
      jacobian[6 + mode] = jacobian[6 + mode]! + step / 6 * (
        Math.cos(theta[station]!) * integratedPhi[mode]![station]! +
        4 * Math.cos(thetaMid) * integratedMid +
        Math.cos(theta[station + 1]!) * integratedPhi[mode]![station + 1]!
      );
    }
  }
  for (let mode = 0; mode < 3; mode++) {
    jacobian[mode] = integratedPhi[mode]![sampleCount]!;
  }
  const turn = theta[sampleCount]! - TWO_PI * representation.winding;
  const maxAbs = Math.max(Math.abs(turn), Math.abs(x), Math.abs(y));
  return {
    residuals: { turn, x, y, maxAbs },
    jacobian,
    condition: condition3(jacobian),
    theta,
  };
}

/** Re-evaluate closure on an independent quadrature mesh. */
export function measureCurvatureClosure(
  representation: CurvatureRepresentation,
  sampleCount = 4096,
): ClosureResiduals {
  if (!Number.isInteger(sampleCount) || sampleCount < 128) {
    throw new RangeError("closure measurement requires at least 128 samples");
  }
  return closureSystem(representation, sampleCount).residuals;
}

function correctionModeBank(): ClosureMode[] {
  const modes: ClosureMode[] = [];
  for (let harmonic = 1; harmonic <= 4; harmonic++) {
    modes.push({ kind: "cos", harmonic }, { kind: "sin", harmonic });
  }
  for (const index of [0, 2, 4, 6]) modes.push({ kind: "bspline", controlCount: 8, index });
  return modes;
}

function chooseCorrectionModes(
  representation: CurvatureRepresentation,
  sampleCount: number,
): [ClosureMode, ClosureMode, ClosureMode] {
  const bank = correctionModeBank();
  let selected: [ClosureMode, ClosureMode, ClosureMode] | null = null;
  let bestCondition = Infinity;
  for (let first = 0; first < bank.length; first++) {
    for (let second = first + 1; second < bank.length; second++) {
      const trial: CurvatureRepresentation = {
        ...representation,
        correctionModes: [{ kind: "constant" }, bank[first]!, bank[second]!],
        correctionCoefficients: new Float64Array(3),
      };
      const condition = closureSystem(trial, sampleCount).condition;
      if (condition < bestCondition) {
        bestCondition = condition;
        selected = trial.correctionModes;
      }
    }
  }
  if (selected === null) throw new Error("no nonsingular curvature closure-mode pair");
  return selected;
}

function copyRepresentation(source: CurvatureRepresentation): CurvatureRepresentation {
  return {
    ...source,
    basis: { ...source.basis, residualProjection: source.basis.residualProjection.slice() },
    coefficients: source.coefficients.slice(),
    correctionModes: source.correctionModes.map(mode => ({ ...mode })) as
      [ClosureMode, ClosureMode, ClosureMode],
    correctionCoefficients: source.correctionCoefficients.slice(),
    translation: [...source.translation],
    closureResiduals: { ...source.closureResiduals },
  };
}

/** Deterministic three-condition damped Newton closure projection. */
export function projectCurvatureClosure(
  source: CurvatureRepresentation,
  options: ClosureProjectionOptions = {},
): CurvatureRepresentation | null {
  const tolerance = options.tolerance ?? 1e-10;
  const sampleCount = options.sampleCount ?? 2048;
  const maximumIterations = options.maximumIterations ?? 16;
  const maximumCondition = options.maximumCondition ?? 1e8;
  if (!(tolerance > 0) || !Number.isInteger(sampleCount) || sampleCount < 128 ||
      !Number.isInteger(maximumIterations) || maximumIterations < 1) {
    throw new RangeError("invalid curvature closure projection settings");
  }
  const result = copyRepresentation(source);
  if (options.selectCorrectionModes ?? true) {
    result.correctionModes = chooseCorrectionModes(result, Math.min(256, sampleCount));
  }
  result.correctionCoefficients.fill(0);
  let system = closureSystem(result, sampleCount);
  let iterations = 0;
  while (system.residuals.maxAbs > tolerance && iterations < maximumIterations) {
    if (!(system.condition <= maximumCondition)) return null;
    const step = solve3(
      system.jacobian,
      Float64Array.of(-system.residuals.turn, -system.residuals.x, -system.residuals.y),
    );
    if (step === null || !Array.from(step).every(Number.isFinite)) return null;
    const prior = result.correctionCoefficients.slice();
    let accepted = false;
    for (let damping = 1; damping >= 1 / 128; damping *= 0.5) {
      for (let mode = 0; mode < 3; mode++) {
        result.correctionCoefficients[mode] = prior[mode]! + damping * step[mode]!;
      }
      const trial = closureSystem(result, sampleCount);
      if (trial.residuals.maxAbs < system.residuals.maxAbs) {
        system = trial;
        accepted = true;
        break;
      }
    }
    if (!accepted) return null;
    iterations++;
  }
  if (system.residuals.maxAbs > tolerance) return null;
  result.closureResiduals = system.residuals;
  result.closureIterations = iterations;
  result.closureCondition = system.condition;
  return result;
}

function resampleByArc(
  source: CurvatureSourceSample[],
  sampleCount: number,
): { samples: CurvatureSourceSample[]; length: number; winding: -1 | 1 } {
  if (source.length < 8) throw new RangeError("curvature conversion needs at least eight samples");
  const segmentLength = new Float64Array(source.length);
  const prefix = new Float64Array(source.length + 1);
  let totalTurn = 0;
  for (let i = 0; i < source.length; i++) {
    const next = (i + 1) % source.length;
    segmentLength[i] = 0.5 * (source[i]!.q + source[next]!.q) / source.length;
    prefix[i + 1] = prefix[i]! + segmentLength[i]!;
    totalTurn += Math.atan2(
      source[i]!.tx * source[next]!.ty - source[i]!.ty * source[next]!.tx,
      source[i]!.tx * source[next]!.tx + source[i]!.ty * source[next]!.ty,
    );
  }
  const samples: CurvatureSourceSample[] = [];
  for (let output = 0; output < sampleCount; output++) {
    const target = output / sampleCount * prefix[source.length]!;
    let low = 0;
    let high = source.length;
    while (high - low > 1) {
      const middle = (low + high) >>> 1;
      if (prefix[middle]! <= target) low = middle;
      else high = middle;
    }
    const next = (low + 1) % source.length;
    const blend = segmentLength[low]! > 0 ?
      (target - prefix[low]!) / segmentLength[low]! : 0;
    const a = source[low]!;
    const b = source[next]!;
    const tx = (1 - blend) * a.tx + blend * b.tx;
    const ty = (1 - blend) * a.ty + blend * b.ty;
    const metric = Math.hypot(tx, ty);
    samples.push({
      x: (1 - blend) * a.x + blend * b.x,
      y: (1 - blend) * a.y + blend * b.y,
      tx: tx / Math.max(metric, 1e-15),
      ty: ty / Math.max(metric, 1e-15),
      kappa: (1 - blend) * a.kappa + blend * b.kappa,
      q: prefix[source.length]!,
    });
  }
  return {
    samples,
    length: prefix[source.length]!,
    winding: totalTurn >= 0 ? 1 : -1,
  };
}

function alignToTarget(
  representation: CurvatureRepresentation,
  target: CurvatureSourceSample[],
): CurvatureRepresentation {
  const reconstructed = reconstructCurvaturePath({ ...representation, rotationRad: 0, translation: [0, 0] }, target.length);
  let sourceX = 0;
  let sourceY = 0;
  let targetX = 0;
  let targetY = 0;
  for (let i = 0; i < target.length; i++) {
    sourceX += reconstructed[i]!.x;
    sourceY += reconstructed[i]!.y;
    targetX += target[i]!.x;
    targetY += target[i]!.y;
  }
  sourceX /= target.length;
  sourceY /= target.length;
  targetX /= target.length;
  targetY /= target.length;
  let cosine = 0;
  let sine = 0;
  for (let i = 0; i < target.length; i++) {
    const ax = reconstructed[i]!.x - sourceX;
    const ay = reconstructed[i]!.y - sourceY;
    const bx = target[i]!.x - targetX;
    const by = target[i]!.y - targetY;
    cosine += ax * bx + ay * by;
    sine += ax * by - ay * bx;
  }
  const rotationRad = Math.atan2(sine, cosine);
  const c = Math.cos(rotationRad);
  const s = Math.sin(rotationRad);
  return {
    ...representation,
    rotationRad,
    translation: [
      targetX - (c * sourceX - s * sourceY),
      targetY - (s * sourceX + c * sourceY),
    ],
  };
}

/** Convert an already feasible closed discovery path into the V2 curvature form. */
export function fitCurvatureRepresentation(
  source: CurvatureSourceSample[],
  fourierModes = 12,
  residualControlCount = 24,
): CurvatureRepresentation {
  const fitCount = Math.max(256, 8 * residualControlCount, 16 * fourierModes);
  const resampled = resampleByArc(source, fitCount);
  const dimensionless = Float64Array.from(
    resampled.samples,
    sample => resampled.length * sample.kappa,
  );
  const basis = buildHybridPeriodicBasis(fourierModes, residualControlCount);
  const fourier = fitRealFourier(dimensionless, fourierModes);
  const residualSamples = new Float64Array(residualControlCount);
  for (let i = 0; i < residualControlCount; i++) {
    const sourceIndex = Math.round(i / residualControlCount * fitCount) % fitCount;
    const u = i / residualControlCount;
    const lowFrequency = evaluateFourierSeries(fourier, u, 0)[0]!;
    residualSamples[i] = dimensionless[sourceIndex]! - lowFrequency;
  }
  const residual = fitPeriodicSplineSamples(residualSamples, 5);
  const coefficients = new Float64Array(hybridCoefficientCount(basis));
  coefficients.set(fourier);
  coefficients.set(residual, fourierCoefficientCount(fourierModes));
  const unprojected: CurvatureRepresentation = {
    schemaVersion: 2,
    pathLengthM: resampled.length,
    winding: resampled.winding,
    basis,
    coefficients,
    correctionModes: [
      { kind: "constant" },
      { kind: "cos", harmonic: 1 },
      { kind: "sin", harmonic: 1 },
    ],
    correctionCoefficients: new Float64Array(3),
    rotationRad: 0,
    translation: [0, 0],
    seamPhase: 0,
    closureResiduals: { turn: Infinity, x: Infinity, y: Infinity, maxAbs: Infinity },
    closureIterations: 0,
    closureCondition: Infinity,
  };
  const projected = projectCurvatureClosure(unprojected);
  if (projected === null) throw new Error("curvature fit could not be closure projected");
  return alignToTarget(projected, resampled.samples);
}

export interface ReconstructedCurvatureSample {
  tau: number;
  x: number;
  y: number;
  tx: number;
  ty: number;
  yaw: number;
  kappa: number;
  kappaL: number;
  kappaLL: number;
}

/** Intrinsic reconstruction using the same periodic trapezoidal closure quadrature. */
export function reconstructCurvaturePath(
  representation: CurvatureRepresentation,
  sampleCount = 2048,
): ReconstructedCurvatureSample[] {
  if (!Number.isInteger(sampleCount) || sampleCount < 8) {
    throw new RangeError("reconstruction sample count must be at least eight");
  }
  const step = 1 / sampleCount;
  const angle = new Float64Array(sampleCount + 1);
  const curvature = new Float64Array(sampleCount + 1);
  const curvatureMid = new Float64Array(sampleCount);
  const curvatureQuarter = new Float64Array(sampleCount);
  for (let i = 0; i <= sampleCount; i++) {
    curvature[i] = evaluateCurvatureRepresentation(representation, i / sampleCount, 0)[0]!;
  }
  for (let i = 0; i < sampleCount; i++) {
    curvatureMid[i] = evaluateCurvatureRepresentation(
      representation, (i + 0.5) / sampleCount, 0,
    )[0]!;
    curvatureQuarter[i] = evaluateCurvatureRepresentation(
      representation, (i + 0.25) / sampleCount, 0,
    )[0]!;
    angle[i + 1] = angle[i]! + step / 6 *
      (curvature[i]! + 4 * curvatureMid[i]! + curvature[i + 1]!);
  }
  const unitX = new Float64Array(sampleCount + 1);
  const unitY = new Float64Array(sampleCount + 1);
  for (let i = 0; i < sampleCount; i++) {
    const angleMid = angle[i]! + step / 12 *
      (curvature[i]! + 4 * curvatureQuarter[i]! + curvatureMid[i]!);
    unitX[i + 1] = unitX[i]! + step / 6 *
      (Math.cos(angle[i]!) + 4 * Math.cos(angleMid) + Math.cos(angle[i + 1]!));
    unitY[i + 1] = unitY[i]! + step / 6 *
      (Math.sin(angle[i]!) + 4 * Math.sin(angleMid) + Math.sin(angle[i + 1]!));
  }
  const c = Math.cos(representation.rotationRad);
  const s = Math.sin(representation.rotationRad);
  return Array.from({ length: sampleCount }, (_, i): ReconstructedCurvatureSample => {
    const field = evaluateCurvatureRepresentation(representation, i / sampleCount, 2);
    const yaw = angle[i]! + representation.rotationRad;
    const px = representation.pathLengthM * unitX[i]!;
    const py = representation.pathLengthM * unitY[i]!;
    return {
      tau: i / sampleCount,
      x: representation.translation[0] + c * px - s * py,
      y: representation.translation[1] + s * px + c * py,
      tx: Math.cos(yaw),
      ty: Math.sin(yaw),
      yaw,
      kappa: field[0]! / representation.pathLengthM,
      kappaL: field[1]! / representation.pathLengthM ** 2,
      kappaLL: field[2]! / representation.pathLengthM ** 3,
    };
  });
}

/** Trust-region homotopy from a closed parent to proposed free coefficients and length. */
export function projectCurvaturePerturbation(
  parent: CurvatureRepresentation,
  proposedCoefficients: ArrayLike<number>,
  proposedLengthM: number,
  options: ClosureProjectionOptions = {},
): CurvatureRepresentation | null {
  if (proposedCoefficients.length !== parent.coefficients.length || !(proposedLengthM > 0)) {
    throw new RangeError("curvature perturbation shape or length is invalid");
  }
  for (let scale = 1; scale >= 1 / 128; scale *= 0.5) {
    const trial = copyRepresentation(parent);
    for (let i = 0; i < trial.coefficients.length; i++) {
      trial.coefficients[i] = parent.coefficients[i]! + scale *
        ((proposedCoefficients[i] ?? 0) - parent.coefficients[i]!);
    }
    trial.pathLengthM = parent.pathLengthM * Math.exp(
      scale * Math.log(proposedLengthM / parent.pathLengthM),
    );
    trial.correctionCoefficients.fill(0);
    const projected = projectCurvatureClosure(trial, {
      ...options,
      selectCorrectionModes: false,
    });
    if (projected !== null) {
      const parentPath: CurvatureSourceSample[] = reconstructCurvaturePath(parent, 512).map(sample => ({
        ...sample,
        q: parent.pathLengthM,
      }));
      return alignToTarget(projected, parentPath);
    }
  }
  return null;
}
