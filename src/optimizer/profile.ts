/** Display profile and lap-time evaluator over analytic PH frames. */
import { GRAVITY, type ProfileNodeJson, type VehicleSettings } from "@/model/contracts";
import { sampleLineFrames, type LineSpec } from "@/renderer/ph-tessellate";

export interface EvaluatedProfile { lapTime: number; lineLength: number; nodes: ProfileNodeJson[]; }

function remainingLongitudinalCapacity(
  vehicle: VehicleSettings,
  gamma: number,
  q: number,
  curvature: number,
): number {
  const load = 1 + gamma * q;
  const lateralUse = Math.abs(q * curvature) / (vehicle.ay0 * load);
  if (!(load > 0) || lateralUse > 1) return 0;
  const remainder = vehicle.ellipseP === 2
    ? Math.sqrt(Math.max(0, 1 - lateralUse * lateralUse))
    : Math.max(0, 1 - lateralUse ** vehicle.ellipseP) ** (1 / vehicle.ellipseP);
  return load * remainder;
}

function forwardReach(
  vehicle: VehicleSettings,
  delta: number,
  gamma: number,
  q0: number,
  cap: number,
  ds: number,
  curvature: number,
): number {
  if (cap <= q0) return cap;
  const feasible = (q: number): boolean => {
    const midpoint = 0.5 * (q0 + q);
    const net = vehicle.axPlus0 *
      remainingLongitudinalCapacity(vehicle, gamma, midpoint, curvature) - delta * midpoint;
    return q <= q0 + 2 * ds * net;
  };
  if (feasible(cap)) return cap;
  let low = 0, high = cap;
  if (!feasible(low)) return 0;
  for (let i = 0; i < 20; i++) {
    const mid = 0.5 * (low + high);
    if (feasible(mid)) low = mid; else high = mid;
  }
  return low;
}

function brakingReach(
  vehicle: VehicleSettings,
  delta: number,
  gamma: number,
  q1: number,
  cap: number,
  ds: number,
  curvature: number,
): number {
  if (cap <= q1) return cap;
  const feasible = (q: number): boolean => {
    const midpoint = 0.5 * (q1 + q);
    const braking = vehicle.axMinus0 *
      remainingLongitudinalCapacity(vehicle, gamma, midpoint, curvature) + delta * midpoint;
    return q <= q1 + 2 * ds * braking;
  };
  if (feasible(cap)) return cap;
  let low = 0, high = cap;
  if (!feasible(low)) return 0;
  for (let i = 0; i < 20; i++) {
    const mid = 0.5 * (low + high);
    if (feasible(mid)) low = mid; else high = mid;
  }
  return low;
}

export function evaluateProfile(spec: LineSpec, vehicle: VehicleSettings, count = 512): EvaluatedProfile {
  const frames = sampleLineFrames(spec, count);
  const ds = new Float64Array(count), edgeK = new Float64Array(count), q = new Float64Array(count);
  const delta = vehicle.airDensity * vehicle.dragAreaM2 / (2 * vehicle.massKg);
  const gamma = vehicle.airDensity * vehicle.downforceAreaM2 / (2 * vehicle.massKg * GRAVITY);
  let lineLength = 0;
  for (let i = 0; i < count; i++) {
    const a = frames[i]!, b = frames[(i + 1) % count]!;
    ds[i] = Math.hypot(b.x - a.x, b.y - a.y); lineLength += ds[i]!;
    edgeK[i] = Math.max(Math.abs(a.kappa), Math.abs(b.kappa));
  }
  for (let i = 0; i < count; i++) {
    const k = Math.max(edgeK[(i + count - 1) % count]!, edgeK[i]!);
    const denominator = k - vehicle.ay0 * gamma;
    const lateral = denominator > 0 ? vehicle.ay0 / denominator : Infinity;
    q[i] = Math.min(vehicle.vMaxMps ** 2, lateral);
    if (vehicle.kappaMax !== null && k > vehicle.kappaMax) q[i] = 0;
  }
  // Periodic force-limited envelope with the same ellipse, drag, downforce,
  // and bisection equations as the authoritative C99 solver.
  for (let pass = 0; pass < 256; pass++) {
    let relativeChange = 0;
    for (let i = 0; i < count; i++) {
      const next = (i + 1) % count;
      const prior = q[next]!;
      q[next] = Math.min(prior, forwardReach(
        vehicle, delta, gamma, q[i]!, q[next]!, ds[i]!, edgeK[i]!,
      ));
      relativeChange = Math.max(relativeChange, Math.abs(prior - q[next]!) / (1 + prior));
    }
    for (let i = count - 1; i >= 0; i--) {
      const next = (i + 1) % count;
      const prior = q[i]!;
      q[i] = Math.min(prior, brakingReach(
        vehicle, delta, gamma, q[next]!, q[i]!, ds[i]!, edgeK[i]!,
      ));
      relativeChange = Math.max(relativeChange, Math.abs(prior - q[i]!) / (1 + prior));
    }
    if (relativeChange < 1e-8) break;
  }
  const nodes: ProfileNodeJson[] = [];
  let distance = 0, time = 0;
  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count;
    const accel = (q[next]! - q[i]!) / Math.max(2 * ds[i]!, 1e-9);
    const speed = Math.sqrt(Math.max(q[i]!, 0));
    const load = 1 + gamma * q[i]!;
    const tireX = accel + delta * q[i]!;
    const ax = tireX >= 0 ? vehicle.axPlus0 : vehicle.axMinus0;
    const ux = Math.abs(tireX) / (ax * load);
    const uy = Math.abs(q[i]! * frames[i]!.kappa) / (vehicle.ay0 * load);
    const stability = (ux ** vehicle.ellipseP + uy ** vehicle.ellipseP) ** (1 / vehicle.ellipseP);
    nodes.push({ parameter: 64 * i / count, distance, time, q: q[i]!, acceleration: accel,
      curvature: frames[i]!.kappa, stability });
    distance += ds[i]!; time += 2 * ds[i]! / Math.max(speed + Math.sqrt(Math.max(q[next]!, 0)), 1e-6);
  }
  return { lapTime: time, lineLength, nodes };
}
