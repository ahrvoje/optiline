/**
 * Optiline shared data contracts (PROJECT_SPECIFICATION.md §20, §21, App. C).
 *
 * This module is the authoritative TypeScript-side contract for worker
 * messages, persisted records, and application states. Exact PH certification
 * originates in C99/WASM; the V2 FP64 Fourier and curvature reference stages
 * are shared TypeScript worker modules, and coarse population scores use WGSL.
 */

/** Stable error codes (Appendix C). Errors are never identified by text. */
export type OpErrorCode =
  | "INVALID_INPUT"
  | "TRACK_CONSTRUCTION_FAILED"
  | "TRACK_OFFSET_CUSP"
  | "TRACK_BOUNDARY_INTERSECTION"
  | "CORRIDOR_CERTIFICATE_FAILED"
  | "PH_PROJECTION_FAILED"
  | "PH_RANK_DEFICIENT"
  | "PH_IRREGULAR"
  | "PH_INTERPOLATION_RESIDUAL"
  | "PH_SELF_INTERSECTION"
  | "PLAYBACK_ARC_LENGTH_INVERSION_FAILED"
  | "RECTANGLE_NOT_CONTAINED"
  | "DYNAMIC_PROFILE_FAILED"
  | "DYNAMIC_REFINEMENT_LIMIT"
  | "GPU_UNAVAILABLE"
  | "GPU_DEVICE_LOST"
  | "GPU_CERTIFICATION_MISMATCH"
  | "PROFILE_INCOMPATIBLE"
  | "PERSISTENCE_FAILED"
  | "STALE_MESSAGE";

/** Numeric values are frozen to match c/include/optiline/op_types.h. */
export const OP_ERROR_CODE_VALUES: Record<OpErrorCode, number> = {
  INVALID_INPUT: 1,
  TRACK_CONSTRUCTION_FAILED: 2,
  TRACK_OFFSET_CUSP: 3,
  TRACK_BOUNDARY_INTERSECTION: 4,
  CORRIDOR_CERTIFICATE_FAILED: 5,
  PH_PROJECTION_FAILED: 6,
  PH_RANK_DEFICIENT: 7,
  PH_IRREGULAR: 8,
  PH_INTERPOLATION_RESIDUAL: 9,
  PH_SELF_INTERSECTION: 10,
  PLAYBACK_ARC_LENGTH_INVERSION_FAILED: 11,
  RECTANGLE_NOT_CONTAINED: 12,
  DYNAMIC_PROFILE_FAILED: 13,
  DYNAMIC_REFINEMENT_LIMIT: 14,
  GPU_UNAVAILABLE: 15,
  GPU_DEVICE_LOST: 16,
  GPU_CERTIFICATION_MISMATCH: 17,
  PROFILE_INCOMPATIBLE: 18,
  PERSISTENCE_FAILED: 19,
  STALE_MESSAGE: 20,
};

export interface OpError {
  code: OpErrorCode;
  message: string;
  runVersion: number;
  /** Structured numeric detail fields; never parsed from message text. */
  detail: Record<string, number>;
}

/** GPU/CPU-search first-failure rejection codes (§14.5). */
export const REJECTION_LABELS = [
  "valid",
  "nonfinite_input",
  "projection_rank_failure",
  "projection_no_descent",
  "interpolation_residual",
  "irregular_preimage",
  "nonpositive_length",
  "racing_line_self_intersection",
  "rectangle_outside_corridor",
  "curvature_limit",
  "speed_envelope_no_convergence",
  "dynamic_infeasible",
  "nonfinite_lap_time",
] as const;
export type RejectionLabel = (typeof REJECTION_LABELS)[number];

/** Fixed topology (§8.2, §10.4, §12). */
export const GATE_COUNT = 64;
export const SPAN_COUNT = 128;
export const MICRO_COUNT = 256;
export const INCUMBENT_EDGES = 1024;
export const MAX_PROFILE_EDGES = 8192;
export const CHAIN_COUNT = 1024;

