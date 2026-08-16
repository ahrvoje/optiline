import { hash32 } from "@/optimizer/ph-search";

export interface OptimizerSeed {
  lo: number;
  hi: number;
}

let lastSeed: OptimizerSeed | null = null;

/** Return a fresh seed pair and prevent an identical consecutive run even if
 * the entropy source is replaced by a repeating test or browser source. */
export function nextOptimizerSeed(
  fill: (values: Uint32Array<ArrayBuffer>) => void = values => {
    crypto.getRandomValues(values);
  },
): OptimizerSeed {
  const values = new Uint32Array(2);
  fill(values);
  const lo = values[0]! >>> 0;
  let hi = values[1]! >>> 0;
  if (lastSeed?.lo === lo && lastSeed.hi === hi) hi = (hi + 0x9e3779b9) >>> 0;
  lastSeed = { lo, hi };
  return lastSeed;
}

/** Fold both stored 32-bit seed words into the exactly representable 24-bit
 * integer passed through the f32 WGSL settings buffer. */
export function gpuSearchSeed(seed: OptimizerSeed): number {
  const rotatedHi = ((seed.hi << 16) | (seed.hi >>> 16)) >>> 0;
  return hash32((seed.lo ^ rotatedHi ^ 0xa511e9b3) >>> 0) & 0x00ffffff;
}
