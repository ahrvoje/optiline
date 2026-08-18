import { describe, expect, it } from "vitest";

import { BUILT_IN_TRACKS } from "@/model/catalog";
import { DEFAULT_VEHICLE } from "@/model/contracts";
import { certifyCurvatureCandidate } from "@/optimizer/curvature-certificate";
import {
  CURVATURE_FINALIZATION_STAGE_COUNT,
  finalizeDiscoveryCandidate,
} from "@/optimizer/curvature-finalization";
import {
  buildHybridPeriodicBasis,
  hybridCoefficientCount,
} from "@/optimizer/hybrid-basis";
import { buildSafeCorridor } from "@/optimizer/racing-line";

describe("canonical live finalization", () => {
  it("turns a discovery snapshot into a directly certifiable display product", () => {
    const track = BUILT_IN_TRACKS[0]!;
    const basis = buildHybridPeriodicBasis(12, 0);
    const source = new Float64Array(hybridCoefficientCount(basis));
    const corridor = buildSafeCorridor(track, DEFAULT_VEHICLE);
    const completed: number[] = [];
    const finalized = finalizeDiscoveryCandidate(
      track,
      DEFAULT_VEHICLE,
      basis,
      [source],
      corridor,
      progress => completed.push(progress.completed),
    );
    const certified = certifyCurvatureCandidate(
      track,
      DEFAULT_VEHICLE,
      finalized.representation,
    );

    expect(completed).toEqual(
      Array.from({ length: CURVATURE_FINALIZATION_STAGE_COUNT + 1 }, (_, index) => index),
    );
    expect(finalized.representations.discovery.lateralFourierModes).toBe(12);
    expect(certified.certificate.pass).toBe(true);
    expect(certified.pathSamples).toHaveLength(5 * 4096);
  }, 30_000);
});
