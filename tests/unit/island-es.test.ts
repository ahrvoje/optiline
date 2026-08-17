import { describe, expect, it } from "vitest";

import {
  IslandEvolution,
  backtrackToFeasible,
  compareFeasibleFirst,
  generateLateralSeeds,
} from "@/optimizer/island-es";

const key = { k0: 0x12345678, k1: 0x9abcdef0 };

describe("hierarchical island evolution", () => {
  it("orders feasibility before time and uses smoothness only for equivalent times", () => {
    const feasible = { feasible: true, violation: 0, lapTime: 100, regularizer: 3, minClearanceM: 1 };
    const fastInvalid = { feasible: false, violation: 1e-6, lapTime: 1, regularizer: 0, minClearanceM: -1 };
    expect(compareFeasibleFirst(feasible, fastInvalid)).toBeLessThan(0);
    expect(compareFeasibleFirst(
      feasible,
      { ...feasible, lapTime: 100 + 5e-7, regularizer: 4 },
      1e-6,
    )).toBeLessThan(0);
  });

  it("generates deterministic antithetic populations", () => {
    const seeds = [new Float64Array(12)];
    const options = {
      islandCount: 2,
      populationPerIsland: 4,
      explorationFraction: 0,
      key,
    };
    const a = new IslandEvolution(seeds, options).generate();
    const b = new IslandEvolution(seeds, options).generate();
    expect(a.map(candidate => Array.from(candidate.coefficients)))
      .toEqual(b.map(candidate => Array.from(candidate.coefficients)));
    for (let island = 0; island < 2; island++) {
      const plus = a[island * 4]!.coefficients;
      const minus = a[island * 4 + 1]!.coefficients;
      for (let i = 0; i < plus.length; i++) expect(plus[i]).toBeCloseTo(-minus[i]!, 14);
    }
  });

  it("changes the population when either run-seed word changes", () => {
    const seeds = [new Float64Array(12)];
    const options = {
      islandCount: 2,
      populationPerIsland: 4,
      explorationFraction: 0,
    };
    const baseline = new IslandEvolution(seeds, { ...options, key }).generate();
    const changedLow = new IslandEvolution(seeds, {
      ...options,
      key: { k0: key.k0 ^ 1, k1: key.k1 },
    }).generate();
    const changedHigh = new IslandEvolution(seeds, {
      ...options,
      key: { k0: key.k0, k1: key.k1 ^ 1 },
    }).generate();
    expect(changedLow.map(candidate => Array.from(candidate.coefficients)))
      .not.toEqual(baseline.map(candidate => Array.from(candidate.coefficients)));
    expect(changedHigh.map(candidate => Array.from(candidate.coefficients)))
      .not.toEqual(baseline.map(candidate => Array.from(candidate.coefficients)));
  });

  it("refines island means without changing their periodic fields", () => {
    const seed = generateLateralSeeds(13, -5, 5, key, 0)[4]!;
    const search = new IslandEvolution([seed], {
      islandCount: 2,
      populationPerIsland: 4,
      key,
    });
    const before = search.islands[0]!.mean.slice();
    search.refine();
    expect(search.controlCount).toBe(2 * before.length);
    expect(Math.max(...search.islands[0]!.sigma)).toBeLessThan(0.18);
  });

  it("restores the deterministic generation and island state", () => {
    const seeds = [new Float64Array(10)];
    const options = { islandCount: 2, populationPerIsland: 4, key };
    const original = new IslandEvolution(seeds, options);
    const observations = original.generate().map(candidate => ({
      candidate,
      score: {
        feasible: true,
        violation: 0,
        lapTime: candidate.coefficients.reduce((sum, value) => sum + value * value, 0),
        regularizer: 0,
        minClearanceM: 1,
      },
    }));
    original.update(observations);
    const restored = new IslandEvolution(seeds, options);
    restored.restore(original.snapshot());
    expect(restored.generationIndex).toBe(original.generationIndex);
    expect(restored.generate().map(candidate => Array.from(candidate.coefficients)))
      .toEqual(original.generate().map(candidate => Array.from(candidate.coefficients)));
  });

  it("injects an externally reranked incumbent into one island", () => {
    const search = new IslandEvolution([new Float64Array(6)], {
      islandCount: 2,
      populationPerIsland: 4,
      explorationFraction: 0,
      key,
    });
    const incumbent = Float64Array.of(0.4, -0.3, 0.2, -0.1, 0.05, -0.02);
    search.inject(incumbent, 1, 0.025);
    expect(Array.from(search.islands[1]!.mean)).toEqual(Array.from(incumbent));
    expect(Array.from(search.islands[1]!.sigma)).toEqual(Array(6).fill(0.025));
    expect(search.islands[0]!.mean).toEqual(new Float64Array(6));
    const scaled = Float64Array.of(0.1, 0.08, 0.06, 0.04, 0.02, 0.01);
    search.inject(incumbent, 1, scaled);
    expect(search.islands[1]!.sigma).toEqual(scaled);
  });

  it("backtracks invalid proposals toward a feasible parent", () => {
    const repaired = backtrackToFeasible(
      new Float64Array([0, 0]),
      new Float64Array([2, 2]),
      values => Math.max(...values) <= 0.6,
    );
    expect(repaired).not.toBeNull();
    expect(Array.from(repaired!)).toEqual([0.5, 0.5]);
  });
});
