/// <reference types="@webgpu/types" />
import type {
  CompiledTrackJson,
  OptimizerCommand,
  OptimizerEvent,
  V2RepresentationsJson,
  VehicleSettings,
} from "@/model/contracts";
import { GRAVITY } from "@/model/contracts";
import {
  IslandEvolution,
  backtrackToFeasible,
  compareFeasibleFirst,
  type FeasibleFirstScore,
  type IslandCandidate,
  type IslandEvolutionSnapshot,
  type IslandObservation,
} from "@/optimizer/island-es";
import { evaluateMinimumLapCandidate } from "@/optimizer/minimum-lap";
import { selectFullEvaluationIndices } from "@/optimizer/surrogate-screening";
import { selectDiverseTimeArchive } from "@/optimizer/elite-archive";
import {
  buildHybridBasisTable,
  buildHybridPeriodicBasis,
  hybridCoefficientCount,
  remapHybridCoefficients,
  type HybridPeriodicBasis,
} from "@/optimizer/hybrid-basis";
import {
  fitRealFourier,
  fourierCoefficientCount,
  selectFourierModeRange,
} from "@/optimizer/fourier";
import { PhiloxStream } from "@/optimizer/philox";
import {
  fitCurvatureRepresentation,
  projectCurvatureClosure,
  projectCurvaturePerturbation,
  reconstructCurvaturePath,
  type CurvatureRepresentation,
} from "@/optimizer/curvature-closure";
import { evaluateCurvatureCandidate } from "@/optimizer/curvature-evaluation";
import { smoothPatternProposals } from "@/optimizer/smooth-arc-search";
import { minimumCurvatureSeed } from "@/optimizer/geometric-seed";
import {
  buildReferenceSpine,
  buildReferenceGeometryTable,
  buildSafeCorridor,
  lateralFieldGenotype,
  lateralFieldPreimage,
  racingLinePolyline,
  remapFourierCorridor,
  sampleRacingLine,
  type SafeCorridor,
} from "@/optimizer/racing-line";
import {
  centerlineSpec,
  evaluateLineFrame,
} from "@/renderer/ph-tessellate";
import shaderSource from "./optimizer.wgsl?raw";

const GPU_ISLAND_COUNT = 8;
const GPU_POPULATION_PER_ISLAND = 256;
const CPU_ISLAND_COUNT = 4;
const CPU_POPULATION_PER_ISLAND = 8;
const GENERATIONS_PER_LEVEL = 4;
const FULL_RECHECKS_PER_ISLAND = 4;
const DISCOVERY_ELITE_COUNT = 12;
const CURVATURE_SOURCE_COUNT = 6;
const PATTERN_FULL_RECHECKS = 4;

function mutationSigmas(
  basis: HybridPeriodicBasis,
  referenceFourierModes: number,
  referenceResidualCount: number,
  base: number,
): Float64Array {
  const fourierCount = fourierCoefficientCount(basis.fourierModes);
  return Float64Array.from(
    { length: hybridCoefficientCount(basis) },
    (_, index) => {
      if (index < fourierCount) {
        const mode = index === 0 ? 0 : Math.ceil(index / 2);
        return base * Math.min(1, (referenceFourierModes / Math.max(1, mode)) ** 2);
      }
      return base * Math.min(
        1,
        (referenceResidualCount / Math.max(1, basis.residualControlCount)) ** 2,
      );
    },
  );
}

function truthStationCount(basis: HybridPeriodicBasis): number {
  return Math.max(
    512,
    4 * basis.residualControlCount,
    16 * basis.fourierModes,
  );
}

let command: Extract<OptimizerCommand, { type: "init" }> | null = null;
let stopping = false;
let running = false;
let generation = 0;
let candidateCountTotal = 0;
let backgroundExecution = true;

const yieldChannel = new MessageChannel();
const yieldResolvers: Array<() => void> = [];
yieldChannel.port1.onmessage = () => yieldResolvers.shift()?.();

function yieldForHostEvents(): Promise<void> {
  if (!backgroundExecution) {
    return new Promise(resolve => setTimeout(resolve, 16));
  }
  return new Promise(resolve => {
    yieldResolvers.push(resolve);
    yieldChannel.port2.postMessage(null);
  });
}

type EventBody<T> = T extends unknown
  ? Omit<T, "runVersion" | "trackFingerprint" | "settingsFingerprint">
  : never;

function send(body: EventBody<OptimizerEvent>): void {
  if (!command) return;
  self.postMessage({
    runVersion: command.runVersion,
    trackFingerprint: command.trackFingerprint,
    settingsFingerprint: command.settingsFingerprint,
    ...body,
  });
}

interface GpuContext {
  adapter: GPUAdapter;
  device: GPUDevice;
  bindGroupLayout: GPUBindGroupLayout;
  geometryPipeline: GPUComputePipeline;
  reductionPipeline: GPUComputePipeline;
}

interface GpuResolution {
  context: GpuContext;
  bindGroup: GPUBindGroup;
  coefficientBuffer: GPUBuffer;
  referenceBuffer: GPUBuffer;
  basisBuffer: GPUBuffer;
  stationGeometryBuffer: GPUBuffer;
  stationViolationBuffer: GPUBuffer;
  speedProfileBuffer: GPUBuffer;
  settingsBuffer: GPUBuffer;
  resultBuffer: GPUBuffer;
  readBuffer: GPUBuffer;
  candidateCount: number;
  coefficientCount: number;
  stationCount: number;
}

async function requestGpu(): Promise<GpuContext | null> {
  if (!navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  void device.lost.then(info => {
    stopping = true;
    send({ type: "deviceLost", reason: info.message || info.reason });
  });
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    ],
  });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
  const module = device.createShaderModule({ code: shaderSource });
  const geometryPipeline = device.createComputePipeline({
    layout,
    compute: {
      module,
      entryPoint: "geometryMain",
    },
  });
  const reductionPipeline = device.createComputePipeline({
    layout,
    compute: { module, entryPoint: "reduceMain" },
  });
  return { adapter, device, bindGroupLayout, geometryPipeline, reductionPipeline };
}

function adapterLabel(adapter: GPUAdapter): string {
  const info = adapter.info;
  const parts = [info.vendor, info.architecture, info.device, info.description].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "high-performance adapter";
}

