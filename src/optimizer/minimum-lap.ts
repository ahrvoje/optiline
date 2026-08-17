import { GRAVITY, type CompiledTrackJson, type VehicleSettings } from "@/model/contracts";
import type { HybridPeriodicBasis } from "@/optimizer/hybrid-basis";
import { projectHybridResidual } from "@/optimizer/hybrid-basis";
import {
  buildReferenceSpine,
  buildSafeCorridor,
  evaluateRacingLineFrame,
  type RacingLineFrame,
} from "@/optimizer/racing-line";

export type EvaluationFidelity = "proxy" | "full";

export interface CandidateEvaluation {
  feasible: boolean;
  violation: number;
  lapTime: number;
  proxyTime: number;
  regularizer: number;
  lapLengthM: number;
  minClearanceM: number;
  minPathMetric: number;
  minProgress: number;
  maxAbsCurvature: number;
  maxAbsCurvatureL: number;
  maxAbsCurvatureLL: number;
  maxLateralJerk: number;
  rmsLateralJerk: number;
  speedOptimalityResidual: number;
  speedSquared: Float64Array | null;
  frames: RacingLineFrame[];
}

export interface AeroTerms {
  drag: number;
  downforce: number;
}

export function aeroTerms(vehicle: VehicleSettings): AeroTerms {
  return {
    drag: vehicle.airDensity * vehicle.dragAreaM2 / (2 * vehicle.massKg),
    downforce: vehicle.airDensity * vehicle.downforceAreaM2 /
      (2 * vehicle.massKg * GRAVITY),
  };
}

export function lateralSpeedCapSquared(
  vehicle: VehicleSettings,
  aero: AeroTerms,
  curvature: number,
): number {
  const denominator = Math.abs(curvature) - vehicle.ay0 * aero.downforce;
  return Math.min(
    vehicle.vMaxMps ** 2,
    denominator > 0 ? vehicle.ay0 / denominator : Infinity,
  );
}

function tireRemainder(
  vehicle: VehicleSettings,
  aero: AeroTerms,
  speedSquared: number,
  curvature: number,
): number {
  const load = 1 + aero.downforce * speedSquared;
  const lateralUse = Math.abs(speedSquared * curvature) / (vehicle.ay0 * load);
  if (!(lateralUse <= 1)) return 0;
  if (vehicle.ellipseP === 2) return Math.sqrt(Math.max(0, 1 - lateralUse * lateralUse));
  return Math.max(0, 1 - lateralUse ** vehicle.ellipseP) ** (1 / vehicle.ellipseP);
}

export function netAcceleration(
  vehicle: VehicleSettings,
  aero: AeroTerms,
  speedSquared: number,
  curvature: number,
): number {
  const load = 1 + aero.downforce * speedSquared;
  return vehicle.axPlus0 * load * tireRemainder(vehicle, aero, speedSquared, curvature) -
    aero.drag * speedSquared;
}

export function netBraking(
  vehicle: VehicleSettings,
  aero: AeroTerms,
  speedSquared: number,
  curvature: number,
): number {
  const load = 1 + aero.downforce * speedSquared;
  return vehicle.axMinus0 * load * tireRemainder(vehicle, aero, speedSquared, curvature) +
    aero.drag * speedSquared;
}

export function implicitReach(
  initial: number,
  cap: number,
  distance: number,
  curvature: number,
  acceleration: (midpoint: number, curvature: number) => number,
): number {
  if (!(cap > 0) || !(distance > 0)) return 0;
  const residual = (target: number): number =>
    initial + 2 * distance * acceleration(0.5 * (initial + target), curvature) - target;
  if (residual(cap) >= 0) return cap;
  let low = 0;
  let high = cap;
  if (residual(low) < 0) return 0;
  for (let iteration = 0; iteration < 28; iteration++) {
    const midpoint = 0.5 * (low + high);
    if (residual(midpoint) >= 0) low = midpoint;
    else high = midpoint;
  }
  return low;
}

export function solveSpeedProfile(
  vehicle: VehicleSettings,
  frames: RacingLineFrame[],
  midpoints: RacingLineFrame[],
  distances: Float64Array,
): Float64Array | null {
  const count = frames.length;
  const aero = aeroTerms(vehicle);
  const speedSquared = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    speedSquared[i] = lateralSpeedCapSquared(vehicle, aero, frames[i]!.kappa);
    if (!(speedSquared[i]! > 0) || !Number.isFinite(speedSquared[i]!)) return null;
  }
  for (let sweep = 0; sweep < 256; sweep++) {
    let relativeChange = 0;
    for (let i = 0; i < count; i++) {
      const next = (i + 1) % count;
      const prior = speedSquared[next]!;
      const reach = implicitReach(
        speedSquared[i]!,
        Math.min(prior, lateralSpeedCapSquared(vehicle, aero, frames[next]!.kappa)),
        distances[i]!,
        midpoints[i]!.kappa,
        (q, curvature) => netAcceleration(vehicle, aero, q, curvature),
      );
      speedSquared[next] = Math.min(prior, reach);
      relativeChange = Math.max(
        relativeChange,
        Math.abs(prior - speedSquared[next]!) / (1 + prior),
      );
    }
    for (let reverse = 0; reverse < count; reverse++) {
      const i = count - 1 - reverse;
      const next = (i + 1) % count;
      const prior = speedSquared[i]!;
      const reach = implicitReach(
        speedSquared[next]!,
        Math.min(prior, lateralSpeedCapSquared(vehicle, aero, frames[i]!.kappa)),
        distances[i]!,
        midpoints[i]!.kappa,
        (q, curvature) => netBraking(vehicle, aero, q, curvature),
      );
      speedSquared[i] = Math.min(prior, reach);
      relativeChange = Math.max(
        relativeChange,
        Math.abs(prior - speedSquared[i]!) / (1 + prior),
      );
    }
    if (relativeChange < 1e-8) return speedSquared;
  }
  return null;
}

