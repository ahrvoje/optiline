import { describe, expect, it } from "vitest";

import { gpuSearchSeed, nextOptimizerSeed } from "@/optimizer/run-seed";

describe("optimizer run seeds", () => {
  it("prevents identical consecutive nondeterministic seed pairs", () => {
    const fill = (values: Uint32Array<ArrayBuffer>): void => {
      values.set([7, 11]);
    };
    const first = nextOptimizerSeed(fill);
    const second = nextOptimizerSeed(fill);
    expect(second).not.toEqual(first);
  });

  it("folds both seed words reproducibly into the WGSL-safe range", () => {
    const first = gpuSearchSeed({ lo: 0x12345678, hi: 0x9abcdef0 });
    expect(gpuSearchSeed({ lo: 0x12345678, hi: 0x9abcdef0 })).toBe(first);
    expect(gpuSearchSeed({ lo: 0x12345678, hi: 0x9abcdef1 })).not.toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(0x00ffffff);
  });
});
