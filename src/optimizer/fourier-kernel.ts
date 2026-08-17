import type { CompiledTrackJson } from "@/model/contracts";
import { evaluateFourierSeries, fitRealFourier } from "@/optimizer/fourier";
import {
  centerlineSpec,
  lineDistancesAtParameters,
  sampleLineFrames,
} from "@/renderer/ph-tessellate";

type Vec2 = readonly [number, number];

export interface FourierKernelSpine {
  kind: "fourier-kernel";
  modeCount: number;
  x: Float64Array;
  y: Float64Array;
  maxFitErrorM: number;
  minForwardProgress: number;
  minMetric: number;
  fitSampleCount: number;
}

const KERNEL_CACHE = new WeakMap<CompiledTrackJson, FourierKernelSpine>();

interface ArcLookup {
  parameters: Float64Array;
  distances: Float64Array;
  totalLength: number;
  frames: ReturnType<typeof sampleLineFrames>;
}

function buildArcLookup(track: CompiledTrackJson, count = 8192): ArcLookup {
  const parameters = Float64Array.from({ length: count + 1 }, (_, i) => 64 * i / count);
  const measured = lineDistancesAtParameters(centerlineSpec(track), parameters);
  return {
    parameters,
    distances: Float64Array.from(measured.distances),
    totalLength: measured.totalLength,
    frames: sampleLineFrames(centerlineSpec(track), count),
  };
}

function parameterAtArcFraction(lookup: ArcLookup, u: number): number {
  const wrapped = ((u % 1) + 1) % 1;
  const target = wrapped * lookup.totalLength;
  let low = 0;
  let high = lookup.distances.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >>> 1;
    if (lookup.distances[middle]! <= target) low = middle;
    else high = middle;
  }
  const s0 = lookup.distances[low]!;
  const s1 = lookup.distances[high]!;
  const blend = s1 > s0 ? (target - s0) / (s1 - s0) : 0;
  return lookup.parameters[low]! + blend *
    (lookup.parameters[high]! - lookup.parameters[low]!);
}

function authoritativeFrame(_track: CompiledTrackJson, lookup: ArcLookup, u: number) {
  const parameter = parameterAtArcFraction(lookup, u);
  const scaled = parameter / 64 * lookup.frames.length;
  const beforeIndex = Math.floor(scaled) % lookup.frames.length;
  const afterIndex = (beforeIndex + 1) % lookup.frames.length;
  const blend = scaled - Math.floor(scaled);
  const before = lookup.frames[beforeIndex]!;
  const after = lookup.frames[afterIndex]!;
  const tx = (1 - blend) * before.tx + blend * after.tx;
  const ty = (1 - blend) * before.ty + blend * after.ty;
  const metric = Math.hypot(tx, ty);
  return {
    x: (1 - blend) * before.x + blend * after.x,
    y: (1 - blend) * before.y + blend * after.y,
    tx: tx / Math.max(metric, 1e-15),
    ty: ty / Math.max(metric, 1e-15),
  };
}

export function evaluateFourierKernel(
  spine: FourierKernelSpine,
  u: number,
  maxDerivative = 0,
): Vec2[] {
  const x = evaluateFourierSeries(spine.x, u, maxDerivative);
  const y = evaluateFourierSeries(spine.y, u, maxDerivative);
  return Array.from({ length: maxDerivative + 1 }, (_, derivative): Vec2 => [
    x[derivative]!,
    y[derivative]!,
  ]);
}

function validateFit(
  track: CompiledTrackJson,
  lookup: ArcLookup,
  x: Float64Array,
  y: Float64Array,
  count = 2048,
): { maxFitErrorM: number; minForwardProgress: number; minMetric: number } {
  let maxFitErrorM = 0;
  let minForwardProgress = 1;
  let minMetric = Infinity;
  for (let station = 0; station < count; station++) {
    const u = (station + 0.37) / count;
    const kx = evaluateFourierSeries(x, u, 1);
    const ky = evaluateFourierSeries(y, u, 1);
    const frame = authoritativeFrame(track, lookup, u);
    const metric = Math.hypot(kx[1]!, ky[1]!);
    maxFitErrorM = Math.max(maxFitErrorM, Math.hypot(kx[0]! - frame.x, ky[0]! - frame.y));
    minMetric = Math.min(minMetric, metric);
    minForwardProgress = Math.min(
      minForwardProgress,
      (kx[1]! * frame.tx + ky[1]! * frame.ty) / Math.max(metric, 1e-15),
    );
  }
  return { maxFitErrorM, minForwardProgress, minMetric };
}

/** Fit the separate C-infinity Fourier kernel in approximate PH arc coordinates. */
export function buildFourierKernelSpine(track: CompiledTrackJson): FourierKernelSpine {
  const cached = KERNEL_CACHE.get(track);
  if (cached) return cached;
  const lookup = buildArcLookup(track);
  const fitSampleCount = 512;
  const xs = new Float64Array(fitSampleCount);
  const ys = new Float64Array(fitSampleCount);
  for (let sample = 0; sample < fitSampleCount; sample++) {
    const frame = authoritativeFrame(track, lookup, sample / fitSampleCount);
    xs[sample] = frame.x;
    ys[sample] = frame.y;
  }
  const laneScale = Math.min(track.source.leftWidthM, track.source.rightWidthM);
  const targetError = Math.min(0.01, 0.005 * laneScale);
  let selected: FourierKernelSpine | null = null;
  let best: FourierKernelSpine | null = null;
  for (let modeCount = 4; modeCount <= 96; modeCount += modeCount < 16 ? 2 : 4) {
    const x = fitRealFourier(xs, modeCount, 1e-20, 4);
    const y = fitRealFourier(ys, modeCount, 1e-20, 4);
    const validation = validateFit(track, lookup, x, y);
    const candidate: FourierKernelSpine = {
      kind: "fourier-kernel",
      modeCount,
      x,
      y,
      ...validation,
      fitSampleCount,
    };
    if (candidate.minForwardProgress > 0.5 && candidate.minMetric > 1e-8 &&
        (best === null || candidate.maxFitErrorM < best.maxFitErrorM)) best = candidate;
    if (candidate.maxFitErrorM <= targetError && candidate.minForwardProgress > 0.9 &&
        candidate.minMetric > 1e-8) {
      selected = candidate;
      break;
    }
  }
  selected ??= best;
  if (selected === null || !(selected.minForwardProgress > 0.5) ||
      !(selected.minMetric > 1e-8) || !(selected.maxFitErrorM < 0.25 * laneScale)) {
    throw new Error("Fourier kernel fit is not a regular forward lane chart");
  }
  KERNEL_CACHE.set(track, selected);
  return selected;
}
