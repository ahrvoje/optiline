import {
  GRAVITY,
  type CompiledTrackJson,
  type V2RepresentationsJson,
  type VehicleSettings,
} from "@/model/contracts";
import {
  fitCurvatureRepresentation,
  projectCurvatureClosure,
  projectCurvaturePerturbation,
  reconstructCurvaturePath,
  type CurvatureRepresentation,
} from "@/optimizer/curvature-closure";
import { evaluateCurvatureCandidate } from "@/optimizer/curvature-evaluation";
import { fourierCoefficientCount } from "@/optimizer/fourier";
import type { HybridPeriodicBasis } from "@/optimizer/hybrid-basis";
import { compareFeasibleFirst } from "@/optimizer/island-es";
import {
  buildReferenceSpine,
  sampleRacingLine,
  type SafeCorridor,
} from "@/optimizer/racing-line";
import { centerlineSpec, evaluateLineFrame } from "@/renderer/ph-tessellate";

export const CURVATURE_FINALIZATION_STAGE_COUNT = 3;

export interface CurvatureFinalizationProgress {
  completed: number;
  total: typeof CURVATURE_FINALIZATION_STAGE_COUNT;
  label: string;
}

interface CurvaturePolishResult {
  representation: CurvatureRepresentation;
  score: ReturnType<typeof evaluateCurvatureCandidate>;
  testedCandidates: number;
  meshLapTimesS: [number, number, number] | null;
  meshLapTimeDeltaS: number | null;
}

export interface FinalizedDiscoveryCandidate {
  genotype: Float64Array;
  lapTime: number;
  representations: V2RepresentationsJson;
  representation: CurvatureRepresentation;
  testedCandidates: number;
}