/** Application states (§16.5, §21). */
export type AppState =
  | "loading"
  | "ready"
  | "optimizing"
  | "stopping"
  | "certifying"
  | "playing"
  | "paused"
  | "gpuLost"
  | "error";

/** Vehicle and dynamics settings (§11.1). Stored in SI units. */
export interface VehicleSettings {
  massKg: number;
  lengthM: number;
  widthM: number;
  safetyMarginM: number;
  vMaxMps: number;
  axPlus0: number;
  axMinus0: number;
  ay0: number;
  ellipseP: number;
  dragAreaM2: number;
  downforceAreaM2: number;
  airDensity: number;
  /** null = disabled (§11.1). */
  kappaMax: number | null;
}

export const GRAVITY = 9.80665;

export const DEFAULT_VEHICLE: VehicleSettings = {
  massKg: 900,
  lengthM: 4.8,
  widthM: 2.0,
  safetyMarginM: 0,
  vMaxMps: 91.6667,
  axPlus0: 6.0,
  axMinus0: 14.0,
  ay0: 15.0,
  ellipseP: 2.0,
  dragAreaM2: 1.0,
  downforceAreaM2: 3.0,
  airDensity: 1.225,
  kappaMax: null,
};

export interface VehicleRange {
  min: number;
  max: number;
}
export const VEHICLE_RANGES: Record<Exclude<keyof VehicleSettings, "kappaMax">, VehicleRange> & {
  kappaMax: VehicleRange;
} = {
  massKg: { min: 100, max: 5000 },
  lengthM: { min: 1, max: 30 },
  widthM: { min: 0.5, max: 12 },
  safetyMarginM: { min: 0, max: 2 },
  vMaxMps: { min: 1, max: 150 },
  axPlus0: { min: 0.1, max: 30 },
  axMinus0: { min: 0.1, max: 50 },
  ay0: { min: 0.1, max: 50 },
  ellipseP: { min: 1, max: 8 },
  dragAreaM2: { min: 0, max: 10 },
  downforceAreaM2: { min: 0, max: 20 },
  airDensity: { min: 0.5, max: 1.5 },
  kappaMax: { min: 0.001, max: 2 },
};

export interface OptimizerSettings {
  /** 64-bit seed as two u32 words (§16.3, §20.3). */
  seedLo: number;
  seedHi: number;
  deterministic: boolean;
  /** Translucent in-progress candidate lines shown, at most 64 (§15.1). */
  candidateVisibility: number;
}

/** Track source JSON (§20.1), extension .optrack.json. */
export interface TrackSourceJson {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  direction: "counterclockwise" | "clockwise";
  centerGatesM: [number, number][];
  leftWidthM: number;
  rightWidthM: number;
  startGate: 0;
  tags: string[];
  sourceVersion: number;
}

/** Compiled track asset (§20.2). Numeric arrays have fixed lengths
 * recorded in schemas/compiled-track.schema.json. */
export interface CompiledTrackJson {
  schemaVersion: 1;
  source: TrackSourceJson;
  sourceSha256: string;
  normalization: { originX: number; originY: number; scaleH: number };
  centerPreimageControls: [number, number][]; // 128 complex pairs
  gatePoints: [number, number][]; // 64 physical gate points
  lapLengthM: number;
  curvature: { min: number; max: number; rhoLeft: number; rhoRight: number };
  leftBoundary: RationalOffsetSpanJson[];
  rightBoundary: RationalOffsetSpanJson[];
  cells: CorridorCellJson[];
  microCells: number[][]; // 256 lists, each up to 8 cell IDs
  renderSeeds: number[]; // tessellation seed parameters
  compilerVersion: number;
  certificateReport: CertificateReportJson;
}

export interface RationalOffsetSpanJson {
  srcSpan: number;
  u0: number;
  u1: number;
  /** Degree-9 homogeneous numerator controls [re, im] x 10. */
  h: [number, number][];
  /** Degree-9 weights, all > 0. */
  w: number[];
}

