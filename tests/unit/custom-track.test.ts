import { describe, expect, it } from "vitest";

import { BUILT_IN_TRACKS, compileEditableTrack } from "@/model/catalog";
import {
  createOvalTrackSource,
  duplicateTrackSource,
  nextCustomTrackName,
} from "@/model/custom-track";
import { DEFAULT_VEHICLE } from "@/model/contracts";
import { evaluateProfile } from "@/optimizer/profile";
import { centerlineSpec } from "@/renderer/ph-tessellate";

describe("custom track sources", () => {
  it("creates and compiles a finite 16-node stadium oval", () => {
    const source = createOvalTrackSource("Custom #1");
    expect(source.centerGatesM).toHaveLength(16);
    const track = compileEditableTrack(source);
    expect(track.source.name).toBe("Custom #1");
    expect(track.source.centerGatesM).toHaveLength(16);
    expect(track.centerPreimageControls).toHaveLength(128);
    expect(track.gatePoints).toHaveLength(64);
    const profile = evaluateProfile(centerlineSpec(track), DEFAULT_VEHICLE, 128);
    expect(profile.lapTime).toBeGreaterThan(0);
    expect(Number.isFinite(profile.lapTime)).toBe(true);
  });

  it("duplicates a canonical source without mutating the catalog", () => {
    const canonical = BUILT_IN_TRACKS[1]!;
    const original = structuredClone(canonical.source);
    const source = duplicateTrackSource(canonical, "Custom #1");
    source.centerGatesM[0]![0] += 25;
    const edited = compileEditableTrack(source);
    expect(edited.source.id).not.toBe(canonical.source.id);
    expect(edited.source.name).toBe("Custom #1");
    expect(canonical.source).toEqual(original);
  });

  it("uses the lowest free custom number", () => {
    const one = compileEditableTrack(createOvalTrackSource("Custom #1"));
    const three = compileEditableTrack(createOvalTrackSource("Custom #3"));
    expect(nextCustomTrackName([...BUILT_IN_TRACKS, one, three])).toBe("Custom #2");
  });
});

