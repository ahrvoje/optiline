import { describe, expect, it } from "vitest";

import { BUILT_IN_TRACKS } from "@/model/catalog";
import { DEFAULT_VEHICLE } from "@/model/contracts";
import { evaluateProfile } from "@/optimizer/profile";
import { centerlineSpec } from "@/renderer/ph-tessellate";

describe("provisional dynamic profile", () => {
  it("uses the configured acceleration-ellipse exponent when ranking lines", () => {
    const line = centerlineSpec(BUILT_IN_TRACKS[1]!);
    const circular = evaluateProfile(line, { ...DEFAULT_VEHICLE, ellipseP: 2 }, 1024);
    const squared = evaluateProfile(line, { ...DEFAULT_VEHICLE, ellipseP: 4 }, 1024);
    expect(squared.lapTime).not.toBeCloseTo(circular.lapTime, 5);
  });

  it("uses braking strength in the periodic force-limited envelope", () => {
    const line = centerlineSpec(BUILT_IN_TRACKS[1]!);
    const standard = evaluateProfile(line, DEFAULT_VEHICLE, 1024);
    const stronger = evaluateProfile(line, { ...DEFAULT_VEHICLE, axMinus0: 24 }, 1024);
    expect(stronger.lapTime).toBeLessThan(standard.lapTime);
  });
});
