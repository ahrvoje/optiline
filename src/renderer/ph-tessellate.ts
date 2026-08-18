/**
 * Display-only PH evaluation and adaptive tessellation (§15.1).
 *
 * Rendering is not part of geometric certification (§15.1) and
 * TypeScript never holds an authoritative copy of the mathematics
 * (§1): everything in this module exists only to turn already-certified
 * data (preimage controls, gate points, exact rational boundary
 * controls, corridor cells) into screen polylines and triangles. All
 * certified numbers still originate in C99/WASM or WGSL.
 *
 * The evaluation is analytic (§15.1): quintic span position controls
 * are built from the quadratic preimage exactly as §8.3–§8.5 and §9.2
 * prescribe, and evaluated by de Casteljau. Tessellation subdivides
 * until the midpoint-to-chord deviation is below the requested world
 * tolerance (0.35 CSS px divided by the camera scale). Closed lines
 * repeat their first vertex so there is no visible seam.
 */
import type {
  CompiledTrackJson,
  CorridorCellJson,
  RationalOffsetSpanJson,
} from "@/model/contracts";
import { GATE_COUNT, SPAN_COUNT } from "@/model/contracts";
import type { WorldBounds } from "@/renderer/camera";
import { boundsOfPoints, unionBounds } from "@/renderer/camera";

/** One racing line: 128 complex preimage pairs + 64 gate point pairs. */
export interface PhLineSpec {
  kind?: "ph";
  /** Packed re,im — length 256. */
  preimage: Float64Array;
  /** Packed x,y — length 128. */
  gates: Float64Array;
}

/**
 * Display cache for an authoritative intrinsic-curvature trajectory.
 * Samples are uniform in arc length and packed as x,y,tx,ty,kappa. The
 * This object contains no alternate geometric representation. The certified
 * intrinsic-curvature samples are the sole trajectory geometry.
 */
export interface CurvatureLineSpec {
  kind: "curvature";
  pathLengthM: number;
  samples: Float64Array;
}

export type LineSpec = PhLineSpec | CurvatureLineSpec;

const H = 0.5; // compiled span width (§8.2)
const MAX_DEPTH = 16;

/* ------------------------------- preimage access ------------------------------ */

/**
 * Extended antiperiodic control access (§5.4): c_{j+kn} = (-1)^k c_j.
 * The sign applies before the wrapped base index; a plain modulo is
 * incorrect.
 */
function control(pre: Float64Array, index: number): [number, number] {
  let k = 0;
  let j = index;
  while (j < 0) {
    j += SPAN_COUNT;
    k++;
  }
  while (j >= SPAN_COUNT) {
    j -= SPAN_COUNT;
    k++;
  }
  const sign = k % 2 === 0 ? 1 : -1;
  return [sign * pre[2 * j]!, sign * pre[2 * j + 1]!];
}

/** §8.3 uniform quadratic Bézier extraction for span j: b0, b1, b2. */
export function spanPreimageBezier(
  pre: Float64Array,
  span: number,
): [[number, number], [number, number], [number, number]] {
  const cm = control(pre, span - 1);
  const c0 = control(pre, span);
  const cp = control(pre, span + 1);
  return [
    [(cm[0] + c0[0]) / 2, (cm[1] + c0[1]) / 2],
    [c0[0], c0[1]],
    [(c0[0] + cp[0]) / 2, (c0[1] + cp[1]) / 2],
  ];
}

function cMul(a: [number, number], b: [number, number]): [number, number] {
  return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
}

/** §8.4 degree-4 Bernstein hodograph coefficients q0..q4 of w². */
function hodographCoefficients(
  b0: [number, number],
  b1: [number, number],
  b2: [number, number],
): [number, number][] {
  const b0b0 = cMul(b0, b0);
  const b0b1 = cMul(b0, b1);
  const b0b2 = cMul(b0, b2);
  const b1b1 = cMul(b1, b1);
  const b1b2 = cMul(b1, b2);
  const b2b2 = cMul(b2, b2);
  return [
    b0b0,
    b0b1,
    [(b0b2[0] + 2 * b1b1[0]) / 3, (b0b2[1] + 2 * b1b1[1]) / 3],
    b1b2,
    b2b2,
  ];
}

