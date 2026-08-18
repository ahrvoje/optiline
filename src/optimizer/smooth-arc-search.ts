import { fourierCoefficientCount } from "@/optimizer/fourier";
import type { HybridPeriodicBasis } from "@/optimizer/hybrid-basis";

export interface PatternProxyScore {
  feasible: boolean;
  lapTime: number;
}

function cyclicDistance(a: number, b: number, count: number): number {
  const direct = Math.abs(a - b);
  return Math.min(direct, count - direct);
}

function boundedMove(base: Float64Array, delta: Float64Array, limit: number): Float64Array {
  let scale = 1;
  for (let i = 0; i < base.length; i++) {
    if (delta[i]! > 0) scale = Math.min(scale, (limit - base[i]!) / delta[i]!);
    else if (delta[i]! < 0) scale = Math.min(scale, (-limit - base[i]!) / delta[i]!);
  }
  const result = base.slice();
  const safeScale = Math.max(0, Math.min(1, scale));
  for (let i = 0; i < result.length; i++) result[i] = result[i]! + safeScale * delta[i]!;
  return result;
}

/**
 * Move one complete arc with a compact raised-cosine window. Adding G*delta
 * to the Fourier block cancels the residual basis' -F*G*delta term, so the
 * represented latent displacement is exactly the local spline window. This
 * prevents a boundary move from creating a compensating global ripple.
 */
export function projectedRaisedCosineMove(
  coefficients: Float64Array,
  basis: HybridPeriodicBasis,
  centerControl: number,
  supportControls: number,
  amplitude: number,
  coefficientLimit = 2,
): Float64Array {
  const residualCount = basis.residualControlCount;
  if (residualCount < 6 || !(supportControls >= 1) || !Number.isFinite(amplitude)) {
    throw new RangeError("invalid smooth arc move");
  }
  const fourierCount = fourierCoefficientCount(basis.fourierModes);
  const delta = new Float64Array(coefficients.length);
  const radius = Math.max(1, supportControls / 2);
  for (let residual = 0; residual < residualCount; residual++) {
    const distance = cyclicDistance(residual, centerControl, residualCount);
    if (distance > radius) continue;
    const window = 0.5 * (1 + Math.cos(Math.PI * distance / radius));
    const change = amplitude * window;
    delta[fourierCount + residual] = change;
    for (let column = 0; column < fourierCount; column++) {
      delta[column] = delta[column]! +
        basis.residualProjection[column * residualCount + residual]! * change;
    }
  }
  return boundedMove(coefficients, delta, coefficientLimit);
}

/** Global spectral probes plus local physical arc probes at all active scales. */
export function smoothPatternProposals(
  coefficients: Float64Array,
  basis: HybridPeriodicBasis,
  pathLengthM: number,
  spectralStep: number,
  coefficientLimit = 2,
  localAmplitudeScale = 1,
): Float64Array[] {
  const proposals: Float64Array[] = [];
  const fourierCount = fourierCoefficientCount(basis.fourierModes);
  for (let coordinate = 0; coordinate < fourierCount; coordinate++) {
    const harmonic = coordinate === 0 ? 0 : Math.ceil(coordinate / 2);
    const amplitude = spectralStep / Math.max(1, harmonic * harmonic);
    for (const sign of [-1, 1]) {
      const delta = new Float64Array(coefficients.length);
      delta[coordinate] = sign * amplitude;
      proposals.push(boundedMove(coefficients, delta, coefficientLimit));
    }
  }
  const residualCount = basis.residualControlCount;
  if (residualCount === 0) return proposals;
  const controlSpacingM = pathLengthM / residualCount;
  for (const supportM of [120, 60, 30, 15]) {
    const supportControls = Math.max(2, Math.min(
      residualCount,
      Math.round(supportM / controlSpacingM),
    ));
    const centerStride = Math.max(1, Math.round(supportControls / 2));
    const amplitude = localAmplitudeScale *
      Math.min(0.16, Math.max(0.01, 0.04 * (supportM / 30) ** 2));
    for (let center = 0; center < residualCount; center += centerStride) {
      for (const sign of [-1, 1]) {
        proposals.push(projectedRaisedCosineMove(
          coefficients,
          basis,
          center,
          supportControls,
          sign * amplitude,
          coefficientLimit,
        ));
      }
    }
  }
  return proposals;
}

