/**
 * §14.6 batch latency controller. Pure and unit-testable.
 *
 * The optimizer worker tunes the number of chains per dispatch so that
 * one measured dispatch wall time stays between TARGET_MIN_MS and
 * TARGET_MAX_MS. It starts with one proposal per chain and all chains
 * in a single dispatch; when a dispatch exceeds TARGET_MAX_MS the chain
 * range is split across multiple dispatches (§14.6). STOP then only has
 * to wait for one in-flight sub-dispatch, which bounds STOP latency.
 */

export const TARGET_MIN_MS = 20;
export const TARGET_MAX_MS = 50;

export interface TunerState {
  /** Chains per dispatch; total batch = ceil(chainCount / chainsPerDispatch) dispatches. */
  chainsPerDispatch: number;
  /** Total chain count of the population (constant per run). */
  chainCount: number;
}

export function createTuner(chainCount: number): TunerState {
  return { chainsPerDispatch: chainCount, chainCount };
}

/** Smallest granularity: one workgroup batch row (must stay >= 32). */
export const MIN_CHAINS_PER_DISPATCH = 32;

/**
 * Update after one measured dispatch. Halve on overrun, grow by 2x when
 * comfortably under the lower target and not yet at full width. The
 * step is a power-of-two factor so the dispatch partition stays a clean
 * cover of the chain range.
 */
export function tuneAfterDispatch(state: TunerState, measuredMs: number): TunerState {
  let c = state.chainsPerDispatch;
  if (!Number.isFinite(measuredMs) || measuredMs < 0) return state;
  if (measuredMs > TARGET_MAX_MS) {
    c = Math.max(MIN_CHAINS_PER_DISPATCH, c >> 1);
  } else if (measuredMs < TARGET_MIN_MS / 2 && c < state.chainCount) {
    c = Math.min(state.chainCount, c << 1);
  }
  if (c === state.chainsPerDispatch) return state;
  return { chainsPerDispatch: c, chainCount: state.chainCount };
}

/** Partition the chain range for one batch into dispatch sub-ranges. */
export function dispatchRanges(state: TunerState): { base: number; count: number }[] {
  const out: { base: number; count: number }[] = [];
  for (let base = 0; base < state.chainCount; base += state.chainsPerDispatch) {
    out.push({ base, count: Math.min(state.chainsPerDispatch, state.chainCount - base) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Batch latency statistics for OptimizerEvent progress reports.       */
/* ------------------------------------------------------------------ */
export interface LatencyStats {
  median: number;
  p95: number;
  worst: number;
}

/** Ring of recent whole-batch latencies. Pure operations only. */
export interface LatencyWindow {
  samples: number[];
  capacity: number;
}

export function createLatencyWindow(capacity = 128): LatencyWindow {
  return { samples: [], capacity };
}

export function pushLatency(win: LatencyWindow, ms: number): LatencyWindow {
  const samples = win.samples.length >= win.capacity
    ? [...win.samples.slice(1), ms]
    : [...win.samples, ms];
  return { samples, capacity: win.capacity };
}

export function latencyStats(win: LatencyWindow): LatencyStats {
  if (win.samples.length === 0) return { median: 0, p95: 0, worst: 0 };
  const sorted = [...win.samples].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
  return {
    median: at(0.5),
    p95: at(0.95),
    worst: sorted[sorted.length - 1] as number,
  };
}
