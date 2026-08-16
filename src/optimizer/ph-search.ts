import type { CompiledTrackJson, VehicleSettings } from "@/model/contracts";
import {
  centerlineSpec,
  evaluateLineFrame,
  flattenPairs,
  gatesFromPreimage,
  sampleLineFrames,
  spanDisplacement,
  spanPreimageBezier,
  type LineSpec,
} from "@/renderer/ph-tessellate";

export const SEARCH_LOCAL_MODE_COUNT = 128;
export const SEARCH_MEDIUM_MODE_COUNT = 32;
export const SEARCH_BROAD_MODE_COUNT = 16;
export const SEARCH_PREIMAGE_MODE_COUNT =
  SEARCH_LOCAL_MODE_COUNT + SEARCH_MEDIUM_MODE_COUNT + SEARCH_BROAD_MODE_COUNT;
export const SEARCH_START_MODE = SEARCH_PREIMAGE_MODE_COUNT;
export const SEARCH_MODE_COUNT = SEARCH_PREIMAGE_MODE_COUNT + 1;
export const SEARCH_CLOSURE_MODE_COUNT = 2;
export const SEARCH_BASIS_COUNT = SEARCH_MODE_COUNT + SEARCH_CLOSURE_MODE_COUNT;
export const SEARCH_DELTA_LIMIT = 0.5;
export const SEARCH_RANDOM_MOVE_COUNT = 4;
export const SEARCH_SMOOTH_VARIANT_COUNT = 3;
export const SEARCH_SMOOTH_CANDIDATE_COUNT =
  SEARCH_LOCAL_MODE_COUNT * SEARCH_SMOOTH_VARIANT_COUNT;
export const SEARCH_SMOOTH_FIRST_CANDIDATE = 2 * SEARCH_MODE_COUNT + 1;
const BASIS_CACHE = new WeakMap<CompiledTrackJson, Float32Array>();
const START_NORMAL_CACHE = new WeakMap<CompiledTrackJson, [number, number]>();
const GATE_NORMAL_CACHE = new WeakMap<CompiledTrackJson, Float64Array>();

export interface ContainmentMeasure {
  valid: boolean;
  /** Largest used fraction of either lane half-width. One is the boundary. */
  maxUtilization: number;
  /** Smallest signed distance between the swept rectangle and a lane edge. */
  minClearanceM: number;
}

function totalDisplacement(preimage: Float64Array): [number, number] {
  let x = 0;
  let y = 0;
  for (let span = 0; span < 128; span++) {
    const displacement = spanDisplacement(spanPreimageBezier(preimage, span));
    x += displacement[0];
    y += displacement[1];
  }
  return [x, y];
}

function harmonicDirection(mode: number): Float64Array {
  const direction = new Float64Array(256);
  const harmonic = 2 * Math.floor(mode / 2) + 1;
  for (let j = 0; j < 128; j++) {
    const angle = harmonic * Math.PI * j / 128 + (mode % 2) * Math.PI / 2;
    direction[2 * j] = Math.cos(angle);
    direction[2 * j + 1] = Math.sin(angle);
  }
  return direction;
}

function closureDerivative(base: Float64Array, direction: Float64Array): [number, number] {
  const epsilon = 1e-5;
  const plus = base.slice();
  const minus = base.slice();
  for (let i = 0; i < plus.length; i++) {
    plus[i] = plus[i]! + epsilon * direction[i]!;
    minus[i] = minus[i]! - epsilon * direction[i]!;
  }
  const fp = totalDisplacement(plus);
  const fm = totalDisplacement(minus);
  return [(fp[0] - fm[0]) / (2 * epsilon), (fp[1] - fm[1]) / (2 * epsilon)];
}

/**
 * 128 compact, 32 medium, and 16 broad PH-preimage shape coordinates, one
 * explicit start-gate offset, then two global closure coordinates. The wider
 * modes let one proposal straighten a linked corner sector instead of building
 * that change from many noisy local edits. Candidate scoring solves the two
 * closure coordinates.
 */
