/// <reference types="@webgpu/types" />
import type {
  CompiledTrackJson,
  OptimizerCommand,
  OptimizerEvent,
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
import {
  evaluateMinimumLapCandidate,
  type CandidateEvaluation,
} from "@/optimizer/minimum-lap";
import { selectFullEvaluationIndices } from "@/optimizer/surrogate-screening";
import { selectDiverseTimeArchive } from "@/optimizer/elite-archive";
import { completedReportingInterval } from "@/optimizer/intermediate-reporting";
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
  quadraticPatternCombinations,
  smoothPatternProposals,
} from "@/optimizer/smooth-arc-search";
import { minimumCurvatureSeed } from "@/optimizer/geometric-seed";
import {
  buildReferenceGeometryTable,
  buildSafeCorridor,
  lateralFieldGenotype,
  racingLinePolyline,
  remapFourierCorridor,
  sampleRacingLine,
  type SafeCorridor,
} from "@/optimizer/racing-line";
import shaderSource from "./optimizer.wgsl?raw";

const GPU_ISLAND_COUNT = 8;
const GPU_POPULATION_PER_ISLAND = 1024;
const CPU_ISLAND_COUNT = 4;
const CPU_POPULATION_PER_ISLAND = 8;
const GENERATIONS_PER_LEVEL = 4;
const FULL_RECHECKS_PER_ISLAND = 2;
const DISCOVERY_ELITE_COUNT = 12;
const CURVATURE_SOURCE_COUNT = 1;
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
    256,
    4 * basis.residualControlCount,
    8 * basis.fourierModes,
  );
}

let command: Extract<OptimizerCommand, { type: "init" }> | null = null;
let stopping = false;
let stopSignal: Int32Array | null = null;
let running = false;
let generation = 0;
let candidateCountTotal = 0;

function stopRequested(): boolean {
  return stopping || (stopSignal !== null && Atomics.load(stopSignal, 0) !== 0);
}

const yieldChannel = new MessageChannel();
const yieldResolvers: Array<() => void> = [];
yieldChannel.port1.onmessage = () => yieldResolvers.shift()?.();

