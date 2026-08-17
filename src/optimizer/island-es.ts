import { PhiloxStream, reflectIntoRange, type PhiloxKey } from "@/optimizer/philox";
import { refinePeriodicQuintic } from "@/optimizer/periodic-bspline";

export interface FeasibleFirstScore {
  feasible: boolean;
  violation: number;
  lapTime: number;
  regularizer: number;
  minClearanceM: number;
}

/** Specification §12 lexicographic ordering with lap-time equivalence. */
export function compareFeasibleFirst(
  a: FeasibleFirstScore,
  b: FeasibleFirstScore,
  lapTimeEpsilon = 1e-6,
): number {
  if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
  if (!a.feasible && a.violation !== b.violation) return a.violation - b.violation;
  const timeDifference = a.lapTime - b.lapTime;
  if (Math.abs(timeDifference) > lapTimeEpsilon) return timeDifference;
  if (a.regularizer !== b.regularizer) return a.regularizer - b.regularizer;
  return b.minClearanceM - a.minClearanceM;
}

export interface IslandCandidate {
  island: number;
  candidateInIsland: number;
  coefficients: Float64Array;
  exploratory: boolean;
}

export interface IslandObservation {
  candidate: IslandCandidate;
  score: FeasibleFirstScore;
}

export interface IslandState {
  mean: Float64Array;
  sigma: Float64Array;
  best: IslandObservation | null;
  stagnation: number;
  generation: number;
}

export interface IslandEvolutionSnapshot {
  generation: number;
  islands: Array<{
    mean: number[];
    sigma: number[];
    stagnation: number;
    generation: number;
  }>;
}

export interface IslandEvolutionOptions {
  islandCount: number;
  populationPerIsland: number;
  eliteFraction: number;
  explorationFraction: number;
  meanLearningRate: number;
  varianceLearningRate: number;
  varianceFloor: number;
  acceptanceTarget: number;
  migrationInterval: number;
  restartGenerations: number;
  /** Symmetric latent coefficient reflection limit; V2 normally uses 2. */
  coefficientLimit: number;
  key: PhiloxKey;
}

const DEFAULT_OPTIONS: IslandEvolutionOptions = {
  islandCount: 16,
  populationPerIsland: 32,
  eliteFraction: 0.25,
  explorationFraction: 0.0625,
  meanLearningRate: 0.65,
  varianceLearningRate: 0.3,
  varianceFloor: 0.005,
  acceptanceTarget: 0.95,
  migrationInterval: 8,
  restartGenerations: 24,
  coefficientLimit: 2,
  key: { k0: 0, k1: 0 },
};

function smoothPeriodic(values: Float64Array, passes: number): Float64Array {
  let current = values;
  for (let pass = 0; pass < passes; pass++) {
    const next = new Float64Array(current.length);
    for (let i = 0; i < current.length; i++) {
      next[i] = 0.25 * current[(i + current.length - 1) % current.length]! +
        0.5 * current[i]! + 0.25 * current[(i + 1) % current.length]!;
    }
    current = next;
  }
  return current;
}

/** Structurally periodic seed families from specification §13.1. */
export function generateLateralSeeds(
  controlCount: number,
  corridorLower: number,
  corridorUpper: number,
  key: PhiloxKey,
  randomCount = 8,
): Float64Array[] {
  if (controlCount < 6 || !(corridorLower <= corridorUpper)) {
    throw new RangeError("invalid seed corridor or control count");
  }
  const midpoint = 0.5 * (corridorLower + corridorUpper);
  const halfWidth = 0.5 * (corridorUpper - corridorLower);
  const centerValue = halfWidth > 0 ? Math.max(-1, Math.min(1, -midpoint / halfWidth)) : 0;
  const constant = (value: number): Float64Array => {
    const out = new Float64Array(controlCount);
    out.fill(value);
    return out;
  };
  const seeds = [constant(centerValue), constant(0), constant(-0.7), constant(0.7)];
  for (const harmonic of [1, 2, 3]) {
    for (const phase of [0, Math.PI / 2]) {
      const coefficients = new Float64Array(controlCount);
      for (let i = 0; i < controlCount; i++) {
        coefficients[i] = 0.45 * Math.sin(2 * Math.PI * harmonic * i / controlCount + phase);
      }
      seeds.push(coefficients);
    }
  }
  for (let seed = 0; seed < randomCount; seed++) {
    const stream = new PhiloxStream(seed, 0, 0x53454544, key);
    const values = new Float64Array(controlCount);
    for (let i = 0; i < controlCount; i++) values[i] = 0.35 * stream.nextNormal();
    const filtered = smoothPeriodic(values, 4);
    for (let i = 0; i < controlCount; i++) {
      filtered[i] = reflectIntoRange(filtered[i]!, -1, 1);
    }
    seeds.push(filtered);
  }
  return seeds;
}

