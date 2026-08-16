/** Display profile and lap-time evaluator over analytic PH frames. */
import { GRAVITY, type ProfileNodeJson, type VehicleSettings } from "@/model/contracts";
import { sampleLineFrames, type LineSpec } from "@/renderer/ph-tessellate";

export interface EvaluatedProfile { lapTime: number; lineLength: number; nodes: ProfileNodeJson[]; }

function remainingLongitudinalCapacity(
  vehicle: VehicleSettings,
  gamma: number,
  qLow: number,
  qHigh: number,
  curvature: number,
): number {
  const loadHigh = 1 + gamma * qHigh;
  const lateralUse = qHigh * curvature / (vehicle.ay0 * loadHigh);
  if (!(loadHigh > 0) || lateralUse > 1) return 0;
  return Math.max(0, 1 - Math.max(0, lateralUse) ** vehicle.ellipseP) **
    (1 / vehicle.ellipseP) * (1 + gamma * qLow);
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
  const feasible = (q: number): boolean =>
    (q - q0) / (2 * ds) + delta * q <= vehicle.axPlus0 *
      remainingLongitudinalCapacity(vehicle, gamma, q0, q, curvature);
  if (feasible(cap)) return cap;
  let low = q0, high = cap;
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
    const remaining = remainingLongitudinalCapacity(vehicle, gamma, q1, q, curvature);
    const positiveCapacity = vehicle.axPlus0 * remaining;
    if (delta * q > positiveCapacity) return false;
    const brakingNeed = Math.max(0, (q - q1) / (2 * ds) - delta * q1);
    return brakingNeed <= vehicle.axMinus0 * remaining;
  };
  if (feasible(cap)) return cap;
  let low = q1, high = cap;
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
    const c = ((delta / vehicle.axPlus0) ** vehicle.ellipseP +
      (k / vehicle.ay0) ** vehicle.ellipseP) ** (1 / vehicle.ellipseP);
    const steady = c > gamma ? 1 / (c - gamma) : Infinity;
    q[i] = Math.min(vehicle.vMaxMps ** 2, steady);
    if (vehicle.kappaMax !== null && k > vehicle.kappaMax) q[i] = 0;
  }
  // Periodic force-limited envelope with the same ellipse, drag, downforce,
  // and bisection equations as the authoritative C99 solver.
  for (let pass = 0; pass < 8; pass++) {
    for (let i = 0; i < count; i++) {
      const next = (i + 1) % count;
      q[next] = Math.min(q[next]!, forwardReach(
        vehicle, delta, gamma, q[i]!, q[next]!, ds[i]!, edgeK[i]!,
      ));
    }
    for (let i = count - 1; i >= 0; i--) {
      const next = (i + 1) % count;
      q[i] = Math.min(q[i]!, brakingReach(
        vehicle, delta, gamma, q[next]!, q[i]!, ds[i]!, edgeK[i]!,
      ));
    }
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
