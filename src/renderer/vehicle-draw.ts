/**
 * Vehicle geometry (§15.4).
 *
 * The drawn rectangle has the physical dimensions Lv × Wv (safety
 * margin excluded), centered on the racing-line point with its long
 * axis along the analytic tangent T. A front marker distinguishes
 * direction, and the optional safety envelope is a translucent Le × We
 * rectangle.
 */

export interface VehiclePose {
  x: number;
  y: number;
  /** Unit tangent. */
  tx: number;
  ty: number;
}

/** Four rectangle corners as x,y pairs: rear-left, front-left, front-right, rear-right. */
export function rectangleCorners(
  pose: VehiclePose,
  lengthM: number,
  widthM: number,
): Float64Array {
  const hl = lengthM / 2;
  const hw = widthM / 2;
  const { x, y, tx, ty } = pose;
  const nx = -ty; // left normal N = iT (§5.2)
  const ny = tx;
  return Float64Array.from([
    x - hl * tx + hw * nx,
    y - hl * ty + hw * ny,
    x + hl * tx + hw * nx,
    y + hl * ty + hw * ny,
    x + hl * tx - hw * nx,
    y + hl * ty - hw * ny,
    x - hl * tx - hw * nx,
    y - hl * ty - hw * ny,
  ]);
}

/** Two solid triangles (6 points) covering the rectangle. */
export function rectangleTriangles(
  pose: VehiclePose,
  lengthM: number,
  widthM: number,
): Float64Array {
  const c = rectangleCorners(pose, lengthM, widthM);
  return Float64Array.from([
    c[0]!, c[1]!, c[2]!, c[3]!, c[4]!, c[5]!,
    c[0]!, c[1]!, c[4]!, c[5]!, c[6]!, c[7]!,
  ]);
}

/**
 * Front direction marker: a small triangle at the vehicle nose pointing
 * along the tangent. Sized relative to the vehicle so it scales with
 * the camera like the body does.
 */
export function frontMarkerTriangle(
  pose: VehiclePose,
  lengthM: number,
  widthM: number,
): Float64Array {
  const { x, y, tx, ty } = pose;
  const nx = -ty;
  const ny = tx;
  const tip = 0.5 * lengthM;
  const back = 0.28 * lengthM;
  const half = 0.3 * widthM;
  return Float64Array.from([
    x + tip * tx,
    y + tip * ty,
    x + back * tx + half * nx,
    y + back * ty + half * ny,
    x + back * tx - half * nx,
    y + back * ty - half * ny,
  ]);
}
