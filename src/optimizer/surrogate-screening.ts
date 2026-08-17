import {
  compareFeasibleFirst,
  type IslandObservation,
} from "@/optimizer/island-es";

/**
 * Promote proxy elites plus one deterministic antithetic exploration pair per
 * island. This prevents the screening surrogate from defining the ES search
 * direction while keeping the number of full evaluations fixed.
 */
export function selectFullEvaluationIndices(
  observations: IslandObservation[],
  generation: number,
  evaluationsPerIsland = 4,
): number[] {
  if (!Number.isInteger(generation) || generation < 0 ||
      !Number.isInteger(evaluationsPerIsland) || evaluationsPerIsland < 2) {
    throw new RangeError("invalid full-evaluation selection request");
  }
  const indices: number[] = [];
  const islandCount = Math.max(0, ...observations.map(item => item.candidate.island + 1));
  for (let island = 0; island < islandCount; island++) {
    const ranked = observations
      .map((observation, index) => ({ observation, index }))
      .filter(item => item.observation.candidate.island === island &&
        item.observation.score.feasible)
      .sort((a, b) => compareFeasibleFirst(a.observation.score, b.observation.score));
    const selected = new Set<number>();
    const proxyEliteCount = Math.max(0, evaluationsPerIsland - 2);
    for (const item of ranked.slice(0, proxyEliteCount)) selected.add(item.index);

    const exploratoryPairs = new Map<number, number[]>();
    for (const item of ranked) {
      if (!item.observation.candidate.exploratory || selected.has(item.index)) continue;
      const pair = Math.floor(item.observation.candidate.candidateInIsland / 2);
      const pairIndices = exploratoryPairs.get(pair) ?? [];
      pairIndices.push(item.index);
      exploratoryPairs.set(pair, pairIndices);
    }
    const completePairs = [...exploratoryPairs.entries()]
      .filter(([, pairIndices]) => pairIndices.length === 2)
      .sort(([a], [b]) => a - b);
    if (completePairs.length > 0) {
      const pair = completePairs[(generation + 3 * island) % completePairs.length]![1];
      for (const index of pair) selected.add(index);
    }
    for (const item of ranked) {
      if (selected.size >= evaluationsPerIsland) break;
      selected.add(item.index);
    }
    indices.push(...selected);
  }
  return indices;
}