export function searchModeBasis(track: CompiledTrackJson): Float32Array {
  const cached = BASIS_CACHE.get(track);
  if (cached) return cached;
  const base = flattenPairs(track.centerPreimageControls);
  const basis = new Float32Array(128 * SEARCH_BASIS_COUNT * 2);
  const weights = [1, 0.72, 0.28, 0.08];
  for (let mode = 0; mode < SEARCH_LOCAL_MODE_COUNT; mode++) {
    for (let offset = -3; offset <= 3; offset++) {
      const j = (mode + offset + 128) % 128;
      const weight = weights[Math.abs(offset)]!;
      const index = 2 * (SEARCH_BASIS_COUNT * j + mode);
      basis[index] = Math.fround(-base[2 * j + 1]! * weight);
      basis[index + 1] = Math.fround(base[2 * j]! * weight);
    }
  }

  const addWindowedModes = (
    firstMode: number,
    modeCount: number,
    controlStride: number,
    radius: number,
    scale: number,
  ): void => {
    for (let localMode = 0; localMode < modeCount; localMode++) {
      const mode = firstMode + localMode;
      const center = localMode * controlStride;
      for (let offset = -radius; offset <= radius; offset++) {
        const j = (center + offset + 128) % 128;
        const window = 0.5 * (1 + Math.cos(Math.PI * offset / (radius + 1)));
        const index = 2 * (SEARCH_BASIS_COUNT * j + mode);
        basis[index] = Math.fround(-base[2 * j + 1]! * window * scale);
        basis[index + 1] = Math.fround(base[2 * j]! * window * scale);
      }
    }
  };
  addWindowedModes(SEARCH_LOCAL_MODE_COUNT, SEARCH_MEDIUM_MODE_COUNT, 4, 12, 0.34);
  addWindowedModes(
    SEARCH_LOCAL_MODE_COUNT + SEARCH_MEDIUM_MODE_COUNT,
    SEARCH_BROAD_MODE_COUNT,
    8,
    24,
    0.2,
  );

  const closureCandidates = Array.from({ length: 16 }, (_, mode) => harmonicDirection(mode));
  const derivatives = closureCandidates.map(direction => closureDerivative(base, direction));
  let first = 0;
  let second = 1;
  let bestDeterminant = 0;
  for (let a = 0; a < derivatives.length; a++) for (let b = a + 1; b < derivatives.length; b++) {
    const determinant = Math.abs(
      derivatives[a]![0] * derivatives[b]![1] - derivatives[a]![1] * derivatives[b]![0],
    );
    if (determinant > bestDeterminant) {
      bestDeterminant = determinant;
      first = a;
      second = b;
    }
  }
  for (let j = 0; j < 128; j++) for (const [slot, direction] of [
    [SEARCH_MODE_COUNT, closureCandidates[first]!],
    [SEARCH_MODE_COUNT + 1, closureCandidates[second]!],
  ] as const) {
    const index = 2 * (SEARCH_BASIS_COUNT * j + slot);
    basis[index] = Math.fround(direction[2 * j]!);
    basis[index + 1] = Math.fround(direction[2 * j + 1]!);
  }
  BASIS_CACHE.set(track, basis);
  return basis;
}

function basisValue(basis: Float32Array, control: number, mode: number): [number, number] {
  const index = 2 * (SEARCH_BASIS_COUNT * control + mode);
  return [basis[index]!, basis[index + 1]!];
}

function closePreimage(preimage: Float64Array, basis: Float32Array): void {
  const directions = [SEARCH_MODE_COUNT, SEARCH_MODE_COUNT + 1];
  for (let iteration = 0; iteration < 5; iteration++) {
    const f = totalDisplacement(preimage);
    if (Math.hypot(f[0], f[1]) < 1e-10) return;
    const jacobian: [number, number][] = [];
    for (const mode of directions) {
      const direction = new Float64Array(256);
      for (let j = 0; j < 128; j++) {
        const value = basisValue(basis, j, mode);
        direction[2 * j] = value[0];
        direction[2 * j + 1] = value[1];
      }
      jacobian.push(closureDerivative(preimage, direction));
    }
    const determinant = jacobian[0]![0] * jacobian[1]![1] - jacobian[0]![1] * jacobian[1]![0];
    if (Math.abs(determinant) < 1e-12) throw new Error("PH closure projection is singular");
    const a = (-f[0] * jacobian[1]![1] + jacobian[1]![0] * f[1]) / determinant;
    const b = (-jacobian[0]![0] * f[1] + f[0] * jacobian[0]![1]) / determinant;
    for (let j = 0; j < 128; j++) {
      const da = basisValue(basis, j, directions[0]!);
      const db = basisValue(basis, j, directions[1]!);
      preimage[2 * j] = preimage[2 * j]! + a * da[0] + b * db[0];
      preimage[2 * j + 1] = preimage[2 * j + 1]! + a * da[1] + b * db[1];
    }
  }
}

