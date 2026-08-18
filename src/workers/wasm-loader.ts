/**
 * WASIp1 reactor loader (§6.4) — implements src/model/wasm-api.ts.
 *
 * Fetches and instantiates
 *   <base>/wasm/optiline_certifier.wasm
 *   <base>/wasm/optiline_playback.wasm
 * which are the outputs of the CMake wasm build:
 *   cmake -S . -B build/wasm -G Ninja -DOPTILINE_WASM=ON
 *   cmake --build build/wasm
 * The build outputs MUST be copied to public/wasm/ (see
 * public/wasm/README.md); Vite serves public/ verbatim at the app base.
 *
 * WASI import policy (§6.4): the `wasi_snapshot_preview1` namespace is
 * built with a Proxy. Only deterministic stubs are provided for imports
 * the linked module actually requires; any other requested import
 * receives a function that TRAPS with the import's name on first call.
 * The production reactors never access files, clocks, randomness,
 * environment variables, processes, or networks. `fd_write` is stubbed
 * deterministically to capture debug text into an error-context string;
 * `proc_exit` traps. `_initialize` is called once after instantiation.
 *
 * Byte-length validation: every call validates input lengths against
 * the module-reported region sizes, and typed-array views are recreated
 * from `memory.buffer` on every access so any (non-production) memory
 * growth cannot leave a detached view in use (§6.4).
 *
 * ------------------------------------------------------------------
 * Region map (must mirror c/wasm/certifier_exports.c REGION MAP):
 *   certifier regions (op_buf_ptr/op_buf_len ids):
 *     0 JSON_IN   20 MiB  UTF-8 JSON input (source/asset/profile)
 *     1 JSON_AUX  64 KiB  vehicle-settings JSON input
 *     2 JSON_OUT  24 MiB  UTF-8 JSON output
 *     3 GENOTYPE  64 f64  candidate genotype input
 *     4 PREIMAGE  256 f64 warm-start input / certified output
 *     5 PROFILE   8192*7 f64 packed profile nodes output (§20.3 order)
 *     6 CERT      16 f64  certificate doubles output (layout below)
 *     7 ERR       18 f64  error detail: [0]=code, [1]=count, [2..17]
 *     8 CHAIN_IO  328 f64 CPU-search chain state I/O (layout below)
 *   playback regions:
 *     0 LINE_IN   384 f64 preimage 256 f64 then 64 gate pairs (128 f64)
 *     1 FRAME     8 f64   frame/point output
 *     2 ERR       18 f64  error detail (same layout)
 *
 * CERT region layout (f64 indices):
 *   0 lapTimeS               6 speedFixedPointResidual
 *   1 maxInterpResidual      7 lapTimeDelta
 *   2 minPreimageSpeed       8 adaptiveEdgeCount
 *   3 maxSeamResidual        9 pass (op_result, 0 = pass)
 *   4 minContainmentBound   10 codeVersion
 *   5 maxUtilizationBound   11 lineLengthM        12..15 reserved (0)
 *
 * CHAIN_IO region layout (f64 indices):
 *   0 lapTime  1 energy  2 sigma  3 level  4 chainId  5 accepted
 *   6 stagnation  7 valid  8..71 genotype[64]  72..327 preimage[256]
 * ------------------------------------------------------------------
 */
import type { CertificateReportJson } from "@/model/contracts";
import {
  WasmCallError,
  type CertifiedCandidate,
  type CertifierApi,
  type PlaybackApi,
  type WasmErrorDetail,
  type WasmLoader,
} from "@/model/wasm-api";

/* Region ids — keep in sync with the C REGION MAP comments. */
export const RGN_JSON_IN = 0;
export const RGN_JSON_AUX = 1;
export const RGN_JSON_OUT = 2;
export const RGN_GENOTYPE = 3;
export const RGN_PREIMAGE = 4;
export const RGN_PROFILE = 5;
export const RGN_CERT = 6;
export const RGN_ERR = 7;
export const RGN_CHAIN_IO = 8;

