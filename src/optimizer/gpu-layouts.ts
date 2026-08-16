/**
 * Byte-exact TypeScript mirrors of the §14.4 storage-buffer records and
 * the optimizer checkpoint serialization.
 *
 * Every offset below is locked against PROJECT_SPECIFICATION.md §14.4
 * and c/include/optiline/op_abi.h; the C side has sizeof/offsetof tests,
 * and these pure helpers are unit-testable without a GPU device.
 *
 * All record I/O goes through DataView with explicit little-endian
 * access; WebGPU buffers are little-endian on every supported target
 * (§24.2 verifies the C ABI side).
 */

/* ------------------------------------------------------------------ */
/* ChainState — 1312 bytes (§14.4).                                    */
/* ------------------------------------------------------------------ */
export const CHAIN_STATE_SIZE = 1312;
export const CHAIN_OFF_SCALARS = 0; // vec4<f32>: lapTime, energy, sigma, temperature
export const CHAIN_OFF_IDS = 16; // vec4<u32>: chainId, level, acceptedCount, stagnation
export const CHAIN_OFF_GENOTYPE = 32; // array<f32, 64>
export const CHAIN_OFF_PREIMAGE = 288; // array<vec2<f32>, 128>

export const CHAIN_STATE_OFFSETS = Object.freeze({
  scalars: CHAIN_OFF_SCALARS,
  ids: CHAIN_OFF_IDS,
  genotype: CHAIN_OFF_GENOTYPE,
  preimage: CHAIN_OFF_PREIMAGE,
});

export const CHAIN_COUNT_GPU = 1024;
export const LEVEL_COUNT = 32;
export const REPLICAS_PER_LEVEL = 32;

export interface ChainStateRecord {
  lapTime: number;
  energy: number;
  sigma: number;
  temperature: number;
  chainId: number;
  level: number;
  acceptedCount: number;
  stagnation: number;
  /** 64 lateral gate offsets (f32 precision). */
  genotype: Float32Array;
  /** 128 complex preimage controls, packed re,im (256 f32). */
  preimage: Float32Array;
}

export function writeChainState(
  view: DataView,
  byteOffset: number,
  rec: ChainStateRecord,
): void {
  if (rec.genotype.length !== 64) throw new Error("genotype must have 64 entries");
  if (rec.preimage.length !== 256) throw new Error("preimage must have 256 entries");
  view.setFloat32(byteOffset + 0, rec.lapTime, true);
  view.setFloat32(byteOffset + 4, rec.energy, true);
  view.setFloat32(byteOffset + 8, rec.sigma, true);
  view.setFloat32(byteOffset + 12, rec.temperature, true);
  view.setUint32(byteOffset + 16, rec.chainId >>> 0, true);
  view.setUint32(byteOffset + 20, rec.level >>> 0, true);
  view.setUint32(byteOffset + 24, rec.acceptedCount >>> 0, true);
  view.setUint32(byteOffset + 28, rec.stagnation >>> 0, true);
  for (let i = 0; i < 64; i++) {
    view.setFloat32(byteOffset + CHAIN_OFF_GENOTYPE + 4 * i, rec.genotype[i] as number, true);
  }
  for (let i = 0; i < 256; i++) {
    view.setFloat32(byteOffset + CHAIN_OFF_PREIMAGE + 4 * i, rec.preimage[i] as number, true);
  }
}

export function readChainState(view: DataView, byteOffset: number): ChainStateRecord {
  const genotype = new Float32Array(64);
  const preimage = new Float32Array(256);
  for (let i = 0; i < 64; i++) {
    genotype[i] = view.getFloat32(byteOffset + CHAIN_OFF_GENOTYPE + 4 * i, true);
  }
  for (let i = 0; i < 256; i++) {
    preimage[i] = view.getFloat32(byteOffset + CHAIN_OFF_PREIMAGE + 4 * i, true);
  }
  return {
    lapTime: view.getFloat32(byteOffset + 0, true),
    energy: view.getFloat32(byteOffset + 4, true),
    sigma: view.getFloat32(byteOffset + 8, true),
    temperature: view.getFloat32(byteOffset + 12, true),
    chainId: view.getUint32(byteOffset + 16, true),
    level: view.getUint32(byteOffset + 20, true),
    acceptedCount: view.getUint32(byteOffset + 24, true),
    stagnation: view.getUint32(byteOffset + 28, true),
    genotype,
    preimage,
  };
}

