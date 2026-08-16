/**
 * Camera (§15.2, §5.2).
 *
 * Two modes: `Fit all` and `Zoomed`. Both produce one affine
 * world-to-screen transform in CSS pixels with +y up in world
 * coordinates and the y flip applied only inside the matrix. Device
 * pixel ratio never enters this module; the renderer applies DPR only
 * after the CSS-pixel transform.
 */

export interface CameraState {
  /** World point mapped to the viewport center. */
  centerX: number;
  centerY: number;
  /** CSS pixels per meter. */
  scale: number;
}

export interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Row-major 2x3 affine: [a, b, tx, c, d, ty]; screen = M · (x, y, 1). */
export type Affine2x3 = readonly [number, number, number, number, number, number];

/**
 * The single world-to-screen matrix (§5.2). Screen x right, screen y
 * down; the y flip lives here and nowhere else.
 */
export function worldToScreenMatrix(
  camera: CameraState,
  viewportW: number,
  viewportH: number,
): Affine2x3 {
  const s = camera.scale;
  return [
    s,
    0,
    viewportW / 2 - s * camera.centerX,
    0,
    -s,
    viewportH / 2 + s * camera.centerY,
  ];
}

export function applyAffine(m: Affine2x3, x: number, y: number): [number, number] {
  return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
}

const FIT_PADDING = 0.08; // 8% padding on all sides (§15.2)

/** `Fit all`: complete outer-boundary bounding box with 8% padding. */
export function fitAllCamera(bounds: WorldBounds, viewportW: number, viewportH: number): CameraState {
  const bw = Math.max(bounds.maxX - bounds.minX, 1e-9);
  const bh = Math.max(bounds.maxY - bounds.minY, 1e-9);
  const usableW = viewportW * (1 - 2 * FIT_PADDING);
  const usableH = viewportH * (1 - 2 * FIT_PADDING);
  const scale = Math.min(usableW / bw, usableH / bh);
  return {
    centerX: (bounds.minX + bounds.maxX) / 2,
    centerY: (bounds.minY + bounds.maxY) / 2,
    scale: scale > 0 && Number.isFinite(scale) ? scale : 1,
  };
}

/**
 * `Zoomed` (§15.2, exact): the camera centers the focused vehicle's
 * physical rectangle every animation frame with no smoothing, clamp,
 * look-ahead, or rotation. With unit tangent T = (Tx, Ty) and left
 * normal N = (-Ty, Tx), the axis-aligned world extents of the physical
 * Lv × Wv rectangle are
 *
 *   Bx = Lv|Tx| + Wv|Nx| = Lv|Tx| + Wv|Ty|
 *   By = Lv|Ty| + Wv|Ny| = Lv|Ty| + Wv|Tx|
 *
 * and the CSS-pixel scale is α = min(Wc / (5·Bx), Hc / (5·By)), which
 * makes the vehicle's screen bounding box exactly one fifth of the
 * limiting viewer dimension. All quantities are CSS pixels; DPR is
 * applied by the renderer afterwards.
 */
export function zoomedCamera(
  vehicleX: number,
  vehicleY: number,
  tangentX: number,
  tangentY: number,
  vehicleLengthM: number,
  vehicleWidthM: number,
  viewportW: number,
  viewportH: number,
): CameraState {
  const ax = Math.abs(tangentX);
  const ay = Math.abs(tangentY);
  const bx = vehicleLengthM * ax + vehicleWidthM * ay;
  const by = vehicleLengthM * ay + vehicleWidthM * ax;
  const alpha = Math.min(viewportW / (5 * bx), viewportH / (5 * by));
  return {
    centerX: vehicleX,
    centerY: vehicleY,
    scale: Number.isFinite(alpha) && alpha > 0 ? alpha : 1,
  };
}

/** Bounding box of interleaved x,y polyline points. */
export function boundsOfPoints(pts: Float32Array | Float64Array): WorldBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = pts[i]!;
    const y = pts[i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
}

export function unionBounds(a: WorldBounds, b: WorldBounds): WorldBounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}