export class IslandEvolution {
  readonly options: IslandEvolutionOptions;
  readonly islands: IslandState[];
  private generation = 0;

  constructor(seeds: Float64Array[], options: Partial<IslandEvolutionOptions> = {}) {
    if (seeds.length === 0) throw new RangeError("at least one seed is required");
    const controlCount = seeds[0]!.length;
    if (controlCount < 1 || seeds.some(seed => seed.length !== controlCount)) {
      throw new RangeError("all islands need equal-sized nonempty coefficient vectors");
    }
    this.options = { ...DEFAULT_OPTIONS, ...options };
    if (this.options.islandCount < 2 || this.options.populationPerIsland < 4 ||
        !(this.options.coefficientLimit > 0) ||
        (this.options.populationPerIsland & 1) !== 0) {
      throw new RangeError("island populations must be even and at least four");
    }
    this.islands = Array.from({ length: this.options.islandCount }, (_, index): IslandState => ({
      mean: Float64Array.from(seeds[index % seeds.length]!),
      sigma: new Float64Array(controlCount).fill(0.18),
      best: null,
      stagnation: 0,
      generation: 0,
    }));
  }

  get controlCount(): number {
    return this.islands[0]!.mean.length;
  }

  get generationIndex(): number {
    return this.generation;
  }

  generate(): IslandCandidate[] {
    const output: IslandCandidate[] = [];
    const pairs = this.options.populationPerIsland / 2;
    const exploratoryPairs = Math.ceil(pairs * this.options.explorationFraction);
    for (let islandIndex = 0; islandIndex < this.islands.length; islandIndex++) {
      const island = this.islands[islandIndex]!;
      for (let pair = 0; pair < pairs; pair++) {
        const stream = new PhiloxStream(
          this.generation >>> 0,
          Math.floor(this.generation / 2 ** 32) >>> 0,
          islandIndex * pairs + pair,
          this.options.key,
        );
        const epsilon = new Float64Array(this.controlCount);
        for (let coefficient = 0; coefficient < this.controlCount; coefficient++) {
          epsilon[coefficient] = stream.nextNormal();
        }
        const exploratory = pair >= pairs - exploratoryPairs;
        const randomField = exploratory ? smoothPeriodic(epsilon, 4) : epsilon;
        for (const sign of [1, -1]) {
          const coefficients = new Float64Array(this.controlCount);
          for (let coefficient = 0; coefficient < this.controlCount; coefficient++) {
            const center = exploratory ? 0 : island.mean[coefficient]!;
            const radius = exploratory ? 0.45 : island.sigma[coefficient]!;
            coefficients[coefficient] = reflectIntoRange(
              center + sign * radius * randomField[coefficient]!,
              -this.options.coefficientLimit,
              this.options.coefficientLimit,
            );
          }
          output.push({
            island: islandIndex,
            candidateInIsland: 2 * pair + (sign < 0 ? 1 : 0),
            coefficients,
            exploratory,
          });
        }
      }
    }
    return output;
  }