/* ------------------------------------------------------------------ */
/* TrackGpuHeader — exactly 128 bytes (§14.4).                         */
/* Rows at byte offsets 0, 16, 32, 48, 64, 80, 96, 112.                */
/* ------------------------------------------------------------------ */
export const TRACK_HEADER_SIZE = 128;
export const TRACK_GPU_HEADER_SIZE = TRACK_HEADER_SIZE;
export const TRACK_GPU_HEADER_OFFSETS = Object.freeze({
  normalization: 0,
  vehicle: 16,
  dynamics: 32,
  aero: 48,
  counts: 64,
  dataOffsets: 80,
  resultOffsets: 96,
  runAndSeed: 112,
});

export interface TrackGpuHeaderRecord {
  /* row 0 (f32): world origin X/Y, scale H, 1/H */
  originX: number;
  originY: number;
  scaleH: number;
  invScaleH: number;
  /* row 16 (f32): normalized Le, We, Lv, Wv */
  leN: number;
  weN: number;
  lvN: number;
  wvN: number;
  /* row 32 (f32): vMax^2, ax+0, ax-0, ay0 */
  vmaxSq: number;
  axPlus0: number;
  axMinus0: number;
  ay0: number;
  /* row 48 (f32): p, delta, gamma, kappaMax (0 = disabled) */
  ellipseP: number;
  delta: number;
  gamma: number;
  kappaLimit: number;
  /* row 64 (u32): gate, span, microinterval, cell counts */
  gateCount: number;
  spanCount: number;
  microCount: number;
  cellCount: number;
  /* row 80 (u32): half-space, candidate-cell, gate, span offsets
   * (u32-word offsets inside the merged read-only track-data buffer) */
  halfspaceOff: number;
  candidateOff: number;
  gateOff: number;
  spanOff: number;
  /* row 96 (u32): counter, best-record, rejection, display offsets
   * counterOff/rejectionOff: word offsets inside the atomic counters
   * buffer; bestOff/displayOff: word offsets inside the records buffer */
  counterOff: number;
  bestOff: number;
  rejectionOff: number;
  displayOff: number;
  /* row 112 (u32): run-version low/high and seed low/high */
  runVersionLo: number;
  runVersionHi: number;
  seedLo: number;
  seedHi: number;
}

export function writeTrackGpuHeader(view: DataView, rec: TrackGpuHeaderRecord): void {
  const f = [
    rec.originX, rec.originY, rec.scaleH, rec.invScaleH,
    rec.leN, rec.weN, rec.lvN, rec.wvN,
    rec.vmaxSq, rec.axPlus0, rec.axMinus0, rec.ay0,
    rec.ellipseP, rec.delta, rec.gamma, rec.kappaLimit,
  ];
  for (let i = 0; i < 16; i++) view.setFloat32(4 * i, f[i] as number, true);
  const u = [
    rec.gateCount, rec.spanCount, rec.microCount, rec.cellCount,
    rec.halfspaceOff, rec.candidateOff, rec.gateOff, rec.spanOff,
    rec.counterOff, rec.bestOff, rec.rejectionOff, rec.displayOff,
    rec.runVersionLo, rec.runVersionHi, rec.seedLo, rec.seedHi,
  ];
  for (let i = 0; i < 16; i++) view.setUint32(64 + 4 * i, (u[i] as number) >>> 0, true);
}

/* ------------------------------------------------------------------ */
/* Corridor half-space vec4<f32>: (nx, ny, b, unused).                 */
/* Center gate vec4<f32>: (x, y, nx, ny) — point and left normal.      */
/* ------------------------------------------------------------------ */
export const HALFSPACE_SIZE = 16;
export const GATE_SIZE = 16;