export const PB_RGN_LINE_IN = 0;
export const PB_RGN_FRAME = 1;
export const PB_RGN_ERR = 2;

export const PROFILE_NODE_DOUBLES = 7;

/** CPU-search chain I/O record length in f64 words. */
export const CHAIN_IO_DOUBLES = 328;

/** Extended CPU fallback interface (§22) over extra certifier exports.
 * These exports wrap c/src/op_cpu_search.c through the reactor layer;
 * see c/wasm/certifier_exports.c. */
export interface CpuSearchApi {
  /** Set Philox key and seed lap time T0 for the run (§13.1, §13.6). */
  cpuConfig(seedLo: number, seedHi: number, t0LapTime: number): void;
  /** Build chain `slot` from the GENOTYPE region; returns nothing or throws. */
  cpuChainInit(slot: number, chainId: number, level: number): void;
  /** One §13 search step; returns the §14.5 first-failure reject code
   * (0 = valid proposal). Throws WasmCallError on hard failure. */
  cpuSearchStep(slot: number, batchLo: number, batchHi: number): number;
  /** Copy chain `slot` into the CHAIN_IO region and return it parsed. */
  cpuChainRead(slot: number): CpuChainRecord;
  /** Rebuild chain `slot` from the CHAIN_IO region contents. */
  cpuChainLoad(slot: number): void;
  cpuChainSwap(slotA: number, slotB: number): void;
  cpuChainSetSigma(slot: number, sigma: number): void;
  /** §13.5 restart: rebuild from the genotype in CHAIN_IO (global best)
   * plus eight top-step-size mutations with bounded retries. */
  cpuChainRestart(slot: number, batchLo: number, batchHi: number): void;
  /** Write a genotype (64 f64) into the GENOTYPE region. */
  writeGenotype(genotype: Float64Array): void;
  /** Write a full chain record into the CHAIN_IO region. */
  writeChainIo(record: CpuChainRecord): void;
}

export interface CpuChainRecord {
  lapTime: number;
  energy: number;
  sigma: number;
  level: number;
  chainId: number;
  accepted: number;
  stagnation: number;
  valid: number;
  genotype: Float64Array; // 64
  preimage: Float64Array; // 256
}

export type CertifierHandle = CertifierApi & CpuSearchApi;

/* ------------------------------------------------------------------ */
/* WASI stubs.                                                        */
/* ------------------------------------------------------------------ */
interface WasiContext {
  memory: () => WebAssembly.Memory;
  debugText: string;
}

function makeWasiNamespace(ctx: WasiContext): Record<string, unknown> {
  const known: Record<string, (...args: number[]) => number> = {
    /** Deterministic fd_write: capture text, report success. */
    fd_write: (_fd, iovsPtr, iovsLen, nwrittenPtr) => {
      const mem = ctx.memory();
      const dv = new DataView(mem.buffer);
      let total = 0;
      let text = "";
      const decoder = new TextDecoder();
      for (let i = 0; i < (iovsLen ?? 0); i++) {
        const base = dv.getUint32((iovsPtr ?? 0) + 8 * i, true);
        const len = dv.getUint32((iovsPtr ?? 0) + 8 * i + 4, true);
        text += decoder.decode(new Uint8Array(mem.buffer, base, len).slice());
        total += len;
      }
      ctx.debugText = (ctx.debugText + text).slice(-4096);
      dv.setUint32(nwrittenPtr ?? 0, total, true);
      return 0; // WASI errno success
    },
    proc_exit: (code) => {
      throw new Error(`wasm reactor called proc_exit(${code})`);
    },
  };
  // §6.4: a missing import must TRAP with its name, never silently
  // return success. The Proxy hands out a throwing function for any
  // import the linked module requests beyond the deterministic stubs.
  return new Proxy(known, {
    get(target, prop: string | symbol) {
      if (typeof prop !== "string") return undefined;
      const hit = target[prop];
      if (hit !== undefined) return hit;
      return (): never => {
        throw new Error(
          `wasi_snapshot_preview1.${prop} is not stubbed; the production ` +
            "reactors must not require this import (§6.4)",
        );
      };
    },
    has() {
      // Instantiation looks imports up by [[Get]]; report presence so
      // the trap-on-call function is used for unknown names.
      return true;
    },
  });
}

