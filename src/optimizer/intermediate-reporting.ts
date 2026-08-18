export const INTERMEDIATE_REPORT_INTERVAL_MS = 30_000;

/** Return the last complete reporting interval. */
export function completedReportingInterval(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new RangeError("invalid optimizer elapsed time");
  }
  return Math.floor(elapsedMs / INTERMEDIATE_REPORT_INTERVAL_MS);
}