export function writeHalfspace(
  view: DataView,
  byteOffset: number,
  nx: number,
  ny: number,
  b: number,
): void {
  view.setFloat32(byteOffset + 0, nx, true);
  view.setFloat32(byteOffset + 4, ny, true);
  view.setFloat32(byteOffset + 8, b, true);
  view.setFloat32(byteOffset + 12, 0, true);
}

export function writeGate(
  view: DataView,
  byteOffset: number,
  x: number,
  y: number,
  nx: number,
  ny: number,
): void {
  view.setFloat32(byteOffset + 0, x, true);
  view.setFloat32(byteOffset + 4, y, true);
  view.setFloat32(byteOffset + 8, nx, true);
  view.setFloat32(byteOffset + 12, ny, true);
}

/* ------------------------------------------------------------------ */
/* Provisional-best record (op_abi.h op_gpu_best_record) — 1296 bytes. */
/* ------------------------------------------------------------------ */
export const BEST_RECORD_SIZE = 1296;
export const BEST_RECORD_CAPACITY = 16; // ring capacity in the records buffer
export const BEST_OFF_LAP = 0; // f32
export const BEST_OFF_CHAIN = 4; // u32
export const BEST_OFF_BATCH_LO = 8; // u32
export const BEST_OFF_BATCH_HI = 12; // u32
export const BEST_OFF_GENOTYPE = 16; // f32[64]
export const BEST_OFF_PREIMAGE = 272; // f32[256]

export interface BestRecord {
  lapTime: number;
  chainId: number;
  batchLo: number;
  batchHi: number;
  genotype: Float32Array; // 64
  preimage: Float32Array; // 256
}

export function readBestRecord(view: DataView, byteOffset: number): BestRecord {
  const genotype = new Float32Array(64);
  const preimage = new Float32Array(256);
  for (let i = 0; i < 64; i++) {
    genotype[i] = view.getFloat32(byteOffset + BEST_OFF_GENOTYPE + 4 * i, true);
  }
  for (let i = 0; i < 256; i++) {
    preimage[i] = view.getFloat32(byteOffset + BEST_OFF_PREIMAGE + 4 * i, true);
  }
  return {
    lapTime: view.getFloat32(byteOffset + BEST_OFF_LAP, true),
    chainId: view.getUint32(byteOffset + BEST_OFF_CHAIN, true),
    batchLo: view.getUint32(byteOffset + BEST_OFF_BATCH_LO, true),
    batchHi: view.getUint32(byteOffset + BEST_OFF_BATCH_HI, true),
    genotype,
    preimage,
  };
}

/* ------------------------------------------------------------------ */
/* Atomic counters buffer layout (u32 words). Mirrored in WGSL.        */
/* ------------------------------------------------------------------ */
export const REJECTION_CODE_COUNT = 13;
// word offsets inside the counters buffer:
export const CTR_REJECTION = 0; // 13 words, §14.5 order
export const CTR_VALID = 13; // 1 word
export const CTR_ACCEPT_PER_LEVEL = 14; // 32 words
export const CTR_PROPOSALS_PER_LEVEL = 46; // 32 words
/** §24.4 instrumentation counters. All four MUST read back zero. */
export const CTR_INSTR_QUADRATURE = 78;
export const CTR_INSTR_INVERSE_LENGTH = 79;
export const CTR_INSTR_CLOSEST_POINT = 80;
export const CTR_INSTR_FINITE_DIFFERENCE = 81;
export const CTR_BEST_BITS = 82; // f32 lap-time bits, atomicMin protocol
export const CTR_RECORD_NEXT = 83; // best-record ring cursor
export const CTR_WORD_COUNT = 84;

/** Positive-f32 ordered bit pattern used for the atomicMin best race. */
export function f32ToOrderedBits(x: number): number {
  const buf = new ArrayBuffer(4);
  const dv = new DataView(buf);
  dv.setFloat32(0, x, true);
  return dv.getUint32(0, true);
}