/* ------------------------------------------------------------------ */
/* Instantiation.                                                     */
/* ------------------------------------------------------------------ */
interface ReactorExports {
  memory: WebAssembly.Memory;
  _initialize: () => void;
  op_ver: () => number;
  op_ws_init: () => number;
  op_buf_ptr: (region: number) => number;
  op_buf_len: (region: number) => number;
  op_err_detail: () => number;
  [name: string]: unknown;
}

function wasmUrl(name: string): string {
  if (import.meta.env.DEV) return new URL(`/${name}`, self.location.origin).toString();
  return new URL(`../${name}`, self.location.href).toString();
}

async function instantiateReactor(name: string): Promise<{
  exports: ReactorExports;
  ctx: WasiContext;
}> {
  const ctx: WasiContext = {
    memory: () => exportsRef.memory,
    debugText: "",
  };
  const imports: WebAssembly.Imports = {
    wasi_snapshot_preview1: makeWasiNamespace(ctx) as WebAssembly.ModuleImports,
  };
  const url = wasmUrl(name);
  let instance: WebAssembly.Instance;
  try {
    const streamed = await WebAssembly.instantiateStreaming(fetch(url), imports);
    instance = streamed.instance;
  } catch {
    // Content-Type fallback (dev servers without application/wasm).
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`failed to fetch ${url}: HTTP ${resp.status}`);
    }
    const bytes = await resp.arrayBuffer();
    const result = await WebAssembly.instantiate(bytes, imports);
    instance = result.instance;
  }
  const exports = instance.exports as unknown as ReactorExports;
  for (const required of ["memory", "_initialize", "op_ver", "op_ws_init", "op_buf_ptr", "op_buf_len", "op_err_detail"]) {
    if (!(required in instance.exports)) {
      throw new Error(`${name} does not export required symbol ${required}`);
    }
  }
  const exportsRef = exports;
  exports._initialize(); // §6.4: reactor initialization
  return { exports, ctx };
}

/* ------------------------------------------------------------------ */
/* Region access helper. Views are recreated on every use so that any  */
/* memory growth (forbidden in production, §6.4) cannot leave a        */
/* detached view live.                                                */
/* ------------------------------------------------------------------ */
class Regions {
  private readonly ptrCache = new Map<number, { ptr: number; len: number }>();

  constructor(
    private readonly exports: ReactorExports,
    private readonly moduleName: string,
  ) {}

  private meta(region: number): { ptr: number; len: number } {
    let m = this.ptrCache.get(region);
    if (!m) {
      const ptr = this.exports.op_buf_ptr(region) >>> 0;
      const len = this.exports.op_buf_len(region) >>> 0;
      if (ptr === 0 || len === 0) {
        throw new Error(`${this.moduleName}: unknown buffer region ${region}`);
      }
      m = { ptr, len };
      this.ptrCache.set(region, m);
    }
    const mem = this.exports.memory.buffer;
    if (m.ptr + m.len > mem.byteLength) {
      throw new Error(`${this.moduleName}: region ${region} exceeds memory`);
    }
    return m;
  }

  bytes(region: number): Uint8Array {
    const { ptr, len } = this.meta(region);
    return new Uint8Array(this.exports.memory.buffer, ptr, len);
  }

  f64(region: number): Float64Array {
    const { ptr, len } = this.meta(region);
    if (ptr % 8 !== 0) {
      throw new Error(`${this.moduleName}: region ${region} is not 8-byte aligned`);
    }
    return new Float64Array(this.exports.memory.buffer, ptr, len >> 3);
  }

  byteLength(region: number): number {
    return this.meta(region).len;
  }