function centerStartNormal(track: CompiledTrackJson): [number, number] {
  const cached = START_NORMAL_CACHE.get(track);
  if (cached) return cached;
  const center = {
    preimage: flattenPairs(track.centerPreimageControls),
    gates: flattenPairs(track.gatePoints),
  };
  const frame = sampleLineFrames(center, 1)[0]!;
  const normal: [number, number] = [-frame.ty, frame.tx];
  START_NORMAL_CACHE.set(track, normal);
  return normal;
}

function startOffsetM(track: CompiledTrackJson, coordinate: number): number {
  return coordinate >= 0
    ? 2 * coordinate * track.source.leftWidthM
    : 2 * coordinate * track.source.rightWidthM;
}

function lineFromPreimage(
  track: CompiledTrackJson,
  preimage: Float64Array,
  startCoordinate = 0,
): LineSpec {
  const origin = track.gatePoints[0]!;
  const normal = centerStartNormal(track);
  const offset = startOffsetM(track, startCoordinate);
  return {
    preimage,
    gates: gatesFromPreimage(
      preimage,
      origin[0] + offset * normal[0],
      origin[1] + offset * normal[1],
    ),
  };
}

export function lineFromSearchDelta(
  track: CompiledTrackJson,
  delta: ArrayLike<number>,
): LineSpec {
  const preimage = flattenPairs(track.centerPreimageControls);
  const basis = searchModeBasis(track);
  for (let j = 0; j < 128; j++) {
    for (let k = 0; k < SEARCH_PREIMAGE_MODE_COUNT; k++) {
      const d = delta[k] ?? 0;
      if (d === 0) continue;
      const value = basisValue(basis, j, k);
      preimage[2 * j] = preimage[2 * j]! + d * value[0];
      preimage[2 * j + 1] = preimage[2 * j + 1]! + d * value[1];
    }
  }
  closePreimage(preimage, basis);
  return lineFromPreimage(track, preimage, delta[SEARCH_START_MODE] ?? 0);
}

/** Apply the one localized coordinate move used by one GPU candidate. */
export function candidateLineFromSearch(
  track: CompiledTrackJson,
  incumbentLine: LineSpec,
  incumbent: ArrayLike<number>,
  candidate: number,
  batch: number,
  sigma: number,
  seed: number,
): LineSpec {
  const next = candidateSearchDelta(incumbent, candidate, batch, sigma, seed);
  const basis = searchModeBasis(track);
  const preimage = incumbentLine.preimage.slice();
  for (let j = 0; j < 128; j++) {
    for (let mode = 0; mode < SEARCH_PREIMAGE_MODE_COUNT; mode++) {
      const step = next[mode]! - (incumbent[mode] ?? 0);
      if (step === 0) continue;
      const value = basisValue(basis, j, mode);
      preimage[2 * j] = preimage[2 * j]! + step * value[0];
      preimage[2 * j + 1] = preimage[2 * j + 1]! + step * value[1];
    }
  }
  closePreimage(preimage, basis);
  return lineFromPreimage(track, preimage, next[SEARCH_START_MODE] ?? 0);
}

export function genotypeForLine(track: CompiledTrackJson, line: LineSpec): Float64Array {
  const genotype = new Float64Array(64);
  const center = {
    preimage: flattenPairs(track.centerPreimageControls),
    gates: flattenPairs(track.gatePoints),
  };
  const frames = sampleLineFrames(center, 64);
  for (let i = 0; i < 64; i++) {
    const frame = frames[i]!;
    genotype[i] =
      (line.gates[2 * i]! - frame.x) * -frame.ty +
      (line.gates[2 * i + 1]! - frame.y) * frame.tx;
  }
  return genotype;
}

