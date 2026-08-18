import type { CompiledTrackJson, VehicleSettings } from "@/model/contracts";
import {
  evaluateCurvatureRepresentation,
  reconstructCurvaturePath,
  type CurvatureRepresentation,
  type ReconstructedCurvatureSample,
} from "@/optimizer/curvature-closure";
import { evaluateFourierKernel } from "@/optimizer/fourier-kernel";
import {
  aeroTerms,
  compensatedSum,
  implicitReach,
  lateralSpeedCapSquared,
  netAcceleration,
  netBraking,
  solveSpeedProfile,
  type CandidateEvaluation,
} from "@/optimizer/minimum-lap";
import {
  buildReferenceSpine,
  type RacingLineFrame,
} from "@/optimizer/racing-line";

function signedCellUnionDistance(
  track: CompiledTrackJson,
  x: number,
  y: number,
): number {
  let unionDistance = -Infinity;
  for (const cell of track.cells) {
    let cellDistance = Infinity;
    for (const halfSpace of cell.halfSpaces) {
      cellDistance = Math.min(
        cellDistance,
        halfSpace.b - halfSpace.nx * x - halfSpace.ny * y,
      );
    }
    unionDistance = Math.max(unionDistance, cellDistance);
  }
  return unionDistance;
}

function continuousRectangleClearance(
  track: CompiledTrackJson,
  vehicle: VehicleSettings,
  start: ReconstructedCurvatureSample,
  midpoint: ReconstructedCurvatureSample,
  end: ReconstructedCurvatureSample,
  distance: number,
  curvatureBound: number,
  curvatureDerivativeBound: number,
): number {
  const halfLength = vehicle.lengthM / 2 + vehicle.safetyMarginM;
  const halfWidth = vehicle.widthM / 2 + vehicle.safetyMarginM;
  const cornerRadius = Math.hypot(halfLength, halfWidth);
  const secondDerivativeBound = curvatureBound + cornerRadius *
    (curvatureBound * curvatureBound + curvatureDerivativeBound);
  // Three samples split the interval in half. Linear interpolation of a
  // scalar C2 function has error <= M*(ds/2)^2/8 = M*ds^2/32.
  const interpolationLoss = secondDerivativeBound * distance * distance / 32;
  let rectangleBound = Infinity;
  for (const longitudinal of [-halfLength, halfLength]) {
    for (const lateral of [-halfWidth, halfWidth]) {
      let unionBound = -Infinity;
      for (const cell of track.cells) {
        let cellBound = Infinity;
        for (const halfSpace of cell.halfSpaces) {
          for (const sample of [start, midpoint, end]) {
            const x = sample.x + longitudinal * sample.tx - lateral * sample.ty;
            const y = sample.y + longitudinal * sample.ty + lateral * sample.tx;
            cellBound = Math.min(
              cellBound,
              halfSpace.b - halfSpace.nx * x - halfSpace.ny * y,
            );
          }
        }
        unionBound = Math.max(unionBound, cellBound - interpolationLoss);
      }
      rectangleBound = Math.min(rectangleBound, unionBound);
    }
  }
  return rectangleBound;
}

function nearestKernelProgress(
  kernels: Array<{ x: number; y: number; tx: number; ty: number }>,
  sample: ReconstructedCurvatureSample,
): { progress: number; relativeYaw: number } {
  const center = Math.round(sample.tau * kernels.length) % kernels.length;
  const radius = Math.min(64, Math.floor(kernels.length / 2));
  let best = kernels[center]!;
  let bestSquared = Infinity;
  for (let offset = -radius; offset <= radius; offset++) {
    const kernel = kernels[(center + offset + kernels.length) % kernels.length]!;
    const squared = (sample.x - kernel.x) ** 2 + (sample.y - kernel.y) ** 2;
    if (squared < bestSquared) {
      bestSquared = squared;
      best = kernel;
    }
  }
  const progress = sample.tx * best.tx + sample.ty * best.ty;
  const cross = best.tx * sample.ty - best.ty * sample.tx;
  return { progress, relativeYaw: Math.atan2(cross, progress) };
}

function pathFrame(
  track: CompiledTrackJson,
  vehicle: VehicleSettings,
  kernels: Array<{ x: number; y: number; tx: number; ty: number }>,
  sample: ReconstructedCurvatureSample,
  pathLengthM: number,
): RacingLineFrame {
  const relation = nearestKernelProgress(kernels, sample);
  const halfLength = vehicle.lengthM / 2 + vehicle.safetyMarginM;
  const halfWidth = vehicle.widthM / 2 + vehicle.safetyMarginM;
  let clearanceM = Infinity;
  for (const longitudinal of [-halfLength, halfLength]) {
    for (const lateral of [-halfWidth, halfWidth]) {
      const x = sample.x + longitudinal * sample.tx - lateral * sample.ty;
      const y = sample.y + longitudinal * sample.ty + lateral * sample.tx;
      clearanceM = Math.min(clearanceM, signedCellUnionDistance(track, x, y));
    }
  }
  return {
    u: sample.tau,
    x: sample.x,
    y: sample.y,
    tx: sample.tx,
    ty: sample.ty,
    q: pathLengthM,
    d: 0,
    kappa: sample.kappa,
    kappaL: sample.kappaL,
    kappaLL: sample.kappaLL,
    progress: relation.progress,
    relativeYaw: relation.relativeYaw,
    clearanceM,
  };
}