  writeString(region: number, text: string): number {
    const encoded = new TextEncoder().encode(text);
    const target = this.bytes(region);
    if (encoded.byteLength > target.byteLength) {
      throw new Error(
        `${this.moduleName}: payload of ${encoded.byteLength} bytes exceeds ` +
          `region ${region} capacity ${target.byteLength}`,
      );
    }
    target.set(encoded);
    return encoded.byteLength;
  }

  readString(region: number, byteLength: number): string {
    const src = this.bytes(region);
    if (byteLength < 0 || byteLength > src.byteLength) {
      throw new Error(`${this.moduleName}: invalid output length ${byteLength}`);
    }
    return new TextDecoder().decode(src.slice(0, byteLength));
  }
}

function readVersion(exports: ReactorExports): string {
  const ptr = exports.op_ver() >>> 0;
  const mem = new Uint8Array(exports.memory.buffer);
  let end = ptr;
  const bound = Math.min(mem.length, ptr + 128);
  while (end < bound && mem[end] !== 0) end++;
  return new TextDecoder().decode(mem.slice(ptr, end));
}

function readErrorDetail(exports: ReactorExports, regions: Regions, errRegion: number): WasmErrorDetail {
  const count = exports.op_err_detail() | 0;
  const err = regions.f64(errRegion);
  const code = err[0] ?? 0;
  const n = Math.max(0, Math.min(16, count));
  return { code, detail: err.slice(2, 2 + n) };
}

function throwWasmError(
  exports: ReactorExports,
  regions: Regions,
  errRegion: number,
  ctx: WasiContext,
  what: string,
  returned: number,
): never {
  const d = readErrorDetail(exports, regions, errRegion);
  const debug = ctx.debugText ? `; wasm debug: ${ctx.debugText}` : "";
  throw new WasmCallError(
    d.code !== 0 ? d.code : -returned,
    d.detail,
    `${what} failed with op_result ${-returned}${debug}`,
  );
}

/* ------------------------------------------------------------------ */
/* Certifier API.                                                     */
/* ------------------------------------------------------------------ */
interface CertifierExports extends ReactorExports {
  op_track_compile_json: (srcLen: number) => number;
  op_track_validate_json: (assetLen: number) => number;
  op_ctx_load: (assetLen: number, vehicleLen: number) => number;
  op_score_candidate: () => number;
  op_score_candidate_warm: () => number;
  op_score_candidate_dense: () => number;
  op_score_candidate_dense_warm: () => number;
  op_certify_candidate: () => number;
  op_certify_candidate_warm: () => number;
  op_profile_validate_json: (profileLen: number) => number;
  op_cpu_config: (seedLo: number, seedHi: number, t0: number) => number;
  op_cpu_chain_init: (slot: number, chainId: number, level: number) => number;
  op_cpu_search_step_e: (slot: number, batchLo: number, batchHi: number) => number;
  op_cpu_chain_read: (slot: number) => number;
  op_cpu_chain_load: (slot: number) => number;
  op_cpu_chain_swap: (a: number, b: number) => number;
  op_cpu_chain_set_sigma: (slot: number, sigma: number) => number;
  op_cpu_chain_restart: (slot: number, batchLo: number, batchHi: number) => number;
}

function certificateFromDoubles(cert: Float64Array): CertificateReportJson {
  return {
    maxInterpResidual: cert[1] ?? 0,
    minPreimageSpeed: cert[2] ?? 0,
    maxSeamResidual: cert[3] ?? 0,
    minContainmentBound: cert[4] ?? 0,
    maxUtilizationBound: cert[5] ?? 0,
    speedFixedPointResidual: cert[6] ?? 0,
    lapTimeDelta: cert[7] ?? 0,
    adaptiveEdgeCount: (cert[8] ?? 0) | 0,
    codeVersion: (cert[10] ?? 0) | 0,
    pass: (cert[9] ?? 1) === 0,
  };
}

