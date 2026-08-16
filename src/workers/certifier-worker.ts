/** Binary64 WASM certifier worker adapter. */
import type { CertifierCommand, CertifierEvent, CompiledTrackJson } from "@/model/contracts";
import {
  chordStraightenedGenotype,
  curvatureHotspotControls,
  smoothPreimageWindow,
} from "@/optimizer/ph-search";
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
        const result = api.certifyCandidate(message.genotype, message.warmPreimage);
        self.postMessage({
          ...envelope(message), type: "certified", candidateId: message.candidateId,
          lapTime: result.lapTime, genotype: message.genotype, preimage: result.preimage,
          profileNodes: result.nodes, edgeCount: result.edgeCount, certificate: result.certificate,
        } satisfies CertifierEvent, [result.preimage.buffer, result.nodes.buffer]);
      } else if (message.type === "polishCandidate") {
        api.loadContext(JSON.stringify(message.compiledTrack), JSON.stringify(message.vehicle));
        const certifierApi = api;
        const certifyBestReconstruction = (
          genotype: Float64Array,
          warmPreimage?: Float64Array,
        ) => {
          const warm = certifierApi.certifyCandidate(genotype, warmPreimage);
          if (warmPreimage === undefined) return warm;
          try {
            const cold = certifierApi.certifyCandidate(genotype);
            return cold.certificate.pass && cold.lapTime < warm.lapTime ? cold : warm;
          } catch {
            return warm;
          }
        };
        const scoreBestReconstruction = (
          genotype: Float64Array,
          warmPreimage: Float64Array,
        ) => {
          const warm = certifierApi.scoreCandidateDense(genotype, warmPreimage);
          try {
            const cold = certifierApi.scoreCandidateDense(genotype);
            return cold.lapTime < warm.lapTime ? cold : warm;
          } catch {
            return warm;
          }
        };
        let bestGenotype = new Float64Array(message.genotype);
        let certifiedGenotype = bestGenotype.slice();
        let certified = certifyBestReconstruction(bestGenotype, message.warmPreimage);
        let certifiedWarm = certified.preimage;
        let bestWarm = certifiedWarm;
        const initialScore = certifierApi.scoreCandidate(bestGenotype, bestWarm);
        let lowResolutionLap = initialScore.lapTime;
        bestWarm = initialScore.preimage;

        // Broad periodic bumps let a complete corner sector move before the
        // single-gate finish. Each accepted move starts from the prior PH
        // preimage, which retains its 128-dimensional manifold state.
        const moves = [
          { steps: [8], halfWidth: 8 },
          { steps: [6, 3, 1.5], halfWidth: 4 },
          { steps: [2, 1], halfWidth: 2 },
          { steps: [0.5, 0.25], halfWidth: 1 },
        ];
        for (const move of moves) for (const step of move.steps) {
          for (let gate = 0; gate < 64; gate++) {
            let nextLap = lowResolutionLap;
            let nextGenotype = bestGenotype;
            let nextWarm = bestWarm;
            for (const sign of [-1, 1]) {
              const proposal = bestGenotype.slice();
              for (let offset = -move.halfWidth; offset <= move.halfWidth; offset++) {
                const index = (gate + offset + 64) % 64;
                const weight = move.halfWidth === 0
                  ? 1
                  : 0.5 * (1 + Math.cos(Math.PI * offset / (move.halfWidth + 1)));
                proposal[index] = Math.max(
                  -message.compiledTrack.source.rightWidthM,
                  Math.min(
                    message.compiledTrack.source.leftWidthM,
                    proposal[index]! + sign * step * weight,
                  ),
                );
              }
              try {
                const scored = api.scoreCandidate(proposal, bestWarm);
                if (scored.lapTime < nextLap) {
                  nextLap = scored.lapTime;
                  nextGenotype = proposal;
                  nextWarm = scored.preimage;
                }
              } catch {
                // An infeasible coordinate move is not a worker failure.
              }
            }
            bestGenotype = nextGenotype;
            bestWarm = nextWarm;
            lowResolutionLap = nextLap;
          }

          // The coarse profile is intentionally cheap and can accept a line
          // that the adaptive binary64 certifier rejects. Preserve the best
          // fully certified checkpoint after every scale. A failed scale
          // resumes from that checkpoint instead of aborting the worker.
          try {
            const checkpoint = certifyBestReconstruction(bestGenotype, bestWarm);
            if (!checkpoint.certificate.pass) throw new Error("checkpoint certificate failed");
            if (checkpoint.lapTime < certified.lapTime - 1e-6) {
              certified = checkpoint;
              certifiedGenotype = bestGenotype.slice();
              certifiedWarm = checkpoint.preimage;
            }
            bestWarm = checkpoint.preimage;
            const rescored = api.scoreCandidate(bestGenotype, bestWarm);
            lowResolutionLap = rescored.lapTime;
            bestWarm = rescored.preimage;
          } catch {
            bestGenotype = certifiedGenotype.slice();
            bestWarm = certifiedWarm;
            const restored = api.scoreCandidate(bestGenotype, bestWarm);
            lowResolutionLap = restored.lapTime;
            bestWarm = restored.preimage;
          }
        }

        // Directly test the physical chord across each short, medium, and
        // long gate window. This creates the coordinated straight-through
        // move that independent offset bumps cannot reach efficiently.
        for (const radius of [12, 8, 4]) {
          const baselineGenotype = bestGenotype;
          const baselineWarm = bestWarm;
          const shortlist: Array<{
            fastLap: number;
            genotype: Float64Array<ArrayBuffer>;
            warm: Float64Array<ArrayBuffer>;
          }> = [];
          for (let center = 0; center < 64; center += 2) {
            for (const blend of [1, 0.5]) {
              const proposal = chordStraightenedGenotype(
                message.compiledTrack, baselineGenotype, center, radius, blend,
              );
              try {
                const scored = certifierApi.scoreCandidate(proposal, baselineWarm);
                shortlist.push({
                  fastLap: scored.lapTime,
                  genotype: proposal,
                  warm: new Float64Array(scored.preimage),
                });
              } catch {
                // Chords that cut outside the finite-width corridor are expected.
              }
            }
          }

          // The two-edge score is only a high-throughput filter. Re-rank its
          // best proposals with the denser curvature bound before changing
          // the working line. This prevents a narrow curvature peak between
          // coarse samples from looking like a fast straight.
          shortlist.sort((a, b) => a.fastLap - b.fastLap);
          const denseBaseline = scoreBestReconstruction(baselineGenotype, baselineWarm);
          let nextDenseLap = denseBaseline.lapTime;
          let nextGenotype = baselineGenotype;
          let nextWarm = denseBaseline.preimage;
          for (const candidate of shortlist.slice(0, 8)) {
            try {
              const scored = scoreBestReconstruction(candidate.genotype, candidate.warm);
              if (scored.lapTime < nextDenseLap) {
                nextDenseLap = scored.lapTime;
                nextGenotype = candidate.genotype;
                nextWarm = scored.preimage;
              }
            } catch {
              // A coarse-feasible chord may fail the dense curvature bound.
            }
          }
          bestGenotype = nextGenotype;
          bestWarm = nextWarm;
          try {
            const checkpoint = certifyBestReconstruction(bestGenotype, bestWarm);
            if (!checkpoint.certificate.pass) throw new Error("chord checkpoint failed");
            if (checkpoint.lapTime < certified.lapTime - 1e-6) {
              certified = checkpoint;
              certifiedGenotype = bestGenotype.slice();
              certifiedWarm = checkpoint.preimage;
            }
            bestWarm = checkpoint.preimage;
            const rescored = certifierApi.scoreCandidate(bestGenotype, bestWarm);
            lowResolutionLap = rescored.lapTime;
            bestWarm = rescored.preimage;
          } catch {
            bestGenotype = certifiedGenotype.slice();
            bestWarm = certifiedWarm;
            const restored = certifierApi.scoreCandidate(bestGenotype, bestWarm);
            lowResolutionLap = restored.lapTime;
            bestWarm = restored.preimage;
          }
        }

        // Remove isolated gate oscillations only when doing so lowers the
        // recomputed dynamic lap time. This is not a smoothness penalty: lap
        // time remains the sole acceptance value, followed by exact proof.
        for (const blend of [1, 0.5, 0.25]) {
          for (let gate = 0; gate < 64; gate++) {
            const proposal = bestGenotype.slice();
            const neighborMean = 0.5 * (
              bestGenotype[(gate + 63) % 64]! + bestGenotype[(gate + 1) % 64]!
            );
            proposal[gate] = bestGenotype[gate]! + blend * (neighborMean - bestGenotype[gate]!);
            try {
              const scored = certifierApi.scoreCandidate(proposal, bestWarm);
              if (scored.lapTime < lowResolutionLap) {
                bestGenotype = proposal;
                bestWarm = scored.preimage;
                lowResolutionLap = scored.lapTime;
              }
            } catch {
              // An infeasible smoothing proposal is not a worker failure.
            }
          }
          try {
            const checkpoint = certifyBestReconstruction(bestGenotype, bestWarm);
            if (!checkpoint.certificate.pass) throw new Error("smoothing checkpoint failed");
            if (checkpoint.lapTime < certified.lapTime - 1e-6) {
              certified = checkpoint;
              certifiedGenotype = bestGenotype.slice();
              certifiedWarm = checkpoint.preimage;
            }
            bestWarm = checkpoint.preimage;
            const rescored = api.scoreCandidate(bestGenotype, bestWarm);
            lowResolutionLap = rescored.lapTime;
            bestWarm = rescored.preimage;
          } catch {
            bestGenotype = certifiedGenotype.slice();
            bestWarm = certifiedWarm;
            const restored = api.scoreCandidate(bestGenotype, bestWarm);
            lowResolutionLap = restored.lapTime;
            bestWarm = restored.preimage;
          }
        }

        // Gate zero is a geometric variable, but ordinary coordinate descent
        // can trap it between the last and first corner sectors. Search the
        // whole periodic seam as one smooth five-knot deformation: fixed
        // endpoints at gates -12/+12 and independently varied approach,
        // start, and exit values at -6/0/+6.
        for (const step of [6, 3, 1.5, 0.75]) {
          let nextLap = lowResolutionLap;
          let nextGenotype = bestGenotype;
          let nextWarm = bestWarm;
          for (const approach of [-1, 0, 1]) for (const start of [-1, 0, 1])
            for (const exit of [-1, 0, 1]) {
              if (approach === 0 && start === 0 && exit === 0) continue;
              const proposal = bestGenotype.slice();
              const values = [0, approach * step, start * step, exit * step, 0];
              for (let offset = -12; offset <= 12; offset++) {
                const segment = Math.min(3, Math.floor((offset + 12) / 6));
                const t = (offset + 12 - 6 * segment) / 6;
                const smooth = t * t * (3 - 2 * t);
                const delta = values[segment]! + smooth *
                  (values[segment + 1]! - values[segment]!);
                const index = (offset + 64) % 64;
                proposal[index] = Math.max(
                  -message.compiledTrack.source.rightWidthM,
                  Math.min(message.compiledTrack.source.leftWidthM, proposal[index]! + delta),
                );
              }
              try {
                const scored = api.scoreCandidate(proposal, bestWarm);
                if (scored.lapTime < nextLap) {
                  nextLap = scored.lapTime;
                  nextGenotype = proposal;
                  nextWarm = scored.preimage;
                }
              } catch {
                // Invalid coordinated seam proposals are expected.
              }
            }
          bestGenotype = nextGenotype;
          bestWarm = nextWarm;
          lowResolutionLap = nextLap;
          try {
            const checkpoint = certifyBestReconstruction(bestGenotype, bestWarm);
            if (!checkpoint.certificate.pass) throw new Error("seam checkpoint certificate failed");
            if (checkpoint.lapTime < certified.lapTime - 1e-6) {
              certified = checkpoint;
              certifiedGenotype = bestGenotype.slice();
              certifiedWarm = checkpoint.preimage;
            }
            bestWarm = checkpoint.preimage;
            const rescored = api.scoreCandidate(bestGenotype, bestWarm);
            lowResolutionLap = rescored.lapTime;
            bestWarm = rescored.preimage;
          } catch {
            bestGenotype = certifiedGenotype.slice();
            bestWarm = certifiedWarm;
            const restored = api.scoreCandidate(bestGenotype, bestWarm);
            lowResolutionLap = restored.lapTime;
            bestWarm = restored.preimage;
          }
        }

        // Gate offsets determine only the interpolation points. The PH
        // preimage retains a large nullspace which can contain a short-wave
        // oscillation between otherwise good gates. Locate those oscillations
        // in the exact 1024-edge profile, low-pass only their local preimage
        // windows, then reproject to the unchanged gates. Lap time is still
        // the sole acceptance value and every accepted pass is recertified.
        bestGenotype = certifiedGenotype.slice();
        bestWarm = certifiedWarm;
        let hotspotControls = curvatureHotspotControls(
          certified.nodes, certified.edgeCount, 10,
        );
        for (const blend of [1, 0.5, 0.25]) {
          let denseBaseline;
          try {
            denseBaseline = certifierApi.scoreCandidateDense(bestGenotype, bestWarm);
          } catch {
            break;
          }
          let nextDenseLap = denseBaseline.lapTime;
          let nextWarm = denseBaseline.preimage;
          let changed = false;
          for (const control of hotspotControls) for (const radius of [1, 2, 4]) {
            const proposalWarm = smoothPreimageWindow(bestWarm, control, radius, blend);
            try {
              const scored = certifierApi.scoreCandidateDense(bestGenotype, proposalWarm);
              if (scored.lapTime < nextDenseLap) {
                nextDenseLap = scored.lapTime;
                nextWarm = scored.preimage;
                changed = true;
              }
            } catch {
              // Projection, containment, or dynamics can reject a nullspace move.
            }
          }
          if (!changed) continue;
          try {
            const checkpoint = certifyBestReconstruction(bestGenotype, nextWarm);
            if (!checkpoint.certificate.pass ||
                !(checkpoint.lapTime < certified.lapTime - 1e-6)) {
              throw new Error("preimage smoothing did not improve certified lap time");
            }
            certified = checkpoint;
            certifiedGenotype = bestGenotype.slice();
            certifiedWarm = checkpoint.preimage;
            bestWarm = checkpoint.preimage;
            hotspotControls = curvatureHotspotControls(
              checkpoint.nodes, checkpoint.edgeCount, 10,
            );
          } catch {
            bestGenotype = certifiedGenotype.slice();
            bestWarm = certifiedWarm;
          }
        }
        self.postMessage({
          ...envelope(message), type: "certified", candidateId: message.candidateId,
          lapTime: certified.lapTime, genotype: certifiedGenotype, preimage: certified.preimage,
          profileNodes: certified.nodes, edgeCount: certified.edgeCount, certificate: certified.certificate,
        } satisfies CertifierEvent, [certified.preimage.buffer, certified.nodes.buffer]);
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
      if (message.type === "certifyCandidate") {
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
