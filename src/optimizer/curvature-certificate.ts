import {
  GRAVITY,
  type CertificateReportJson,
  type CompiledTrackJson,
  type ProfileNodeJson,
  type VehicleSettings,
} from "@/model/contracts";
import {
  measureCurvatureClosure,
  projectCurvatureClosure,
  reconstructCurvaturePath,
  type CurvatureRepresentation,
} from "@/optimizer/curvature-closure";
import { evaluateCurvatureCandidate } from "@/optimizer/curvature-evaluation";

export interface CertifiedCurvatureCandidate {
  representation: CurvatureRepresentation;
  lapTime: number;
  lineLengthM: number;
  profileNodes: Float64Array;
  edgeCount: number;
  pathSamples: Float64Array;
  certificate: CertificateReportJson;
}

export const CURVATURE_CERTIFICATION_STAGE_COUNT = 7;

export interface CurvatureCertificationProgress {
  completed: number;
  total: typeof CURVATURE_CERTIFICATION_STAGE_COUNT;
  label: string;
}

function packedProfile(
  vehicle: VehicleSettings,
  score: ReturnType<typeof evaluateCurvatureCandidate>,
  speedScale = 1,
): { values: Float64Array; maximumUtilization: number; lapTime: number } {
  const speedSquared = score.speedSquared;
  if (speedSquared === null) {
    return { values: new Float64Array(), maximumUtilization: Infinity, lapTime: Infinity };
  }
  const count = speedSquared.length;
  const ds = score.lapLengthM / count;
  const delta = vehicle.airDensity * vehicle.dragAreaM2 / (2 * vehicle.massKg);
  const gamma = vehicle.airDensity * vehicle.downforceAreaM2 /
    (2 * vehicle.massKg * GRAVITY);
  const nodes: ProfileNodeJson[] = [];
  let elapsed = 0;
  let maximumUtilization = 0;
  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count;
    const q = speedScale * speedSquared[i]!;
    const nextQ = speedScale * speedSquared[next]!;
    const acceleration = (nextQ - q) / (2 * ds);
    const load = 1 + gamma * q;
    const tireX = acceleration + delta * q;
    const longitudinal = Math.abs(tireX) /
      ((tireX >= 0 ? vehicle.axPlus0 : vehicle.axMinus0) * load);
    const lateral = Math.abs(q * score.frames[i]!.kappa) / (vehicle.ay0 * load);
    const stability = (longitudinal ** vehicle.ellipseP + lateral ** vehicle.ellipseP) **
      (1 / vehicle.ellipseP);
    maximumUtilization = Math.max(maximumUtilization, stability);
    nodes.push({
      parameter: 64 * i / count,
      distance: i * ds,
      time: elapsed,
      q,
      acceleration,
      curvature: score.frames[i]!.kappa,
      stability,
    });
    elapsed += 2 * ds /
      Math.max(Math.sqrt(q) + Math.sqrt(nextQ), 1e-12);
  }
  const values = new Float64Array(7 * count);
  for (let i = 0; i < count; i++) {
    const node = nodes[i]!;
    values.set([
      node.parameter,
      node.distance,
      node.time,
      node.q,
      node.acceleration,
      node.curvature,
      node.stability,
    ], 7 * i);
  }
  return { values, maximumUtilization, lapTime: elapsed };
}

function packedPath(representation: CurvatureRepresentation, count: number): Float64Array {
  const samples = reconstructCurvaturePath(representation, count);
  const packed = new Float64Array(5 * count);
  for (let i = 0; i < count; i++) {
    const sample = samples[i]!;
    packed.set([sample.x, sample.y, sample.tx, sample.ty, sample.kappa], 5 * i);
  }
  return packed;
}

/**
 * Independent FP64 certificate for the authoritative intrinsic trajectory.
 * Geometry is closure-projected again and checked on three nested meshes.
 */
export function certifyCurvatureCandidate(
  track: CompiledTrackJson,
  vehicle: VehicleSettings,
  source: CurvatureRepresentation,
  onProgress?: (progress: CurvatureCertificationProgress) => void,
): CertifiedCurvatureCandidate {
  const report = (completed: number, label: string): void => onProgress?.({
    completed,
    total: CURVATURE_CERTIFICATION_STAGE_COUNT,
    label,
  });
  report(0, "Projecting curvature closure");
  const representation = projectCurvatureClosure(source, {
    tolerance: 1e-11,
    sampleCount: 8192,
    maximumIterations: 24,
    selectCorrectionModes: false,
  });
  if (representation === null) throw new Error("curvature closure projection failed");
  report(1, "Checking 2,048-edge mesh");
  const coarse = evaluateCurvatureCandidate(track, vehicle, representation, 2048);
  report(2, "Checking 4,096-edge mesh");
  const refined = evaluateCurvatureCandidate(track, vehicle, representation, 4096);
  report(3, "Checking 8,192-edge mesh");
  const finest = evaluateCurvatureCandidate(track, vehicle, representation, 8192);
  report(4, "Measuring closure residuals");
  const closure = measureCurvatureClosure(representation, 16384);
  const physicalClosure = Math.max(
    Math.abs(closure.turn),
    representation.pathLengthM * Math.abs(closure.x),
    representation.pathLengthM * Math.abs(closure.y),
  );
  const lapTimeDelta = Math.abs(finest.lapTime - refined.lapTime);
  report(5, "Checking dynamic utilization");
  let speedScale = 1;
  let profile = packedProfile(vehicle, finest, speedScale);
  while (profile.maximumUtilization > 1 && speedScale > 0.98) {
    speedScale -= 0.0001;
    profile = packedProfile(vehicle, finest, speedScale);
  }
  report(6, "Building certified path");
  // Every mesh uses an interval curvature upper bound, so the finest lap is
  // already a feasible upper bound. Mesh delta measures tightness; it is not
  // a feasibility condition and must not reject an otherwise certified path.
  const pass = coarse.feasible && refined.feasible && finest.feasible &&
    physicalClosure <= 1e-7 &&
    finest.speedOptimalityResidual <= 1e-7 &&
    profile.maximumUtilization <= 1;
  const certificate: CertificateReportJson = {
    maxInterpResidual: physicalClosure,
    minPreimageSpeed: finest.minPathMetric,
    maxSeamResidual: physicalClosure,
    minContainmentBound: finest.minClearanceM,
    maxUtilizationBound: profile.maximumUtilization,
    speedFixedPointResidual: finest.speedOptimalityResidual,
    adaptiveEdgeCount: 8192,
    lapTimeDelta,
    codeVersion: 2,
    pass,
  };
  const pathSamples = packedPath(representation, 4096);
  report(7, "Certification complete");
  return {
    representation,
    lapTime: profile.lapTime,
    lineLengthM: finest.lapLengthM,
    profileNodes: profile.values,
    edgeCount: 8192,
    pathSamples,
    certificate,
  };
}
