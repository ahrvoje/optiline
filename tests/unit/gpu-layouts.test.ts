/**
 * §14.4 storage-buffer record layout tests for
 * src/optimizer/gpu-layouts.ts.
 *
 * The byte contract is frozen by the specification table:
 *   ChainState: 1312 bytes; fields at offsets 0, 16, 32, 288.
 *   TrackGpuHeader: exactly 128 bytes; eight vec4 rows at
 *   0, 16, 32, 48, 64, 80, 96, 112.
 * TypeScript writers SHALL test every offset (§14.4); this suite is
 * that test on the TypeScript side.
 */
import { describe, expect, it } from "vitest";
import * as layoutsModule from "@/optimizer/gpu-layouts";
import {
  findFunction,
  findNumber,
  findObject,
  missingExportMessage,
  numericValues,
} from "./support/api-probe";

const mod = layoutsModule as Record<string, unknown>;

const CHAIN_STATE_BYTES = 1312;
const CHAIN_STATE_OFFSETS = [0, 16, 32, 288];
const HEADER_BYTES = 128;
const HEADER_OFFSETS = [0, 16, 32, 48, 64, 80, 96, 112];

const CHAIN_SIZE_NAMES = [
  "CHAIN_STATE_BYTES",
  "CHAIN_STATE_SIZE",
  "CHAIN_STATE_BYTE_SIZE",
  "CHAIN_STATE_STRIDE",
  "chainStateBytes",
];
const HEADER_SIZE_NAMES = [
  "TRACK_GPU_HEADER_BYTES",
  "TRACK_GPU_HEADER_SIZE",
  "TRACK_HEADER_BYTES",
  "TRACK_GPU_HEADER_BYTE_SIZE",
  "trackGpuHeaderBytes",
];
const CHAIN_OFFSET_NAMES = [
  "CHAIN_STATE_OFFSETS",
  "CHAIN_STATE_LAYOUT",
  "ChainStateOffsets",
  "chainStateOffsets",
  "chainStateLayout",
];
const HEADER_OFFSET_NAMES = [
  "TRACK_GPU_HEADER_OFFSETS",
  "TRACK_GPU_HEADER_LAYOUT",
  "TrackGpuHeaderOffsets",
  "trackGpuHeaderOffsets",
  "trackGpuHeaderLayout",
];

describe("ChainState byte layout (§14.4)", () => {
  it("record size is 1312 bytes", () => {
    const size = findNumber(mod, CHAIN_SIZE_NAMES);
    if (size === undefined) {
      throw new Error(missingExportMessage("ChainState byte size", CHAIN_SIZE_NAMES, mod));
    }
    expect(size).toBe(CHAIN_STATE_BYTES);
  });

  it("field offsets are 0 (scalars), 16 (ids), 32 (genotype), 288 (preimage)", () => {
    const layout = findObject(mod, CHAIN_OFFSET_NAMES);
    if (layout === undefined) {
      throw new Error(
        missingExportMessage("ChainState offset table", CHAIN_OFFSET_NAMES, mod),
      );
    }
    const values = new Set(numericValues(layout));
    for (const offset of CHAIN_STATE_OFFSETS) {
      expect(values, `offset ${offset} must appear in the exported layout`).toContain(offset);
    }
  });
});