function fitDiscoveryCandidate(
  track: CompiledTrackJson,
  vehicle: VehicleSettings,
  lateralBasis: HybridPeriodicBasis,
  lateralCoefficients: Float64Array<ArrayBufferLike>,
  corridor: SafeCorridor,
): CurvaturePolishResult {
  const source = sampleRacingLine(
    track, vehicle, lateralBasis, lateralCoefficients, 1024, corridor,
  );
  let representation: CurvatureRepresentation | null = null;
  let score: ReturnType<typeof evaluateCurvatureCandidate> | null = null;
  let testedCandidates = 0;
  const failures: string[] = [];
  for (const [fourierModes, residualControls] of [[24, 64], [16, 48]] as const) {
    try {
      const fitted = fitCurvatureRepresentation(source, fourierModes, residualControls);
      const evaluated = evaluateCurvatureCandidate(track, vehicle, fitted, 512);
      testedCandidates++;
      if (evaluated.feasible) {
        representation = fitted;
        score = evaluated;
        break;
      }
      failures.push(
        `${fourierModes}/${residualControls} fit infeasible ` +
        `(violation ${evaluated.violation.toExponential(2)}, ` +
        `clearance ${evaluated.minClearanceM.toFixed(4)} m, ` +
        `progress ${evaluated.minProgress.toFixed(4)})`,
      );
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (representation === null || score === null) {
    throw new Error(failures.join("; ") || "curvature conversion failed");
  }

  const fourierCount = fourierCoefficientCount(representation.basis.fourierModes);
  if (representation.basis.residualControlCount > 0) {
    const smoothed = representation.coefficients.slice();
    for (let i = 0; i < representation.basis.residualControlCount; i++) {
      const before = fourierCount +
        (i + representation.basis.residualControlCount - 1) %
          representation.basis.residualControlCount;
      const current = fourierCount + i;
      const after = fourierCount + (i + 1) % representation.basis.residualControlCount;
      smoothed[current] = 0.25 * representation.coefficients[before]! +
        0.5 * representation.coefficients[current]! +
        0.25 * representation.coefficients[after]!;
    }
    const projected = projectCurvaturePerturbation(
      representation,
      smoothed,
      representation.pathLengthM,
      { tolerance: 1e-10, sampleCount: 2048 },
    );
    if (projected !== null) {
      const evaluated = evaluateCurvatureCandidate(track, vehicle, projected, 512);
      testedCandidates++;
      const allowedTime = Math.max(1e-5 * score.lapTime, 1e-6);
      if (evaluated.feasible && evaluated.lapTime <= score.lapTime + allowedTime &&
          evaluated.regularizer < score.regularizer) {
        representation = projected;
        score = evaluated;
      }
    }
  }
  return {
    representation,
    score,
    testedCandidates,
    meshLapTimesS: null,
    meshLapTimeDeltaS: null,
  };
}

function diffuseCurvature(
  source: CurvatureRepresentation,
  strength: number,
): Float64Array {
  const coefficients = source.coefficients.slice();
  const fourierCount = fourierCoefficientCount(source.basis.fourierModes);
  for (let index = 1; index < fourierCount; index++) {
    const harmonic = Math.ceil(index / 2);
    const normalized = harmonic / Math.max(1, source.basis.fourierModes);
    coefficients[index] = coefficients[index]! * Math.exp(-strength * normalized ** 4);
  }
  const residualCount = source.basis.residualControlCount;
  if (residualCount > 0) {
    const original = source.coefficients.subarray(fourierCount);
    for (let i = 0; i < residualCount; i++) {
      const average = 0.25 * original[(i + residualCount - 1) % residualCount]! +
        0.5 * original[i]! +
        0.25 * original[(i + 1) % residualCount]!;
      coefficients[fourierCount + i] =
        (1 - strength) * original[i]! + strength * average;
    }
  }
  return coefficients;
}

/** Apply the exact bounded smoothing and mesh treatment used for every live publication. */
function refineCurvatureCandidate(
  track: CompiledTrackJson,
  vehicle: VehicleSettings,
  input: CurvaturePolishResult,
): CurvaturePolishResult {
  let representation = input.representation;
  let score = input.score;
  let testedCandidates = input.testedCandidates;
  const timeLimit = score.lapTime * (1 + 1e-4);
  let smoothRepresentation = representation;
  let smoothScore = score;
  for (const strength of [0.02, 0.04, 0.08, 0.16, 0.32, 0.5, 0.75, 1]) {
    const projected = projectCurvaturePerturbation(
      representation,
      diffuseCurvature(representation, strength),
      representation.pathLengthM,
      { tolerance: 1e-10, sampleCount: 2048 },
    );
    if (projected === null) continue;
    const evaluated = evaluateCurvatureCandidate(track, vehicle, projected, 512);
    testedCandidates++;
    if (evaluated.feasible && evaluated.lapTime <= timeLimit &&
        evaluated.regularizer < smoothScore.regularizer) {
      smoothRepresentation = projected;
      smoothScore = evaluated;
    }
  }
  representation = smoothRepresentation;
  score = smoothScore;

  const closureCertified = projectCurvatureClosure(representation, {
    tolerance: 1e-11,
    sampleCount: 4096,
    maximumIterations: 24,
    selectCorrectionModes: false,
  });
  if (closureCertified !== null) representation = closureCertified;
  const coarse = evaluateCurvatureCandidate(track, vehicle, representation, 1024);
  const refined = evaluateCurvatureCandidate(track, vehicle, representation, 2048);
  const finest = evaluateCurvatureCandidate(track, vehicle, representation, 4096);
  testedCandidates += 3;
  const allFeasible = coarse.feasible && refined.feasible && finest.feasible;
  return {
    representation,
    score: allFeasible ? finest : score,
    testedCandidates,
    meshLapTimesS: allFeasible ? [coarse.lapTime, refined.lapTime, finest.lapTime] : null,
    meshLapTimeDeltaS: allFeasible ? Math.abs(finest.lapTime - refined.lapTime) : null,
  };
}

function curvatureGenotype(
  track: CompiledTrackJson,
  representation: CurvatureRepresentation,
): Float64Array {
  const path = reconstructCurvaturePath(representation, 2048);
  const center = centerlineSpec(track);
  const genotype = new Float64Array(64);
  for (let gate = 0; gate < 64; gate++) {
    const reference = evaluateLineFrame(center, gate);
    let nearest = path[0]!;
    let nearestSquared = Infinity;
    for (const sample of path) {
      const squared = (sample.x - reference.x) ** 2 + (sample.y - reference.y) ** 2;
      if (squared < nearestSquared) {
        nearestSquared = squared;
        nearest = sample;
      }
    }
    genotype[gate] = (nearest.x - reference.x) * -reference.ty +
      (nearest.y - reference.y) * reference.tx;
  }
  return genotype;
}

function v2Representations(
  track: CompiledTrackJson,
  vehicle: VehicleSettings,
  corridor: SafeCorridor,
  lateralBasis: HybridPeriodicBasis,
  lateralCoefficients: Float64Array<ArrayBufferLike>,
  curvature: CurvaturePolishResult,
): V2RepresentationsJson {
  const lateralFourierCount = fourierCoefficientCount(lateralBasis.fourierModes);
  const curvatureFourierCount = fourierCoefficientCount(
    curvature.representation.basis.fourierModes,
  );
  const score = curvature.score;
  let minimumSpeedMps = Infinity;
  let maximumSpeedMps = 0;
  let maximumAccelerationMps2 = 0;
  let maximumBrakingMps2 = 0;
  let maximumLateralAccelerationMps2 = 0;
  let maximumSuperellipseUtilization = 0;
  let maximumDragAccelerationMps2 = 0;
  let maximumDownforceMultiplier = 1;
  if (score.speedSquared !== null) {
    const distance = score.lapLengthM / score.speedSquared.length;
    const drag = vehicle.airDensity * vehicle.dragAreaM2 / (2 * vehicle.massKg);
    const downforce = vehicle.airDensity * vehicle.downforceAreaM2 /
      (2 * vehicle.massKg * GRAVITY);
    for (let i = 0; i < score.speedSquared.length; i++) {
      const next = (i + 1) % score.speedSquared.length;
      const q = score.speedSquared[i]!;
      const speed = Math.sqrt(q);
      const acceleration = (score.speedSquared[next]! - q) / (2 * distance);
      const load = 1 + downforce * q;
      const dragAcceleration = drag * q;
      const lateralAcceleration = Math.abs(q * score.frames[i]!.kappa);
      const tireAcceleration = acceleration >= 0
        ? acceleration + dragAcceleration
        : Math.max(0, -acceleration - dragAcceleration);
      const longitudinalCapacity =
        (acceleration >= 0 ? vehicle.axPlus0 : vehicle.axMinus0) * load;
      const utilization = (tireAcceleration / longitudinalCapacity) ** vehicle.ellipseP +
        (lateralAcceleration / (vehicle.ay0 * load)) ** vehicle.ellipseP;
      minimumSpeedMps = Math.min(minimumSpeedMps, speed);
      maximumSpeedMps = Math.max(maximumSpeedMps, speed);
      maximumAccelerationMps2 = Math.max(maximumAccelerationMps2, acceleration);
      maximumBrakingMps2 = Math.max(maximumBrakingMps2, -acceleration);
      maximumLateralAccelerationMps2 = Math.max(
        maximumLateralAccelerationMps2,
        lateralAcceleration,
      );
      maximumSuperellipseUtilization = Math.max(maximumSuperellipseUtilization, utilization);
      maximumDragAccelerationMps2 = Math.max(maximumDragAccelerationMps2, dragAcceleration);
      maximumDownforceMultiplier = Math.max(maximumDownforceMultiplier, load);
    }
  }
  if (!Number.isFinite(minimumSpeedMps)) minimumSpeedMps = 0;
  return {
    discovery: {
      schemaVersion: 2,
      kernelChartId: `${track.sourceSha256}:fourier-kernel`,
      kernelModeCount: buildReferenceSpine(track).modeCount,
      lateralFourierModes: lateralBasis.fourierModes,
      lateralFourierCoefficients: Array.from(
        lateralCoefficients.slice(0, lateralFourierCount),
      ),
      residualControlCount: lateralBasis.residualControlCount,
      residualCoefficients: Array.from(lateralCoefficients.slice(lateralFourierCount)),
      corridor: {
        lowerM: corridor.lower,
        upperM: corridor.upper,
        betaSafeRad: corridor.betaSafeRad,
      },
    },
    curvature: {
      schemaVersion: 2,
      pathLengthM: curvature.representation.pathLengthM,
      winding: curvature.representation.winding,
      fourierModes: curvature.representation.basis.fourierModes,
      fourierCoefficients: Array.from(
        curvature.representation.coefficients.slice(0, curvatureFourierCount),
      ),
      residualControlCount: curvature.representation.basis.residualControlCount,
      residualCoefficients: Array.from(
        curvature.representation.coefficients.slice(curvatureFourierCount),
      ),
      closureModes: curvature.representation.correctionModes.map(mode => ({ ...mode })),
      closureCoefficients: Array.from(curvature.representation.correctionCoefficients),
      rigidTransform: {
        rotationRad: curvature.representation.rotationRad,
        translationM: [...curvature.representation.translation],
      },
      seamPhase: curvature.representation.seamPhase,
      closureResiduals: { ...curvature.representation.closureResiduals },
    },
    optimality: {
      closure: { ...curvature.representation.closureResiduals },
      geometry: {
        lengthM: score.lapLengthM,
        maxAbsCurvature: score.maxAbsCurvature,
        maxAbsCurvatureL: score.maxAbsCurvatureL,
        maxAbsCurvatureLL: score.maxAbsCurvatureLL,
        minPathMetric: score.minPathMetric,
        minProgress: score.minProgress,
      },
      rectangle: {
        minimumClearanceM: score.minClearanceM,
        continuouslyBounded: score.minClearanceM >= 0,
      },
      dynamics: {
        minimumSpeedMps,
        maximumSpeedMps,
        maximumAccelerationMps2,
        maximumBrakingMps2,
        maximumLateralAccelerationMps2,
        maximumSuperellipseUtilization,
        maximumDragAccelerationMps2,
        maximumDownforceMultiplier,
        speedOptimalityResidual: score.speedOptimalityResidual,
        maxLateralJerk: score.maxLateralJerk,
        rmsLateralJerk: score.rmsLateralJerk,
      },
      convergence: {
        meshLapTimesS: curvature.meshLapTimesS,
        meshLapTimeDeltaS: curvature.meshLapTimeDeltaS,
        bestTestedDescentS: null,
        fourierExtensionImprovementS: null,
        splineRefinementImprovementS: null,
        curvatureRefinementImprovementS: null,
      },
    },
  };
}

/**
 * Convert, smooth, close, and mesh-check a discovery snapshot. This is the
 * only path that can create a publishable optimization trajectory.
 */
export function finalizeDiscoveryCandidate(
  track: CompiledTrackJson,
  vehicle: VehicleSettings,
  lateralBasis: HybridPeriodicBasis,
  sources: readonly Float64Array<ArrayBufferLike>[],
  corridor: SafeCorridor,
  onProgress?: (progress: CurvatureFinalizationProgress) => void,
): FinalizedDiscoveryCandidate {
  const report = (completed: number, label: string): void => onProgress?.({
    completed,
    total: CURVATURE_FINALIZATION_STAGE_COUNT,
    label,
  });
  if (sources.length === 0) throw new Error("no discovery candidate was supplied");
  report(0, "Preparing the best discovered candidate");
  let chosen: CurvaturePolishResult | null = null;
  let chosenSource: Float64Array<ArrayBufferLike> | null = null;
  let testedCandidates = 0;
  const failures: string[] = [];
  for (const source of sources) {
    try {
      const converted = fitDiscoveryCandidate(
        track, vehicle, lateralBasis, source, corridor,
      );
      testedCandidates += converted.testedCandidates;
      if (chosen === null || compareFeasibleFirst(converted.score, chosen.score, 0) < 0) {
        chosen = converted;
        chosenSource = source;
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (chosen === null || chosenSource === null) {
    throw new Error(failures.join("; ") || "no curvature candidate passed conversion");
  }
  report(1, "Smoothing the canonical curvature candidate");
  const priorTested = chosen.testedCandidates;
  chosen = refineCurvatureCandidate(track, vehicle, chosen);
  testedCandidates += chosen.testedCandidates - priorTested;
  report(2, "Packaging the canonical candidate");
  const representations = v2Representations(
    track, vehicle, corridor, lateralBasis, chosenSource, chosen,
  );
  const genotype = curvatureGenotype(track, chosen.representation);
  report(3, "Canonical finalization complete");
  return {
    genotype,
    lapTime: chosen.score.lapTime,
    representations,
    representation: chosen.representation,
    testedCandidates,
  };
}