export function orderedBitsToF32(bits: number): number {
  const buf = new ArrayBuffer(4);
  const dv = new DataView(buf);
  dv.setUint32(0, bits >>> 0, true);
  return dv.getFloat32(0, true);
}

/** Sentinel: +infinity bits (0x7f800000) means "no best yet". */
export const BEST_BITS_NONE = 0x7f800000;

/* ------------------------------------------------------------------ */
/* Records buffer layout (plain u32/f32): best ring + display lines.   */
/* ------------------------------------------------------------------ */
export const DISPLAY_MAX_LINES = 64;
export const DISPLAY_POINTS_PER_LINE = 256;
export const DISPLAY_LINE_FLOATS = DISPLAY_POINTS_PER_LINE * 2;

export function recordsBufferByteSize(): number {
  return (
    BEST_RECORD_CAPACITY * BEST_RECORD_SIZE +
    DISPLAY_MAX_LINES * DISPLAY_LINE_FLOATS * 4
  );
}

/** Word offsets inside the records buffer (mirrored into the header). */
export const RECORDS_BEST_WORD_OFF = 0;
export const RECORDS_DISPLAY_WORD_OFF = (BEST_RECORD_CAPACITY * BEST_RECORD_SIZE) / 4;

/* ------------------------------------------------------------------ */
/* Checkpoint serialization (§14.6, §16.4 resume).                     */
/* Layout: 512-byte header + chainCount * CHAIN_STATE_SIZE states.     */
/* ------------------------------------------------------------------ */
export const CHECKPOINT_MAGIC = 0x4f50434b; // "OPCK"
export const CHECKPOINT_VERSION = 1;
export const CHECKPOINT_HEADER_SIZE = 512;

export interface CheckpointHeader {
  runVersion: number;
  batchLo: number;
  batchHi: number;
  seedLo: number;
  seedHi: number;
  chainCount: number;
  /** Certified seed lap time T0 (§13.1), fixed for the run. */
  t0SeedLapTime: number;
  /** Current per-level step sizes (§13.3). */
  levelSigmas: Float32Array; // 32
  /** Adaptation update count n per level (§13.3 eta_n). */
  adaptationCount: number;
  bestLapTime: number; // +Infinity when none
}

export function serializeCheckpoint(
  headerOrStates: CheckpointHeader | ArrayBuffer | ArrayBufferView,
  suppliedStates?: ArrayBuffer,
): ArrayBuffer {
  const rawOnly = headerOrStates instanceof ArrayBuffer || ArrayBuffer.isView(headerOrStates);
  const rawView = rawOnly
    ? headerOrStates instanceof ArrayBuffer
      ? new Uint8Array(headerOrStates)
      : new Uint8Array(
          headerOrStates.buffer,
          headerOrStates.byteOffset,
          headerOrStates.byteLength,
        )
    : undefined;
  if (rawView !== undefined && rawView.byteLength % CHAIN_STATE_SIZE !== 0) {
    throw new Error("chain state block is not a whole number of records");
  }
  const chainStates = rawView !== undefined
    ? rawView.slice().buffer
    : suppliedStates;
  if (chainStates === undefined) throw new Error("chain state block is required");
  const header: CheckpointHeader = rawView !== undefined
    ? {
        runVersion: 0,
        batchLo: 0,
        batchHi: 0,
        seedLo: 0,
        seedHi: 0,
        chainCount: rawView.byteLength / CHAIN_STATE_SIZE,
        t0SeedLapTime: Number.POSITIVE_INFINITY,
        levelSigmas: new Float32Array(LEVEL_COUNT),
        adaptationCount: 0,
        bestLapTime: Number.POSITIVE_INFINITY,
      }
    : headerOrStates as CheckpointHeader;
  if (header.levelSigmas.length !== LEVEL_COUNT) {
    throw new Error("levelSigmas must have 32 entries");
  }
  const expected = header.chainCount * CHAIN_STATE_SIZE;
  if (chainStates.byteLength !== expected) {
    throw new Error(
      `chain state block is ${chainStates.byteLength} bytes; expected ${expected}`,
    );
  }
  const out = new ArrayBuffer(CHECKPOINT_HEADER_SIZE + expected);
  const dv = new DataView(out);
  dv.setUint32(0, CHECKPOINT_MAGIC, true);
  dv.setUint32(4, CHECKPOINT_VERSION, true);
  dv.setFloat64(8, header.runVersion, true);
  dv.setUint32(16, header.batchLo >>> 0, true);
  dv.setUint32(20, header.batchHi >>> 0, true);
  dv.setUint32(24, header.seedLo >>> 0, true);
  dv.setUint32(28, header.seedHi >>> 0, true);
  dv.setUint32(32, header.chainCount >>> 0, true);
  dv.setUint32(36, header.adaptationCount >>> 0, true);
  dv.setFloat64(40, header.t0SeedLapTime, true);
  dv.setFloat64(48, header.bestLapTime, true);
  for (let i = 0; i < LEVEL_COUNT; i++) {
    dv.setFloat32(56 + 4 * i, header.levelSigmas[i] as number, true);
  }
  new Uint8Array(out, CHECKPOINT_HEADER_SIZE).set(new Uint8Array(chainStates));
  return out;
}

