import {
  GRAVITY,
  type ProfileNodeJson,
  type VehicleSettings,
} from "@/model/contracts";
import type { CandidateEvaluation } from "@/optimizer/minimum-lap";

export const INTERMEDIATE_REPORT_INTERVAL_MS = 30_000;

/** Return the last complete reporting interval. */
export function completedReportingInterval(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new RangeError("invalid optimizer elapsed time");
  }
  return Math.floor(elapsedMs / INTERMEDIATE_REPORT_INTERVAL_MS);
}

export interface IntermediatePreview {
  optimizerLapTime: number;
  lapTime: number;
  lineLengthM: number;
  pathSamples: Float64Array;
  profileNodes: ProfileNodeJson[];
}

/** Resample a full binary64 discovery evaluation to a uniform-distance preview. */
export function buildIntermediatePreview(
  score: CandidateEvaluation,
  vehicle: VehicleSettings,
  sampleCount = 512,
): IntermediatePreview {
  const sourceCount = score.frames.length;
  if (!score.feasible || score.speedSquared === null ||
      score.speedSquared.length !== sourceCount || score.distances.length !== sourceCount ||
      !Number.isInteger(sampleCount) || sampleCount < 8 || !(score.lapLengthM > 0)) {
    throw new RangeError("invalid intermediate preview evaluation");
  }
  const cumulative = new Float64Array(sourceCount + 1);
  for (let i = 0; i < sourceCount; i++) {
    cumulative[i + 1] = cumulative[i]! + score.distances[i]!;
  }
  const measuredLength = cumulative[sourceCount]!;
  if (!(measuredLength > 0) || !Number.isFinite(measuredLength)) {
    throw new RangeError("invalid intermediate preview length");
  }
  const distanceScale = score.lapLengthM / measuredLength;
  for (let i = 1; i < cumulative.length; i++) {
    cumulative[i] = cumulative[i]! * distanceScale;
  }

  const pathSamples = new Float64Array(5 * sampleCount);
  const speedSquared = new Float64Array(sampleCount);
  const curvature = new Float64Array(sampleCount);
  let source = 0;
  for (let sample = 0; sample < sampleCount; sample++) {
    const distance = sample * score.lapLengthM / sampleCount;
    while (source + 1 < sourceCount && cumulative[source + 1]! <= distance) source++;
    const next = (source + 1) % sourceCount;
    const segmentLength = source + 1 < sourceCount
      ? cumulative[source + 1]! - cumulative[source]!
      : score.lapLengthM - cumulative[source]!;
    const t = Math.max(0, Math.min(1,
      (distance - cumulative[source]!) / Math.max(segmentLength, 1e-12),
    ));
    const a = score.frames[source]!;
    const b = score.frames[next]!;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const dh00 = 6 * t2 - 6 * t;
    const dh10 = 3 * t2 - 4 * t + 1;
    const dh01 = -dh00;
    const dh11 = 3 * t2 - 2 * t;
    const x = h00 * a.x + h10 * segmentLength * a.tx +
      h01 * b.x + h11 * segmentLength * b.tx;
    const y = h00 * a.y + h10 * segmentLength * a.ty +
      h01 * b.y + h11 * segmentLength * b.ty;
    const dx = dh00 * a.x + dh10 * segmentLength * a.tx +
      dh01 * b.x + dh11 * segmentLength * b.tx;
    const dy = dh00 * a.y + dh10 * segmentLength * a.ty +
      dh01 * b.y + dh11 * segmentLength * b.ty;
    const metric = Math.max(Math.hypot(dx, dy), 1e-12);
    curvature[sample] = (1 - t) * a.kappa + t * b.kappa;
    speedSquared[sample] = (1 - t) * score.speedSquared[source]! +
      t * score.speedSquared[next]!;
    pathSamples.set([x, y, dx / metric, dy / metric, curvature[sample]!], 5 * sample);
  }

  const ds = score.lapLengthM / sampleCount;
  const delta = vehicle.airDensity * vehicle.dragAreaM2 / (2 * vehicle.massKg);
  const gamma = vehicle.airDensity * vehicle.downforceAreaM2 /
    (2 * vehicle.massKg * GRAVITY);
  const intervalTimes = new Float64Array(sampleCount);
  let lapTime = 0;
  for (let i = 0; i < sampleCount; i++) {
    const next = (i + 1) % sampleCount;
    intervalTimes[i] = 2 * ds / Math.max(
      Math.sqrt(Math.max(speedSquared[i]!, 0)) +
      Math.sqrt(Math.max(speedSquared[next]!, 0)),
      1e-12,
    );
    lapTime += intervalTimes[i]!;
  }
  const profileNodes: ProfileNodeJson[] = [];
  let time = 0;
  for (let i = 0; i < sampleCount; i++) {
    const next = (i + 1) % sampleCount;
    const q = speedSquared[i]!;
    const acceleration = (speedSquared[next]! - q) / (2 * ds);
    const load = 1 + gamma * q;
    const tireX = acceleration + delta * q;
    const longitudinalCapacity = (tireX >= 0 ? vehicle.axPlus0 : vehicle.axMinus0) * load;
    const longitudinal = Math.abs(tireX) / Math.max(longitudinalCapacity, 1e-12);
    const lateral = Math.abs(q * curvature[i]!) / Math.max(vehicle.ay0 * load, 1e-12);
    const stability = (
      longitudinal ** vehicle.ellipseP + lateral ** vehicle.ellipseP
    ) ** (1 / vehicle.ellipseP);
    profileNodes.push({
      parameter: 64 * i / sampleCount,
      distance: i * ds,
      time,
      q,
      acceleration,
      curvature: curvature[i]!,
      stability,
    });
    time += intervalTimes[i]!;
  }
  return {
    optimizerLapTime: score.lapTime,
    lapTime,
    lineLengthM: score.lapLengthM,
    pathSamples,
    profileNodes,
  };
}