describe("TrackGpuHeader byte layout (§14.4)", () => {
  it("record size is exactly 128 bytes", () => {
    const size = findNumber(mod, HEADER_SIZE_NAMES);
    if (size === undefined) {
      throw new Error(missingExportMessage("TrackGpuHeader byte size", HEADER_SIZE_NAMES, mod));
    }
    expect(size).toBe(HEADER_BYTES);
  });

  it("has all eight vec4 rows at offsets 0..112", () => {
    const layout = findObject(mod, HEADER_OFFSET_NAMES);
    if (layout === undefined) {
      throw new Error(
        missingExportMessage("TrackGpuHeader offset table", HEADER_OFFSET_NAMES, mod),
      );
    }
    const values = new Set(numericValues(layout));
    for (const offset of HEADER_OFFSETS) {
      expect(values, `row offset ${offset} must appear in the exported layout`).toContain(offset);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Roundtrip and checkpoint tests. The exact function signatures are   */
/* not fixed by the spec, so these resolve tolerantly and skip         */
/* (visibly) when no matching API exists yet.                          */
/* ------------------------------------------------------------------ */

const readChain = findFunction(mod, [
  "readChainState",
  "decodeChainState",
  "chainStateFromBuffer",
  "parseChainState",
]);
const writeChain = findFunction(mod, [
  "writeChainState",
  "encodeChainState",
  "chainStateToBuffer",
]);
const serializeCheckpoint = findFunction(mod, [
  "serializeCheckpoint",
  "encodeCheckpoint",
  "checkpointToBuffer",
]);
const deserializeCheckpoint = findFunction(mod, [
  "deserializeCheckpoint",
  "decodeCheckpoint",
  "checkpointFromBuffer",
]);

/**
 * A 1312-byte record whose f32 lanes are all finite (high byte of each
 * 32-bit word stays below 0x7f so no NaN/Inf payloads defeat a bitwise
 * roundtrip comparison).
 */
function patternRecord(): ArrayBuffer {
  const buffer = new ArrayBuffer(CHAIN_STATE_BYTES);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = i % 4 === 3 ? (i * 7) % 0x60 : (i * 131 + 17) % 251;
  }
  return buffer;
}

function callFlex(fn: (...args: never[]) => unknown, variants: unknown[][]): unknown {
  for (const args of variants) {
    try {
      const out = (fn as (...a: unknown[]) => unknown)(...args);
      if (out !== undefined) return out;
    } catch {
      // try next signature
    }
  }
  return undefined;
}

describe("ChainState roundtrip (§14.4)", () => {
  it.skipIf(readChain === undefined || writeChain === undefined)(
    "read → write → read is byte-stable without knowing the object shape",
    () => {
      const source = patternRecord();
      const state = callFlex(readChain as (...a: never[]) => unknown, [
        [new DataView(source), 0],
        [source, 0],
        [new Uint8Array(source), 0],
        [new DataView(source)],
        [source],
      ]);
      expect(state, "readChainState returned nothing for any known signature").toBeDefined();

      const target = new ArrayBuffer(CHAIN_STATE_BYTES);
      const wrote = callFlex(writeChain as (...a: never[]) => unknown, [
        [new DataView(target), 0, state],
        [target, 0, state],
        [state, new DataView(target), 0],
        [state, target, 0],
        [state],
      ]);
      // Some conventions return the buffer instead of writing in place.
      const written =
        wrote instanceof ArrayBuffer
          ? new Uint8Array(wrote)
          : ArrayBuffer.isView(wrote)
            ? new Uint8Array(wrote.buffer, wrote.byteOffset, wrote.byteLength)
            : new Uint8Array(target);

      expect(written.byteLength).toBe(CHAIN_STATE_BYTES);
      expect(Array.from(written)).toEqual(Array.from(new Uint8Array(source)));
    },
  );
});

describe("checkpoint serialize/deserialize (§14.6, §20.4)", () => {
  it.skipIf(serializeCheckpoint === undefined || deserializeCheckpoint === undefined)(
    "roundtrips a chain snapshot buffer byte-for-byte",
    () => {
      const chains = new ArrayBuffer(CHAIN_STATE_BYTES * 4);
      new Uint8Array(chains).set(
        Array.from({ length: CHAIN_STATE_BYTES * 4 }, (_, i) =>
          i % 4 === 3 ? (i * 5) % 0x60 : (i * 37 + 3) % 251,
        ),
      );

      const serialized = callFlex(serializeCheckpoint as (...a: never[]) => unknown, [
        [chains],
        [new Uint8Array(chains)],
        [{ chains, runVersion: 1 }],
      ]);
      expect(serialized, "serializeCheckpoint returned nothing").toBeDefined();

      const restored = callFlex(deserializeCheckpoint as (...a: never[]) => unknown, [
        [serialized],
      ]);
      expect(restored, "deserializeCheckpoint returned nothing").toBeDefined();

      const restoredBytes =
        restored instanceof ArrayBuffer
          ? new Uint8Array(restored)
          : ArrayBuffer.isView(restored)
            ? new Uint8Array(restored.buffer, restored.byteOffset, restored.byteLength)
            : typeof restored === "object" && restored !== null && "chains" in restored
              ? toBytes((restored as { chains: unknown }).chains)
              : undefined;
      expect(restoredBytes, "could not view deserialized checkpoint as bytes").toBeDefined();
      expect(Array.from(restoredBytes as Uint8Array)).toEqual(
        Array.from(new Uint8Array(chains)),
      );
    },
  );
});

function toBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}