function scaledCombination(
  base: Float64Array,
  deltas: Float64Array[],
  scale: number,
  coefficientLimit: number,
): Float64Array {
  const combined = base.slice();
  for (const delta of deltas) {
    for (let i = 0; i < combined.length; i++) {
      combined[i] = Math.max(
        -coefficientLimit,
        Math.min(coefficientLimit, combined[i]! + scale * delta[i]!),
      );
    }
  }
  return combined;
}

/** Combine symmetric probes into simultaneous smooth trust-region moves. */
export function quadraticPatternCombinations(
  base: Float64Array,
  pairedProposals: Float64Array[],
  baseScore: PatternProxyScore,
  proposalScores: PatternProxyScore[],
  spectralPairCount: number,
  coefficientLimit = 2,
): Float64Array[] {
  if (pairedProposals.length !== proposalScores.length ||
      (pairedProposals.length & 1) !== 0 ||
      !Number.isInteger(spectralPairCount) || spectralPairCount < 0 ||
      2 * spectralPairCount > pairedProposals.length) {
    throw new RangeError("invalid paired pattern observations");
  }
  const spectral: Float64Array[] = [];
  const local: Array<{ gain: number; delta: Float64Array }> = [];
  for (let pair = 0; 2 * pair < pairedProposals.length; pair++) {
    const minus = pairedProposals[2 * pair]!;
    const plus = pairedProposals[2 * pair + 1]!;
    const minusScore = proposalScores[2 * pair]!;
    const plusScore = proposalScores[2 * pair + 1]!;
    if (!baseScore.feasible || (!minusScore.feasible && !plusScore.feasible)) continue;
    const feasibleMinus = minusScore.feasible ? minusScore.lapTime : Infinity;
    const feasiblePlus = plusScore.feasible ? plusScore.lapTime : Infinity;
    const gain = baseScore.lapTime - Math.min(feasibleMinus, feasiblePlus);
    if (!(gain > 0)) continue;
    const delta = new Float64Array(base.length);
    if (minusScore.feasible && plusScore.feasible) {
      const curvature = minusScore.lapTime + plusScore.lapTime - 2 * baseScore.lapTime;
      const stationary = curvature > 1e-7
        ? (minusScore.lapTime - plusScore.lapTime) / (2 * curvature)
        : minusScore.lapTime < plusScore.lapTime ? -1 : 1;
      const amount = Math.max(-1, Math.min(1, stationary));
      for (let i = 0; i < delta.length; i++) {
        delta[i] = 0.5 * amount * (plus[i]! - minus[i]!);
      }
    } else {
      const improving = minusScore.feasible ? minus : plus;
      for (let i = 0; i < delta.length; i++) delta[i] = improving[i]! - base[i]!;
    }
    if (pair < spectralPairCount) spectral.push(delta);
    else local.push({ gain, delta });
  }
  local.sort((a, b) => b.gain - a.gain);
  const localDeltas = local.slice(0, 8).map(item => item.delta);
  const proposals: Float64Array[] = [];
  for (const scale of [0.25, 0.5, 1]) {
    if (spectral.length > 0) {
      proposals.push(scaledCombination(base, spectral, scale, coefficientLimit));
    }
    if (localDeltas.length > 0) {
      proposals.push(scaledCombination(base, localDeltas, scale, coefficientLimit));
    }
    if (spectral.length > 0 && localDeltas.length > 0) {
      proposals.push(scaledCombination(
        base, [...spectral, ...localDeltas], scale, coefficientLimit,
      ));
    }
  }
  return proposals;
}