function speedCoefficients(
  b0: [number, number],
  b1: [number, number],
  b2: [number, number],
): number[] {
  const dot = (a: [number, number], b: [number, number]) => a[0] * b[0] + a[1] * b[1];
  return [
    dot(b0, b0),
    dot(b0, b1),
    (dot(b0, b2) + 2 * dot(b1, b1)) / 3,
    dot(b1, b2),
    dot(b2, b2),
  ];
}

function evalBernsteinScalar(values: number[], parameter: number): number {
  const work = values.slice();
  for (let level = work.length - 1; level >= 1; level--) {
    for (let i = 0; i < level; i++) {
      work[i] = (1 - parameter) * work[i]! + parameter * work[i + 1]!;
    }
  }
  return work[0]!;
}

/** Closed-form forward arc length on one quintic PH span. */
export function spanArcForward(
  preimage: Float64Array,
  span: number,
  parameter: number,
): number {
  const b = spanPreimageBezier(preimage, span);
  const speed = speedCoefficients(b[0], b[1], b[2]);
  const integral = [0];
  for (let i = 0; i < speed.length; i++) {
    integral.push(integral[i]! + speed[i]! / 5);
  }
  return H * evalBernsteinScalar(integral, Math.max(0, Math.min(1, parameter)));
}

/** Exact centerline distances for global parameters in [0,64]. */
export function lineDistancesAtParameters(
  spec: LineSpec,
  parameters: ArrayLike<number>,
): { distances: number[]; totalLength: number } {
  if (spec.kind === "curvature") {
    return {
      distances: Array.from(parameters, parameter =>
        Math.max(0, Math.min(GATE_COUNT, parameter)) / GATE_COUNT * spec.pathLengthM),
      totalLength: spec.pathLengthM,
    };
  }
  const prefix = new Float64Array(SPAN_COUNT + 1);
  for (let span = 0; span < SPAN_COUNT; span++) {
    prefix[span + 1] = prefix[span]! + spanArcForward(spec.preimage, span, 1);
  }
  const distances = Array.from(parameters, (globalParameter) => {
    const spanParameter = Math.max(0, Math.min(SPAN_COUNT, globalParameter / H));
    if (spanParameter >= SPAN_COUNT) return prefix[SPAN_COUNT]!;
    const span = Math.floor(spanParameter);
    return prefix[span]! + spanArcForward(spec.preimage, span, spanParameter - span);
  });
  return { distances, totalLength: prefix[SPAN_COUNT]! };
}

const BINOMIAL = [
  [1],
  [1, 1],
  [1, 2, 1],
  [1, 3, 3, 1],
  [1, 4, 6, 4, 1],
  [1, 5, 10, 10, 5, 1],
  [1, 6, 15, 20, 15, 6, 1],
  [1, 7, 21, 35, 35, 21, 7, 1],
  [1, 8, 28, 56, 70, 56, 28, 8, 1],
  [1, 9, 36, 84, 126, 126, 84, 36, 9, 1],
] as const;

/** §9.2 exact quadratic Bernstein Gram matrix. */
const GRAM = [
  [1 / 5, 1 / 10, 1 / 30],
  [1 / 10, 2 / 15, 1 / 10],
  [1 / 30, 1 / 10, 1 / 5],
] as const;

/** §9.2 exact span displacement Φ(b) = h · bᵀ G b (complex bilinear). */
export function spanDisplacement(
  b: [[number, number], [number, number], [number, number]],
): [number, number] {
  let re = 0;
  let im = 0;
  for (let a = 0; a < 3; a++) {
    for (let c = 0; c < 3; c++) {
      const p = cMul(b[a]!, b[c]!);
      const g = GRAM[a]![c]!;
      re += g * p[0];
      im += g * p[1];
    }
  }
  return [H * re, H * im];
}

