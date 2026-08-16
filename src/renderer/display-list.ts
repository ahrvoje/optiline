/**
 * Scene -> ordered primitive list (§15.1).
 *
 * Both renderers replay this one list in order, which makes the
 * mandated draw order a structural property: the WebGPU path and the
 * Canvas 2D fallback cannot disagree on ordering because neither owns
 * it.
 */
import { LINE_COLORS } from "@/model/contracts";
import type { CameraState } from "@/renderer/camera";
import { TessellationCache } from "@/renderer/ph-tessellate";
import type { RenderScene } from "@/renderer/scene";
import { denormalizeCandidates } from "@/renderer/scene";
import { frontMarkerTriangle, rectangleCorners, rectangleTriangles } from "@/renderer/vehicle-draw";

export const BACKGROUND_COLOR = "#14171b";
export const GRID_COLOR = "#1c2128";
export const LANE_COLOR = "#242a31";
export const STRIPE_LIGHT = "#e8eaed";
export const STRIPE_DARK = "#14171b";

export type Primitive =
  | { kind: "fill"; tris: ArrayLike<number>; color: string }
  | {
      kind: "line";
      pts: ArrayLike<number>;
      color: string;
      widthPx: number;
      /** [dashPx, gapPx] or null for solid. */
      dash: [number, number] | null;
    };

const TESSELLATION_TOL_CSS_PX = 0.35; // §15.1

export function buildDisplayList(
  scene: RenderScene,
  viewportW: number,
  viewportH: number,
  cache: TessellationCache,
): Primitive[] {
  const prims: Primitive[] = [];
  const scale = scene.camera.scale;
  const tolWorld = TESSELLATION_TOL_CSS_PX / Math.max(scale, 1e-9);

  // 1. grid (background clear is the renderer's pass/fill).
  pushGrid(prims, scene.camera, viewportW, viewportH);

  if (scene.track) {
    const geom = cache.track(scene.track, tolWorld);
    // 2. lane fill.
    prims.push({ kind: "fill", tris: geom.laneTris, color: LANE_COLOR });
    // 3. start/finish stripe (light base with dark dashes -> checker cue).
    const stripe = geom.startStripe;
    const stripePts = [stripe[0], stripe[1], stripe[2], stripe[3]];
    prims.push({ kind: "line", pts: stripePts, color: STRIPE_LIGHT, widthPx: 6, dash: null });
    prims.push({ kind: "line", pts: stripePts, color: STRIPE_DARK, widthPx: 6, dash: [4, 4] });
    // 4. Closed exact-offset boundaries stay above the checker stripe,
    // so its dark squares cannot look like gaps at the periodic seam.
    prims.push({ kind: "line", pts: geom.left, color: LINE_COLORS.leftBoundary, widthPx: 2, dash: null });
    prims.push({ kind: "line", pts: geom.right, color: LINE_COLORS.rightBoundary, widthPx: 2, dash: null });
    // Idle centerline when no result exists (§15.3).
    if (scene.showCenterline) {
      prims.push({
        kind: "line",
        pts: geom.centerline,
        color: LINE_COLORS.centerlineIdle,
        widthPx: 1.5,
        dash: null,
      });
    }
  }

  // 5. translucent in-progress candidates, at most 64.
  if (scene.candidateLines && scene.candidateOffsets && scene.track) {
    const lines = denormalizeCandidates(scene.candidateLines, scene.track);
    const offsets = scene.candidateOffsets;
    const lineCount = Math.min(offsets.length, 64);
    for (let k = 0; k < lineCount; k++) {
      const start = offsets[k]!;
      const end = k + 1 < offsets.length ? offsets[k + 1]! : lines.length;
      if (end - start >= 4) {
        prims.push({
          kind: "line",
          pts: lines.subarray(start, end),
          color: LINE_COLORS.activeCandidates,
          widthPx: 1.5,
          dash: null,
        });
      }
    }
  }

  // 6. certified best: solid high-contrast.
  if (scene.certifiedBest) {
    prims.push({
      kind: "line",
      pts: cache.line(scene.certifiedBest, tolWorld),
      color: LINE_COLORS.certifiedBest,
      widthPx: 3,
      dash: null,
    });
  }

  // 7a. provisional best: dashed (flashes invalid on failed certification).
  if (scene.provisionalBest) {
    prims.push({
      kind: "line",
      pts: cache.line(scene.provisionalBest, tolWorld),
      color: scene.invalidFlash ? LINE_COLORS.invalidFlash : LINE_COLORS.provisionalBest,
      widthPx: 2,
      dash: [8, 6],
    });
  }

  // 7b. selected saved lines: dashed in profile colors.
  for (const saved of scene.savedLines) {
    prims.push({
      kind: "line",
      pts: cache.line(saved.spec, tolWorld),
      color: saved.color,
      widthPx: 2,
      dash: [6, 5],
    });
  }

  // 8. vehicles.
  for (const v of scene.vehicles) {
    const pose = { x: v.x, y: v.y, tx: v.tx, ty: v.ty };
    if (v.envelope) {
      const c = rectangleCorners(pose, v.envelope.lengthM, v.envelope.widthM);
      prims.push({
        kind: "line",
        pts: [c[0]!, c[1]!, c[2]!, c[3]!, c[4]!, c[5]!, c[6]!, c[7]!, c[0]!, c[1]!],
        color: withAlpha(v.color, 0.72),
        widthPx: 1,
        dash: [3, 3],
      });
    }
    prims.push({
      kind: "fill",
      tris: rectangleTriangles(pose, v.lengthM, v.widthM),
      color: "#0c1015",
    });
    const body = rectangleCorners(pose, v.lengthM, v.widthM);
    prims.push({
      kind: "line",
      pts: [body[0]!, body[1]!, body[2]!, body[3]!, body[4]!, body[5]!, body[6]!, body[7]!, body[0]!, body[1]!],
      color: v.color,
      widthPx: v.focused ? 3 : 2,
      dash: null,
    });
    prims.push({
      kind: "fill",
      tris: frontMarkerTriangle(pose, v.lengthM, v.widthM),
      color: v.focused ? "#ffffff" : v.color,
    });
  }

  // 9. labels are text: rendered by the overlay canvas in both backends.
  return prims;
}