export interface CorridorCellJson {
  /** Normalized inequalities n.x <= b with |n| = 1; 3..8 rows. */
  halfSpaces: { nx: number; ny: number; b: number }[];
  gateLo: number;
  gateHi: number;
  neighbors: number[];
}

export interface CertificateReportJson {
  maxInterpResidual: number;
  minPreimageSpeed: number;
  maxSeamResidual: number;
  minContainmentBound: number;
  maxUtilizationBound: number;
  speedFixedPointResidual: number;
  adaptiveEdgeCount: number;
  lapTimeDelta: number;
  codeVersion: number;
  pass: boolean;
}

/** Saved profile (§20.3), extension .opprofile.json. */
export interface SavedProfileJson {
  schemaVersion: 2;
  profileId: string; // UUID v4
  name: string;
  createdAt: string; // ISO-8601 UTC
  trackId: string;
  trackFingerprint: string; // SHA-256
  vehicleSettings: VehicleSettings;
  dynamicSettings: OptimizerSettings;
  optimizerSeed: [number, number];
  lineLengthM: number;
  lapTimeS: number;
  profileNodes: ProfileNodeJson[];
  certificate: CertificateReportJson & { hash: string };
  /** Discovery metadata, canonical curvature, and optimality output. */
  v2Representations: V2RepresentationsJson;
}

export interface ProfileNodeJson {
  parameter: number;
  distance: number;
  time: number;
  q: number;
  acceleration: number;
  curvature: number;
  stability: number;
}

export interface DiscoveryRepresentationJson {
  schemaVersion: 2;
  kernelChartId: string;
  kernelModeCount: number;
  lateralFourierModes: number;
  lateralFourierCoefficients: number[];
  residualControlCount: number;
  residualCoefficients: number[];
  corridor: { lowerM: number; upperM: number; betaSafeRad: number };
}

export interface FinalCurvatureRepresentationJson {
  schemaVersion: 2;
  pathLengthM: number;
  winding: -1 | 1;
  fourierModes: number;
  fourierCoefficients: number[];
  residualControlCount: number;
  residualCoefficients: number[];
  closureModes: Array<
    | { kind: "constant" }
    | { kind: "cos" | "sin"; harmonic: number }
    | { kind: "bspline"; controlCount: number; index: number }
  >;
  closureCoefficients: number[];
  rigidTransform: { rotationRad: number; translationM: [number, number] };
  seamPhase: number;
  closureResiduals: { turn: number; x: number; y: number; maxAbs: number };
}

export interface OptimalityReportJson {
  closure: { turn: number; x: number; y: number; maxAbs: number };
  geometry: {
    lengthM: number;
    maxAbsCurvature: number;
    maxAbsCurvatureL: number;
    maxAbsCurvatureLL: number;
    minPathMetric: number;
    minProgress: number;
  };
  rectangle: { minimumClearanceM: number; continuouslyBounded: boolean };
  dynamics: {
    minimumSpeedMps: number;
    maximumSpeedMps: number;
    maximumAccelerationMps2: number;
    maximumBrakingMps2: number;
    maximumLateralAccelerationMps2: number;
    maximumSuperellipseUtilization: number;
    maximumDragAccelerationMps2: number;
    maximumDownforceMultiplier: number;
    speedOptimalityResidual: number;
    maxLateralJerk: number;
    rmsLateralJerk: number;
  };
  convergence: {
    meshLapTimesS: [number, number, number] | null;
    meshLapTimeDeltaS: number | null;
    bestTestedDescentS: number | null;
    fourierExtensionImprovementS: number | null;
    splineRefinementImprovementS: number | null;
    curvatureRefinementImprovementS: number | null;
  };
}

export interface V2RepresentationsJson {
  discovery: DiscoveryRepresentationJson;
  curvature: FinalCurvatureRepresentationJson;
  optimality: OptimalityReportJson;
}

/* ------------------------------------------------------------------ */
/* Worker protocol (§6.2, §21). Every async message carries the track  */
/* fingerprint, settings fingerprint, and a monotonically increasing   */
/* run version; receivers discard stale messages.                      */
/* ------------------------------------------------------------------ */

