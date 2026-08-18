/** Binary64 WASM certifier worker adapter. */
import type {
  CertifierCommand,
  CertifierEvent,
  CompiledTrackJson,
  ProfileNodeJson,
} from "@/model/contracts";
import { certifyCurvatureCandidate } from "@/optimizer/curvature-certificate";
import {
  curvatureRepresentationFromJson,
  curvatureRepresentationToJson,
} from "@/optimizer/curvature-closure";
import { loadCertifier } from "@/workers/wasm-loader";

let api: Awaited<ReturnType<typeof loadCertifier>> | null = null;

function envelope(message: CertifierCommand) {
  return {
    runVersion: message.runVersion,
    trackFingerprint: message.trackFingerprint,
    settingsFingerprint: message.settingsFingerprint,
  };
}

function unpackProfile(values: Float64Array, edgeCount: number): ProfileNodeJson[] {
  return Array.from({ length: edgeCount }, (_, index) => {
    const offset = 7 * index;
    return {
      parameter: values[offset]!,
      distance: values[offset + 1]!,
      time: values[offset + 2]!,
      q: values[offset + 3]!,
      acceleration: values[offset + 4]!,
      curvature: values[offset + 5]!,
      stability: values[offset + 6]!,
    };
  });
}

self.addEventListener("message", (event: MessageEvent<CertifierCommand>) => {
  const message = event.data;
  void (async () => {
    try {
      if (message.type === "init") {
        api = await loadCertifier();
        api.initWorkspace();
        self.postMessage({
          ...envelope(message), type: "ready", wasmVersion: api.version(),
        } satisfies CertifierEvent);
      } else if (message.type === "shutdown") {
        self.close();
      } else if (!api) {
        throw new Error("Certifier is not initialized");
      } else if (message.type === "compileTrack") {
        const asset = JSON.parse(api.compileTrack(JSON.stringify(message.source))) as CompiledTrackJson;
        self.postMessage({ ...envelope(message), type: "trackCompiled", asset } satisfies CertifierEvent);
      } else if (message.type === "validateImportedTrack") {
        api.validateTrack(JSON.stringify(message.asset));
        self.postMessage({
          ...envelope(message), type: "trackCompiled", asset: message.asset,
        } satisfies CertifierEvent);
      } else if (message.type === "certifyCenterline") {
        api.loadContext(JSON.stringify(message.compiledTrack), JSON.stringify(message.vehicle));
        const result = api.certifyCandidate(new Float64Array(64));
        self.postMessage({
          ...envelope(message), type: "centerlineCertified", candidateId: message.candidateId,
          lapTime: result.lapTime,
          profileNodes: result.nodes, edgeCount: result.edgeCount, certificate: result.certificate,
        } satisfies CertifierEvent, [result.nodes.buffer]);
      } else if (message.type === "certifyCurvature") {
        const representation = curvatureRepresentationFromJson(
          message.representations.curvature,
        );
        const result = certifyCurvatureCandidate(
          message.compiledTrack,
          message.vehicle,
          representation,
        );
        message.representations.curvature = curvatureRepresentationToJson(
          result.representation,
        );
        message.representations.optimality.closure = {
          ...result.representation.closureResiduals,
        };
        self.postMessage({
          ...envelope(message),
          type: "curvatureCertified",
          candidateId: message.candidateId,
          genotype: message.genotype,
          lapTime: result.lapTime,
          lineLengthM: result.lineLengthM,
          profileNodes: result.profileNodes,
          edgeCount: result.edgeCount,
          pathSamples: result.pathSamples,
          representations: message.representations,
          certificate: result.certificate,
        } satisfies CertifierEvent, [
          message.genotype.buffer,
          result.profileNodes.buffer,
          result.pathSamples.buffer,
        ]);
      } else if (message.type === "certifyImportedProfile") {
        const representation = curvatureRepresentationFromJson(
          message.profile.v2Representations.curvature,
        );
        const result = certifyCurvatureCandidate(
          message.compiledTrack,
          message.profile.vehicleSettings,
          representation,
        );
        if (!result.certificate.pass) throw new Error("imported curvature profile is infeasible");
        message.profile.v2Representations.curvature = curvatureRepresentationToJson(
          result.representation,
        );
        message.profile.v2Representations.optimality.closure = {
          ...result.representation.closureResiduals,
        };
        self.postMessage({
          ...envelope(message),
          type: "profileValidated",
          profile: {
            ...message.profile,
            lineLengthM: result.lineLengthM,
            lapTimeS: result.lapTime,
            profileNodes: unpackProfile(result.profileNodes, result.edgeCount),
            certificate: {
              ...result.certificate,
              hash: message.trackFingerprint,
            },
          },
        } satisfies CertifierEvent);
      }
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error ?? "");
      const failure = {
        code: "INVALID_INPUT" as const,
        message: rawMessage.trim() || "certifier failed without a diagnostic",
        runVersion: message.runVersion,
        detail: {},
      };
      if (message.type === "certifyCenterline" || message.type === "certifyCurvature") {
        self.postMessage({
          ...envelope(message), type: "certificationFailed",
          candidateId: message.candidateId, error: failure,
        } satisfies CertifierEvent);
      } else {
        self.postMessage({ ...envelope(message), type: "error", error: failure } satisfies CertifierEvent);
      }
    }
  })();
});
