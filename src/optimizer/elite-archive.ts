export interface TimeArchiveEntry {
  lapTime: number;
  signature: ArrayLike<number>;
}

function signatureRms(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return Infinity;
  let squared = 0;
  for (let index = 0; index < a.length; index++) {
    squared += ((a[index] ?? 0) - (b[index] ?? 0)) ** 2;
  }
  return Math.sqrt(squared / a.length);
}

/** Retain fast alternatives across time bands and physically distinct basins. */
export function selectDiverseTimeArchive<T extends TimeArchiveEntry>(
  entries: readonly T[],
  maximumCount: number,
  timeBandS: number,
  entriesPerBand: number,
  minimumSignatureRms: number,
): T[] {
  if (!Number.isInteger(maximumCount) || maximumCount < 1 ||
      !(timeBandS > 0) || !Number.isInteger(entriesPerBand) || entriesPerBand < 1 ||
      !(minimumSignatureRms >= 0)) {
    throw new RangeError("invalid elite archive selection request");
  }
  const selected: T[] = [];
  const bands = new Map<number, number>();
  const ranked = entries
    .filter(entry => Number.isFinite(entry.lapTime))
    .slice()
    .sort((a, b) => a.lapTime - b.lapTime);
  for (const entry of ranked) {
    if (selected.some(existing =>
      signatureRms(existing.signature, entry.signature) < minimumSignatureRms)) {
      continue;
    }
    const band = Math.floor(entry.lapTime / timeBandS);
    if ((bands.get(band) ?? 0) >= entriesPerBand) continue;
    selected.push(entry);
    bands.set(band, (bands.get(band) ?? 0) + 1);
    if (selected.length >= maximumCount) break;
  }
  return selected;
}
