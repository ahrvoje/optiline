/**
 * Philox4x32-10 counter-based RNG, exactly per PROJECT_SPECIFICATION.md
 * §13.6, for host-side deterministic decisions (replica-exchange swap
 * draws, checkpoint-stable orchestration) and for the §24.7 cross-
 * language known-answer tests against the C99 and WGSL implementations.
 *
 * Counter convention (§13.6): (batch_low, batch_high, chain_id,
 * draw_block). The key is the user 64-bit seed as two u32 words.
 *
 * This module is search control, not authoritative curve/dynamics
 * mathematics (§1): it never computes a geometric or dynamic quantity.
 */

const M0 = 0xd2511f53;
const M1 = 0xcd9e8d57;
const W0 = 0x9e3779b9;
const W1 = 0xbb67ae85;

/**
 * 32x32 -> 64 bit unsigned multiply using 16-bit limbs, the exact §13.6
 * sequence (shared with WGSL, which has no 64-bit integers).
 * Returns [hi, lo] as unsigned u32 values.
 */
export function mulHiLo(a: number, b: number): [number, number] {
  const a0 = a & 0xffff;
  const a1 = a >>> 16;
  const b0 = b & 0xffff;
  const b1 = b >>> 16;
  // Products fit in 2^32 (16x16 bits); Math.imul is unsuitable because
  // these must be full unsigned 32-bit products.
  const p0 = a0 * b0;
  const p1 = a0 * b1;
  const p2 = a1 * b0;
  const p3 = a1 * b1;
  const mid = (p0 >>> 16) + (p1 & 0xffff) + (p2 & 0xffff);
  const lo = ((p0 & 0xffff) | ((mid & 0xffff) << 16)) >>> 0;
  const hi = (p3 + (p1 >>> 16) + (p2 >>> 16) + (mid >>> 16)) >>> 0;
  return [hi, lo];
}

export interface PhiloxCounter {
  c0: number;
  c1: number;
  c2: number;
  c3: number;
}

export interface PhiloxKey {
  k0: number;
  k1: number;
}

type CounterInput = PhiloxCounter | ArrayLike<number>;
type KeyInput = PhiloxKey | ArrayLike<number>;

function counterWord(counter: CounterInput, field: keyof PhiloxCounter, index: number): number {
  return ("length" in counter ? counter[index] : counter[field]) ?? 0;
}

function keyWord(key: KeyInput, field: keyof PhiloxKey, index: number): number {
  return ("length" in key ? key[index] : key[field]) ?? 0;
}

/** Ten-round Philox4x32-10 block (§13.6). Returns four u32 words. */
export function philox4x32_10(
  ctr: CounterInput,
  key: KeyInput,
): [number, number, number, number] {
  let c0 = counterWord(ctr, "c0", 0) >>> 0;
  let c1 = counterWord(ctr, "c1", 1) >>> 0;
  let c2 = counterWord(ctr, "c2", 2) >>> 0;
  let c3 = counterWord(ctr, "c3", 3) >>> 0;
  let k0 = keyWord(key, "k0", 0) >>> 0;
  let k1 = keyWord(key, "k1", 1) >>> 0;
  for (let round = 0; round < 10; round++) {
    const [hi0, lo0] = mulHiLo(M0, c0);
    const [hi1, lo1] = mulHiLo(M1, c2);
    const n0 = (hi1 ^ c1 ^ k0) >>> 0;
    const n1 = lo1;
    const n2 = (hi0 ^ c3 ^ k1) >>> 0;
    const n3 = lo0;
    c0 = n0;
    c1 = n1;
    c2 = n2;
    c3 = n3;
    k0 = (k0 + W0) >>> 0;
    k1 = (k1 + W1) >>> 0;
  }
  return [c0, c1, c2, c3];
}

/** Open-interval uniform U = (x + 0.5) * 2^-32 (§13.6). */
export function philoxUniform(x: number): number {
  return ((x >>> 0) + 0.5) * 2 ** -32;
}

