import type { CompiledTrackJson, VehicleSettings } from "@/model/contracts";
import { evaluateFourierKernel } from "@/optimizer/fourier-kernel";
import { fitRealFourier } from "@/optimizer/fourier";
import type { HybridPeriodicBasis } from "@/optimizer/hybrid-basis";
import { buildReferenceSpine, type SafeCorridor } from "@/optimizer/racing-line";

/**
 * Convex projected minimum-curvature seed on the reference normal chart.
 * This is a geometric initializer only; minimum lap time remains the
 * authoritative objective in the island search.
 */
export function minimumCurvatureSeed(
  track: CompiledTrackJson,
  _vehicle: VehicleSettings,
  basis: HybridPeriodicBasis,
  corridor: SafeCorridor,
  sampleCount = 256,
): Float64Array {
  const spine = buildReferenceSpine(track);
  const x = new Float64Array(sampleCount);
  const y = new Float64Array(sampleCount);
  const nx = new Float64Array(sampleCount);
  const ny = new Float64Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const frame = evaluateFourierKernel(spine, i / sampleCount, 1);
    const metric = Math.max(Math.hypot(frame[1]![0], frame[1]![1]), 1e-12);
    x[i] = frame[0]![0];
    y[i] = frame[0]![1];
    nx[i] = -frame[1]![1] / metric;
    ny[i] = frame[1]![0] / metric;
  }
  const displacement = new Float64Array(sampleCount);
  const ax = new Float64Array(sampleCount);
  const ay = new Float64Array(sampleCount);
  const gradient = new Float64Array(sampleCount);
  for (let iteration = 0; iteration < 600; iteration++) {
    for (let i = 0; i < sampleCount; i++) {
      const previous = (i + sampleCount - 1) % sampleCount;
      const next = (i + 1) % sampleCount;
      const px = x[i]! + displacement[i]! * nx[i]!;
      const py = y[i]! + displacement[i]! * ny[i]!;
      ax[i] = x[previous]! + displacement[previous]! * nx[previous]! - 2 * px +
        x[next]! + displacement[next]! * nx[next]!;
      ay[i] = y[previous]! + displacement[previous]! * ny[previous]! - 2 * py +
        y[next]! + displacement[next]! * ny[next]!;
    }
    let maximumChange = 0;
    for (let i = 0; i < sampleCount; i++) {
      const previous = (i + sampleCount - 1) % sampleCount;
      const next = (i + 1) % sampleCount;
      const gx = 2 * (ax[previous]! - 2 * ax[i]! + ax[next]!);
      const gy = 2 * (ay[previous]! - 2 * ay[i]! + ay[next]!);
      gradient[i] = gx * nx[i]! + gy * ny[i]!;
    }
    for (let i = 0; i < sampleCount; i++) {
      const next = Math.max(
        corridor.lower + 1e-4,
        Math.min(corridor.upper - 1e-4, displacement[i]! - 0.02 * gradient[i]!),
      );
      maximumChange = Math.max(maximumChange, Math.abs(next - displacement[i]!));
      displacement[i] = next;
    }
    if (maximumChange < 1e-7) break;
  }
  const midpoint = 0.5 * (corridor.lower + corridor.upper);
  const halfWidth = 0.5 * (corridor.upper - corridor.lower);
  const latent = Float64Array.from(displacement, value => {
    const normalized = Math.max(-0.96, Math.min(0.96, (value - midpoint) / halfWidth));
    return Math.atanh(normalized);
  });
  const coefficients = new Float64Array(1 + 2 * basis.fourierModes + basis.residualControlCount);
  coefficients.set(fitRealFourier(latent, basis.fourierModes));
  return coefficients;
}
