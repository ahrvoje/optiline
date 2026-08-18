import {
  compareFeasibleFirst,
  type IslandObservation,
} from "@/optimizer/island-es";

/**
 * Promote proxy elites plus deterministic exploration samples per island.
 * With four or more promotions, reserve an antithetic exploration pair. With
 * two promotions, keep one elite and one rotating exploratory sample so the
 * binary64 gate remains useful at small fixed budgets. With one promotion,
 * rotate the exploration duty across islands and promote elites elsewhere.
 */
export function selectFullEvaluationIndices(
  observations: IslandObservation[],
  generation: number,
  evaluationsPerIsland = 4,
): number[] {
  if (!Number.isInteger(generation) || generation < 0 ||
      !Number.isInteger(evaluationsPerIsland) || evaluationsPerIsland < 1) {
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
    if (evaluationsPerIsland === 1) {
      const exploratory = ranked.filter(item => item.observation.candidate.exploratory);
      const explorationIsland = generation % Math.max(1, islandCount);
      const choice = island === explorationIsland && exploratory.length > 0
        ? exploratory[Math.floor(generation / Math.max(1, islandCount)) % exploratory.length]!
        : ranked[0];
      if (choice !== undefined) indices.push(choice.index);
      continue;
    }
    const exploratoryBudget = evaluationsPerIsland >= 4 ? 2 : 1;
    const proxyEliteCount = evaluationsPerIsland - exploratoryBudget;
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
    if (exploratoryBudget === 2 && completePairs.length > 0) {
      const pair = completePairs[(generation + 3 * island) % completePairs.length]![1];
      for (const index of pair) selected.add(index);
    } else if (exploratoryBudget === 1) {
      const exploratory = ranked.filter(item =>
        item.observation.candidate.exploratory && !selected.has(item.index));
      if (exploratory.length > 0) {
        selected.add(exploratory[(generation + 3 * island) % exploratory.length]!.index);
      }
    }
    for (const item of ranked) {
      if (selected.size >= evaluationsPerIsland) break;
      selected.add(item.index);
    }
    indices.push(...selected);
  }
  return indices;
}