/* --------------------------- span position controls --------------------------- */

/**
 * Position controls for all 128 spans (§8.5 with the §9.2 anchor rule):
 * span 2i starts exactly at gate point P_i and span 2i+1 starts at
 * P_i + Φ(b_{2i}). Returns Float64Array of 128 × 6 complex controls
 * (128 * 12 numbers).
 */
export function buildPositionControls(spec: PhLineSpec): Float64Array {
  const out = new Float64Array(SPAN_COUNT * 12);
  for (let i = 0; i < GATE_COUNT; i++) {
    const px = spec.gates[2 * i]!;
    const py = spec.gates[2 * i + 1]!;
    const bA = spanPreimageBezier(spec.preimage, 2 * i);
    const phiA = spanDisplacement(bA);
    writeSpanControls(out, 2 * i, px, py, bA);
    const bB = spanPreimageBezier(spec.preimage, 2 * i + 1);
    writeSpanControls(out, 2 * i + 1, px + phiA[0], py + phiA[1], bB);
  }
  return out;
}

function writeSpanControls(
  out: Float64Array,
  span: number,
  startX: number,
  startY: number,
  b: [[number, number], [number, number], [number, number]],
): void {
  const q = hodographCoefficients(b[0], b[1], b[2]);
  const base = span * 12;
  let x = startX;
  let y = startY;
  out[base] = x;
  out[base + 1] = y;
  for (let k = 0; k < 5; k++) {
    x += (H / 5) * q[k]![0];
    y += (H / 5) * q[k]![1];
    out[base + 2 * (k + 1)] = x;
    out[base + 2 * (k + 1) + 1] = y;
  }
}

/** De Casteljau on one span's 6 complex position controls. */
function evalSpan(controls: Float64Array, span: number, nu: number): [number, number] {
  const base = span * 12;
  const xs = [
    controls[base]!,
    controls[base + 2]!,
    controls[base + 4]!,
    controls[base + 6]!,
    controls[base + 8]!,
    controls[base + 10]!,
  ];
  const ys = [
    controls[base + 1]!,
    controls[base + 3]!,
    controls[base + 5]!,
    controls[base + 7]!,
    controls[base + 9]!,
    controls[base + 11]!,
  ];
  for (let r = 5; r >= 1; r--) {
    for (let k = 0; k < r; k++) {
      xs[k] = (1 - nu) * xs[k]! + nu * xs[k + 1]!;
      ys[k] = (1 - nu) * ys[k]! + nu * ys[k + 1]!;
    }
  }
  return [xs[0]!, ys[0]!];
}

/** Derive the 64 interpolation gates by exact PH span displacement sums. */
export function gatesFromPreimage(
  preimage: Float64Array,
  originX = 0,
  originY = 0,
): Float64Array {
  if (preimage.length !== SPAN_COUNT * 2) throw new Error("preimage must have 256 values");
  const gates = new Float64Array(GATE_COUNT * 2);
  gates[0] = originX;
  gates[1] = originY;
  for (let i = 0; i + 1 < GATE_COUNT; i++) {
    const a = spanDisplacement(spanPreimageBezier(preimage, 2 * i));
    const b = spanDisplacement(spanPreimageBezier(preimage, 2 * i + 1));
    gates[2 * (i + 1)] = gates[2 * i]! + a[0] + b[0];
    gates[2 * (i + 1) + 1] = gates[2 * i + 1]! + a[1] + b[1];
  }
  return gates;
}

/** Display/profile evaluation of an already constructed PH line. */
export interface LineFrame {
  x: number;
  y: number;
  tx: number;
  ty: number;
  kappa: number;
}

