/**
 * TypeScript-facing API of the two WASIp1 reactors (§6.4).
 *
 * Implemented by src/workers/wasm-loader.ts over the raw exports of
 * optiline_certifier.wasm and optiline_playback.wasm. TypeScript
 * validates byte lengths before every call and recreates typed-array
 * views after any permitted memory growth (§6.4); production memory is
 * fixed-maximum and never grows during optimization or playback.
 */
import type { CertificateReportJson } from "@/model/contracts";

export interface WasmErrorDetail {
  /** op_result numeric code (op_types.h / OP_ERROR_CODE_VALUES). */
  code: number;
  /** Structured numeric detail fields written by the C side. */
  detail: Float64Array;
}

/** Thrown by loader wrappers when a reactor call reports failure. */
export class WasmCallError extends Error {
  constructor(
    public readonly opCode: number,
    public readonly detail: Float64Array,
    message: string,
  ) {
    super(message);
    this.name = "WasmCallError";
  }
}

export interface CertifiedCandidate {
  lapTime: number;
  /** 128 complex pairs, packed re,im. */
  preimage: Float64Array;
  /** Packed profile nodes, 7 doubles per node (§20.3 field order). */
  nodes: Float64Array;
  edgeCount: number;
  certificate: CertificateReportJson;
}

export interface ScoredCandidate {
  lapTime: number;
  /** Binary64 PH preimage after exact gate projection. */
  preimage: Float64Array;
}

/** optiline_certifier.wasm — certification and track compilation. */
export interface CertifierApi {
  /** Reactor version string, e.g. "optiline-certifier 1". */
  version(): string;
  /** One-time workspace initialization; idempotent. */
  initWorkspace(): void;
  /** Compile a source track JSON to a compiled-asset JSON (§20.2). */
  compileTrack(sourceJson: string): string;
  /** Re-validate a deserialized compiled asset (import path). */
  validateTrack(assetJson: string): string;
  /** Cache a compiled track + vehicle settings for candidate calls. */
  loadContext(assetJson: string, vehicleJson: string): void;
  /** Low-resolution exact-constraint score used only inside coordinate polish. */
  scoreCandidate(genotype: Float64Array, warmPreimage?: Float64Array): ScoredCandidate;
  /** 1024-edge score used to shortlist curvature-sensitive polish moves. */
  scoreCandidateDense(genotype: Float64Array, warmPreimage?: Float64Array): ScoredCandidate;
  /** Full binary64 rebuild + certification of one genotype (64 values). */
  certifyCandidate(genotype: Float64Array, warmPreimage?: Float64Array): CertifiedCandidate;
  /** Validate an imported profile JSON against the loaded context. */
  validateProfile(profileJson: string): string;
  /** Detail record of the most recent failed call. */
  lastErrorDetail(): WasmErrorDetail;
}

/** optiline_playback.wasm — analytic evaluation and §8.8 inverse only. */
export interface PlaybackApi {
  version(): string;
  initWorkspace(): void;
  /** Load a racing line: 128 complex preimage pairs + 64 gate points. */
  loadLine(preimage: Float64Array, gatePoints: Float64Array): void;
  /** Exact forward arc length on one span (§8.5). */
  spanArcForward(spanIndex: number, nu: number): number;
  /** Span exact length. */
  spanLength(spanIndex: number): number;
  /** §8.8 bounded inverse: local arc target -> local nu on one span. */
  arcLengthInverse(spanIndex: number, s: number): number;
  /** Diagnostic point-at-distance over the whole line. */
  pointAtDistance(s: number): {
    spanIndex: number;
    nu: number;
    x: number;
    y: number;
  };
  /** Analytic frame: x, y, tangentX, tangentY, kappa (§8.6, §12.9). */
  evalFrame(spanIndex: number, nu: number): Float64Array;
  lastErrorDetail(): WasmErrorDetail;
}

/** Loader entry points implemented in src/workers/wasm-loader.ts. */
export interface WasmLoader {
  loadCertifier(): Promise<CertifierApi>;
  loadPlayback(): Promise<PlaybackApi>;
}