export interface MessageEnvelope {
  runVersion: number;
  trackFingerprint: string;
  settingsFingerprint: string;
}

/** Main -> optimizer worker. */
export type OptimizerCommand = MessageEnvelope &
  (
    | {
        type: "init";
        compiledTrack: CompiledTrackJson;
        vehicle: VehicleSettings;
        optimizer: OptimizerSettings;
        /** Atomic STOP flag when cross-origin isolation is available. */
        stopSignal: SharedArrayBuffer | null;
      }
    | {
        type: "start";
        seedGenotype: Float64Array | null;
        checkpoint: ArrayBuffer | null;
      }
    | { type: "stop" }
    | { type: "setCandidateVisibility"; count: number }
    | { type: "shutdown" }
  );

/** Optimizer worker -> main. Candidate lines are transferable typed
 * arrays; display updates are capped at 15/s (§6.2). */
export type OptimizerEvent = MessageEnvelope &
  (
    | { type: "ready"; adapterInfo: string; cpuFallback: boolean }
    | {
        type: "progress";
        elapsedMs: number;
        batches: number;
        candidates: number;
        validPercent: number;
        rejectionCounts: number[]; // 13 entries, §14.5 order
        provisionalLapTime: number | null;
        batchLatencyMs: { median: number; p95: number; worst: number };
        phaseLatencyMs: {
          generate: number;
          gpuProxy: number;
          cpuTruth: number;
          patternSearch: number;
          canonicalization: number;
          bookkeeping: number;
        };
        /** Active multi-fidelity level of the hierarchical optimizer. */
        stage: "fourier" | "spline" | "curvature" | "smoothing";
        /** Rates are intentionally separate; a proxy is not a certified lap. */
        throughput: {
          stationPerSecond: number;
          proxyPerSecond: number;
          fullPerSecond: number;
          curvaturePerSecond: number;
          certifiedPerSecond: number;
        };
      }
    | {
        type: "displayCandidates";
        /** Interleaved x,y polylines; at most candidateVisibility lines. */
        lines: Float32Array;
        lineOffsets: Uint32Array;
      }
    | {
        type: "discoverySnapshot";
        /** One-based completed 30-second interval of discovery. */
        sequence: number;
        elapsedMs: number;
        /** Source binary64 optimizer lap; never shown as a publishable lap. */
        optimizerLapTime: number;
        candidateId: number;
        basis: {
          fourierModes: number;
          residualControlCount: number;
        };
        corridor: {
          lower: number;
          upper: number;
          betaSafeRad: number;
          fallback: boolean;
        };
        /** Global discovery incumbent followed by at most one archive alternate. */
        sources: Float64Array[];
      }
    | {
        type: "warning";
        stage: "curvature";
        message: string;
      }
    | {
        type: "stopped";
        checkpoint: ArrayBuffer;
      }
    | { type: "deviceLost"; reason: string }
    | { type: "error"; error: OpError }
  );

/** Main -> certifier worker. */
export type CertifierCommand = MessageEnvelope &
  (
    | { type: "init" }
    | { type: "compileTrack"; source: TrackSourceJson }
    | { type: "validateImportedTrack"; asset: CompiledTrackJson }
    | {
        type: "certifyCenterline";
        compiledTrack: CompiledTrackJson;
        vehicle: VehicleSettings;
        provisionalLapTime: number;
        candidateId: number;
      }
    | {
        type: "certifyCurvature";
        compiledTrack: CompiledTrackJson;
        vehicle: VehicleSettings;
        genotype: Float64Array;
        representations: V2RepresentationsJson;
        provisionalLapTime: number;
        candidateId: number;
      }
    | {
        type: "certifyImportedProfile";
        compiledTrack: CompiledTrackJson;
        profile: SavedProfileJson;
      }
    | { type: "shutdown" }
  );

