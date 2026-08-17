import { describe, expect, it } from "vitest";
import { buildHybridPeriodicBasis, evaluateHybridField } from "@/optimizer/hybrid-basis";
import { projectedRaisedCosineMove, smoothPatternProposals } from "@/optimizer/smooth-arc-search";

describe("smooth arc search", () => {
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