export function compensatedSum(values: ArrayLike<number>): number {
  let sum = 0;
  let correction = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i] ?? 0;
    const next = sum + value;
    correction += Math.abs(sum) >= Math.abs(value)
      ? (sum - next) + value
      : (value - next) + sum;
    sum = next;
  }
  return sum + correction;
}

/** CPU FP64 reference used for elite reranking and browser fallback. */
export function evaluateMinimumLapCandidate(
  track: CompiledTrackJson,
  vehicle: VehicleSettings,
  basis: HybridPeriodicBasis,
  coefficients: ArrayLike<number>,
  stationCount: number,
  fidelity: EvaluationFidelity,
  corridor = buildSafeCorridor(track, vehicle),
): CandidateEvaluation {
  if (!(vehicle.massKg > 0) || !(vehicle.lengthM > 0) || !(vehicle.widthM > 0) ||
      !(vehicle.safetyMarginM >= 0) || !(vehicle.vMaxMps > 0) ||
      !(vehicle.axPlus0 > 0) || !(vehicle.axMinus0 > 0) || !(vehicle.ay0 > 0) ||
      !(vehicle.ellipseP >= 1) || !(vehicle.dragAreaM2 >= 0) ||
      !(vehicle.downforceAreaM2 >= 0) || !(vehicle.airDensity > 0) ||
      (vehicle.kappaMax !== null && !(vehicle.kappaMax > 0))) {
    throw new RangeError("invalid vehicle dynamics settings");
  }
  const minimumStations = Math.max(
    64,
    4 * basis.residualControlCount,
    8 * basis.fourierModes,
  );
  if (!Number.isInteger(stationCount) || stationCount < minimumStations) {
    throw new RangeError("candidate basis is under-resolved by the station mesh");
  }
  const spine = buildReferenceSpine(track);
  const projection = projectHybridResidual(basis, coefficients);
  const frames: RacingLineFrame[] = [];
  const midpoints: RacingLineFrame[] = [];
  const distances = new Float64Array(stationCount);
  let violation = 0;
  for (let i = 0; i < coefficients.length; i++) {
    const coefficient = coefficients[i] ?? Infinity;
    violation = Math.max(violation, Math.max(0, Math.abs(coefficient) - 2) / 2);
  }
  let minClearanceM = Infinity;
  let minPathMetric = Infinity;
  let minProgress = Infinity;
  let maxAbsCurvature = 0;
  let maxAbsCurvatureL = 0;
  let maxAbsCurvatureLL = 0;
  for (let i = 0; i < stationCount; i++) {
    const frame = evaluateRacingLineFrame(
      spine, basis, coefficients, corridor, track, vehicle, i / stationCount, projection,
    );
    const midpoint = evaluateRacingLineFrame(
      spine, basis, coefficients, corridor, track, vehicle, (i + 0.5) / stationCount,
      projection,
    );
    frames.push(frame);
    midpoints.push(midpoint);
    distances[i] = midpoint.q / stationCount;
    minClearanceM = Math.min(minClearanceM, frame.clearanceM, midpoint.clearanceM);
    minPathMetric = Math.min(minPathMetric, frame.q, midpoint.q);
    minProgress = Math.min(minProgress, frame.progress, midpoint.progress);
    maxAbsCurvature = Math.max(maxAbsCurvature, Math.abs(frame.kappa), Math.abs(midpoint.kappa));
    maxAbsCurvatureL = Math.max(maxAbsCurvatureL, Math.abs(frame.kappaL), Math.abs(midpoint.kappaL));
    maxAbsCurvatureLL = Math.max(maxAbsCurvatureLL, Math.abs(frame.kappaLL), Math.abs(midpoint.kappaLL));
  }
  const characteristicLength = Math.max(1, track.lapLengthM);
  violation = Math.max(
    violation,
    Math.max(0, -minClearanceM) / Math.max(1, vehicle.widthM),
    Math.max(0, characteristicLength * 1e-8 - minPathMetric) /
      (characteristicLength * 1e-8),
    Math.max(0, 0.1 - minProgress) / 0.1,
  );
  if (vehicle.kappaMax !== null) {
    violation = Math.max(violation, Math.max(0, maxAbsCurvature - vehicle.kappaMax) /
      vehicle.kappaMax);
  }
  if (![minClearanceM, minPathMetric, minProgress, maxAbsCurvature].every(Number.isFinite)) {
    violation = Infinity;
  }
  const lapLengthM = compensatedSum(distances);
  const aero = aeroTerms(vehicle);
  const proxyTerms = new Float64Array(stationCount);
  let capDrop = 0;
  for (let i = 0; i < stationCount; i++) {
    const cap = lateralSpeedCapSquared(vehicle, aero, midpoints[i]!.kappa);
    proxyTerms[i] = distances[i]! / Math.sqrt(Math.max(cap, 1e-12));
    const nextCap = lateralSpeedCapSquared(
      vehicle, aero, midpoints[(i + 1) % stationCount]!.kappa,
    );
    capDrop += Math.max(0, Math.sqrt(cap) - Math.sqrt(nextCap));
  }
  const proxyTime = compensatedSum(proxyTerms) + 1e-4 * capDrop;
  const effectiveLength = vehicle.lengthM + 2 * vehicle.safetyMarginM;
  const regularizerTerms = new Float64Array(stationCount);
  for (let i = 0; i < stationCount; i++) {
    const frame = midpoints[i]!;
    regularizerTerms[i] = distances[i]! * (
      (effectiveLength ** 2 * frame.kappaL) ** 2 +
      0.1 * (effectiveLength ** 3 * frame.kappaLL) ** 2
    );
  }
  const regularizer = compensatedSum(regularizerTerms) / Math.max(lapLengthM, 1e-12);
  if (violation > 0 || fidelity === "proxy") {
    return {
      feasible: violation === 0,
      violation,
      lapTime: proxyTime,
      proxyTime,
      regularizer,
      lapLengthM,
      minClearanceM,
      minPathMetric,
      minProgress,
      maxAbsCurvature,
      maxAbsCurvatureL,
      maxAbsCurvatureLL,
      maxLateralJerk: 0,
      rmsLateralJerk: 0,
      speedOptimalityResidual: Infinity,
      speedSquared: null,
      frames,
    };
  }
  const speedSquared = solveSpeedProfile(vehicle, frames, midpoints, distances);
  if (speedSquared === null) violation = Math.max(violation, 1);
  const timeTerms = new Float64Array(stationCount);
  let maxLateralJerk = 0;
  let jerkSquaredIntegral = 0;
  let elapsed = 0;
  let speedOptimalityResidual = Infinity;
  if (speedSquared !== null) {
    speedOptimalityResidual = 0;
    for (let i = 0; i < stationCount; i++) {
      const next = (i + 1) % stationCount;
      const vi = Math.sqrt(speedSquared[i]!);
      const vj = Math.sqrt(speedSquared[next]!);
      timeTerms[i] = 2 * distances[i]! / Math.max(vi + vj, 1e-12);
      const acceleration = (speedSquared[next]! - speedSquared[i]!) /
        Math.max(2 * distances[i]!, 1e-12);
      const jerk = 2 * vi * acceleration * frames[i]!.kappa +
        vi ** 3 * frames[i]!.kappaL;
      maxLateralJerk = Math.max(maxLateralJerk, Math.abs(jerk));
      jerkSquaredIntegral += jerk * jerk * timeTerms[i]!;
      elapsed += timeTerms[i]!;
      const previous = (i + stationCount - 1) % stationCount;
      const cap = lateralSpeedCapSquared(vehicle, aero, frames[i]!.kappa);
      const forward = implicitReach(
        speedSquared[previous]!, cap, distances[previous]!, midpoints[previous]!.kappa,
        (q, curvature) => netAcceleration(vehicle, aero, q, curvature),
      );
      const braking = implicitReach(
        speedSquared[next]!, cap, distances[i]!, midpoints[i]!.kappa,
        (q, curvature) => netBraking(vehicle, aero, q, curvature),
      );
      const activeSlack = Math.min(
        cap - speedSquared[i]!,
        forward - speedSquared[i]!,
        braking - speedSquared[i]!,
      );
      speedOptimalityResidual = Math.max(
        speedOptimalityResidual,
        Math.max(0, activeSlack) / (1 + speedSquared[i]!),
      );
    }
  }
  const lapTime = speedSquared === null ? Infinity : compensatedSum(timeTerms);
  return {
    feasible: violation === 0 && Number.isFinite(lapTime),
    violation,
    lapTime,
    proxyTime,
    regularizer,
    lapLengthM,
    minClearanceM,
    minPathMetric,
    minProgress,
    maxAbsCurvature,
    maxAbsCurvatureL,
    maxAbsCurvatureLL,
    maxLateralJerk,
    rmsLateralJerk: elapsed > 0 ? Math.sqrt(jerkSquaredIntegral / elapsed) : 0,
    speedOptimalityResidual,
    speedSquared,
    frames,
  };
}