function evaluateLineFrameWithControls(
  spec: PhLineSpec,
  controls: Float64Array,
  parameter: number,
): LineFrame {
  const wrapped = ((parameter % GATE_COUNT) + GATE_COUNT) % GATE_COUNT;
  const spanFloat = wrapped / H;
  const span = Math.min(SPAN_COUNT - 1, Math.floor(spanFloat));
  const nu = spanFloat - span;
  const [x, y] = evalSpan(controls, span, nu);
  const b = spanPreimageBezier(spec.preimage, span);
  const s = 1 - nu;
  const wr = s * s * b[0][0] + 2 * s * nu * b[1][0] + nu * nu * b[2][0];
  const wi = s * s * b[0][1] + 2 * s * nu * b[1][1] + nu * nu * b[2][1];
  const dr = 2 * (s * (b[1][0] - b[0][0]) + nu * (b[2][0] - b[1][0]));
  const di = 2 * (s * (b[1][1] - b[0][1]) + nu * (b[2][1] - b[1][1]));
  const r2 = wr * wr + wi * wi;
  const mag = Math.sqrt(r2);
  const ar = mag > 0 ? wr / mag : 1;
  const ai = mag > 0 ? wi / mag : 0;
  return {
    x,
    y,
    tx: (ar - ai) * (ar + ai),
    ty: 2 * ar * ai,
    kappa: r2 > 0 ? (2 * (wr * di - wi * dr)) / (H * r2 * r2) : 0,
  };
}

export function evaluateLineFrame(spec: LineSpec, parameter: number): LineFrame {
  if (spec.kind === "curvature") return evaluateCurvatureFrame(spec, parameter);
  return evaluateLineFrameWithControls(spec, buildPositionControls(spec), parameter);
}

function evaluateCurvatureFrame(spec: CurvatureLineSpec, parameter: number): LineFrame {
  const count = spec.samples.length / 5;
  if (!Number.isInteger(count) || count < 8) throw new Error("invalid curvature line cache");
  const wrapped = ((parameter % GATE_COUNT) + GATE_COUNT) % GATE_COUNT;
  const sample = wrapped / GATE_COUNT * count;
  const index = Math.floor(sample) % count;
  const next = (index + 1) % count;
  const t = sample - Math.floor(sample);
  const a = 5 * index;
  const b = 5 * next;
  const segmentLength = spec.pathLengthM / count;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  const dh00 = 6 * t2 - 6 * t;
  const dh10 = 3 * t2 - 4 * t + 1;
  const dh01 = -dh00;
  const dh11 = 3 * t2 - 2 * t;
  const x = h00 * spec.samples[a]! + h10 * segmentLength * spec.samples[a + 2]! +
    h01 * spec.samples[b]! + h11 * segmentLength * spec.samples[b + 2]!;
  const y = h00 * spec.samples[a + 1]! + h10 * segmentLength * spec.samples[a + 3]! +
    h01 * spec.samples[b + 1]! + h11 * segmentLength * spec.samples[b + 3]!;
  const dx = dh00 * spec.samples[a]! + dh10 * segmentLength * spec.samples[a + 2]! +
    dh01 * spec.samples[b]! + dh11 * segmentLength * spec.samples[b + 2]!;
  const dy = dh00 * spec.samples[a + 1]! + dh10 * segmentLength * spec.samples[a + 3]! +
    dh01 * spec.samples[b + 1]! + dh11 * segmentLength * spec.samples[b + 3]!;
  const metric = Math.max(Math.hypot(dx, dy), 1e-15);
  return {
    x,
    y,
    tx: dx / metric,
    ty: dy / metric,
    kappa: (1 - t) * spec.samples[a + 4]! + t * spec.samples[b + 4]!,
  };
}