function makeCertifierApi(
  exports: CertifierExports,
  ctx: WasiContext,
): CertifierHandle {
  const regions = new Regions(exports, "optiline_certifier");
  let initialized = false;

  const fail = (what: string, code: number): never =>
    throwWasmError(exports, regions, RGN_ERR, ctx, what, code);

  const readChainIo = (): CpuChainRecord => {
    const io = regions.f64(RGN_CHAIN_IO);
    return {
      lapTime: io[0] ?? 0,
      energy: io[1] ?? 0,
      sigma: io[2] ?? 0,
      level: io[3] ?? 0,
      chainId: io[4] ?? 0,
      accepted: io[5] ?? 0,
      stagnation: io[6] ?? 0,
      valid: io[7] ?? 0,
      genotype: io.slice(8, 72),
      preimage: io.slice(72, 328),
    };
  };

  const writeCandidateInputs = (genotype: Float64Array, warmPreimage?: Float64Array): void => {
    if (genotype.length !== 64) {
      throw new WasmCallError(1, new Float64Array(0), "genotype must have 64 values");
    }
    if (warmPreimage !== undefined && warmPreimage.length !== 256) {
      throw new WasmCallError(1, new Float64Array(0), "warm preimage must have 256 values");
    }
    regions.f64(RGN_GENOTYPE).set(genotype);
    if (warmPreimage !== undefined) regions.f64(RGN_PREIMAGE).set(warmPreimage);
  };

  const api: CertifierHandle = {
    version: () => readVersion(exports),
    initWorkspace: () => {
      if (initialized) return;
      const r = exports.op_ws_init() | 0;
      if (r < 0) fail("op_ws_init", r);
      initialized = true;
    },
    compileTrack: (sourceJson: string): string => {
      const len = regions.writeString(RGN_JSON_IN, sourceJson);
      const out = exports.op_track_compile_json(len) | 0;
      if (out < 0) fail("op_track_compile_json", out);
      return regions.readString(RGN_JSON_OUT, out);
    },
    validateTrack: (assetJson: string): string => {
      const len = regions.writeString(RGN_JSON_IN, assetJson);
      const out = exports.op_track_validate_json(len) | 0;
      if (out < 0) fail("op_track_validate_json", out);
      return regions.readString(RGN_JSON_OUT, out);
    },
    loadContext: (assetJson: string, vehicleJson: string): void => {
      const aLen = regions.writeString(RGN_JSON_IN, assetJson);
      const vLen = regions.writeString(RGN_JSON_AUX, vehicleJson);
      const r = exports.op_ctx_load(aLen, vLen) | 0;
      if (r < 0) fail("op_ctx_load", r);
    },
    scoreCandidate: (genotype: Float64Array, warmPreimage?: Float64Array) => {
      writeCandidateInputs(genotype, warmPreimage);
      const scored = (warmPreimage === undefined
        ? exports.op_score_candidate()
        : exports.op_score_candidate_warm()) | 0;
      if (scored < 0) fail("op_score_candidate", scored);
      return {
        lapTime: regions.f64(RGN_CERT)[0] ?? Number.POSITIVE_INFINITY,
        preimage: regions.f64(RGN_PREIMAGE).slice(0, 256),
      };
    },
    scoreCandidateDense: (genotype: Float64Array, warmPreimage?: Float64Array) => {
      writeCandidateInputs(genotype, warmPreimage);
      const scored = (warmPreimage === undefined
        ? exports.op_score_candidate_dense()
        : exports.op_score_candidate_dense_warm()) | 0;
      if (scored < 0) fail("op_score_candidate_dense", scored);
      return {
        lapTime: regions.f64(RGN_CERT)[0] ?? Number.POSITIVE_INFINITY,
        preimage: regions.f64(RGN_PREIMAGE).slice(0, 256),
      };
    },
    certifyCandidate: (genotype: Float64Array, warmPreimage?: Float64Array): CertifiedCandidate => {
      writeCandidateInputs(genotype, warmPreimage);
      const edges = (warmPreimage === undefined
        ? exports.op_certify_candidate()
        : exports.op_certify_candidate_warm()) | 0;
      if (edges < 0) fail("op_certify_candidate", edges);
      const cert = regions.f64(RGN_CERT).slice(0, 16);
      const nodeDoubles = edges * PROFILE_NODE_DOUBLES;
      const profileRegion = regions.f64(RGN_PROFILE);
      if (nodeDoubles > profileRegion.length) {
        throw new WasmCallError(1, cert, "profile output exceeds region size");
      }
      return {
        lapTime: cert[0] ?? Number.POSITIVE_INFINITY,
        preimage: regions.f64(RGN_PREIMAGE).slice(0, 256),
        nodes: profileRegion.slice(0, nodeDoubles),
        edgeCount: edges,
        certificate: certificateFromDoubles(cert),
      };
    },
    validateProfile: (profileJson: string): string => {
      const len = regions.writeString(RGN_JSON_IN, profileJson);
      const out = exports.op_profile_validate_json(len) | 0;
      if (out < 0) fail("op_profile_validate_json", out);
      return regions.readString(RGN_JSON_OUT, out);
    },
    lastErrorDetail: (): WasmErrorDetail => readErrorDetail(exports, regions, RGN_ERR),

    /* --- CPU fallback extension (§22) --- */
    cpuConfig: (seedLo, seedHi, t0) => {
      const r = exports.op_cpu_config(seedLo >>> 0, seedHi >>> 0, t0) | 0;
      if (r < 0) fail("op_cpu_config", r);
    },
    cpuChainInit: (slot, chainId, level) => {
      const r = exports.op_cpu_chain_init(slot | 0, chainId >>> 0, level >>> 0) | 0;
      if (r < 0) fail("op_cpu_chain_init", r);
    },
    cpuSearchStep: (slot, batchLo, batchHi): number => {
      const r = exports.op_cpu_search_step_e(slot | 0, batchLo >>> 0, batchHi >>> 0) | 0;
      if (r < 0) fail("op_cpu_search_step_e", r);
      return r;
    },
    cpuChainRead: (slot): CpuChainRecord => {
      const r = exports.op_cpu_chain_read(slot | 0) | 0;
      if (r < 0) fail("op_cpu_chain_read", r);
      return readChainIo();
    },
    cpuChainLoad: (slot) => {
      const r = exports.op_cpu_chain_load(slot | 0) | 0;
      if (r < 0) fail("op_cpu_chain_load", r);
    },
    cpuChainSwap: (a, b) => {
      const r = exports.op_cpu_chain_swap(a | 0, b | 0) | 0;
      if (r < 0) fail("op_cpu_chain_swap", r);
    },
    cpuChainSetSigma: (slot, sigma) => {
      const r = exports.op_cpu_chain_set_sigma(slot | 0, sigma) | 0;
      if (r < 0) fail("op_cpu_chain_set_sigma", r);
    },
    cpuChainRestart: (slot, batchLo, batchHi) => {
      const r = exports.op_cpu_chain_restart(slot | 0, batchLo >>> 0, batchHi >>> 0) | 0;
      if (r < 0) fail("op_cpu_chain_restart", r);
    },
    writeGenotype: (genotype) => {
      if (genotype.length !== 64) {
        throw new WasmCallError(1, new Float64Array(0), "genotype must have 64 values");
      }
      regions.f64(RGN_GENOTYPE).set(genotype);
    },
    writeChainIo: (rec) => {
      if (rec.genotype.length !== 64 || rec.preimage.length !== 256) {
        throw new WasmCallError(1, new Float64Array(0), "bad chain record shape");
      }
      const io = regions.f64(RGN_CHAIN_IO);
      io[0] = rec.lapTime;
      io[1] = rec.energy;
      io[2] = rec.sigma;
      io[3] = rec.level;
      io[4] = rec.chainId;
      io[5] = rec.accepted;
      io[6] = rec.stagnation;
      io[7] = rec.valid;
      io.set(rec.genotype, 8);
      io.set(rec.preimage, 72);
    },
  };
  return api;
}