  update(observations: IslandObservation[], lapTimeEpsilon = 1e-6): void {
    const grouped = Array.from({ length: this.islands.length }, () => [] as IslandObservation[]);
    for (const observation of observations) grouped[observation.candidate.island]?.push(observation);
    for (let islandIndex = 0; islandIndex < this.islands.length; islandIndex++) {
      const island = this.islands[islandIndex]!;
      const ranked = grouped[islandIndex]!.sort((a, b) =>
        compareFeasibleFirst(a.score, b.score, lapTimeEpsilon));
      if (ranked.length === 0) continue;
      const eliteCount = Math.max(2, Math.floor(ranked.length * this.options.eliteFraction));
      const elites = ranked.slice(0, eliteCount);
      const weights = elites.map((_, rank) => Math.log(eliteCount + 0.5) - Math.log(rank + 1));
      const weightSum = weights.reduce((sum, value) => sum + value, 0);
      const priorMean = island.mean.slice();
      for (let coefficient = 0; coefficient < this.controlCount; coefficient++) {
        let targetMean = 0;
        for (let elite = 0; elite < elites.length; elite++) {
          targetMean += weights[elite]! * elites[elite]!.candidate.coefficients[coefficient]!;
        }
        targetMean /= weightSum;
        island.mean[coefficient] = reflectIntoRange(
          (1 - this.options.meanLearningRate) * priorMean[coefficient]! +
            this.options.meanLearningRate * targetMean,
          -this.options.coefficientLimit,
          this.options.coefficientLimit,
        );
        let targetVariance = 0;
        for (let elite = 0; elite < elites.length; elite++) {
          const difference = elites[elite]!.candidate.coefficients[coefficient]! -
            priorMean[coefficient]!;
          targetVariance += weights[elite]! * difference * difference;
        }
        targetVariance /= weightSum;
        const variance = (1 - this.options.varianceLearningRate) * island.sigma[coefficient]! ** 2 +
          this.options.varianceLearningRate * targetVariance;
        island.sigma[coefficient] = Math.max(this.options.varianceFloor, Math.sqrt(variance));
      }
      const winner = ranked[0]!;
      const acceptanceRate = ranked.filter(observation => observation.score.feasible).length /
        ranked.length;
      if (acceptanceRate < this.options.acceptanceTarget) {
        for (let coefficient = 0; coefficient < this.controlCount; coefficient++) {
          island.sigma[coefficient] = Math.max(
            this.options.varianceFloor,
            0.8 * island.sigma[coefficient]!,
          );
        }
      }
      if (island.best === null ||
          compareFeasibleFirst(winner.score, island.best.score, lapTimeEpsilon) < 0) {
        island.best = {
          candidate: { ...winner.candidate, coefficients: winner.candidate.coefficients.slice() },
          score: { ...winner.score },
        };
        island.stagnation = 0;
      } else {
        island.stagnation++;
      }
      island.generation++;
    }
    this.generation++;
    if (this.generation % this.options.migrationInterval === 0) this.migrate();
    this.restartStagnant();
  }

  private migrate(): void {
    const donors = this.islands.map(island => island.best?.candidate.coefficients.slice() ?? null);
    for (let destination = 0; destination < this.islands.length; destination++) {
      const donor = donors[(destination + this.islands.length - 1) % this.islands.length] ?? null;
      if (donor === null) continue;
      const island = this.islands[destination]!;
      for (let coefficient = 0; coefficient < this.controlCount; coefficient++) {
        island.mean[coefficient] = 0.8 * island.mean[coefficient]! + 0.2 * donor[coefficient]!;
      }
    }
  }

  private restartStagnant(): void {
    const globalBest = this.best()?.candidate.coefficients;
    for (let index = 0; index < this.islands.length; index++) {
      const island = this.islands[index]!;
      if (island.stagnation < this.options.restartGenerations) continue;
      const stream = new PhiloxStream(this.generation, 0, 0x52535400 + index, this.options.key);
      for (let coefficient = 0; coefficient < this.controlCount; coefficient++) {
        const center = globalBest?.[coefficient] ?? 0;
        island.mean[coefficient] = reflectIntoRange(
          center + 0.2 * stream.nextNormal(),
          -this.options.coefficientLimit,
          this.options.coefficientLimit,
        );
        island.sigma[coefficient] = 0.18;
      }
      island.best = null;
      island.stagnation = 0;
    }
  }

  best(): IslandObservation | null {
    let best: IslandObservation | null = null;
    for (const island of this.islands) {
      if (island.best !== null &&
          (best === null || compareFeasibleFirst(island.best.score, best.score) < 0)) {
        best = island.best;
      }
    }
    return best;
  }

  snapshot(): IslandEvolutionSnapshot {
    return {
      generation: this.generation,
      islands: this.islands.map(island => ({
        mean: Array.from(island.mean),
        sigma: Array.from(island.sigma),
        stagnation: island.stagnation,
        generation: island.generation,
      })),
    };
  }

  restore(snapshot: IslandEvolutionSnapshot): void {
    if (!Number.isInteger(snapshot.generation) || snapshot.generation < 0 ||
        snapshot.islands.length !== this.islands.length) {
      throw new Error("checkpoint island topology does not match the optimizer");
    }
    for (let index = 0; index < this.islands.length; index++) {
      const source = snapshot.islands[index]!;
      const destination = this.islands[index]!;
      if (source.mean.length !== this.controlCount || source.sigma.length !== this.controlCount ||
          source.mean.some(value =>
            !Number.isFinite(value) || Math.abs(value) > this.options.coefficientLimit) ||
          source.sigma.some(value => !Number.isFinite(value) || value <= 0)) {
        throw new Error("checkpoint contains an invalid island state");
      }
      destination.mean = Float64Array.from(source.mean);
      destination.sigma = Float64Array.from(source.sigma);
      destination.stagnation = source.stagnation;
      destination.generation = source.generation;
      destination.best = null;
    }
    this.generation = snapshot.generation;
  }