/** Fixed equal-parameter samples with one position-control construction. */
export function sampleLineFrames(spec: LineSpec, count: number): LineFrame[] {
  if (spec.kind === "curvature") {
    return Array.from({ length: count }, (_, i) =>
      evaluateCurvatureFrame(spec, GATE_COUNT * i / count));
  }
  const controls = buildPositionControls(spec);
  return Array.from({ length: count }, (_, i) =>
    evaluateLineFrameWithControls(spec, controls, (GATE_COUNT * i) / count),
  );
}

/* ------------------------------ line tessellation ----------------------------- */

/**
 * Adaptive closed-line tessellation. Subdivides each span until the
 * curve midpoint deviates from the chord midpoint by less than
 * `tolWorld` meters. The final vertex repeats the first (seamless
 * closure, §15.1).
 */
export function tessellateLine(spec: LineSpec, tolWorld: number): Float32Array {
  if (spec.kind === "curvature") {
    const count = spec.samples.length / 5;
    const points = new Float32Array(2 * (count + 1));
    for (let i = 0; i <= count; i++) {
      const source = 5 * (i % count);
      points[2 * i] = spec.samples[source]!;
      points[2 * i + 1] = spec.samples[source + 1]!;
    }
    return points;
  }
  const controls = buildPositionControls(spec);
  const pts: number[] = [];
  const first = evalSpan(controls, 0, 0);
  pts.push(first[0], first[1]);
  const tol2 = tolWorld * tolWorld;
  for (let span = 0; span < SPAN_COUNT; span++) {
    const z0 = evalSpan(controls, span, 0);
    const z1 = evalSpan(controls, span, 1);
    subdivide(controls, span, 0, z0, 1, z1, tol2, 0, pts);
  }
  // Seamless closure: overwrite the last vertex with the exact first.
  pts[pts.length - 2] = first[0];
  pts[pts.length - 1] = first[1];
  return Float32Array.from(pts);
}

function subdivide(
  controls: Float64Array,
  span: number,
  nu0: number,
  z0: [number, number],
  nu1: number,
  z1: [number, number],
  tol2: number,
  depth: number,
  out: number[],
): void {
  const num = (nu0 + nu1) / 2;
  const zm = evalSpan(controls, span, num);
  const cx = (z0[0] + z1[0]) / 2;
  const cy = (z0[1] + z1[1]) / 2;
  const dx = zm[0] - cx;
  const dy = zm[1] - cy;
  if (depth < MAX_DEPTH && dx * dx + dy * dy > tol2) {
    subdivide(controls, span, nu0, z0, num, zm, tol2, depth + 1, out);
    subdivide(controls, span, num, zm, nu1, z1, tol2, depth + 1, out);
  } else {
    out.push(z1[0], z1[1]);
  }
}

/* --------------------------- racing-line gate points -------------------------- */

/**
 * Racing-line gate points P_i = C_i + d_i · N_c(i/64) (§9.1). The
 * centerline normal at gate i is evaluated from the compiled track's
 * centerline preimage at span 2i, ν = 0, where w(0) = b0 (§8.3, §8.6).
 */
export function racingLineGatePoints(
  track: CompiledTrackJson,
  genotype: ArrayLike<number>,
): Float64Array {
  const pre = flattenPairs(track.centerPreimageControls);
  const out = new Float64Array(GATE_COUNT * 2);
  for (let i = 0; i < GATE_COUNT; i++) {
    const gate = track.gatePoints[i]!;
    const n = gateLeftNormal(pre, i);
    const d = genotype[i] ?? 0;
    out[2 * i] = gate[0] + d * n[0];
    out[2 * i + 1] = gate[1] + d * n[1];
  }
  return out;
}

/**
 * Reconstruct a projected PH racing line at its optimized physical origin.
 * The preimage determines displacements but not translation; gate 0 from the
 * genotype supplies that missing degree of freedom.
 */