/* ------------------------------------------------------------------ */
/* Playback API.                                                      */
/* ------------------------------------------------------------------ */
interface PlaybackExports extends ReactorExports {
  op_line_load: () => number;
  op_span_arc_forward_e: (span: number, nu: number) => number;
  op_span_length_e: (span: number) => number;
  op_arc_inverse_e: (span: number, s: number) => number;
  op_point_at_distance_e: (s: number) => number;
  op_eval_frame_e: (span: number, nu: number) => number;
}

function makePlaybackApi(exports: PlaybackExports, ctx: WasiContext): PlaybackApi {
  const regions = new Regions(exports, "optiline_playback");
  let initialized = false;
  const fail = (what: string, code: number): never =>
    throwWasmError(exports, regions, PB_RGN_ERR, ctx, what, code);

  const checkSpan = (spanIndex: number): void => {
    if (!Number.isInteger(spanIndex) || spanIndex < 0 || spanIndex >= 128) {
      throw new WasmCallError(1, new Float64Array(0), `bad span index ${spanIndex}`);
    }
  };

  return {
    version: () => readVersion(exports),
    initWorkspace: () => {
      if (initialized) return;
      const r = exports.op_ws_init() | 0;
      if (r < 0) fail("op_ws_init", r);
      initialized = true;
    },
    loadLine: (preimage: Float64Array, gatePoints: Float64Array): void => {
      if (preimage.length !== 256) {
        throw new WasmCallError(1, new Float64Array(0), "preimage must have 256 values");
      }
      if (gatePoints.length !== 128) {
        throw new WasmCallError(1, new Float64Array(0), "gatePoints must have 128 values");
      }
      const line = regions.f64(PB_RGN_LINE_IN);
      line.set(preimage, 0);
      line.set(gatePoints, 256);
      const r = exports.op_line_load() | 0;
      if (r < 0) fail("op_line_load", r);
    },
    spanArcForward: (spanIndex: number, nu: number): number => {
      checkSpan(spanIndex);
      return exports.op_span_arc_forward_e(spanIndex, nu);
    },
    spanLength: (spanIndex: number): number => {
      checkSpan(spanIndex);
      return exports.op_span_length_e(spanIndex);
    },
    arcLengthInverse: (spanIndex: number, s: number): number => {
      checkSpan(spanIndex);
      const nu = exports.op_arc_inverse_e(spanIndex, s);
      if (nu < 0) fail("op_arc_inverse_e", Math.round(nu));
      return nu;
    },
    pointAtDistance: (s: number) => {
      const span = exports.op_point_at_distance_e(s) | 0;
      if (span < 0) fail("op_point_at_distance_e", span);
      const frame = regions.f64(PB_RGN_FRAME);
      return {
        spanIndex: span,
        nu: frame[0] ?? 0,
        x: frame[1] ?? 0,
        y: frame[2] ?? 0,
      };
    },
    evalFrame: (spanIndex: number, nu: number): Float64Array => {
      checkSpan(spanIndex);
      const r = exports.op_eval_frame_e(spanIndex, nu) | 0;
      if (r < 0) fail("op_eval_frame_e", r);
      return regions.f64(PB_RGN_FRAME).slice(0, 5);
    },
    lastErrorDetail: (): WasmErrorDetail => readErrorDetail(exports, regions, PB_RGN_ERR),
  };
}

/* ------------------------------------------------------------------ */
/* Loader entry points (WasmLoader).                                  */
/* ------------------------------------------------------------------ */
export async function loadCertifier(): Promise<CertifierHandle> {
  const { exports, ctx } = await instantiateReactor("optiline_certifier.wasm");
  return makeCertifierApi(exports as CertifierExports, ctx);
}

export async function loadPlayback(): Promise<PlaybackApi> {
  const { exports, ctx } = await instantiateReactor("optiline_playback.wasm");
  return makePlaybackApi(exports as PlaybackExports, ctx);
}

export const wasmLoader: WasmLoader = { loadCertifier, loadPlayback };
