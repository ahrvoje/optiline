/** Independent canonical finalization and certification for live optimization results. */
import type {
  CompiledTrackJson,
  PresentationCommand,
  PresentationEvent,
  VehicleSettings,
} from "@/model/contracts";
import {
  certifyCurvatureCandidate,
  CURVATURE_CERTIFICATION_STAGE_COUNT,
} from "@/optimizer/curvature-certificate";
import {
  CURVATURE_FINALIZATION_STAGE_COUNT,
  finalizeDiscoveryCandidate,
} from "@/optimizer/curvature-finalization";
import {
  curvatureRepresentationToJson,
} from "@/optimizer/curvature-closure";
import { buildHybridPeriodicBasis } from "@/optimizer/hybrid-basis";

function envelope(message: PresentationCommand) {
  return {
    runVersion: message.runVersion,
    trackFingerprint: message.trackFingerprint,
    settingsFingerprint: message.settingsFingerprint,
  };
}

let track: CompiledTrackJson | null = null;
let vehicle: VehicleSettings | null = null;

self.addEventListener("message", (event: MessageEvent<PresentationCommand>) => {
  const message = event.data;
  try {
    if (message.type === "init") {
      track = message.compiledTrack;
      vehicle = message.vehicle;
      return;
    }
    if (track === null || vehicle === null) {
      throw new Error("presentation worker is not initialized");
    }
    const finalizationStages = CURVATURE_FINALIZATION_STAGE_COUNT;
    const certificationStages = CURVATURE_CERTIFICATION_STAGE_COUNT;
    const total = finalizationStages + certificationStages;
    const report = (completed: number, label: string): void => self.postMessage({
      ...envelope(message),
      type: "presentationProgress",
      sequence: message.sequence,
      completed,
      total,
      label,
    } satisfies PresentationEvent);
    const basis = buildHybridPeriodicBasis(
      message.basis.fourierModes,
      message.basis.residualControlCount,
    );
    const finalized = finalizeDiscoveryCandidate(
      track,
      vehicle,
      basis,
      message.sources,
      message.corridor,
      progress => report(progress.completed, progress.label),
    );
    const certified = certifyCurvatureCandidate(
      track,
      vehicle,
      finalized.representation,
      progress => {
        if (progress.completed > 0) {
          report(finalizationStages + progress.completed, progress.label);
        }
      },
    );
    finalized.representations.curvature = curvatureRepresentationToJson(
      certified.representation,
    );
    finalized.representations.optimality.closure = {
      ...certified.representation.closureResiduals,
    };
    self.postMessage({
      ...envelope(message),
      type: "liveProductCertified",
      sequence: message.sequence,
      elapsedMs: message.elapsedMs,
      optimizerLapTime: message.optimizerLapTime,
      candidateId: message.candidateId,
      genotype: finalized.genotype,
      lapTime: certified.lapTime,
      lineLengthM: certified.lineLengthM,
      profileNodes: certified.profileNodes,
      edgeCount: certified.edgeCount,
      pathSamples: certified.pathSamples,
      representations: finalized.representations,
      certificate: certified.certificate,
      testedCandidates: finalized.testedCandidates,
    } satisfies PresentationEvent, [
      finalized.genotype.buffer,
      certified.profileNodes.buffer,
      certified.pathSamples.buffer,
    ]);
  } catch (error) {
    if (message.type === "init") return;
    self.postMessage({
      ...envelope(message),
      type: "liveProductRejected",
      sequence: message.sequence,
      message: error instanceof Error ? error.message : String(error),
    } satisfies PresentationEvent);
  }
});
