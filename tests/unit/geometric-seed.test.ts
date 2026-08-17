import { describe, expect, it } from "vitest";
import { BUILT_IN_TRACKS } from "@/model/catalog";
import { DEFAULT_VEHICLE } from "@/model/contracts";
import { minimumCurvatureSeed } from "@/optimizer/geometric-seed";
import { buildHybridPeriodicBasis } from "@/optimizer/hybrid-basis";
import { evaluateMinimumLapCandidate } from "@/optimizer/minimum-lap";
import { buildSafeCorridor } from "@/optimizer/racing-line";

describe("minimum-curvature initializer", () => {
  it("starts Silver Delta in a faster feasible smooth basin", () => {
    const track = BUILT_IN_TRACKS.find(candidate => candidate.source.id === "silver-delta")!;
    const basis = buildHybridPeriodicBasis(12, 0);
    const corridor = buildSafeCorridor(track, DEFAULT_VEHICLE, Math.PI / 12);
    const center = evaluateMinimumLapCandidate(
      track, DEFAULT_VEHICLE, basis, new Float64Array(25), 512, "full", corridor,
    );
    const seed = minimumCurvatureSeed(track, DEFAULT_VEHICLE, basis, corridor);
    const candidate = evaluateMinimumLapCandidate(
      track, DEFAULT_VEHICLE, basis, seed, 512, "full", corridor,
    );
    expect(candidate.feasible).toBe(true);
    expect(candidate.lapTime).toBeLessThan(center.lapTime - 0.25);
    expect(candidate.regularizer).toBeLessThan(center.regularizer * 4);
  });
});
