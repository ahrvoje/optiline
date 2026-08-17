/** Binary64 WASM certifier worker adapter. */
import type { CertifierCommand, CertifierEvent, CompiledTrackJson } from "@/model/contracts";
import { certifyCurvatureCandidate } from "@/optimizer/curvature-certificate";
import { curvatureRepresentationFromJson } from "@/optimizer/curvature-closure";
import { loadCertifier } from "@/workers/wasm-loader";

let api: Awaited<ReturnType<typeof loadCertifier>> | null = null;

function envelope(message: CertifierCommand) {
  return {
    runVersion: message.runVersion,
    trackFingerprint: message.trackFingerprint,
    settingsFingerprint: message.settingsFingerprint,
  };
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
      } else if (message.type === "certifyCandidate") {
        api.loadContext(JSON.stringify(message.compiledTrack), JSON.stringify(message.vehicle));
        let result = api.certifyCandidate(message.genotype, message.warmPreimage);

        // A warm PH reconstruction is an acceleration hint, not an objective.
        // Certify the cold reconstruction too and retain the faster valid one.
        if (message.warmPreimage !== undefined) {
          try {
            const cold = api.certifyCandidate(message.genotype);
            if (cold.certificate.pass &&
                (!result.certificate.pass || cold.lapTime < result.lapTime)) {
              result = cold;
            }
          } catch {
            // The warm reconstruction remains authoritative when cold projection fails.
          }
        }
        self.postMessage({
          ...envelope(message), type: "certified", candidateId: message.candidateId,
          lapTime: result.lapTime, genotype: message.genotype, preimage: result.preimage,
          profileNodes: result.nodes, edgeCount: result.edgeCount, certificate: result.certificate,
        } satisfies CertifierEvent, [result.preimage.buffer, result.nodes.buffer]);
      } else if (message.type === "certifyCurvature") {
        const representation = curvatureRepresentationFromJson(
          message.representations.curvature,
        );
        const result = certifyCurvatureCandidate(
          message.compiledTrack,
          message.vehicle,
          representation,
        );
        message.representations.curvature.closureResiduals = {
          ...result.representation.closureResiduals,
        };
        self.postMessage({
          ...envelope(message),
          type: "curvatureCertified",
          candidateId: message.candidateId,
          genotype: message.genotype,
          preimage: message.preimage,
          lapTime: result.lapTime,
          lineLengthM: result.lineLengthM,
          profileNodes: result.profileNodes,
          edgeCount: result.edgeCount,
          pathSamples: result.pathSamples,
          representations: message.representations,
          certificate: result.certificate,
        } satisfies CertifierEvent, [
          message.genotype.buffer,
          message.preimage.buffer,
          result.profileNodes.buffer,
          result.pathSamples.buffer,
        ]);
      } else if (message.type === "certifyImportedProfile") {
        api.loadContext(
          JSON.stringify(message.compiledTrack),
          JSON.stringify(message.profile.vehicleSettings),
        );
        api.validateProfile(JSON.stringify(message.profile));
        self.postMessage({
          ...envelope(message), type: "profileValidated", profile: message.profile,
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
      if (message.type === "certifyCandidate" || message.type === "certifyCurvature") {
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