export function racingLineFromPreimage(
  track: CompiledTrackJson,
  genotype: ArrayLike<number>,
  preimage: Float64Array,
): PhLineSpec {
  const targetGates = racingLineGatePoints(track, genotype);
  return {
    preimage,
    gates: gatesFromPreimage(preimage, targetGates[0]!, targetGates[1]!),
  };
}

/** Left unit normal of the centerline at gate i (§8.6: N_L = iT). */
export function gateLeftNormal(centerPreimage: Float64Array, i: number): [number, number] {
  const b = spanPreimageBezier(centerPreimage, 2 * i);
  const w = b[0]; // w(0) = b0
  const mag = Math.hypot(w[0], w[1]);
  if (mag === 0) return [0, 1];
  const a = w[0] / mag;
  const bIm = w[1] / mag;
  const tx = (a - bIm) * (a + bIm);
  const ty = 2 * a * bIm;
  return [-ty, tx];
}

export function flattenPairs(pairs: [number, number][]): Float64Array {
  const out = new Float64Array(pairs.length * 2);
  for (let i = 0; i < pairs.length; i++) {
    out[2 * i] = pairs[i]![0];
    out[2 * i + 1] = pairs[i]![1];
  }
  return out;
}

/** LineSpec of the compiled track's centerline. */
export function centerlineSpec(track: CompiledTrackJson): PhLineSpec {
  return {
    preimage: flattenPairs(track.centerPreimageControls),
    gates: flattenPairs(track.gatePoints),
  };
}

/**
 * Exact degree-9 rational PH offset z_d = (zR + d·iQ) / R (§8.9).
 * The returned spans share exact endpoints, and the final span ends at
 * the first offset point because the source PH line is periodic.
 */
export function exactOffsetBoundary(spec: PhLineSpec, signedDistance: number): RationalOffsetSpanJson[] {
  const positions = buildPositionControls(spec);
  const out: RationalOffsetSpanJson[] = [];
  for (let span = 0; span < SPAN_COUNT; span++) {
    const b = spanPreimageBezier(spec.preimage, span);
    const q = hodographCoefficients(b[0], b[1], b[2]);
    const r = speedCoefficients(b[0], b[1], b[2]);
    const h: [number, number][] = [];
    const w: number[] = [];
    for (let k = 0; k <= 9; k++) {
      let hx = 0;
      let hy = 0;
      let wk = 0;
      let qx = 0;
      let qy = 0;
      const denominator = BINOMIAL[9]![k]!;
      for (let i = 0; i <= 5; i++) {
        const j = k - i;
        if (j < 0 || j > 4) continue;
        const factor = BINOMIAL[5]![i]! * BINOMIAL[4]![j]! / denominator;
        const px = positions[span * 12 + 2 * i]!;
        const py = positions[span * 12 + 2 * i + 1]!;
        hx += factor * px * r[j]!;
        hy += factor * py * r[j]!;
        wk += factor * r[j]!;
      }
      for (let j = 0; j <= 4; j++) {
        const i = k - j;
        if (i < 0 || i > 5) continue;
        const factor = BINOMIAL[4]![j]! * BINOMIAL[5]![i]! / denominator;
        qx += factor * q[j]![0];
        qy += factor * q[j]![1];
      }
      h.push([hx - signedDistance * qy, hy + signedDistance * qx]);
      w.push(wk);
    }
    out.push({ srcSpan: span, u0: 0, u1: 1, h, w });
  }
  if (out.length > 0) {
    const first = out[0]!;
    const last = out.at(-1)!;
    last.h[9] = [...first.h[0]!] as [number, number];
    last.w[9] = first.w[0]!;
  }
  return out;
}

/* ---------------------------- boundary tessellation --------------------------- */

/**
 * Adaptive tessellation of the exact rational offset boundary (§8.9).
 * Each stored span has degree-9 homogeneous numerator controls and
 * positive weights; points are evaluated by homogeneous de Casteljau
 * and divided at the end.
 */
