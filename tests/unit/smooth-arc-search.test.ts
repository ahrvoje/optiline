import { describe, expect, it } from "vitest";
import { buildHybridPeriodicBasis, evaluateHybridField } from "@/optimizer/hybrid-basis";
import {
  projectedRaisedCosineMove,
  quadraticPatternCombinations,
  smoothPatternProposals,
} from "@/optimizer/smooth-arc-search";

describe("smooth arc search", () => {
  it("combines independent symmetric improvements with trust-region scales", () => {
    const base = Float64Array.of(0, 0);
    const proposals = [
      Float64Array.of(-1, 0), Float64Array.of(1, 0),
      Float64Array.of(0, -1), Float64Array.of(0, 1),
    ];
    const combined = quadraticPatternCombinations(
      base,
      proposals,
      { feasible: true, lapTime: 10 },
      [
        { feasible: true, lapTime: 9 }, { feasible: true, lapTime: 11 },
        { feasible: true, lapTime: 11 }, { feasible: true, lapTime: 9 },
      ],
      1,
    );
    expect(combined).toHaveLength(9);
    expect(combined.at(-1)![0]).toBeLessThan(0);
    expect(combined.at(-1)![1]).toBeGreaterThan(0);
  });

  it("retains an improving one-sided move at an active constraint", () => {
    const combined = quadraticPatternCombinations(
      Float64Array.of(0),
      [Float64Array.of(-1), Float64Array.of(1)],
      { feasible: true, lapTime: 10 },
      [
        { feasible: false, lapTime: 0 },
        { feasible: true, lapTime: 9 },
      ],
      1,
    );
    expect(combined).toHaveLength(3);
    expect(combined.at(-1)![0]).toBe(1);
  });

  it("cancels the residual high-pass projection and leaves no remote ripple", () => {
    const basis = buildHybridPeriodicBasis(8, 64);
    const base = new Float64Array(81);
    const moved = projectedRaisedCosineMove(base, basis, 16, 12, 0.2);
    for (const sample of [0.55, 0.65, 0.75, 0.85]) {
      expect(Math.abs(evaluateHybridField(basis, moved, sample)[0]!)).toBeLessThan(1e-10);
    }
    expect(evaluateHybridField(basis, moved, 0.25)[0]).toBeGreaterThan(0.15);
  });

  it("always includes fine and broad bounded corrections", () => {
    const basis = buildHybridPeriodicBasis(8, 128);
    const proposals = smoothPatternProposals(new Float64Array(145), basis, 960, 0.04);
    expect(proposals.length).toBeGreaterThan(100);
    expect(proposals.every(proposal => Array.from(proposal).every(value => Math.abs(value) <= 2)))
      .toBe(true);
  });
});