function yieldForHostEvents(): Promise<void> {
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
  return {
    adapter,
    device,
    bindGroupLayout,
    geometryPipeline,
    reductionPipeline,
  };
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
  shouldCancel: () => boolean,
): Float32Array {
  const output = new Float32Array(4 * candidates.length);
  for (let index = 0; index < candidates.length; index++) {
    output.set([1e30, 1e30, 1e30, -1e30], 4 * index);
  }
  for (let index = 0; index < candidates.length; index++) {
    if (shouldCancel()) break;
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
    } catch { /* The prefilled rejection remains authoritative. */ }
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
  let globalEvaluation: CandidateEvaluation | null;
  try {
    const initial = evaluateMinimumLapCandidate(
      track, vehicle, basisModel, globalCoefficients,
      truthStationCount(basisModel), "full",
      corridor,
    );
    globalScore = initial;
    globalEvaluation = initial;
  } catch {
    globalScore = {
      feasible: false,
      violation: Infinity,
      lapTime: Infinity,
      regularizer: Infinity,
      minClearanceM: -Infinity,
    };
    globalEvaluation = null;
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
  let lastReportedInterval = 0;

  while (!stopRequested()) {
    const batchStarted = performance.now();
    let phaseStarted = batchStarted;
    let generateMs = 0;
    let gpuProxyMs = 0;
    let cpuTruthMs = 0;
    let patternSearchMs = 0;
    let canonicalizationMs = 0;
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
    generateMs = performance.now() - phaseStarted;
    phaseStarted = performance.now();
    const packed = gpu
      ? await scoreGpu(gpu, generated)
      : scoreCpu(track, vehicle, basisModel, generated, stationCount, corridor, stopRequested);
    gpuProxyMs = performance.now() - phaseStarted;
    phaseStarted = performance.now();
    const observations = proxyObservations(generated, packed);
    proxyCandidates += generated.length;
    candidateCountTotal += generated.length;
    stationEvaluations += generated.length * stationCount;

    for (const index of selectFullEvaluationIndices(
      observations,
      generation,
      atFinestLevel ? 1 : FULL_RECHECKS_PER_ISLAND,
    )) {
      if (stopRequested()) break;
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
          globalEvaluation = evaluated;
          globalCoefficients = candidateCoefficients.slice();
        }
      } catch {
        // Full FP64 reranking rejects singular or nonfinite proxy survivors.
      }
    }
    cpuTruthMs = performance.now() - phaseStarted;
    phaseStarted = performance.now();
    // The full GPU population controls the stochastic search. Binary64 scores
    // remain authoritative for the global incumbent and retained archive; the
    // two numeric domains are never compared with each other.
    search.update(observations, 1e-5);

    const patternInterval = atFinestLevel ? 2 : 8;
    if (!stopRequested() && basisModel.residualControlCount > 0 && generation > 0 &&
        generation % patternInterval === 0 && globalScore.feasible) {
      const physicalScale = track.lapLengthM /
        Math.max(1, basisModel.residualControlCount || 1);
      const spectralStep = Math.max(
        0.012,
        Math.min(0.08, 0.03 * (physicalScale / 10) ** 2),
      );
      const patternCoefficients = smoothPatternProposals(
        new Float64Array(globalCoefficients),
        basisModel,
        track.lapLengthM,
        spectralStep,
      );
      const trials = [new Float64Array(globalCoefficients), ...patternCoefficients]
        .map((coefficients, index): IslandCandidate => ({
        island: 0,
        candidateInIsland: index,
        coefficients,
        exploratory: false,
      }));
      const trialPacked = gpu
        ? await scoreGpu(gpu, trials)
        : scoreCpu(track, vehicle, basisModel, trials, stationCount, corridor, stopRequested);
      const trialObservations = proxyObservations(trials, trialPacked);
      proxyCandidates += trials.length;
      candidateCountTotal += trials.length;
      stationEvaluations += trials.length * stationCount;
      const baseProxy = trialObservations[0]!.score;
      const rankedTrials = trialObservations
        .map((observation, index) => ({ observation, index }))
        .filter(item => item.index > 0 && item.observation.score.feasible &&
          compareFeasibleFirst(item.observation.score, baseProxy, 0) < 0)
        .sort((a, b) => compareFeasibleFirst(a.observation.score, b.observation.score));
      const combinedCoefficients = quadraticPatternCombinations(
        new Float64Array(globalCoefficients),
        patternCoefficients,
        baseProxy,
        trialObservations.slice(1).map(observation => observation.score),
        fourierCoefficientCount(basisModel.fourierModes),
      );
      const fullTrialCoefficients = [
        ...rankedTrials.slice(0, PATTERN_FULL_RECHECKS)
          .map(trial => trial.observation.candidate.coefficients),
        ...combinedCoefficients,
      ];
      let patternImproved = false;
      for (const coefficients of fullTrialCoefficients) {
        if (stopRequested()) break;
        try {
          const evaluated = evaluateMinimumLapCandidate(
            track,
            vehicle,
            basisModel,
            coefficients,
            truthStationCount(basisModel),
            "full", corridor,
          );
          fullCandidates++;
          retainDiscoveryElite(
            discoveryElites,
            coefficients,
            evaluated,
            lateralFieldGenotype(
              track,
              vehicle,
              basisModel,
              coefficients,
              corridor,
            ),
          );
          if (compareFeasibleFirst(evaluated, globalScore, 0) < 0) {
            globalScore = evaluated;
            globalEvaluation = evaluated;
            globalCoefficients = coefficients.slice();
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
    patternSearchMs = performance.now() - phaseStarted;
    phaseStarted = performance.now();

    generation++;
    if (stopRequested()) break;
    const elapsedMs = performance.now() - started;
    const reportingInterval = completedReportingInterval(elapsedMs);
    if (reportingInterval > lastReportedInterval && globalEvaluation?.feasible &&
        globalEvaluation.speedSquared !== null) {
      const sources = [
        globalCoefficients,
        ...discoveryElites.slice(0, CURVATURE_SOURCE_COUNT).map(elite => elite.coefficients),
      ].filter((source, index, all) => all.findIndex(other => {
        if (other.length !== source.length) return false;
        for (let i = 0; i < source.length; i++) {
          if (Math.abs(other[i]! - source[i]!) > 1e-12) return false;
        }
        return true;
      }) === index).map(source => source.slice());
      send({
        type: "discoverySnapshot",
        sequence: reportingInterval,
        elapsedMs,
        optimizerLapTime: globalEvaluation.lapTime,
        candidateId: candidateCountTotal,
        basis: {
          fourierModes: basisModel.fourierModes,
          residualControlCount: basisModel.residualControlCount,
        },
        corridor: {
          lower: corridor.lower,
          upper: corridor.upper,
          betaSafeRad: corridor.betaSafeRad,
          fallback: corridor.fallback,
        },
        sources,
      });
      lastReportedInterval = reportingInterval;
    }
    canonicalizationMs = performance.now() - phaseStarted;
    phaseStarted = performance.now();
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
      phaseLatencyMs: {
        generate: generateMs,
        gpuProxy: gpuProxyMs,
        cpuTruth: cpuTruthMs,
        patternSearch: patternSearchMs,
        canonicalization: canonicalizationMs,
        bookkeeping: Math.max(0, latency - (
          generateMs + gpuProxyMs + cpuTruthMs + patternSearchMs + canonicalizationMs
        )),
      },
      stage: spectralComplete ? "spline" : "fourier",
      throughput: {
        stationPerSecond: stationEvaluations / elapsedSeconds,
        proxyPerSecond: proxyCandidates / elapsedSeconds,
        fullPerSecond: fullCandidates / elapsedSeconds,
        curvaturePerSecond: 0,
        certifiedPerSecond: 0,
      },
    });

    if (!stopRequested() && generation % GENERATIONS_PER_LEVEL === 0 && !atFinestLevel) {
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
        globalEvaluation = evaluateMinimumLapCandidate(
          track, vehicle, basisModel, globalCoefficients,
          truthStationCount(basisModel),
          "full", corridor,
        );
        globalScore = globalEvaluation;
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
        globalEvaluation = null;
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
    stopSignal = message.stopSignal === null ? null : new Int32Array(message.stopSignal);
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
  } else if (message.type === "shutdown") {
    stopping = true;
    self.close();
  }
});