export function tessellateBoundary(
  spans: CompiledTrackJson["leftBoundary"],
  tolWorld: number,
): Float32Array {
  const pts: number[] = [];
  const tol2 = tolWorld * tolWorld;
  let first: [number, number] | null = null;
  for (const span of spans) {
    const z0 = evalRational(span.h, span.w, 0);
    const z1 = evalRational(span.h, span.w, 1);
    if (first === null) {
      first = z0;
      pts.push(z0[0], z0[1]);
    }
    subdivideRational(span.h, span.w, 0, z0, 1, z1, tol2, 0, pts);
  }
  if (first && pts.length >= 4) {
    pts[pts.length - 2] = first[0];
    pts[pts.length - 1] = first[1];
  }
  return Float32Array.from(pts);
}

function evalRational(
  hControls: [number, number][],
  weights: number[],
  t: number,
): [number, number] {
  const n = hControls.length;
  const xs = new Array<number>(n);
  const ys = new Array<number>(n);
  const ws = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    xs[i] = hControls[i]![0];
    ys[i] = hControls[i]![1];
    ws[i] = weights[i]!;
  }
  for (let r = n - 1; r >= 1; r--) {
    for (let k = 0; k < r; k++) {
      xs[k] = (1 - t) * xs[k]! + t * xs[k + 1]!;
      ys[k] = (1 - t) * ys[k]! + t * ys[k + 1]!;
      ws[k] = (1 - t) * ws[k]! + t * ws[k + 1]!;
    }
  }
  const w = ws[0]!;
  return w !== 0 ? [xs[0]! / w, ys[0]! / w] : [xs[0]!, ys[0]!];
}

function subdivideRational(
  hControls: [number, number][],
  weights: number[],
  t0: number,
  z0: [number, number],
  t1: number,
  z1: [number, number],
  tol2: number,
  depth: number,
  out: number[],
): void {
  const tm = (t0 + t1) / 2;
  const zm = evalRational(hControls, weights, tm);
  const dx = zm[0] - (z0[0] + z1[0]) / 2;
  const dy = zm[1] - (z0[1] + z1[1]) / 2;
  if (depth < MAX_DEPTH && dx * dx + dy * dy > tol2) {
    subdivideRational(hControls, weights, t0, z0, tm, zm, tol2, depth + 1, out);
    subdivideRational(hControls, weights, tm, zm, t1, z1, tol2, depth + 1, out);
  } else {
    out.push(z1[0], z1[1]);
  }
}

/* ------------------------------ corridor-cell fill ---------------------------- */

/**
 * Lane fill geometry: every proven corridor cell is a convex subset of
 * the exact lane (§7.4), so filling the union of cells fills the lane
 * to within the documented 1 mm cover tolerance. Cell polygons are
 * recovered by clipping a large box against the cell's half-spaces
 * (robust regardless of half-space ordering) and fanned into triangles.
 */
export function laneFillTriangles(
  cells: CorridorCellJson[],
  bounds: WorldBounds,
): Float32Array {
  const tris: number[] = [];
  const margin = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1);
  const box: number[] = [
    bounds.minX - margin,
    bounds.minY - margin,
    bounds.maxX + margin,
    bounds.minY - margin,
    bounds.maxX + margin,
    bounds.maxY + margin,
    bounds.minX - margin,
    bounds.maxY + margin,
  ];
  for (const cell of cells) {
    let poly = box;
    for (const hs of cell.halfSpaces) {
      poly = clipHalfSpace(poly, hs.nx, hs.ny, hs.b);
      if (poly.length < 6) break;
    }
    if (poly.length < 6) continue;
    const x0 = poly[0]!;
    const y0 = poly[1]!;
    for (let i = 2; i + 3 < poly.length; i += 2) {
      tris.push(x0, y0, poly[i]!, poly[i + 1]!, poly[i + 2]!, poly[i + 3]!);
    }
  }
  return Float32Array.from(tris);
}