/** Certifier worker -> main. */
export type CertifierEvent = MessageEnvelope &
  (
    | { type: "ready"; wasmVersion: string }
    | { type: "trackCompiled"; asset: CompiledTrackJson }
    | {
        type: "centerlineCertified";
        candidateId: number;
        lapTime: number;
        profileNodes: Float64Array; // packed 7 doubles per node (§20.3 order)
        edgeCount: number;
        certificate: CertificateReportJson;
      }
    | {
        type: "curvatureCertified";
        candidateId: number;
        genotype: Float64Array;
        lapTime: number;
        lineLengthM: number;
        profileNodes: Float64Array;
        edgeCount: number;
        pathSamples: Float64Array;
        representations: V2RepresentationsJson;
        certificate: CertificateReportJson;
      }
    | {
        type: "certificationProgress";
        candidateId: number;
        completed: number;
        total: number;
        label: string;
      }
    | { type: "certificationFailed"; candidateId: number; error: OpError }
    | { type: "profileValidated"; profile: SavedProfileJson }
    | { type: "error"; error: OpError }
  );

/** Main -> independent live-presentation worker. */
export type PresentationCommand = MessageEnvelope &
  (
    | {
        type: "init";
        compiledTrack: CompiledTrackJson;
        vehicle: VehicleSettings;
      }
    | {
        type: "prepareLiveProduct";
        sequence: number;
        elapsedMs: number;
        optimizerLapTime: number;
        candidateId: number;
        basis: {
          fourierModes: number;
          residualControlCount: number;
        };
        corridor: {
          lower: number;
          upper: number;
          betaSafeRad: number;
          fallback: boolean;
        };
        sources: Float64Array[];
      }
  );

/** Independent live-presentation worker -> main. */
export type PresentationEvent = MessageEnvelope &
  (
    | {
        type: "presentationProgress";
        sequence: number;
        completed: number;
        total: number;
        label: string;
      }
    | {
        type: "liveProductCertified";
        sequence: number;
        elapsedMs: number;
        optimizerLapTime: number;
        candidateId: number;
        genotype: Float64Array;
        lapTime: number;
        lineLengthM: number;
        profileNodes: Float64Array;
        edgeCount: number;
        pathSamples: Float64Array;
        representations: V2RepresentationsJson;
        certificate: CertificateReportJson;
        testedCandidates: number;
      }
    | {
        type: "liveProductRejected";
        sequence: number;
        message: string;
      }
  );

/* ------------------------------------------------------------------ */
/* Rendering constants (§15.3, §17.1).                                */
/* ------------------------------------------------------------------ */
export const LINE_COLORS = {
  certifiedBest: "#ff8a1f",
  provisionalBest: "#ffd19a",
  activeCandidates: "rgba(79,195,247,0.16)",
  leftBoundary: "#f1f3f5",
  rightBoundary: "#c8cdd2",
  centerlineIdle: "#58616b",
  invalidFlash: "#ef5350",
} as const;

export const CHART_COLORS = {
  speed: "#ff8a1f",
  longAccel: "#26c6da",
  latAccel: "#ec407a",
  utilization: "#66bb6a",
  utilizationOver: "#ef5350",
  curvature: "#ab8cff",
} as const;

/** Fixed color-blind-safe palette keyed by profile UUID (§15.3). */
export const PROFILE_PALETTE = [
  "#4fc3f7",
  "#ffb74d",
  "#81c784",
  "#ba68c8",
  "#e57373",
  "#64b5f6",
  "#ffd54f",
  "#4db6ac",
  "#f06292",
  "#a1887f",
] as const;

export function profileColor(uuid: string): string {
  let h = 0;
  for (let i = 0; i < uuid.length; i++) h = (h * 31 + uuid.charCodeAt(i)) >>> 0;
  const color = PROFILE_PALETTE[h % PROFILE_PALETTE.length];
  return color ?? PROFILE_PALETTE[0];
}

/** IndexedDB layout (§20.4). */
export const DB_NAME = "optiline";
export const DB_VERSION = 1;
export const STORE_TRACKS = "tracks";
export const STORE_PROFILES = "profiles";
export const STORE_CHECKPOINTS = "runCheckpoints";
export const STORE_PREFERENCES = "preferences";

export const KMH_PER_MPS = 3.6;