function createGpuResolution(
  context: GpuContext,
  track: CompiledTrackJson,
  vehicle: VehicleSettings,
  candidateCount: number,
  basisModel: HybridPeriodicBasis,
  stationCount: number,
  corridor: SafeCorridor,
): GpuResolution {
  const { device } = context;
  const reference = buildReferenceGeometryTable(track, stationCount);
  const basis = buildHybridBasisTable(basisModel, stationCount);
  const coefficientCount = hybridCoefficientCount(basisModel);
  const halfLength = vehicle.lengthM / 2 + vehicle.safetyMarginM;
  const halfWidth = vehicle.widthM / 2 + vehicle.safetyMarginM;
  const settings = Float32Array.from([
    candidateCount,
    coefficientCount,
    stationCount,
    corridor.lower,
    corridor.upper,
    track.source.leftWidthM,
    track.source.rightWidthM,
    halfLength,
    halfWidth,
    vehicle.vMaxMps ** 2,
    vehicle.ay0,
    vehicle.airDensity * vehicle.downforceAreaM2 / (2 * vehicle.massKg * GRAVITY),
    vehicle.kappaMax ?? 0,
    0.1,
    vehicle.lengthM + 2 * vehicle.safetyMarginM,
    vehicle.axPlus0,
    vehicle.axMinus0,
    vehicle.ellipseP,
    vehicle.airDensity * vehicle.dragAreaM2 / (2 * vehicle.massKg),
  ]);
  const storage = (data: ArrayBufferView, label: string): GPUBuffer => {
    const buffer = device.createBuffer({
      label,
      size: Math.max(16, (data.byteLength + 15) & ~15),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  };
  const coefficientBuffer = device.createBuffer({
    label: "lateral candidate coefficients",
    size: Math.max(16, candidateCount * coefficientCount * 4),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const referenceBuffer = storage(reference, "reference spine geometry");
  const basisBuffer = storage(basis, "periodic quintic basis table");
  const settingsBuffer = storage(settings, "minimum-lap settings");
  const stationGeometryBuffer = device.createBuffer({
    label: "station-major candidate geometry",
    size: candidateCount * stationCount * 16,
    usage: GPUBufferUsage.STORAGE,
  });
  const stationViolationBuffer = device.createBuffer({
    label: "station-major candidate violations",
    size: candidateCount * stationCount * 4,
    usage: GPUBufferUsage.STORAGE,
  });
  const speedProfileBuffer = device.createBuffer({
    label: "station-major candidate speed profile",
    size: candidateCount * stationCount * 4,
    usage: GPUBufferUsage.STORAGE,
  });
  const resultBuffer = device.createBuffer({
    label: "candidate proxy results",
    size: candidateCount * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readBuffer = device.createBuffer({
    label: "candidate proxy readback",
    size: candidateCount * 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const bindGroup = device.createBindGroup({
    layout: context.bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: coefficientBuffer } },
      { binding: 1, resource: { buffer: referenceBuffer } },
      { binding: 2, resource: { buffer: basisBuffer } },
      { binding: 3, resource: { buffer: stationGeometryBuffer } },
      { binding: 4, resource: { buffer: stationViolationBuffer } },
      { binding: 5, resource: { buffer: resultBuffer } },
      { binding: 6, resource: { buffer: settingsBuffer } },
      { binding: 7, resource: { buffer: speedProfileBuffer } },
    ],
  });
  return {
    context,
    bindGroup,
    coefficientBuffer,
    referenceBuffer,
    basisBuffer,
    stationGeometryBuffer,
    stationViolationBuffer,
    speedProfileBuffer,
    settingsBuffer,
    resultBuffer,
    readBuffer,
    candidateCount,
    coefficientCount,
    stationCount,
  };
}

function destroyGpuResolution(gpu: GpuResolution): void {
  gpu.coefficientBuffer.destroy();
  gpu.referenceBuffer.destroy();
  gpu.basisBuffer.destroy();
  gpu.stationGeometryBuffer.destroy();
  gpu.stationViolationBuffer.destroy();
  gpu.speedProfileBuffer.destroy();
  gpu.settingsBuffer.destroy();
  gpu.resultBuffer.destroy();
  gpu.readBuffer.destroy();
}

async function scoreGpu(
  gpu: GpuResolution,
  candidates: IslandCandidate[],
): Promise<Float32Array> {
  const packed = new Float32Array(gpu.candidateCount * gpu.coefficientCount);
  for (let candidate = 0; candidate < candidates.length; candidate++) {
    for (let coefficient = 0; coefficient < gpu.coefficientCount; coefficient++) {
      packed[coefficient * gpu.candidateCount + candidate] =
        candidates[candidate]!.coefficients[coefficient] ?? 0;
    }
  }
  gpu.context.device.queue.writeBuffer(gpu.coefficientBuffer, 0, packed);
  const encoder = gpu.context.device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(gpu.context.geometryPipeline);
  pass.setBindGroup(0, gpu.bindGroup);
  pass.dispatchWorkgroups(Math.ceil(gpu.candidateCount * gpu.stationCount / 256));
  pass.setPipeline(gpu.context.reductionPipeline);
  pass.dispatchWorkgroups(Math.ceil(gpu.candidateCount / 256));
  pass.end();
  encoder.copyBufferToBuffer(gpu.resultBuffer, 0, gpu.readBuffer, 0, gpu.candidateCount * 16);
  gpu.context.device.queue.submit([encoder.finish()]);
  await gpu.readBuffer.mapAsync(GPUMapMode.READ);
  const output = new Float32Array(4 * gpu.candidateCount);
  output.set(new Float32Array(gpu.readBuffer.getMappedRange()));
  gpu.readBuffer.unmap();
  return output;
}

function scoreCpu(
  track: CompiledTrackJson,
  vehicle: VehicleSettings,
  basis: HybridPeriodicBasis,
  candidates: IslandCandidate[],
  stationCount: number,
  corridor: SafeCorridor,
): Float32Array {
  const output = new Float32Array(4 * candidates.length);
  for (let index = 0; index < candidates.length; index++) {
    try {
      const score = evaluateMinimumLapCandidate(
        track, vehicle, basis, candidates[index]!.coefficients, stationCount, "full", corridor,
      );
      output.set([
        score.lapTime,
        score.violation,
        score.regularizer,
        score.minClearanceM,
      ], 4 * index);
    } catch {
      output.set([1e30, 1e30, 1e30, -1e30], 4 * index);
    }
  }
  return output;
}

function proxyObservations(
  candidates: IslandCandidate[],
  packed: Float32Array,
): IslandObservation[] {
  return candidates.map((candidate, index): IslandObservation => {
    const violation = packed[4 * index + 1] ?? Infinity;
    return {
      candidate,
      score: {
        feasible: violation === 0,
        violation,
        lapTime: packed[4 * index] ?? Infinity,
        regularizer: packed[4 * index + 2] ?? Infinity,
        minClearanceM: packed[4 * index + 3] ?? -Infinity,
      },
    };
  });
}

function seedFromGenotype(
  genotype: ArrayLike<number>,
  basis: HybridPeriodicBasis,
  lower: number,
  upper: number,
): Float64Array {
  const midpoint = 0.5 * (lower + upper);
  const halfWidth = Math.max(0.5 * (upper - lower), 1e-12);
  const latent = new Float64Array(64);
  for (let gate = 0; gate < 64; gate++) {
    const eta = Math.max(-0.96, Math.min(0.96, ((genotype[gate] ?? 0) - midpoint) / halfWidth));
    latent[gate] = Math.atanh(eta);
  }
  const coefficients = new Float64Array(hybridCoefficientCount(basis));
  coefficients.set(fitRealFourier(latent, basis.fourierModes));
  return coefficients;
}

function generateHybridSeeds(
  basis: HybridPeriodicBasis,
  lower: number,
  upper: number,
  key: { k0: number; k1: number },
  randomCount = 8,
): Float64Array[] {
  const count = hybridCoefficientCount(basis);
  const fourierCount = fourierCoefficientCount(basis.fourierModes);
  const midpoint = 0.5 * (lower + upper);
  const halfWidth = Math.max(0.5 * (upper - lower), 1e-12);
  const centerEta = Math.max(-0.96, Math.min(0.96, -midpoint / halfWidth));
  const constant = (value: number): Float64Array => {
    const coefficients = new Float64Array(count);
    coefficients[0] = value;
    return coefficients;
  };
  const seeds = [
    constant(Math.atanh(centerEta)),
    constant(0),
    constant(Math.atanh(-0.7)),
    constant(Math.atanh(0.7)),
  ];
  for (let harmonic = 1; harmonic <= Math.min(3, basis.fourierModes); harmonic++) {
    for (const sine of [false, true]) {
      const coefficients = new Float64Array(count);
      coefficients[2 * harmonic - (sine ? 0 : 1)] = 0.45;
      seeds.push(coefficients);
    }
  }
  for (let seed = 0; seed < randomCount; seed++) {
    const stream = new PhiloxStream(seed, 0, 0x56325345, key);
    const coefficients = new Float64Array(count);
    for (let i = 0; i < fourierCount; i++) {
      const harmonic = i === 0 ? 0 : Math.ceil(i / 2);
      coefficients[i] = 0.3 * stream.nextNormal() / (1 + harmonic * harmonic);
    }
    for (let i = fourierCount; i < count; i++) coefficients[i] = 0.05 * stream.nextNormal();
    seeds.push(coefficients);
  }
  return seeds;
}

function publishIslandLines(
  track: CompiledTrackJson,
  vehicle: VehicleSettings,
  basis: HybridPeriodicBasis,
  search: IslandEvolution,
  corridor: SafeCorridor,
): void {
  if (!command) return;
  const lines: number[] = [];
  const offsets: number[] = [];
  const visible = Math.min(command.optimizer.candidateVisibility, 8, search.islands.length);
  for (let island = 0; island < visible; island++) {
    try {
      const frames = sampleRacingLine(
        track, vehicle, basis, search.islands[island]!.mean, 256, corridor,
      );
      offsets.push(lines.length);
      lines.push(...racingLinePolyline(frames));
    } catch {
      // An invalid island mean is excluded from display and remains rankable.
    }
  }
  send({
    type: "displayCandidates",
    lines: Float32Array.from(lines),
    lineOffsets: Uint32Array.from(offsets),
  });
}

interface SearchCheckpoint {
  version: 4;
  generation: number;
  candidateCountTotal: number;
  fourierModes: number;
  residualControlCount: number;
  corridorBetaSafeRad: number;
  best: number[];
  search: IslandEvolutionSnapshot;
}

function parseCheckpoint(buffer: ArrayBuffer | null): SearchCheckpoint | null {
  if (buffer === null) return null;
  const value = JSON.parse(new TextDecoder().decode(buffer)) as Partial<SearchCheckpoint>;
  if (value.version !== 4 || !Number.isInteger(value.generation) || (value.generation ?? -1) < 0 ||
      !Number.isInteger(value.candidateCountTotal) || (value.candidateCountTotal ?? -1) < 0 ||
      !Number.isInteger(value.fourierModes) || (value.fourierModes ?? -1) < 0 ||
      !Number.isInteger(value.residualControlCount) || (value.residualControlCount ?? -1) < 0 ||
      !Number.isFinite(value.corridorBetaSafeRad) ||
      (value.corridorBetaSafeRad ?? -1) < 0 ||
      (value.corridorBetaSafeRad ?? Infinity) > Math.PI / 12 ||
      !Array.isArray(value.best) ||
      value.best.some(item => typeof item !== "number" || !Number.isFinite(item) || Math.abs(item) > 2) ||
      value.search === undefined || value.search === null || typeof value.search !== "object") {
    throw new Error("optimizer checkpoint has an invalid version or shape");
  }
  return value as SearchCheckpoint;
}

function checkpoint(
  search: IslandEvolution,
  basis: HybridPeriodicBasis,
  best: Float64Array<ArrayBufferLike>,
  corridor: SafeCorridor,
): ArrayBuffer {
  const json = JSON.stringify({
    version: 4,
    generation,
    candidateCountTotal,
    fourierModes: basis.fourierModes,
    residualControlCount: basis.residualControlCount,
    corridorBetaSafeRad: corridor.betaSafeRad,
    best: Array.from(best),
    search: search.snapshot(),
  } satisfies SearchCheckpoint);
  return new TextEncoder().encode(json).buffer as ArrayBuffer;
}

interface DiscoveryElite {
  coefficients: Float64Array;
  score: FeasibleFirstScore;
  lapTime: number;
  signature: Float64Array;
}

function retainDiscoveryElite(
  elites: DiscoveryElite[],
  coefficients: Float64Array<ArrayBufferLike>,
  score: FeasibleFirstScore,
  signature: Float64Array,
): void {
  if (!score.feasible || !Number.isFinite(score.lapTime)) return;
  elites.push({
    coefficients: new Float64Array(coefficients),
    score: { ...score },
    lapTime: score.lapTime,
    signature: signature.slice(),
  });
  const retained = selectDiverseTimeArchive(
    elites, DISCOVERY_ELITE_COUNT, 0.25, 2, 0.05,
  );
  elites.splice(0, elites.length, ...retained);
}

interface CurvaturePolishResult {
  representation: CurvatureRepresentation;
  score: ReturnType<typeof evaluateCurvatureCandidate>;
  testedCandidates: number;
  meshLapTimesS: [number, number, number] | null;
  meshLapTimeDeltaS: number | null;
}

function curvaturePolish(
  track: CompiledTrackJson,
  vehicle: VehicleSettings,
  lateralBasis: HybridPeriodicBasis,
  lateralCoefficients: Float64Array<ArrayBufferLike>,
  corridor: SafeCorridor,
  fastFinalization = false,
): CurvaturePolishResult {
  const source = sampleRacingLine(
    track, vehicle, lateralBasis, lateralCoefficients, 1024, corridor,
  );
  let representation: CurvatureRepresentation | null = null;
  let score: ReturnType<typeof evaluateCurvatureCandidate> | null = null;
  let testedCandidates = 0;
  const failures: string[] = [];
  const fitLevels: ReadonlyArray<readonly [number, number]> = fastFinalization
    ? [[24, 64], [16, 48]]
    : [[48, 256], [40, 192], [32, 128], [24, 64]];
  for (const [fourierModes, residualControls] of fitLevels) {
    try {
      const fitted = fitCurvatureRepresentation(source, fourierModes, residualControls);
      const evaluated = evaluateCurvatureCandidate(track, vehicle, fitted, 512);
      testedCandidates++;
      if (evaluated.feasible) {
        representation = fitted;
        score = evaluated;
        break;
      }
      failures.push(
        `${fourierModes}/${residualControls} fit infeasible ` +
        `(violation ${evaluated.violation.toExponential(2)}, ` +
        `clearance ${evaluated.minClearanceM.toFixed(4)} m, ` +
        `progress ${evaluated.minProgress.toFixed(4)})`,
      );
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (representation === null || score === null) {
    throw new Error(failures.join("; ") || "curvature conversion failed");
  }
  const fourierCount = fourierCoefficientCount(representation.basis.fourierModes);
  if (representation.basis.residualControlCount > 0 && score.feasible) {
    const smoothed = representation.coefficients.slice();
    for (let i = 0; i < representation.basis.residualControlCount; i++) {
      const before = fourierCount +
        (i + representation.basis.residualControlCount - 1) % representation.basis.residualControlCount;
      const current = fourierCount + i;
      const after = fourierCount + (i + 1) % representation.basis.residualControlCount;
      smoothed[current] = 0.25 * representation.coefficients[before]! +
        0.5 * representation.coefficients[current]! +
        0.25 * representation.coefficients[after]!;
    }
    const projected = projectCurvaturePerturbation(
      representation,
      smoothed,
      representation.pathLengthM,
      { tolerance: 1e-10, sampleCount: 2048 },
    );
    if (projected !== null) {
      const evaluated = evaluateCurvatureCandidate(track, vehicle, projected, 512);
      testedCandidates++;
      const allowedTime = Math.max(1e-5 * score.lapTime, 1e-6);
      if (evaluated.feasible && evaluated.lapTime <= score.lapTime + allowedTime &&
          evaluated.regularizer < score.regularizer) {
        representation = projected;
        score = evaluated;
      }
    }
  }
  return {
    representation,
    score,
    testedCandidates,
    meshLapTimesS: null,
    meshLapTimeDeltaS: null,
  };
}

function diffuseCurvature(
  source: CurvatureRepresentation,
  strength: number,
): Float64Array {
  const coefficients = source.coefficients.slice();
  const fourierCount = fourierCoefficientCount(source.basis.fourierModes);
  for (let index = 1; index < fourierCount; index++) {
    const harmonic = Math.ceil(index / 2);
    const normalized = harmonic / Math.max(1, source.basis.fourierModes);
    coefficients[index] = coefficients[index]! * Math.exp(-strength * normalized ** 4);
  }
  const residualCount = source.basis.residualControlCount;
  if (residualCount > 0) {
    const original = source.coefficients.subarray(fourierCount);
    for (let i = 0; i < residualCount; i++) {
      const average = 0.25 * original[(i + residualCount - 1) % residualCount]! +
        0.5 * original[i]! +
        0.25 * original[(i + 1) % residualCount]!;
      coefficients[fourierCount + i] = (1 - strength) * original[i]! + strength * average;
    }
  }
  return coefficients;
}

/** Direct curvature-space descent followed by §15.9 time-preserving smoothing. */
function refineCurvaturePolish(
  track: CompiledTrackJson,
  vehicle: VehicleSettings,
  input: CurvaturePolishResult,
  fastFinalization = false,
): CurvaturePolishResult {
  let representation = input.representation;
  let score = input.score;
  let testedCandidates = input.testedCandidates;
  const descentPasses: ReadonlyArray<readonly [number, number]> = fastFinalization
    ? []
    : [[0.08, 1], [0.03, 0.4]];
  for (const [spectralStep, localScale] of descentPasses) {
    const allProposals = smoothPatternProposals(
      representation.coefficients,
      representation.basis,
      representation.pathLengthM,
      spectralStep,
      Infinity,
      localScale,
    );
    const spectralCount = 2 * fourierCoefficientCount(representation.basis.fourierModes);
    const proposals = allProposals.slice(0, Math.min(34, spectralCount));
    const local = allProposals.slice(spectralCount);
    const localCount = Math.min(64, local.length);
    for (let i = 0; i < localCount; i++) {
      proposals.push(local[Math.floor(i * local.length / localCount)]!);
    }
    const ranked: Array<{
      representation: CurvatureRepresentation;
      score: ReturnType<typeof evaluateCurvatureCandidate>;
    }> = [];
    for (const coefficients of proposals) {
      const projected = projectCurvaturePerturbation(
        representation,
        coefficients,
        representation.pathLengthM,
        { tolerance: 1e-8, sampleCount: 256 },
      );
      if (projected === null) continue;
      const evaluated = evaluateCurvatureCandidate(track, vehicle, projected, 128);
      testedCandidates++;
      if (evaluated.feasible) ranked.push({ representation: projected, score: evaluated });
    }
    ranked.sort((a, b) => compareFeasibleFirst(a.score, b.score, 0));
    for (const candidate of ranked.slice(0, 8)) {
      const evaluated = evaluateCurvatureCandidate(
        track, vehicle, candidate.representation, 512,
      );
      testedCandidates++;
      if (compareFeasibleFirst(evaluated, score, 0) < 0) {
        representation = candidate.representation;
        score = evaluated;
      }
    }
  }

  const fastestLapTime = score.lapTime;
  const timeLimit = fastestLapTime * (1 + 1e-4);
  let smoothRepresentation = representation;
  let smoothScore = score;
  for (const strength of [0.02, 0.04, 0.08, 0.16, 0.32, 0.5, 0.75, 1]) {
    const projected = projectCurvaturePerturbation(
      representation,
      diffuseCurvature(representation, strength),
      representation.pathLengthM,
      { tolerance: 1e-10, sampleCount: 2048 },
    );
    if (projected === null) continue;
    const evaluated = evaluateCurvatureCandidate(track, vehicle, projected, 512);
    testedCandidates++;
    if (evaluated.feasible && evaluated.lapTime <= timeLimit &&
        evaluated.regularizer < smoothScore.regularizer) {
      smoothRepresentation = projected;
      smoothScore = evaluated;
    }
  }
  representation = smoothRepresentation;
  score = smoothScore;

  const closureCertified = projectCurvatureClosure(representation, {
    tolerance: 1e-11,
    sampleCount: 4096,
    maximumIterations: 24,
    selectCorrectionModes: false,
  });
  if (closureCertified !== null) representation = closureCertified;
  const coarse = evaluateCurvatureCandidate(track, vehicle, representation, 1024);
  const refined = evaluateCurvatureCandidate(track, vehicle, representation, 2048);
  const finest = evaluateCurvatureCandidate(track, vehicle, representation, 4096);
  testedCandidates += 3;
  const allFeasible = coarse.feasible && refined.feasible && finest.feasible;
  return {
    representation,
    score: allFeasible ? finest : score,
    testedCandidates,
    meshLapTimesS: allFeasible ? [coarse.lapTime, refined.lapTime, finest.lapTime] : null,
    meshLapTimeDeltaS: allFeasible ? Math.abs(finest.lapTime - refined.lapTime) : null,
  };
}

function curvatureGenotype(
  track: CompiledTrackJson,
  representation: CurvatureRepresentation,
): Float64Array {
  const path = reconstructCurvaturePath(representation, 2048);
  const center = centerlineSpec(track);
  const genotype = new Float64Array(64);
  for (let gate = 0; gate < 64; gate++) {
    const reference = evaluateLineFrame(center, gate);
    let nearest = path[0]!;
    let nearestSquared = Infinity;
    for (const sample of path) {
      const squared = (sample.x - reference.x) ** 2 + (sample.y - reference.y) ** 2;
      if (squared < nearestSquared) {
        nearestSquared = squared;
        nearest = sample;
      }
    }
    genotype[gate] = (nearest.x - reference.x) * -reference.ty +
      (nearest.y - reference.y) * reference.tx;
  }
  return genotype;
}

function v2Representations(
  track: CompiledTrackJson,
  vehicle: VehicleSettings,
  corridor: ReturnType<typeof buildSafeCorridor>,
  lateralBasis: HybridPeriodicBasis,
  lateralCoefficients: Float64Array<ArrayBufferLike>,
  curvature: CurvaturePolishResult,
): V2RepresentationsJson {
  const lateralFourierCount = fourierCoefficientCount(lateralBasis.fourierModes);
  const curvatureFourierCount = fourierCoefficientCount(
    curvature.representation.basis.fourierModes,
  );
  const score = curvature.score;
  let minimumSpeedMps = Infinity;
  let maximumSpeedMps = 0;
  let maximumAccelerationMps2 = 0;
  let maximumBrakingMps2 = 0;
  let maximumLateralAccelerationMps2 = 0;
  let maximumSuperellipseUtilization = 0;
  let maximumDragAccelerationMps2 = 0;
  let maximumDownforceMultiplier = 1;
  if (score.speedSquared !== null) {
    const distance = score.lapLengthM / score.speedSquared.length;
    const drag = vehicle.airDensity * vehicle.dragAreaM2 / (2 * vehicle.massKg);
    const downforce = vehicle.airDensity * vehicle.downforceAreaM2 /
      (2 * vehicle.massKg * GRAVITY);
    for (let i = 0; i < score.speedSquared.length; i++) {
      const next = (i + 1) % score.speedSquared.length;
      const q = score.speedSquared[i]!;
      const speed = Math.sqrt(q);
      const acceleration = (score.speedSquared[next]! - q) / (2 * distance);
      const load = 1 + downforce * q;
      const dragAcceleration = drag * q;
      const lateralAcceleration = Math.abs(q * score.frames[i]!.kappa);
      const tireAcceleration = acceleration >= 0
        ? acceleration + dragAcceleration
        : Math.max(0, -acceleration - dragAcceleration);
      const longitudinalCapacity = (acceleration >= 0 ? vehicle.axPlus0 : vehicle.axMinus0) * load;
      const utilization = (tireAcceleration / longitudinalCapacity) ** vehicle.ellipseP +
        (lateralAcceleration / (vehicle.ay0 * load)) ** vehicle.ellipseP;
      minimumSpeedMps = Math.min(minimumSpeedMps, speed);
      maximumSpeedMps = Math.max(maximumSpeedMps, speed);
      maximumAccelerationMps2 = Math.max(maximumAccelerationMps2, acceleration);
      maximumBrakingMps2 = Math.max(maximumBrakingMps2, -acceleration);
      maximumLateralAccelerationMps2 = Math.max(
        maximumLateralAccelerationMps2,
        lateralAcceleration,
      );
      maximumSuperellipseUtilization = Math.max(maximumSuperellipseUtilization, utilization);
      maximumDragAccelerationMps2 = Math.max(maximumDragAccelerationMps2, dragAcceleration);
      maximumDownforceMultiplier = Math.max(maximumDownforceMultiplier, load);
    }
  }
  if (!Number.isFinite(minimumSpeedMps)) minimumSpeedMps = 0;
  return {
    discovery: {
      schemaVersion: 2,
      kernelChartId: `${track.sourceSha256}:fourier-kernel`,
      kernelModeCount: buildReferenceSpine(track).modeCount,
      lateralFourierModes: lateralBasis.fourierModes,
      lateralFourierCoefficients: Array.from(lateralCoefficients.slice(0, lateralFourierCount)),
      residualControlCount: lateralBasis.residualControlCount,
      residualCoefficients: Array.from(lateralCoefficients.slice(lateralFourierCount)),
      corridor: {
        lowerM: corridor.lower,
        upperM: corridor.upper,
        betaSafeRad: corridor.betaSafeRad,
      },
    },
    curvature: {
      schemaVersion: 2,
      pathLengthM: curvature.representation.pathLengthM,
      winding: curvature.representation.winding,
      fourierModes: curvature.representation.basis.fourierModes,
      fourierCoefficients: Array.from(
        curvature.representation.coefficients.slice(0, curvatureFourierCount),
      ),
      residualControlCount: curvature.representation.basis.residualControlCount,
      residualCoefficients: Array.from(
        curvature.representation.coefficients.slice(curvatureFourierCount),
      ),
      closureModes: curvature.representation.correctionModes.map(mode => ({ ...mode })),
      closureCoefficients: Array.from(curvature.representation.correctionCoefficients),
      rigidTransform: {
        rotationRad: curvature.representation.rotationRad,
        translationM: [...curvature.representation.translation],
      },
      seamPhase: curvature.representation.seamPhase,
      closureResiduals: { ...curvature.representation.closureResiduals },
    },
    optimality: {
      closure: { ...curvature.representation.closureResiduals },
      geometry: {
        lengthM: score.lapLengthM,
        maxAbsCurvature: score.maxAbsCurvature,
        maxAbsCurvatureL: score.maxAbsCurvatureL,
        maxAbsCurvatureLL: score.maxAbsCurvatureLL,
        minPathMetric: score.minPathMetric,
        minProgress: score.minProgress,
      },
      rectangle: {
        minimumClearanceM: score.minClearanceM,
        continuouslyBounded: score.minClearanceM >= 0,
      },
      dynamics: {
        minimumSpeedMps,
        maximumSpeedMps,
        maximumAccelerationMps2,
        maximumBrakingMps2,
        maximumLateralAccelerationMps2,
        maximumSuperellipseUtilization,
        maximumDragAccelerationMps2,
        maximumDownforceMultiplier,
        speedOptimalityResidual: score.speedOptimalityResidual,
        maxLateralJerk: score.maxLateralJerk,
        rmsLateralJerk: score.rmsLateralJerk,
      },
      convergence: {
        meshLapTimesS: curvature.meshLapTimesS,
        meshLapTimeDeltaS: curvature.meshLapTimeDeltaS,
        bestTestedDescentS: null,
        fourierExtensionImprovementS: null,
        splineRefinementImprovementS: null,
        curvatureRefinementImprovementS: null,
      },
    },
  };
}

async function run(start: Extract<OptimizerCommand, { type: "start" }>): Promise<void> {
  if (!command || running) return;
  running = true;
  stopping = false;
  const started = performance.now();
  const track = command.compiledTrack;
  const vehicle = command.vehicle;
  const gpuContext = await requestGpu();
  const islandCount = gpuContext ? GPU_ISLAND_COUNT : CPU_ISLAND_COUNT;
  const populationPerIsland = gpuContext
    ? GPU_POPULATION_PER_ISLAND
    : CPU_POPULATION_PER_ISLAND;
  const restored = parseCheckpoint(start.checkpoint);
  const modeRange = selectFourierModeRange(track.lapLengthM, 1, 32, 150, 30);
  const targetResidualCount = Math.min(256, Math.max(8, Math.ceil(track.lapLengthM / 5)));
  const initialResidualCount = Math.min(
    targetResidualCount,
    Math.max(8, Math.ceil(track.lapLengthM / 80)),
  );
  let basisModel = buildHybridPeriodicBasis(
    restored?.fourierModes ?? Math.min(modeRange.maximum, Math.max(12, modeRange.initial)),
    restored?.residualControlCount ?? 0,
  );
  if (basisModel.fourierModes > modeRange.maximum || basisModel.residualControlCount > 256) {
    throw new Error("checkpoint hybrid basis is invalid");
  }
  let stationCount = Math.max(
    128,
    8 * basisModel.fourierModes,
    4 * basisModel.residualControlCount,
  );
  let corridor = buildSafeCorridor(
    track,
    vehicle,
    restored?.corridorBetaSafeRad ?? Math.PI / 12,
  );
  const key = { k0: command.optimizer.seedLo >>> 0, k1: command.optimizer.seedHi >>> 0 };
  const seeds = generateHybridSeeds(basisModel, corridor.lower, corridor.upper, key);
  const geometricSeed = minimumCurvatureSeed(track, vehicle, basisModel, corridor);
  seeds.unshift(
    geometricSeed,
    Float64Array.from(geometricSeed, coefficient => 0.65 * coefficient),
  );
  if (start.seedGenotype !== null) {
    seeds.unshift(seedFromGenotype(
      start.seedGenotype, basisModel, corridor.lower, corridor.upper,
    ));
  }
  const search = new IslandEvolution(seeds, {
    islandCount,
    populationPerIsland,
    key,
    migrationInterval: 8,
    restartGenerations: 24,
  });
  if (restored !== null) {
    search.restore(restored.search);
    generation = restored.generation;
    candidateCountTotal = restored.candidateCountTotal;
  }
  let gpu = gpuContext
    ? createGpuResolution(
        gpuContext, track, vehicle, islandCount * populationPerIsland, basisModel, stationCount,
        corridor,
      )
    : null;
  send({
    type: "ready",
    adapterInfo: gpuContext
      ? `${adapterLabel(gpuContext.adapter)} · ${islandCount} islands · ` +
        `${(islandCount * populationPerIsland).toLocaleString()} candidates/generation`
      : `CPU reference · ${islandCount} islands`,
    cpuFallback: gpuContext === null,
  });

  let globalCoefficients: Float64Array<ArrayBufferLike> = restored === null
    ? seeds[0]!.slice()
    : Float64Array.from(restored.best);
  let globalScore: FeasibleFirstScore;
  try {
    const initial = evaluateMinimumLapCandidate(
      track, vehicle, basisModel, globalCoefficients,
      truthStationCount(basisModel), "full",
      corridor,
    );
    globalScore = initial;
  } catch {
    globalScore = {
      feasible: false,
      violation: Infinity,
      lapTime: Infinity,
      regularizer: Infinity,
      minClearanceM: -Infinity,
    };
  }
  const discoveryElites: DiscoveryElite[] = [];
  retainDiscoveryElite(
    discoveryElites,
    globalCoefficients,
    globalScore,
    lateralFieldGenotype(track, vehicle, basisModel, globalCoefficients, corridor),
  );
  let proxyCandidates = 0;
  let fullCandidates = 1;
  let stationEvaluations = 0;
  let lastPublishedDiscoveryLap = Infinity;

  while (!stopping) {
    const batchStarted = performance.now();
    const spectralComplete = basisModel.fourierModes >= modeRange.maximum;
    const corridorComplete = corridor.betaSafeRad === 0;
    const residualComplete = basisModel.residualControlCount >= targetResidualCount ||
      2 * basisModel.residualControlCount > 256;
    const atFinestLevel = spectralComplete && corridorComplete && residualComplete;
    const residualScaleM = basisModel.residualControlCount > 0
      ? track.lapLengthM / basisModel.residualControlCount
      : Infinity;
    search.options.varianceFloor = Math.max(
      0.001,
      0.005 * Math.min(1, (residualScaleM / 20) ** 2),
    );
    search.options.acceptanceTarget = atFinestLevel ? 0.8 : 0.95;
    search.options.explorationFraction = atFinestLevel ? 0.03125 : 0.0625;
    const generated = search.generate();
    const packed = gpu
      ? await scoreGpu(gpu, generated)
      : scoreCpu(track, vehicle, basisModel, generated, stationCount, corridor);
    const observations = proxyObservations(generated, packed);
    const fullObservations: IslandObservation[] = [];
    proxyCandidates += generated.length;
    candidateCountTotal += generated.length;
    stationEvaluations += generated.length * stationCount;

    for (const index of selectFullEvaluationIndices(
      observations, generation, FULL_RECHECKS_PER_ISLAND,
    )) {
      const observation = observations[index]!;
      try {
        let candidateCoefficients = observation.candidate.coefficients;
        let evaluated = evaluateMinimumLapCandidate(
          track,
          vehicle,
          basisModel,
          candidateCoefficients,
          truthStationCount(basisModel),
          "full", corridor,
        );
        if (atFinestLevel && !evaluated.feasible && globalScore.feasible) {
          const repaired = backtrackToFeasible(
            globalCoefficients,
            candidateCoefficients,
            trial => evaluateMinimumLapCandidate(
              track, vehicle, basisModel, trial, stationCount, "proxy", corridor,
            ).feasible,
          );
          if (repaired !== null) {
            candidateCoefficients = repaired;
            evaluated = evaluateMinimumLapCandidate(
              track, vehicle, basisModel, repaired,
              truthStationCount(basisModel),
              "full", corridor,
            );
          }
        }
        observation.candidate = {
          ...observation.candidate,
          coefficients: candidateCoefficients,
        };
        observation.score = evaluated;
        fullObservations.push(observation);
        fullCandidates++;
        retainDiscoveryElite(
          discoveryElites,
          candidateCoefficients,
          evaluated,
          lateralFieldGenotype(
            track, vehicle, basisModel, candidateCoefficients, corridor,
          ),
        );
        if (compareFeasibleFirst(evaluated, globalScore, 0) < 0) {
          globalScore = evaluated;
          globalCoefficients = candidateCoefficients.slice();
        }
      } catch {
        // Full FP64 reranking rejects singular or nonfinite proxy survivors.
      }
    }
    // The GPU utility is a screening surrogate. Only truth-evaluated scores
    // update the ES; proxy and truth numeric domains are never mixed.
    search.update(fullObservations, 1e-5);

    if (basisModel.residualControlCount > 0 && generation > 0 &&
        generation % 8 === 0 && globalScore.feasible) {
      const physicalScale = track.lapLengthM /
        Math.max(1, basisModel.residualControlCount || 1);
      const spectralStep = Math.max(
        0.012,
        Math.min(0.08, 0.03 * (physicalScale / 10) ** 2),
      );
      const trials = smoothPatternProposals(
        new Float64Array(globalCoefficients),
        basisModel,
        track.lapLengthM,
        spectralStep,
      ).map((coefficients, index): IslandCandidate => ({
        island: 0,
        candidateInIsland: index,
        coefficients,
        exploratory: false,
      }));
      const trialPacked = gpu
        ? await scoreGpu(gpu, trials)
        : scoreCpu(track, vehicle, basisModel, trials, stationCount, corridor);
      const trialObservations = proxyObservations(trials, trialPacked);
      proxyCandidates += trials.length;
      candidateCountTotal += trials.length;
      stationEvaluations += trials.length * stationCount;
      const rankedTrials = trialObservations
        .map((observation, index) => ({ observation, index }))
        .filter(item => item.observation.score.feasible)
        .sort((a, b) => compareFeasibleFirst(a.observation.score, b.observation.score));
      let patternImproved = false;
      for (const trial of rankedTrials.slice(0, PATTERN_FULL_RECHECKS)) {
        try {
          const evaluated = evaluateMinimumLapCandidate(
            track,
            vehicle,
            basisModel,
            trial.observation.candidate.coefficients,
            truthStationCount(basisModel),
            "full", corridor,
          );
          fullCandidates++;
          retainDiscoveryElite(
            discoveryElites,
            trial.observation.candidate.coefficients,
            evaluated,
            lateralFieldGenotype(
              track,
              vehicle,
              basisModel,
              trial.observation.candidate.coefficients,
              corridor,
            ),
          );
          if (compareFeasibleFirst(evaluated, globalScore, 0) < 0) {
            globalScore = evaluated;
            globalCoefficients = trial.observation.candidate.coefficients.slice();
            patternImproved = true;
          }
        } catch {
          // One-sided active-boundary probes are expected to fail occasionally.
        }
      }
      if (patternImproved) {
        search.inject(
          globalCoefficients,
          generation % search.islands.length,
          mutationSigmas(basisModel, modeRange.initial, initialResidualCount, 0.04),
        );
      }
    }

    generation++;
    if (generation % 8 === 0 && globalScore.feasible &&
        globalScore.lapTime < lastPublishedDiscoveryLap - 0.02) {
      lastPublishedDiscoveryLap = globalScore.lapTime;
      send({
        type: "provisionalBest",
        candidateSpace: "discovery",
        candidateKey: "discovery-live",
        lapTime: globalScore.lapTime,
        genotype: lateralFieldGenotype(
          track, vehicle, basisModel, globalCoefficients, corridor,
        ),
        preimage: lateralFieldPreimage(
          track, vehicle, basisModel, globalCoefficients, corridor,
        ),
        candidateId: candidateCountTotal + generation,
      });
    }
    if (generation % 2 === 0) {
      publishIslandLines(track, vehicle, basisModel, search, corridor);
    }
    const latency = performance.now() - batchStarted;
    const elapsedSeconds = Math.max((performance.now() - started) / 1000, 1e-9);
    const validCount = observations.filter(observation => observation.score.feasible).length;
    send({
      type: "progress",
      elapsedMs: performance.now() - started,
      batches: generation,
      candidates: candidateCountTotal,
      validPercent: 100 * validCount / observations.length,
      rejectionCounts: [
        validCount, 0, 0, 0, 0, 0, 0, 0,
        observations.length - validCount, 0, 0, 0, 0,
      ],
      provisionalLapTime: globalScore.feasible ? globalScore.lapTime : null,
      batchLatencyMs: { median: latency, p95: latency, worst: latency },
      stage: spectralComplete ? "spline" : "fourier",
      throughput: {
        stationPerSecond: stationEvaluations / elapsedSeconds,
        proxyPerSecond: proxyCandidates / elapsedSeconds,
        fullPerSecond: fullCandidates / elapsedSeconds,
        curvaturePerSecond: 0,
        certifiedPerSecond: 0,
      },
    });

    if (!stopping && generation % GENERATIONS_PER_LEVEL === 0 && !atFinestLevel) {
      const priorBasis = basisModel;
      const priorCorridor = corridor;
      if (!spectralComplete) {
        const nextModes = Math.min(
          modeRange.maximum,
          Math.max(priorBasis.fourierModes + 1, 2 * priorBasis.fourierModes),
        );
        basisModel = buildHybridPeriodicBasis(nextModes, priorBasis.residualControlCount);
      } else if (!corridorComplete) {
        corridor = buildSafeCorridor(
          track,
          vehicle,
          corridor.betaSafeRad > Math.PI / 16 ? corridor.betaSafeRad / 2 : 0,
        );
      } else if (priorBasis.residualControlCount === 0) {
        basisModel = buildHybridPeriodicBasis(priorBasis.fourierModes, initialResidualCount);
      } else {
        basisModel = buildHybridPeriodicBasis(
          priorBasis.fourierModes,
          Math.min(256, 2 * priorBasis.residualControlCount),
        );
      }
      const corridorChanged = corridor.betaSafeRad !== priorCorridor.betaSafeRad;
      const remap = (values: Float64Array): Float64Array => {
        const mapped = remapHybridCoefficients(priorBasis, basisModel, values);
        return corridorChanged
          ? remapFourierCorridor(basisModel, mapped, priorCorridor, corridor)
          : mapped;
      };
      const remapSigma = (values: Float64Array): Float64Array => {
        if (corridorChanged) {
          const priorHalfWidth = 0.5 * (priorCorridor.upper - priorCorridor.lower);
          const nextHalfWidth = 0.5 * (corridor.upper - corridor.lower);
          return Float64Array.from(
            values,
            value => Math.max(0.005, value * priorHalfWidth / nextHalfWidth),
          );
        }
        const mapped = remap(values);
        if (basisModel.residualControlCount === 2 * priorBasis.residualControlCount &&
            priorBasis.residualControlCount > 0) {
          const start = fourierCoefficientCount(basisModel.fourierModes);
          for (let i = start; i < mapped.length; i++) mapped[i] = 0.25 * mapped[i]!;
        }
        return mapped;
      };
      search.remap(
        remap,
        mutationSigmas(basisModel, modeRange.initial, initialResidualCount, 0.08),
        remapSigma,
      );
      globalCoefficients = remap(globalCoefficients);
      search.inject(
        globalCoefficients,
        0,
        mutationSigmas(basisModel, modeRange.initial, initialResidualCount, 0.1),
      );
      for (const elite of discoveryElites) elite.coefficients = remap(elite.coefficients);
      stationCount = Math.max(
        128,
        8 * basisModel.fourierModes,
        4 * basisModel.residualControlCount,
      );
      try {
        globalScore = evaluateMinimumLapCandidate(
          track, vehicle, basisModel, globalCoefficients,
          truthStationCount(basisModel),
          "full", corridor,
        );
        fullCandidates++;
        retainDiscoveryElite(
          discoveryElites,
          globalCoefficients,
          globalScore,
          lateralFieldGenotype(track, vehicle, basisModel, globalCoefficients, corridor),
        );
      } catch {
        globalScore = {
          feasible: false,
          violation: Infinity,
          lapTime: Infinity,
          regularizer: Infinity,
          minClearanceM: -Infinity,
        };
      }
      if (gpu !== null && gpuContext !== null) {
        destroyGpuResolution(gpu);
        gpu = createGpuResolution(
          gpuContext,
          track,
          vehicle,
          islandCount * populationPerIsland,
          basisModel,
          stationCount,
          corridor,
        );
      }
    }
    // Yield through an event task so hidden-tab timer clamping cannot reduce
    // the optimizer to one generation per timer wake-up. This still admits
    // stop and live-setting messages between station-major dispatches.
    await yieldForHostEvents();
  }

  let curvatureCandidates = 0;
  if (globalScore.feasible) {
    retainDiscoveryElite(
      discoveryElites,
      globalCoefficients,
      globalScore,
      lateralFieldGenotype(track, vehicle, basisModel, globalCoefficients, corridor),
    );
    // PH reconstruction can reverse the order of close discovery scores.
    // Publish every retained full-evaluation elite under a distinct key so
    // the main thread certifies each one before selecting the displayed line.
    for (let index = 0; index < discoveryElites.length; index++) {
      const elite = discoveryElites[index]!;
      send({
        type: "provisionalBest",
        candidateSpace: "discovery",
        candidateKey: `discovery-final-${index}`,
        lapTime: elite.score.lapTime,
        genotype: lateralFieldGenotype(
          track, vehicle, basisModel, elite.coefficients, corridor,
        ),
        preimage: lateralFieldPreimage(
          track, vehicle, basisModel, elite.coefficients, corridor,
        ),
        candidateId: candidateCountTotal + index,
      });
    }
    const curvatureStarted = performance.now();
    let curvature: CurvaturePolishResult | null = null;
    let curvatureSource: Float64Array | null = null;
    const conversionErrors: string[] = [];
    let feasibleConversions = 0;
    const conversionSources = [
      globalCoefficients,
      ...discoveryElites.slice(0, CURVATURE_SOURCE_COUNT).map(elite => elite.coefficients),
    ].filter((source, index, all) => all.findIndex(other => {
      if (other.length !== source.length) return false;
      for (let i = 0; i < source.length; i++) {
        if (Math.abs(other[i]! - source[i]!) > 1e-12) return false;
      }
      return true;
    }) === index);
    const fastFinalization = generation < 64;
    for (const source of conversionSources) {
      try {
        const converted = curvaturePolish(
          track, vehicle, basisModel, source, corridor, fastFinalization,
        );
        curvatureCandidates += converted.testedCandidates;
        if (!converted.score.feasible) {
          conversionErrors.push("projected curvature path is infeasible");
          continue;
        }
        feasibleConversions++;
        if (curvature === null || compareFeasibleFirst(converted.score, curvature.score, 0) < 0) {
          curvature = converted;
          curvatureSource = source;
        }
        if (feasibleConversions >= 1) break;
      } catch (error) {
        conversionErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (curvature !== null) {
      const priorTested = curvature.testedCandidates;
      curvature = refineCurvaturePolish(track, vehicle, curvature, fastFinalization);
      curvatureCandidates += curvature.testedCandidates - priorTested;
    }
    const curvatureSeconds = Math.max((performance.now() - curvatureStarted) / 1000, 1e-9);
    const elapsedSeconds = Math.max((performance.now() - started) / 1000, 1e-9);
    send({
      type: "progress",
      elapsedMs: performance.now() - started,
      batches: generation,
      candidates: candidateCountTotal + curvatureCandidates,
      validPercent: curvature?.score.feasible ? 100 : 0,
      rejectionCounts: [curvature?.score.feasible ? 1 : 0, 0, 0, 0, 0, 0, 0, 0,
        curvature?.score.feasible ? 0 : 1, 0, 0, 0, 0],
      provisionalLapTime: curvature?.score.feasible ? curvature.score.lapTime : globalScore.lapTime,
      batchLatencyMs: {
        median: curvatureSeconds * 1000,
        p95: curvatureSeconds * 1000,
        worst: curvatureSeconds * 1000,
      },
      stage: "curvature",
      throughput: {
        stationPerSecond: stationEvaluations / elapsedSeconds,
        proxyPerSecond: proxyCandidates / elapsedSeconds,
        fullPerSecond: fullCandidates / elapsedSeconds,
        curvaturePerSecond: curvatureCandidates / curvatureSeconds,
        certifiedPerSecond: 0,
      },
    });
    if (curvature !== null && curvatureSource !== null) {
      const representations = v2Representations(
        track, vehicle, corridor, basisModel, curvatureSource, curvature,
      );
      send({
        type: "provisionalBest",
        candidateSpace: "curvature",
        candidateKey: "curvature-final",
        lapTime: curvature.score.lapTime,
        genotype: curvatureGenotype(track, curvature.representation),
        preimage: lateralFieldPreimage(
          track, vehicle, basisModel, curvatureSource, corridor,
        ),
        candidateId: candidateCountTotal + curvatureCandidates,
        representations,
      });
    } else {
      const reason = conversionErrors.find(message => message.trim().length > 0) ??
        "no curvature elite passed closure and geometry checks";
      send({ type: "warning", stage: "curvature", message: reason });
    }
  }
  if (gpu !== null) destroyGpuResolution(gpu);
  send({
    type: "stopped",
    checkpoint: checkpoint(search, basisModel, globalCoefficients, corridor),
  });
  running = false;
}

self.addEventListener("message", (event: MessageEvent<OptimizerCommand>) => {
  const message = event.data;
  if (message.type === "init") {
    command = message;
    generation = 0;
    candidateCountTotal = 0;
    send({ type: "ready", adapterInfo: "initializing", cpuFallback: false });
  } else if (message.type === "start") {
    void run(message).catch((error: unknown) => {
      running = false;
      stopping = false;
      const raw = error instanceof Error ? error.message : String(error ?? "");
      send({
        type: "error",
        error: {
          code: "INVALID_INPUT",
          message: raw.trim() || "optimizer run failed without a diagnostic",
          runVersion: command?.runVersion ?? 0,
          detail: {},
        },
      });
    });
  } else if (message.type === "stop") {
    stopping = true;
  } else if (message.type === "setBackgroundExecution") {
    backgroundExecution = message.enabled;
  } else if (message.type === "shutdown") {
    stopping = true;
    self.close();
  }
});