function centerGateNormals(track: CompiledTrackJson): Float64Array {
  const cached = GATE_NORMAL_CACHE.get(track);
  if (cached) return cached;
  const line = centerlineSpec(track);
  const normals = new Float64Array(128);
  for (let gate = 0; gate < 64; gate++) {
    const frame = evaluateLineFrame(line, gate);
    normals[2 * gate] = -frame.ty;
    normals[2 * gate + 1] = frame.tx;
  }
  GATE_NORMAL_CACHE.set(track, normals);
  return normals;
}

/** Replace one periodic gate window by its physical endpoint chord, projected
 * onto each track gate normal. Exact construction and containment decide
 * whether the coordinated straight-through proposal is feasible. */
export function chordStraightenedGenotype(
  track: CompiledTrackJson,
  genotype: ArrayLike<number>,
  center: number,
  radius: number,
  blend: number,
): Float64Array<ArrayBuffer> {
  const proposal = Float64Array.from(genotype);
  const normals = centerGateNormals(track);
  const left = (center - radius + 64) % 64;
  const right = (center + radius) % 64;
  const point = (gate: number): [number, number] => {
    const base = track.gatePoints[gate]!;
    return [
      base[0] + normals[2 * gate]! * (genotype[gate] ?? 0),
      base[1] + normals[2 * gate + 1]! * (genotype[gate] ?? 0),
    ];
  };
  const a = point(left);
  const b = point(right);
  for (let step = 1; step < 2 * radius; step++) {
    const gate = (left + step) % 64;
    const t = step / (2 * radius);
    const targetX = a[0] + t * (b[0] - a[0]);
    const targetY = a[1] + t * (b[1] - a[1]);
    const base = track.gatePoints[gate]!;
    const targetOffset =
      (targetX - base[0]) * normals[2 * gate]! +
      (targetY - base[1]) * normals[2 * gate + 1]!;
    const bounded = Math.max(
      -track.source.rightWidthM,
      Math.min(track.source.leftWidthM, targetOffset),
    );
    proposal[gate] = (genotype[gate] ?? 0) + blend * (bounded - (genotype[gate] ?? 0));
  }
  return proposal;
}

function antiperiodicPreimageControl(
  preimage: ArrayLike<number>,
  index: number,
): [number, number, number, number] {
  const wraps = Math.floor(index / 128);
  const base = ((index % 128) + 128) % 128;
  const sign = (wraps & 1) === 0 ? 1 : -1;
  return [
    sign * (preimage[2 * base] ?? 0),
    sign * (preimage[2 * base + 1] ?? 0),
    base,
    sign,
  ];
}

/** Low-pass one local PH-preimage window while respecting its antiperiodic
 * seam. The C99 projector restores the unchanged racing gates afterward, so
 * this proposal explores the otherwise hidden interpolation-nullspace shape. */
export function smoothPreimageWindow(
  preimage: ArrayLike<number>,
  center: number,
  radius: number,
  blend: number,
): Float64Array<ArrayBuffer> {
  const proposal = Float64Array.from(preimage);
  for (let offset = -radius; offset <= radius; offset++) {
    const index = center + offset;
    const previous = antiperiodicPreimageControl(preimage, index - 1);
    const current = antiperiodicPreimageControl(preimage, index);
    const next = antiperiodicPreimageControl(preimage, index + 1);
    const window = 0.5 * (1 + Math.cos(Math.PI * offset / (radius + 1)));
    const amount = blend * window;
    const targetX = 0.25 * previous[0] + 0.5 * current[0] + 0.25 * next[0];
    const targetY = 0.25 * previous[1] + 0.5 * current[1] + 0.25 * next[1];
    proposal[2 * current[2]] = current[3] * (
      current[0] + amount * (targetX - current[0])
    );
    proposal[2 * current[2] + 1] = current[3] * (
      current[1] + amount * (targetY - current[1])
    );
  }
  return proposal;
}

/** Locate narrow curvature changes in a packed certified profile. The return
 * values are PH preimage-control indices, not racing-gate indices. */