/** Descriptive alias used by the cross-language conformance suite. */
export const u32ToUniform = philoxUniform;

/**
 * Sequential word stream over draw blocks for one (batch, chain).
 * Each next() consumes one u32 word; a new Philox block is generated
 * every four words, incrementing draw_block.
 */
export class PhiloxStream {
  private block: [number, number, number, number] | null = null;
  private wordIndex = 0;
  private drawBlock: number;

  constructor(
    private readonly batchLo: number,
    private readonly batchHi: number,
    private readonly chainId: number,
    private readonly key: PhiloxKey,
    drawBlockStart = 0,
  ) {
    this.drawBlock = drawBlockStart >>> 0;
  }

  nextWord(): number {
    if (this.block === null || this.wordIndex === 4) {
      this.block = philox4x32_10(
        {
          c0: this.batchLo,
          c1: this.batchHi,
          c2: this.chainId,
          c3: this.drawBlock,
        },
        this.key,
      );
      this.drawBlock = (this.drawBlock + 1) >>> 0;
      this.wordIndex = 0;
    }
    const w = this.block[this.wordIndex] as number;
    this.wordIndex++;
    return w >>> 0;
  }

  nextUniform(): number {
    return philoxUniform(this.nextWord());
  }

  /** Irwin–Hall approximate normal: sum of 12 uniforms minus 6 (§13.2). */
  nextNormal(): number {
    let z = -6;
    for (let i = 0; i < 12; i++) z += this.nextUniform();
    return z;
  }
}

/**
 * §13.4 replica-exchange swap draw, deterministic across resume.
 * Counter domain documented for cross-implementation agreement:
 * (batch_lo, batch_hi, 0x45584348 ("EXCH"), pairIndex) where pairIndex =
 * lowerLevel * 32 + replica. One uniform word per decision (word 0).
 */
export const EXCHANGE_CHAIN_TAG = 0x45584348;

export function exchangeSwapUniform(
  batchLo: number,
  batchHi: number,
  pairIndex: number,
  key: PhiloxKey,
): number {
  const words = philox4x32_10(
    { c0: batchLo, c1: batchHi, c2: EXCHANGE_CHAIN_TAG, c3: pairIndex },
    key,
  );
  return philoxUniform(words[0]);
}

/** §13.2 reflection into [a, b]; nonnegative real modulo, never a clamp. */
export function reflectIntoRange(x: number, a: number, b: number): number {
  const w = b - a;
  if (!(w > 0)) return a;
  const two = 2 * w;
  let y = (x - a) % two;
  if (y < 0) y += two;
  return y <= w ? a + y : b - (y - w);
}

/** §13.1 temperature ladder tau_l = 10^(-6 + 6 l / 31), l = 0..31. */
export function temperatureLadder(level: number): number {
  return 10 ** (-6 + (6 * level) / 31);
}

/** §13.2 initial step size sigma_l = W_median * min(0.25, 0.002 * 2^(l/4)). */
export function initialSigma(level: number, wMedian: number): number {
  return wMedian * Math.min(0.25, 0.002 * 2 ** (level / 4));
}

/** §13.3 adaptation gain eta_n = 0.05 / sqrt(1 + n / 256). */
export function adaptationGain(n: number): number {
  return 0.05 / Math.sqrt(1 + n / 256);
}

/**
 * §13.3 level step-size update from the mean acceptance rate across the
 * level's replicas: log sigma += eta_n (A_rate - 0.234), clamped to
 * [log(1e-5 W), log(0.5 W)].
 */
export function adaptSigma(
  sigma: number,
  meanAcceptRate: number,
  n: number,
  wMedian: number,
): number {
  const lo = Math.log(1e-5 * wMedian);
  const hi = Math.log(0.5 * wMedian);
  let ls = Math.log(sigma) + adaptationGain(n) * (meanAcceptRate - 0.234);
  if (ls < lo) ls = lo;
  if (ls > hi) ls = hi;
  return Math.exp(ls);
}