export interface ParsedCheckpoint {
  header: CheckpointHeader;
  /** View into the checkpoint buffer; copy before uploading if needed. */
  chainStates: Uint8Array;
}

export function parseCheckpoint(buffer: ArrayBuffer): ParsedCheckpoint {
  if (buffer.byteLength < CHECKPOINT_HEADER_SIZE) {
    throw new Error("checkpoint too small");
  }
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== CHECKPOINT_MAGIC) {
    throw new Error("bad checkpoint magic");
  }
  if (dv.getUint32(4, true) !== CHECKPOINT_VERSION) {
    throw new Error("unsupported checkpoint version");
  }
  const chainCount = dv.getUint32(32, true);
  const expected = CHECKPOINT_HEADER_SIZE + chainCount * CHAIN_STATE_SIZE;
  if (buffer.byteLength !== expected) {
    throw new Error(`checkpoint is ${buffer.byteLength} bytes; expected ${expected}`);
  }
  const levelSigmas = new Float32Array(LEVEL_COUNT);
  for (let i = 0; i < LEVEL_COUNT; i++) {
    levelSigmas[i] = dv.getFloat32(56 + 4 * i, true);
  }
  return {
    header: {
      runVersion: dv.getFloat64(8, true),
      batchLo: dv.getUint32(16, true),
      batchHi: dv.getUint32(20, true),
      seedLo: dv.getUint32(24, true),
      seedHi: dv.getUint32(28, true),
      chainCount,
      adaptationCount: dv.getUint32(36, true),
      t0SeedLapTime: dv.getFloat64(40, true),
      bestLapTime: dv.getFloat64(48, true),
      levelSigmas,
    },
    chainStates: new Uint8Array(buffer, CHECKPOINT_HEADER_SIZE),
  };
}

/** Convenience inverse used by byte-contract tests and recovery tooling. */
export function deserializeCheckpoint(buffer: ArrayBuffer): ArrayBuffer {
  return parseCheckpoint(buffer).chainStates.slice().buffer;
}

/* ------------------------------------------------------------------ */
/* GPU buffer creation/upload helpers (thin; layout logic stays pure). */
/* ------------------------------------------------------------------ */
export function createStorageBuffer(
  device: GPUDevice,
  byteLength: number,
  usage: GPUBufferUsageFlags,
  label: string,
): GPUBuffer {
  return device.createBuffer({
    label,
    size: Math.max(16, (byteLength + 15) & ~15),
    usage,
  });
}

export function uploadBytes(
  device: GPUDevice,
  buffer: GPUBuffer,
  data: ArrayBuffer | ArrayBufferView,
  byteOffset = 0,
): void {
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  device.queue.writeBuffer(buffer, byteOffset, bytes);
}
