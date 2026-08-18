/**
 * Render scene contract shared by the WebGPU renderer and the Canvas 2D
 * fallback (§15.1). Both implementations consume the same scene and
 * follow the identical draw order:
 *
 *  1. background and grid
 *  2. track lane fill
 *  3. exact-offset boundary tessellations
 *  4. start/finish stripe
 *  5. translucent in-progress candidate lines (≤ 64)
 *  6. certified best line (solid)
 *  7. provisional best (dashed) and selected saved lines (dashed)
 *  8. animated physical vehicle rectangles
 *  9. labels and lap order
 */
import type { CompiledTrackJson } from "@/model/contracts";
import type { CameraState } from "@/renderer/camera";
import type { CurvatureLineSpec } from "@/renderer/ph-tessellate";

export interface SceneVehicle {
  x: number;
  y: number;
  /** Unit tangent from the analytic frame (§12.9). */
  tx: number;
  ty: number;
  lengthM: number;
  widthM: number;
  color: string;
  focused: boolean;
  label: string;
  /** Optional translucent Le × We safety envelope (§15.4). */
  envelope: { lengthM: number; widthM: number } | null;
}

export interface SceneLabel {
  x: number;
  y: number;
  text: string;
  color: string;
}

export interface RenderScene {
  camera: CameraState;
  track: CompiledTrackJson | null;
  /** Draw the idle centerline when no result exists (§15.3). */
  showCenterline: boolean;
  /** Interleaved x,y candidate polylines with float start offsets. */
  candidateLines: Float32Array | null;
  candidateOffsets: Uint32Array | null;
  provisionalBest: CurvatureLineSpec | null;
  /** Provisional line flashes invalid (#ef5350) on failed certification. */
  invalidFlash: boolean;
  certifiedBest: CurvatureLineSpec | null;
  savedLines: { color: string; spec: CurvatureLineSpec }[];
  vehicles: SceneVehicle[];
  labels: SceneLabel[];
  /** Low-contrast work state painted behind the track geometry. */
  workLabel: "OPTIMIZING" | "VALIDATING" | null;
  /** Editable custom-track guide nodes, rendered above the track. */
  editNodes: [number, number][] | null;
}

export interface TrackRenderer {
  readonly kind: "webgpu" | "canvas2d";
  render(scene: RenderScene): void;
  dispose(): void;
}

export function emptyScene(): RenderScene {
  return {
    camera: { centerX: 0, centerY: 0, scale: 1 },
    track: null,
    showCenterline: true,
    candidateLines: null,
    candidateOffsets: null,
    provisionalBest: null,
    invalidFlash: false,
    certifiedBest: null,
    savedLines: [],
    vehicles: [],
    labels: [],
    workLabel: null,
    editNodes: null,
  };
}

/**
 * Candidate display lines arrive from the optimizer worker as
 * transferable typed arrays. The contract does not state whether their
 * coordinates are physical meters or §7.5 normalized GPU coordinates,
 * so the renderer detects it: a physical track is 180–320 m across
 * while normalized geometry lies within about one unit. When the
 * extent is ≤ 4 units the points are denormalized with z = ẑ·H + O.
 */
export function denormalizeCandidates(
  lines: Float32Array,
  track: CompiledTrackJson,
): Float32Array {
  let maxAbs = 0;
  for (let i = 0; i < lines.length; i++) {
    const a = Math.abs(lines[i]!);
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs > 4) return lines; // already physical
  const { originX, originY, scaleH } = track.normalization;
  const out = new Float32Array(lines.length);
  for (let i = 0; i + 1 < lines.length; i += 2) {
    out[i] = lines[i]! * scaleH + originX;
    out[i + 1] = lines[i + 1]! * scaleH + originY;
  }
  return out;
}

/** Parse #rrggbb or rgba(r,g,b,a) into [r,g,b,a] in 0..1. */
export function parseColor(color: string): [number, number, number, number] {
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    const a = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return [r, g, b, a];
  }
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(
    color,
  );
  if (m) {
    return [
      Number(m[1]) / 255,
      Number(m[2]) / 255,
      Number(m[3]) / 255,
      m[4] !== undefined ? Number(m[4]) : 1,
    ];
  }
  return [1, 1, 1, 1];
}
