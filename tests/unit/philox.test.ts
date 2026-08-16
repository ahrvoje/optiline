/**
 * Philox4x32-10 known-answer tests (§13.6, §24.7) for the TypeScript
 * implementation in src/optimizer/philox.ts.
 *
 * The vectors are the published Random123 known-answer vectors; the
 * same vectors are asserted on the C99 and WGSL sides. If these fail,
 * the generator is wrong — do not update the expected words.
 */
import { describe, expect, it } from "vitest";
import * as philoxModule from "@/optimizer/philox";
import { exportNames, findExport, missingExportMessage } from "./support/api-probe";

const mod = philoxModule as Record<string, unknown>;

type Vec4 = [number, number, number, number];
type Vec2 = [number, number];

const FN_NAMES = [
  "philox4x32",
  "philox4x32_10",
  "philox",
  "philoxBlock",
  "philox4x32Ten",
] as const;

/**
 * Resolve the block function and adapt to its calling convention.
 * Accepted conventions:
 *   f([c0,c1,c2,c3], [k0,k1])            arrays or Uint32Arrays
 *   f(Uint32Array(4), Uint32Array(2))
 *   f(c0, c1, c2, c3, k0, k1)
 * Returns 4 u32 words (array-like).
 */
function resolvePhilox(): (counter: Vec4, key: Vec2) => Vec4 {
  const raw = findExport(mod, FN_NAMES);
  if (typeof raw !== "function") {
    throw new Error(missingExportMessage("Philox4x32-10 block function", FN_NAMES, mod));
  }
  const fn = raw as (...args: unknown[]) => unknown;

  const conventions: ((c: Vec4, k: Vec2) => unknown)[] = [
    (c, k) => fn(c, k),
    (c, k) => fn(new Uint32Array(c), new Uint32Array(k)),
    (c, k) => fn(c[0], c[1], c[2], c[3], k[0], k[1]),
  ];
  for (const call of conventions) {
    try {
      const out = call([1, 2, 3, 4], [5, 6]);
      const words = toWords(out);
      if (words !== null) {
        return (c, k) => {
          const result = toWords(call(c, k));
          if (result === null) throw new Error("Philox call returned a non 4-word result");
          return result;
        };
      }
    } catch {
      // try the next convention
    }
  }
  throw new Error(
    `Philox export found but no known calling convention worked. ` +
      `Module exports: [${exportNames(mod).join(", ")}]`,
  );
}

function toWords(out: unknown): Vec4 | null {
  if (out === null || out === undefined) return null;
  const arr = out as ArrayLike<number>;
  if (typeof arr.length !== "number" || arr.length < 4) return null;
  const w = [arr[0], arr[1], arr[2], arr[3]].map((x) =>
    typeof x === "number" && Number.isFinite(x) ? x >>> 0 : Number.NaN,
  );
  if (w.some((x) => Number.isNaN(x))) return null;
  return [w[0] as number, w[1] as number, w[2] as number, w[3] as number];
}

function hex(words: Vec4): string[] {
  return words.map((w) => "0x" + w.toString(16).padStart(8, "0"));
}

describe("Philox4x32-10 known-answer vectors (§13.6, §24.7)", () => {
  it("counter (0,0,0,0), key (0,0)", () => {
    const philox = resolvePhilox();
    const out = philox([0, 0, 0, 0], [0, 0]);
    expect(hex(out)).toEqual(hex([0x6627e8d5, 0xe169c58d, 0xbc57ac4c, 0x9b00dbd8]));
  });

  it("counter all-ff, key all-ff", () => {
    const philox = resolvePhilox();
    const out = philox(
      [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff],
      [0xffffffff, 0xffffffff],
    );
    expect(hex(out)).toEqual(hex([0x408f276d, 0x41c83b0e, 0xa20bc7c6, 0x6d5451fd]));
  });

  it("pi-digits counter and key", () => {
    const philox = resolvePhilox();
    const out = philox(
      [0x243f6a88, 0x85a308d3, 0x13198a2e, 0x03707344],
      [0xa4093822, 0x299f31d0],
    );
    expect(hex(out)).toEqual(hex([0xd16cfe09, 0x94fdcceb, 0x5001e420, 0x24126ea1]));
  });

  it("is a pure function: identical inputs give identical outputs", () => {
    const philox = resolvePhilox();
    const a = philox([7, 11, 13, 17], [19, 23]);
    const b = philox([7, 11, 13, 17], [19, 23]);
    expect(a).toEqual(b);
  });
});

describe("open-interval uniform conversion U = (x + 0.5) * 2^-32 (§13.6)", () => {
  const UNIFORM_NAMES = [
    "toUniform",
    "u32ToUniform",
    "uniformOpen",
    "openUniform",
    "u32ToOpenUnit",
    "toOpenUnit",
    "wordToUniform",
    "uniform",
  ] as const;
  const rawUniform = findExport(mod, UNIFORM_NAMES);
  const toUniform =
    typeof rawUniform === "function" ? (rawUniform as (x: number) => number) : undefined;

  // The conversion may be a private helper rather than an export; skip
  // (visibly, not fake-pass) when no export matches.
  it.skipIf(toUniform === undefined)(
    "maps u32 words into the open interval (0,1) with exact endpoints",
    () => {
      const f = toUniform as (x: number) => number;
      // Exact binary64 values: both operands are exactly representable.
      expect(f(0)).toBe(0.5 * 2 ** -32);
      expect(f(0xffffffff)).toBe((0xffffffff + 0.5) * 2 ** -32);
      expect(f(0)).toBeGreaterThan(0);
      expect(f(0xffffffff)).toBeLessThan(1);
    },
  );

  it.skipIf(toUniform === undefined)(
    "keeps a Philox stream strictly inside (0,1)",
    () => {
      const philox = resolvePhilox();
      const f = toUniform as (x: number) => number;
      for (let block = 0; block < 1024; block++) {
        const words = philox([block, 0, 0, block >>> 1], [0xdeadbeef, 0x12345678]);
        for (const w of words) {
          const u = f(w);
          expect(u).toBeGreaterThan(0);
          expect(u).toBeLessThan(1);
          expect(u).toBe((w + 0.5) * 2 ** -32);
        }
      }
    },
  );
});
