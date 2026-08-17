import { describe, expect, it } from "vitest";
import type { IslandObservation } from "@/optimizer/island-es";
import { selectFullEvaluationIndices } from "@/optimizer/surrogate-screening";

function observation(
  island: number,
  candidateInIsland: number,
  lapTime: number,
  exploratory = false,
): IslandObservation {
  return {
    candidate: {
      island,
      candidateInIsland,
      coefficients: Float64Array.of(candidateInIsland),
      exploratory,
    },
    score: {
      feasible: true,
      violation: 0,
      lapTime,
      regularizer: 0,
      minClearanceM: 1,
    },
  };
}

describe("surrogate screening", () => {
  it("promotes two proxy elites and a complete exploratory pair per island", () => {
    const observations: IslandObservation[] = [];
    for (let island = 0; island < 2; island++) {
      for (let candidate = 0; candidate < 8; candidate++) {
        observations.push(observation(
          island,
          candidate,
          30 + candidate,
          candidate >= 4,
        ));
      }
    }
    const selected = selectFullEvaluationIndices(observations, 0, 4);
    for (let island = 0; island < 2; island++) {
      const local = selected.map(index => observations[index]!)
        .filter(item => item.candidate.island === island);
      expect(local).toHaveLength(4);
      expect(local.map(item => item.candidate.candidateInIsland)).toContain(0);
      expect(local.map(item => item.candidate.candidateInIsland)).toContain(1);
      const exploratory = local.filter(item => item.candidate.exploratory);
      expect(exploratory).toHaveLength(2);
      expect(Math.floor(exploratory[0]!.candidate.candidateInIsland / 2)).toBe(
        Math.floor(exploratory[1]!.candidate.candidateInIsland / 2),
      );
    }
  });

  it("falls back to the proxy rank when no complete exploratory pair is feasible", () => {
    const observations = Array.from({ length: 6 }, (_, candidate) =>
      observation(0, candidate, 30 + candidate, candidate === 5));
    expect(selectFullEvaluationIndices(observations, 0, 4)).toEqual([0, 1, 2, 3]);
  });
});
