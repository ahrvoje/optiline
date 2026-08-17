import { fourierCoefficientCount } from "@/optimizer/fourier";
import type { HybridPeriodicBasis } from "@/optimizer/hybrid-basis";

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