export function curvatureHotspotControls(
  nodes: ArrayLike<number>,
  edgeCount: number,
  limit = 8,
): number[] {
  const scoreByControl = new Float64Array(128);
  const at = (node: number, field: number): number => {
    const wrapped = ((node % edgeCount) + edgeCount) % edgeCount;
    return nodes[7 * wrapped + field] ?? 0;
  };
  for (let node = 0; node < edgeCount; node++) {
    const kappa = at(node, 5);
    const nearRoughness = Math.abs(2 * kappa - at(node - 4, 5) - at(node + 4, 5));
    const farRoughness = Math.abs(2 * kappa - at(node - 8, 5) - at(node + 8, 5));
    const speed = Math.sqrt(Math.max(0, at(node, 3)));
    const neighborSpeed = Math.sqrt(Math.max(0, at(node - 8, 3), at(node + 8, 3)));
    const relativeDrop = Math.max(0, neighborSpeed - speed) / Math.max(neighborSpeed, 1);
    const score = (nearRoughness + 0.5 * farRoughness) * (1 + 4 * relativeDrop);
    const parameter = at(node, 0);
    const control = ((Math.round(2 * parameter) % 128) + 128) % 128;
    scoreByControl[control] = Math.max(scoreByControl[control]!, score);
  }
  const ranked = Array.from({ length: 128 }, (_, control) => control)
    .sort((a, b) => scoreByControl[b]! - scoreByControl[a]!);
  const selected: number[] = [];
  for (const control of ranked) {
    if (!(scoreByControl[control]! > 0)) break;
    const separated = selected.every(existing => {
      const distance = Math.abs(existing - control);
      return Math.min(distance, 128 - distance) > 3;
    });
    if (separated) selected.push(control);
    if (selected.length === limit) break;
  }
  return selected;
}

/**
 * Sampled provisional guard used only before the independent C99 certificate.
 * It evaluates the complete oriented vehicle rectangle, including safety margin.
 */
export function measureSweptRectangle(
  track: CompiledTrackJson,
  line: LineSpec,
  vehicle: VehicleSettings,
  sampleCount = 256,
): ContainmentMeasure {
  const center = {
    preimage: flattenPairs(track.centerPreimageControls),
    gates: flattenPairs(track.gatePoints),
  };
  const halfLength = vehicle.lengthM / 2 + vehicle.safetyMarginM;
  const halfWidth = vehicle.widthM / 2 + vehicle.safetyMarginM;
  let maxUtilization = 0;
  let minClearanceM = Infinity;
  const centerFrames = sampleLineFrames(center, sampleCount);
  const lineFrames = sampleLineFrames(line, sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const centerFrame = centerFrames[i]!;
    const frame = lineFrames[i]!;
    const centerNx = -centerFrame.ty;
    const centerNy = centerFrame.tx;
    const lateral =
      (frame.x - centerFrame.x) * centerNx +
      (frame.y - centerFrame.y) * centerNy;
    const extent =
      halfLength * Math.abs(frame.tx * centerNx + frame.ty * centerNy) +
      halfWidth * Math.abs(-frame.ty * centerNx + frame.tx * centerNy);
    const leftUse = lateral + extent;
    const rightUse = -lateral + extent;
    maxUtilization = Math.max(
      maxUtilization,
      leftUse / track.source.leftWidthM,
      rightUse / track.source.rightWidthM,
    );
    minClearanceM = Math.min(
      minClearanceM,
      track.source.leftWidthM - leftUse,
      track.source.rightWidthM - rightUse,
    );
  }
  return { valid: minClearanceM >= 0, maxUtilization, minClearanceM };
}