/** Sutherland–Hodgman clip of polygon (x,y pairs) to n·x <= b. */
function clipHalfSpace(poly: number[], nx: number, ny: number, b: number): number[] {
  const out: number[] = [];
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const ax = poly[2 * i]!;
    const ay = poly[2 * i + 1]!;
    const bx = poly[(2 * ((i + 1) % n))]!;
    const by = poly[2 * ((i + 1) % n) + 1]!;
    const da = nx * ax + ny * ay - b;
    const db = nx * bx + ny * by - b;
    if (da <= 0) {
      out.push(ax, ay);
      if (db > 0) pushIntersection(out, ax, ay, bx, by, da, db);
    } else if (db <= 0) {
      pushIntersection(out, ax, ay, bx, by, da, db);
    }
  }
  return out;
}

function pushIntersection(
  out: number[],
  ax: number,
  ay: number,
  bx: number,
  by: number,
  da: number,
  db: number,
): void {
  const t = da / (da - db);
  out.push(ax + t * (bx - ax), ay + t * (by - ay));
}

/* ------------------------------ track display data ---------------------------- */

export interface TrackGeometry {
  left: Float32Array;
  right: Float32Array;
  laneTris: Float32Array;
  centerline: Float32Array;
  /** Start/finish stripe endpoints [x1,y1,x2,y2] across the lane. */
  startStripe: [number, number, number, number];
  /** Complete outer-boundary bounds for Fit-all (§15.2). */
  bounds: WorldBounds;
  tolWorld: number;
}

export function buildTrackGeometry(track: CompiledTrackJson, tolWorld: number): TrackGeometry {
  const left = tessellateBoundary(track.leftBoundary, tolWorld);
  const right = tessellateBoundary(track.rightBoundary, tolWorld);
  const bounds = unionBounds(boundsOfPoints(left), boundsOfPoints(right));
  const laneTris = laneFillTriangles(track.cells, bounds);
  const centerline = tessellateLine(centerlineSpec(track), tolWorld);
  const pre = flattenPairs(track.centerPreimageControls);
  const n = gateLeftNormal(pre, 0);
  const gate0 = track.gatePoints[0]!;
  const dL = track.source.leftWidthM;
  const dR = track.source.rightWidthM;
  const startStripe: [number, number, number, number] = [
    gate0[0] + dL * n[0],
    gate0[1] + dL * n[1],
    gate0[0] - dR * n[0],
    gate0[1] - dR * n[1],
  ];
  return { left, right, laneTris, centerline, startStripe, bounds, tolWorld };
}

/* ---------------------------------- caching ----------------------------------- */

/**
 * Tessellations are cached per source object and rebuilt only when the
 * camera demands a finer world tolerance than the cached build (zoom
 * in). Cached lines are built at half the demanded tolerance so small
 * zoom changes do not thrash the cache; a coarser demand keeps the
 * finer cached result, which still satisfies the 0.35 CSS px rule.
 */
export class TessellationCache {
  #tracks = new WeakMap<CompiledTrackJson, TrackGeometry>();
  #lines = new WeakMap<LineSpec, { pts: Float32Array; tolWorld: number }>();

  track(track: CompiledTrackJson, requiredTolWorld: number): TrackGeometry {
    const cached = this.#tracks.get(track);
    if (cached && cached.tolWorld <= requiredTolWorld) return cached;
    const built = buildTrackGeometry(track, requiredTolWorld / 2);
    this.#tracks.set(track, built);
    return built;
  }

  line(spec: LineSpec, requiredTolWorld: number): Float32Array {
    const cached = this.#lines.get(spec);
    if (cached && cached.tolWorld <= requiredTolWorld) return cached.pts;
    const pts = tessellateLine(spec, requiredTolWorld / 2);
    this.#lines.set(spec, { pts, tolWorld: requiredTolWorld / 2 });
    return pts;
  }
}
