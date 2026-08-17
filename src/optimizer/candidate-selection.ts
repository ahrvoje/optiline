export type CandidateSource = "baseline" | "discovery" | "curvature";

export interface PendingCandidate {
  source: CandidateSource;
  /** Replacement key for candidates whose provisional scores are comparable. */
  queueKey: string;
  provisionalLapTime: number;
}

/**
 * Keep one pending candidate per comparable score domain. Discovery and
 * curvature lap times come from different evaluators, so one must never
 * evict the other before both receive the same binary64 certification.
 */
export function upsertPendingCandidate<T extends PendingCandidate>(
  queue: readonly T[],
  candidate: T,
): T[] {
  const queued = queue.find(item => item.queueKey === candidate.queueKey);
  if (queued !== undefined && queued.provisionalLapTime <= candidate.provisionalLapTime) {
    return queue.slice();
  }
  return [...queue.filter(item => item.queueKey !== candidate.queueKey), candidate];
}

/** Certified lap time is the only cross-representation adoption objective. */
export function shouldAdoptCertifiedLap(
  candidateLapTime: number,
  incumbentLapTime: number,
  epsilon = 1e-6,
): boolean {
  return Number.isFinite(candidateLapTime) &&
    candidateLapTime < incumbentLapTime - epsilon;
}