function pushGrid(
  prims: Primitive[],
  camera: CameraState,
  viewportW: number,
  viewportH: number,
): void {
  const scale = Math.max(camera.scale, 1e-9);
  const halfW = viewportW / (2 * scale);
  const halfH = viewportH / (2 * scale);
  const steps = [5, 10, 25, 50, 100, 250, 500];
  let step = steps[steps.length - 1]!;
  for (const s of steps) {
    if (s * scale >= 48) {
      step = s;
      break;
    }
  }
  const minX = camera.centerX - halfW;
  const maxX = camera.centerX + halfW;
  const minY = camera.centerY - halfH;
  const maxY = camera.centerY + halfH;
  const maxLines = 200;
  let count = 0;
  for (let x = Math.ceil(minX / step) * step; x <= maxX && count < maxLines; x += step, count++) {
    prims.push({ kind: "line", pts: [x, minY, x, maxY], color: GRID_COLOR, widthPx: 1, dash: null });
  }
  for (let y = Math.ceil(minY / step) * step; y <= maxY && count < maxLines; y += step, count++) {
    prims.push({ kind: "line", pts: [minX, y, maxX, y], color: GRID_COLOR, widthPx: 1, dash: null });
  }
}

function withAlpha(hexColor: string, alpha: number): string {
  if (hexColor.startsWith("#") && hexColor.length === 7) {
    const a = Math.round(alpha * 255)
      .toString(16)
      .padStart(2, "0");
    return `${hexColor}${a}`;
  }
  return hexColor;
}