  /** Seed one island from an externally reranked incumbent. */
  inject(
    coefficients: ArrayLike<number>,
    islandIndex = 0,
    sigma: number | ArrayLike<number> = 0.1,
  ): void {
    const island = this.islands[islandIndex];
    if (island === undefined || coefficients.length !== this.controlCount ||
        (typeof sigma === "number"
          ? !(sigma > 0) || !Number.isFinite(sigma)
          : sigma.length !== this.controlCount)) {
      throw new RangeError("invalid island injection");
    }
    const mean = Float64Array.from(coefficients);
    if (Array.from(mean).some(value =>
      !Number.isFinite(value) || Math.abs(value) > this.options.coefficientLimit)) {
      throw new RangeError("injected coefficients exceed the search domain");
    }
    island.mean = mean;
    island.sigma = typeof sigma === "number"
      ? new Float64Array(mean.length).fill(sigma)
      : Float64Array.from(sigma);
    if (Array.from(island.sigma).some(value => !(value > 0) || !Number.isFinite(value))) {
      throw new RangeError("invalid island injection variance");
    }
    island.best = null;
    island.stagnation = 0;
  }

  /** Exact trajectory-preserving refinement plus h^2 mutation scaling. */
  refine(): void {
    for (const island of this.islands) {
      island.mean = refinePeriodicQuintic(island.mean);
      const refinedSigma = refinePeriodicQuintic(island.sigma);
      for (let i = 0; i < refinedSigma.length; i++) {
        refinedSigma[i] = Math.max(this.options.varianceFloor, 0.25 * refinedSigma[i]!);
      }
      island.sigma = refinedSigma;
      island.best = null;
      island.stagnation = 0;
    }
  }

  /** Remap all island state when spectral modes or residual knots are activated. */
  remap(
    transform: (values: Float64Array) => Float64Array,
    sigmaForNewCoordinate: number | ArrayLike<number> = 0.08,
    sigmaTransform: (values: Float64Array) => Float64Array = transform,
  ): void {
    let targetLength = -1;
    for (const island of this.islands) {
      const nextMean = transform(island.mean);
      const mappedSigma = sigmaTransform(island.sigma);
      if (targetLength < 0) targetLength = nextMean.length;
      if (nextMean.length !== targetLength || mappedSigma.length !== targetLength) {
        throw new Error("island remap produced inconsistent coefficient dimensions");
      }
      for (let i = 0; i < mappedSigma.length; i++) {
        if (!(mappedSigma[i]! > 0) || !Number.isFinite(mappedSigma[i]!)) {
          mappedSigma[i] = typeof sigmaForNewCoordinate === "number"
            ? sigmaForNewCoordinate
            : sigmaForNewCoordinate[i] ?? NaN;
        }
        if (!(mappedSigma[i]! > 0) || !Number.isFinite(mappedSigma[i]!)) {
          throw new Error("island remap has no valid variance for a new coordinate");
        }
      }
      island.mean = nextMean;
      island.sigma = mappedSigma;
      island.best = null;
      island.stagnation = 0;
    }
  }
}

/** Keep near-optimal lines separated by the normalized lateral RMS metric. */
export function selectDiverseNearOptimal(
  observations: IslandObservation[],
  count: number,
  timeTolerance: number,
  minimumDistance: number,
): IslandObservation[] {
  const ranked = observations.slice().sort((a, b) => compareFeasibleFirst(a.score, b.score));
  const bestTime = ranked.find(item => item.score.feasible)?.score.lapTime ?? Infinity;
  const selected: IslandObservation[] = [];
  for (const observation of ranked) {
    if (!observation.score.feasible || observation.score.lapTime > bestTime + timeTolerance) continue;
    const distinct = selected.every(existing => {
      let sum = 0;
      const a = observation.candidate.coefficients;
      const b = existing.candidate.coefficients;
      for (let i = 0; i < a.length; i++) sum += (a[i]! - b[i]!) ** 2;
      return Math.sqrt(sum / a.length) >= minimumDistance;
    });
    if (distinct) selected.push(observation);
    if (selected.length >= count) break;
  }
  return selected;
}

/** Feasibility repair along the parent-to-proposal segment. */
export function backtrackToFeasible(
  parent: ArrayLike<number>,
  proposal: ArrayLike<number>,
  feasible: (coefficients: Float64Array) => boolean,
  minimumScale = 1 / 64,
): Float64Array | null {
  for (let scale = 1; scale >= minimumScale; scale *= 0.5) {
    const trial = new Float64Array(parent.length);
    for (let i = 0; i < trial.length; i++) {
      trial[i] = (parent[i] ?? 0) + scale * ((proposal[i] ?? 0) - (parent[i] ?? 0));
    }
    if (feasible(trial)) return trial;
  }
  return null;
}
