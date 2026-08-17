import { describe, expect, it } from "vitest";

import { BUILT_IN_TRACKS } from "@/model/catalog";
import { DEFAULT_VEHICLE } from "@/model/contracts";
import { IslandEvolution } from "@/optimizer/island-es";
import {
  buildHybridPeriodicBasis,
  hybridCoefficientCount,
} from "@/optimizer/hybrid-basis";
import { evaluateMinimumLapCandidate } from "@/optimizer/minimum-lap";
import {
  buildReferenceSpine,
  buildSafeCorridor,
  evaluateRacingLineFrame,
  lateralFieldGenotype,
  lateralFieldPreimage,
  remapFourierCorridor,
} from "@/optimizer/racing-line";
import {
  centerlineSpec,
  evaluateLineFrame,
  lineDistancesAtParameters,
} from "@/renderer/ph-tessellate";

describe("minimum-lap FP64 reference", () => {
  it("solves a finite periodic profile for the structural center seed", () => {
    const basis = buildHybridPeriodicBasis(4, 16);
    const evaluation = evaluateMinimumLapCandidate(
      BUILT_IN_TRACKS[0]!,
      DEFAULT_VEHICLE,
      basis,
      new Float64Array(hybridCoefficientCount(basis)),
      128,
      "full",
    );
    expect(evaluation.feasible).toBe(true);
    expect(evaluation.lapTime).toBeGreaterThan(0);
    expect(evaluation.speedSquared).not.toBeNull();
    expect(Math.max(...evaluation.speedSquared!)).toBeLessThanOrEqual(
      DEFAULT_VEHICLE.vMaxMps ** 2,
    );
    expect(evaluation.minProgress).toBeGreaterThan(0.1);
    expect(evaluation.minClearanceM).toBeGreaterThanOrEqual(0);
    expect(evaluation.speedOptimalityResidual).toBeLessThan(1e-6);
  });

  it("keeps hard feasibility ahead of an invalid fast proxy", () => {
    const basis = buildHybridPeriodicBasis(4, 16);
    const coefficients = Float64Array.from(
      { length: hybridCoefficientCount(basis) },
      (_, i) => i % 2 === 0 ? 3 : -3,
    );
    const evaluation = evaluateMinimumLapCandidate(
      BUILT_IN_TRACKS[0]!,
      DEFAULT_VEHICLE,
      basis,
      coefficients,
      128,
      "proxy",
    );
    expect(evaluation.feasible).toBe(false);
    expect(evaluation.violation).toBeGreaterThan(0);
  });

  it("meets the initial geometric-acceptance target", () => {
    const track = BUILT_IN_TRACKS[0]!;
    const basis = buildHybridPeriodicBasis(2, 8);
    const key = { k0: 0x12345678, k1: 0x9abcdef0 };
    const search = new IslandEvolution(
      [new Float64Array(hybridCoefficientCount(basis))],
      { islandCount: 8, populationPerIsland: 16, key },
    );
    const candidates = search.generate();
    const accepted = candidates.filter(candidate => evaluateMinimumLapCandidate(
      track, DEFAULT_VEHICLE, basis, candidate.coefficients, 128, "proxy",
    ).feasible).length;
    expect(accepted / candidates.length).toBeGreaterThanOrEqual(0.95);
  });

  it("preserves physical gate cross-sections in the Fourier-to-PH handoff", () => {
    const track = BUILT_IN_TRACKS.find(item => item.source.id === "silver-delta")!;
    const basis = buildHybridPeriodicBasis(6, 0);
    const coefficients = new Float64Array(hybridCoefficientCount(basis));
    coefficients[1] = 0.65;
    coefficients[4] = -0.35;
    const genotype = lateralFieldGenotype(track, DEFAULT_VEHICLE, basis, coefficients);
    const center = centerlineSpec(track);
    const measured = lineDistancesAtParameters(
      center,
      Float64Array.from({ length: 64 }, (_, gate) => gate),
    );
    const spine = buildReferenceSpine(track);
    const corridor = buildSafeCorridor(track, DEFAULT_VEHICLE);
    for (let gate = 0; gate < 64; gate++) {
      const frame = evaluateLineFrame(center, gate);
      const path = evaluateRacingLineFrame(
        spine,
        basis,
        coefficients,
        corridor,
        track,
        DEFAULT_VEHICLE,
        measured.distances[gate]! / measured.totalLength,
      );
      const expected = (path.x - frame.x) * -frame.ty +
        (path.y - frame.y) * frame.tx;
      expect(genotype[gate]).toBeCloseTo(expected, 11);
    }
  });

  it("builds a path-dependent PH warm preimage without moving the center seed", () => {
    const track = BUILT_IN_TRACKS.find(item => item.source.id === "silver-delta")!;
    const basis = buildHybridPeriodicBasis(6, 0);
    const centerCoefficients = new Float64Array(hybridCoefficientCount(basis));
    const centerWarm = lateralFieldPreimage(
      track, DEFAULT_VEHICLE, basis, centerCoefficients,
    );
    const center = Float64Array.from(track.centerPreimageControls.flat());
    expect(Math.max(...centerWarm.map((value, index) => Math.abs(value - center[index]!))))
      .toBeLessThan(1e-10);
    const offsetCoefficients = centerCoefficients.slice();
    offsetCoefficients[1] = 0.7;
    offsetCoefficients[4] = -0.4;
    const offsetWarm = lateralFieldPreimage(
      track, DEFAULT_VEHICLE, basis, offsetCoefficients,
    );
    expect(offsetWarm.every(Number.isFinite)).toBe(true);
    expect(Math.max(...offsetWarm.map((value, index) => Math.abs(value - center[index]!))))
      .toBeGreaterThan(0.01);
  });

  it("preserves the lateral path during corridor continuation", () => {
    const track = BUILT_IN_TRACKS.find(item => item.source.id === "silver-delta")!;
    const basis = buildHybridPeriodicBasis(12, 0);
    const coefficients = new Float64Array(hybridCoefficientCount(basis));
    coefficients[0] = 0.1;
    coefficients[1] = 0.6;
    coefficients[4] = -0.3;
    coefficients[9] = 0.15;
    const robust = buildSafeCorridor(track, DEFAULT_VEHICLE, Math.PI / 12);
    const expanded = buildSafeCorridor(track, DEFAULT_VEHICLE, Math.PI / 24);
    const remapped = remapFourierCorridor(basis, coefficients, robust, expanded);
    const spine = buildReferenceSpine(track);
    let maximumDifference = 0;
    for (let sample = 0; sample < 256; sample++) {
      const u = sample / 256;
      const before = evaluateRacingLineFrame(
        spine, basis, coefficients, robust, track, DEFAULT_VEHICLE, u,
      );
      const after = evaluateRacingLineFrame(
        spine, basis, remapped, expanded, track, DEFAULT_VEHICLE, u,
      );
      maximumDifference = Math.max(maximumDifference, Math.abs(before.d - after.d));
    }
    expect(maximumDifference).toBeLessThan(5e-4);
  });
});