/** Full FP64 nodal evaluation of a closure-projected intrinsic path. */
export function evaluateCurvatureCandidate(
  track: CompiledTrackJson,
  vehicle: VehicleSettings,
  representation: CurvatureRepresentation,
  stationCount = 1024,
): CandidateEvaluation {
  if (!Number.isInteger(stationCount) || stationCount < 128) {
    throw new RangeError("curvature evaluation requires at least 128 stations");
  }
  const dense = reconstructCurvaturePath(representation, 2 * stationCount);
  const spine = buildReferenceSpine(track);
  const kernelCount = Math.max(1024, stationCount);
  const kernels = Array.from({ length: kernelCount }, (_, i) => {
    const value = evaluateFourierKernel(spine, i / kernelCount, 1);
    const metric = Math.hypot(value[1]![0], value[1]![1]);
    return {
      x: value[0]![0],
      y: value[0]![1],
      tx: value[1]![0] / metric,
      ty: value[1]![1] / metric,
    };
  });
  const frames: RacingLineFrame[] = [];
  const midpoints: RacingLineFrame[] = [];
  const distances = new Float64Array(stationCount);
  const intervalCurvatureBounds = new Float64Array(stationCount);
  let violation = Math.max(0, representation.closureResiduals.maxAbs - 1e-10) / 1e-10;
  let minClearanceM = Infinity;
  let minPathMetric = representation.pathLengthM;
  let minProgress = Infinity;
  let maxAbsCurvature = 0;
  let maxAbsCurvatureL = 0;
  let maxAbsCurvatureLL = 0;
  for (let i = 0; i < stationCount; i++) {
    const frame = pathFrame(track, vehicle, kernels, dense[2 * i]!, representation.pathLengthM);
    const midpoint = pathFrame(
      track, vehicle, kernels, dense[2 * i + 1]!, representation.pathLengthM,
    );
    frames.push(frame);
    midpoints.push(midpoint);
    distances[i] = representation.pathLengthM / stationCount;
    const inverseLength = 1 / representation.pathLengthM;
    let sampledCurvature = Math.max(Math.abs(frame.kappa), Math.abs(midpoint.kappa));
    let sampledCurvatureL = Math.max(Math.abs(frame.kappaL), Math.abs(midpoint.kappaL));
    let sampledCurvatureLL = Math.max(Math.abs(frame.kappaLL), Math.abs(midpoint.kappaLL));
    const curvatureSubsamples = 16;
    for (let subsample = 0; subsample < curvatureSubsamples; subsample++) {
      const field = evaluateCurvatureRepresentation(
        representation,
        (i + (subsample + 0.5) / curvatureSubsamples) / stationCount,
        2,
      );
      sampledCurvature = Math.max(sampledCurvature, Math.abs(field[0]! * inverseLength));
      sampledCurvatureL = Math.max(
        sampledCurvatureL,
        Math.abs(field[1]! * inverseLength ** 2),
      );
      sampledCurvatureLL = Math.max(
        sampledCurvatureLL,
        Math.abs(field[2]! * inverseLength ** 3),
      );
    }
    const sampleRadius = distances[i]! / (2 * curvatureSubsamples);
    const curvatureBound = sampledCurvature + sampleRadius * sampledCurvatureL +
      0.5 * sampleRadius * sampleRadius * sampledCurvatureLL;
    intervalCurvatureBounds[i] = curvatureBound;
    const curvatureDerivativeBound = sampledCurvatureL +
      sampleRadius * sampledCurvatureLL;
    const continuousMargin = continuousRectangleClearance(
      track,
      vehicle,
      dense[2 * i]!,
      dense[2 * i + 1]!,
      dense[(2 * i + 2) % dense.length]!,
      distances[i]!,
      curvatureBound,
      curvatureDerivativeBound,
    );
    minClearanceM = Math.min(minClearanceM, frame.clearanceM, continuousMargin);
    minProgress = Math.min(minProgress, frame.progress, midpoint.progress);
    maxAbsCurvature = Math.max(maxAbsCurvature, curvatureBound);
    maxAbsCurvatureL = Math.max(maxAbsCurvatureL, sampledCurvatureL);
    maxAbsCurvatureLL = Math.max(maxAbsCurvatureLL, sampledCurvatureLL);
  }
  violation = Math.max(
    violation,
    Math.max(0, -minClearanceM) / Math.max(1, vehicle.widthM),
    Math.max(0, 0.1 - minProgress) / 0.1,
  );
  if (vehicle.kappaMax !== null) {
    violation = Math.max(
      violation,
      Math.max(0, maxAbsCurvature - vehicle.kappaMax) / vehicle.kappaMax,
    );
  }
  const speedMidpoints = midpoints.map((frame, i): RacingLineFrame => ({
    ...frame,
    kappa: (frame.kappa < 0 ? -1 : 1) * intervalCurvatureBounds[i]!,
  }));
  const speedFrames = frames.map((frame, i): RacingLineFrame => ({
    ...frame,
    kappa: (frame.kappa < 0 ? -1 : 1) * Math.max(
      intervalCurvatureBounds[(i + stationCount - 1) % stationCount]!,
      intervalCurvatureBounds[i]!,
    ),
  }));
  const aero = aeroTerms(vehicle);
  const proxyTerms = new Float64Array(stationCount);
  let capDrop = 0;
  for (let i = 0; i < stationCount; i++) {
    const cap = lateralSpeedCapSquared(vehicle, aero, speedMidpoints[i]!.kappa);
    proxyTerms[i] = distances[i]! / Math.sqrt(Math.max(cap, 1e-12));
    const nextCap = lateralSpeedCapSquared(
      vehicle,
      aero,
      speedMidpoints[(i + 1) % stationCount]!.kappa,
    );
    capDrop += Math.max(0, Math.sqrt(cap) - Math.sqrt(nextCap));
  }
  const proxyTime = compensatedSum(proxyTerms) + 1e-4 * capDrop;
  const effectiveLength = vehicle.lengthM + 2 * vehicle.safetyMarginM;
  const roughness = new Float64Array(stationCount);
  for (let i = 0; i < stationCount; i++) {
    roughness[i] = distances[i]! * (
      (effectiveLength ** 2 * midpoints[i]!.kappaL) ** 2 +
      0.1 * (effectiveLength ** 3 * midpoints[i]!.kappaLL) ** 2
    );
  }
  const regularizer = compensatedSum(roughness) / representation.pathLengthM;
  if (violation > 0) {
    return {
      feasible: false,
      violation,
      lapTime: proxyTime,
      proxyTime,
      regularizer,
      lapLengthM: representation.pathLengthM,
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
      distances,
      frames,
    };
  }
  const speedSquared = solveSpeedProfile(vehicle, speedFrames, speedMidpoints, distances);
  if (speedSquared === null) violation = Math.max(violation, 1);
  const timeTerms = new Float64Array(stationCount);
  let maxLateralJerk = 0;
  let jerkSquaredIntegral = 0;
  let elapsed = 0;
  let speedOptimalityResidual = 0;
  if (speedSquared !== null) {
    for (let i = 0; i < stationCount; i++) {
      const next = (i + 1) % stationCount;
      const previous = (i + stationCount - 1) % stationCount;
      const speed = Math.sqrt(speedSquared[i]!);
      const nextSpeed = Math.sqrt(speedSquared[next]!);
      timeTerms[i] = 2 * distances[i]! / Math.max(speed + nextSpeed, 1e-12);
      const acceleration = (speedSquared[next]! - speedSquared[i]!) /
        (2 * distances[i]!);
      const jerk = 2 * speed * acceleration * frames[i]!.kappa +
        speed ** 3 * frames[i]!.kappaL;
      maxLateralJerk = Math.max(maxLateralJerk, Math.abs(jerk));
      jerkSquaredIntegral += jerk * jerk * timeTerms[i]!;
      elapsed += timeTerms[i]!;
      const cap = lateralSpeedCapSquared(vehicle, aero, speedFrames[i]!.kappa);
      const forward = implicitReach(
        speedSquared[previous]!, cap, distances[previous]!, speedMidpoints[previous]!.kappa,
        (q, curvature) => netAcceleration(vehicle, aero, q, curvature),
      );
      const braking = implicitReach(
        speedSquared[next]!, cap, distances[i]!, speedMidpoints[i]!.kappa,
        (q, curvature) => netBraking(vehicle, aero, q, curvature),
      );
      speedOptimalityResidual = Math.max(
        speedOptimalityResidual,
        Math.max(0, Math.min(
          cap - speedSquared[i]!,
          forward - speedSquared[i]!,
          braking - speedSquared[i]!,
        )) / (1 + speedSquared[i]!),
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
    lapLengthM: representation.pathLengthM,
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
    distances,
    frames,
  };
}
