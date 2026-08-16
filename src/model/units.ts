/**
 * Unit conversion and formatting helpers (§5.1, §16.3, §20.4, §26).
 *
 * Speed is stored in m/s; the UI may display km/h. The conversion factor
 * is exactly 3.6 (KMH_PER_MPS from the shared contract).
 */
import { KMH_PER_MPS } from "@/model/contracts";

export function mpsToKmh(v: number): number {
  return v * KMH_PER_MPS;
}

export function kmhToMps(v: number): number {
  return v / KMH_PER_MPS;
}

/**
 * Strict numeric parsing (§26): accepts only an unambiguous ECMAScript
 * decimal literal with '.' as the decimal separator. Locale-ambiguous
 * forms (comma separators, grouping, spaces) and nonfinite values are
 * rejected with null rather than guessed at.
 */
const STRICT_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function parseStrictNumber(text: string): number | null {
  const t = text.trim();
  if (t.length === 0 || !STRICT_NUMBER.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/** Strict unsigned 32-bit integer parse (optimizer seed words, §16.3). */
export function parseStrictU32(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const v = Number(t);
  if (!Number.isSafeInteger(v) || v < 0 || v > 0xffffffff) return null;
  return v;
}

/** Lap time formatted to 0.001 s (§20.4 default save name). */
export function formatLapTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  return `${seconds.toFixed(3)} s`;
}

/** Signed time gap, e.g. "+1.204 s". */
export function formatGap(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  const sign = seconds >= 0 ? "+" : "−";
  return `${sign}${Math.abs(seconds).toFixed(3)} s`;
}

export function formatMeters(m: number, decimals = 0): string {
  if (!Number.isFinite(m)) return "—";
  return `${m.toFixed(decimals)} m`;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

/**
 * Count Unicode scalar values. String iteration yields code points, so
 * `[...s].length` counts scalar values for well-formed strings (§20.4).
 */
export function countUnicodeScalars(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** One binary64 ULP of |v| (used by the §12.9 clamp tolerance). */
const ULP_VIEW = new DataView(new ArrayBuffer(8));
export function ulp(v: number): number {
  const a = Math.abs(v);
  if (!Number.isFinite(a)) return NaN;
  if (a === 0) return Number.MIN_VALUE;
  ULP_VIEW.setFloat64(0, a);
  const bits = ULP_VIEW.getBigUint64(0);
  ULP_VIEW.setBigUint64(0, bits + 1n);
  return ULP_VIEW.getFloat64(0) - a;
}