export function hash32(value: number): number {
  let x = value >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

function proposalNoise(candidate: number, mode: number, move: number, batch: number, seed: number): number {
  const base =
    (candidate ^ Math.imul(batch, 0x9e3779b9) ^ Math.imul(mode, 0x85ebca6b) ^
      Math.imul(move, 0x27d4eb2d) ^ seed) >>> 0;
  let sum = 0;
  for (let draw = 0; draw < 4; draw++) {
    const bits = hash32((base + Math.imul(draw, 0xc2b2ae35)) >>> 0);
    sum += (bits & 0x00ffffff) / 16777216;
  }
  return Math.fround(sum - 2);
}

export function candidateMode(candidate: number, batch: number, seed: number): number {
  if (candidate > 0 && candidate <= 2 * SEARCH_MODE_COUNT) return Math.floor((candidate - 1) / 2);
  if (candidate >= SEARCH_SMOOTH_FIRST_CANDIDATE &&
      candidate < SEARCH_SMOOTH_FIRST_CANDIDATE + SEARCH_SMOOTH_CANDIDATE_COUNT) {
    return Math.floor(
      (candidate - SEARCH_SMOOTH_FIRST_CANDIDATE) / SEARCH_SMOOTH_VARIANT_COUNT,
    );
  }
  const base = hash32((candidate ^ Math.imul(batch, 0x9e3779b9) ^ seed) >>> 0);
  return (base & 15) === 0 ? SEARCH_START_MODE : base % SEARCH_PREIMAGE_MODE_COUNT;
}

function candidateModeAt(candidate: number, move: number, batch: number, seed: number): number {
  if (candidate <= 2 * SEARCH_MODE_COUNT ||
      (candidate >= SEARCH_SMOOTH_FIRST_CANDIDATE &&
       candidate < SEARCH_SMOOTH_FIRST_CANDIDATE + SEARCH_SMOOTH_CANDIDATE_COUNT)) {
    return candidateMode(candidate, batch, seed);
  }
  const base = hash32((candidate ^ Math.imul(batch, 0x9e3779b9) ^ seed) >>> 0);
  if (move === 0 && (base & 15) === 0) return SEARCH_START_MODE;
  const stride = (hash32(base ^ 0x68bc21eb) | 1) % SEARCH_PREIMAGE_MODE_COUNT;
  return (base + move * stride) % SEARCH_PREIMAGE_MODE_COUNT;
}

/** Reconstructs the exact f32 proposal generated by optimizer.wgsl. */
export function candidateSearchDelta(
  incumbent: ArrayLike<number>,
  candidate: number,
  batch: number,
  sigma: number,
  seed: number,
): Float32Array<ArrayBuffer> {
  const delta = Float32Array.from(incumbent as ArrayLike<number>);
  if (candidate === 0) return delta;
  const probe = candidate <= 2 * SEARCH_MODE_COUNT;
  const smooth = candidate >= SEARCH_SMOOTH_FIRST_CANDIDATE &&
    candidate < SEARCH_SMOOTH_FIRST_CANDIDATE + SEARCH_SMOOTH_CANDIDATE_COUNT;
  const moveCount = probe || smooth ? 1 : SEARCH_RANDOM_MOVE_COUNT;
  for (let move = 0; move < moveCount; move++) {
    const mode = candidateModeAt(candidate, move, batch, seed);
    const base = Math.fround(incumbent[mode] ?? 0);
    let change: number;
    if (probe) {
      const bits = hash32((seed ^ Math.imul(mode + 1, 0x85ebca6b)) >>> 0);
      const unit = Math.fround((bits & 0x00ffffff) / 16777216);
      const magnitude = Math.fround(0.02 + Math.fround(0.1 * unit));
      change = candidate % 2 === 1 ? -magnitude : magnitude;
    } else if (smooth) {
      const variant = (candidate - SEARCH_SMOOTH_FIRST_CANDIDATE) %
        SEARCH_SMOOTH_VARIANT_COUNT;
      const blend = [1, 0.5, 0.25][variant]!;
      const left = Math.fround(
        incumbent[(mode + SEARCH_LOCAL_MODE_COUNT - 1) % SEARCH_LOCAL_MODE_COUNT] ?? 0,
      );
      const right = Math.fround(
        incumbent[(mode + 1) % SEARCH_LOCAL_MODE_COUNT] ?? 0,
      );
      const target = Math.fround(
        Math.fround(0.25 * left) + Math.fround(0.5 * base) + Math.fround(0.25 * right),
      );
      change = Math.fround(blend * Math.fround(target - base));
    } else {
      change = Math.fround(
        Math.fround(sigma / Math.sqrt(SEARCH_RANDOM_MOVE_COUNT)) *
        proposalNoise(candidate, mode, move, batch, seed),
      );
    }
    delta[mode] = Math.fround(Math.max(
      -SEARCH_DELTA_LIMIT,
      Math.min(SEARCH_DELTA_LIMIT, Math.fround(base + change)),
    ));
  }
  return delta;
}
