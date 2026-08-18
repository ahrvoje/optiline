import { GRAVITY, type ProfileNodeJson, type VehicleSettings } from "@/model/contracts";

export type ConstraintDomain =
  | "containment"
  | "speed"
  | "acceleration"
  | "braking"
  | "lateral"
  | "combined"
  | "aero"
  | "curvature"
  | "none";

/** Domains that can appear in the profile ribbon. Geometric limits stay in settings. */
export type ProfileLimitDomain = Exclude<ConstraintDomain, "containment" | "curvature">;

export const CONSTRAINT_COLORS: Record<ConstraintDomain, string> = {
  containment: "#32d7ff",
  speed: "#ffd60a",
  acceleration: "#f5f7fa",
  braking: "#268cff",
  lateral: "#ff2dbf",
  combined: "#7ee000",
  aero: "#00bfa5",
  curvature: "#b794ff",
  none: "#303740",
};

/* The ribbon is a sampled visualization, not the feasibility proof. A 0.5%
 * tolerance in q is 0.25% in speed and keeps a certified cap visible after
 * the solver's strict interior contraction and profile resampling. */
const SPEED_CAP_Q_RATIO = 0.995;

/** Classify only near-active motion constraints; inactive arcs remain neutral. */
export function limitingProfileConstraint(
  node: ProfileNodeJson,
  vehicle: VehicleSettings,
): ProfileLimitDomain {
  if (node.q >= SPEED_CAP_Q_RATIO * vehicle.vMaxMps ** 2) return "speed";

  const delta = vehicle.airDensity * vehicle.dragAreaM2 / (2 * vehicle.massKg);
  const gamma = vehicle.airDensity * vehicle.downforceAreaM2 /
    (2 * vehicle.massKg * GRAVITY);
  const load = 1 + gamma * node.q;
  const tireX = node.acceleration + delta * node.q;
  const longitudinalBase = tireX >= 0 ? vehicle.axPlus0 : vehicle.axMinus0;
  const ux = Math.abs(tireX) / Math.max(longitudinalBase * load, 1e-12);
  const uy = Math.abs(node.q * node.curvature) / Math.max(vehicle.ay0 * load, 1e-12);
  const utilization = (ux ** vehicle.ellipseP + uy ** vehicle.ellipseP) **
    (1 / vehicle.ellipseP);
  if (utilization < 0.985) return "none";
  const dragShare = delta * node.q / Math.max(vehicle.axPlus0 * load, 1e-12);
  if (tireX >= 0 && dragShare >= 0.5 && Math.abs(node.acceleration) <= 0.2) return "aero";
  if (ux >= 0.2 && uy >= 0.2) return "combined";
  if (uy > ux) return "lateral";
  return tireX >= 0 ? "acceleration" : "braking";
}

/** Classify a periodic profile and keep an isolated speed-cap contact visible. */
export function limitingProfileConstraints(
  nodes: ProfileNodeJson[],
  vehicle: VehicleSettings,
): ProfileLimitDomain[] {
  const domains = nodes.map(node => limitingProfileConstraint(node, vehicle));
  if (domains.length < 2) return domains;
  const speedContacts = domains.map(domain => domain === "speed");
  for (let i = 0; i < speedContacts.length; i++) {
    if (speedContacts[i]) domains[(i + domains.length - 1) % domains.length] = "speed";
  }
  return domains;
}
