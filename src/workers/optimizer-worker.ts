/// <reference types="@webgpu/types" />
import type {
  CompiledTrackJson,
  OptimizerCommand,
  OptimizerEvent,
  VehicleSettings,
} from "@/model/contracts";
import { GRAVITY } from "@/model/contracts";
import {
  candidateLineFromSearch,
  candidateSearchDelta,
  genotypeForLine,
  hash32,
  lineFromSearchDelta,
  measureSweptRectangle,
  SEARCH_LOCAL_MODE_COUNT,
  SEARCH_MEDIUM_MODE_COUNT,
  SEARCH_MODE_COUNT,
  SEARCH_PREIMAGE_MODE_COUNT,
  SEARCH_START_MODE,
  searchModeBasis,
} from "@/optimizer/ph-search";
import { evaluateProfile } from "@/optimizer/profile";
import { gpuSearchSeed } from "@/optimizer/run-seed";
import { evaluateLineFrame, flattenPairs, tessellateLine } from "@/renderer/ph-tessellate";
import shaderSource from "./optimizer.wgsl?raw";

const GPU_CANDIDATES = 262_144;
const CPU_CANDIDATES = 512;
const CPU_RECHECK_COUNT = 48;
const STAGNANT_BATCH_LIMIT = 8;
const BASIN_BATCH_LIMIT = 48;

let command: Extract<OptimizerCommand, { type: "init" }> | null = null;
let stopping = false;
let running = false;
let batch = 0;
let candidates = 0;
let bestLap = Infinity;
let bestDelta = new Float32Array(SEARCH_MODE_COUNT);
let searchSeed = 0;

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

interface GpuState {
  adapter: GPUAdapter;
  device: GPUDevice;
  pipeline: GPUComputePipeline;
  bindGroup: GPUBindGroup;
  baseBuffer: GPUBuffer;
  incumbentBuffer: GPUBuffer;
  scoreBuffer: GPUBuffer;
  readBuffer: GPUBuffer;
  settingsBuffer: GPUBuffer;
  settings: Float32Array;
  count: number;
}

async function createGpu(
  track: CompiledTrackJson,
  vehicle: VehicleSettings,
  count: number,
): Promise<GpuState | null> {
  if (!navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  void device.lost.then((info) => {
    stopping = true;
    send({ type: "deviceLost", reason: info.message || info.reason });
  });
  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: {
      module: device.createShaderModule({ code: shaderSource }),
      entryPoint: "main",
    },
  });

  const base = Float32Array.from(flattenPairs(track.centerPreimageControls));
  const baseBuffer = device.createBuffer({
    size: base.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(baseBuffer, 0, base);

  const centerSpec = {
    preimage: flattenPairs(track.centerPreimageControls),
    gates: flattenPairs(track.gatePoints),
  };
  const centerData = new Float32Array(64 * 4);
  for (let i = 0; i < 64; i++) {
    const frame = evaluateLineFrame(centerSpec, i);
    centerData.set([frame.x, frame.y, -frame.ty, frame.tx], 4 * i);
  }
  const centerBuffer = device.createBuffer({
    size: centerData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(centerBuffer, 0, centerData);

  const basis = searchModeBasis(track);
  const basisBuffer = device.createBuffer({
    size: basis.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(basisBuffer, 0, basis);

  const incumbentBuffer = device.createBuffer({
    size: SEARCH_MODE_COUNT * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const scoreBuffer = device.createBuffer({
    size: count * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readBuffer = device.createBuffer({
    size: count * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const settings = new Float32Array(20);
  settings.set([
    count,
    track.source.leftWidthM,
    track.source.rightWidthM,
    vehicle.lengthM,
    vehicle.widthM,
    vehicle.safetyMarginM,
    vehicle.vMaxMps,
    vehicle.axPlus0,
    vehicle.axMinus0,
    vehicle.ay0,
    vehicle.ellipseP,
    (vehicle.airDensity * vehicle.dragAreaM2) / (2 * vehicle.massKg),
    (vehicle.airDensity * vehicle.downforceAreaM2) / (2 * vehicle.massKg * GRAVITY),
    vehicle.kappaMax ?? 0,
  ]);
  const settingsBuffer = device.createBuffer({
    size: settings.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(settingsBuffer, 0, settings);
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: baseBuffer } },
      { binding: 1, resource: { buffer: centerBuffer } },
      { binding: 2, resource: { buffer: incumbentBuffer } },
      { binding: 3, resource: { buffer: scoreBuffer } },
      { binding: 4, resource: { buffer: settingsBuffer } },
      { binding: 5, resource: { buffer: basisBuffer } },
    ],
  });
  return {
    adapter,
    device,
    pipeline,
    bindGroup,
    baseBuffer,
    incumbentBuffer,
    scoreBuffer,
    readBuffer,
    settingsBuffer,
    settings,
    count,
  };
}

function adapterLabel(adapter: GPUAdapter): string {
  const info = adapter.info;
  const parts = [info.vendor, info.architecture, info.device, info.description].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "high-performance adapter";
}

function insertTopCandidate(
  indices: number[],
  values: number[],
  candidate: number,
  score: number,
): void {
  if (!(score < 1e30)) return;
  let position = 0;
  while (position < values.length && values[position]! <= score) position++;
  if (position >= CPU_RECHECK_COUNT) return;
  indices.splice(position, 0, candidate);
  values.splice(position, 0, score);
  if (indices.length > CPU_RECHECK_COUNT) {
    indices.pop();
    values.pop();
  }
}

async function scoreGpuBatch(
  gpu: GpuState,
  incumbentLine: ReturnType<typeof lineFromSearchDelta>,
  incumbent: Float32Array,
  sigma: number,
): Promise<Float32Array> {
  gpu.settings[14] = batch;
  gpu.settings[15] = sigma;
  gpu.settings[16] = searchSeed;
  gpu.device.queue.writeBuffer(gpu.baseBuffer, 0, Float32Array.from(incumbentLine.preimage));
  gpu.device.queue.writeBuffer(gpu.incumbentBuffer, 0, incumbent);
  gpu.device.queue.writeBuffer(gpu.settingsBuffer, 0, gpu.settings);
  const encoder = gpu.device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(gpu.pipeline);
  pass.setBindGroup(0, gpu.bindGroup);
  pass.dispatchWorkgroups(Math.ceil(gpu.count / 256));
  pass.end();
  encoder.copyBufferToBuffer(gpu.scoreBuffer, 0, gpu.readBuffer, 0, gpu.count * 4);
  gpu.device.queue.submit([encoder.finish()]);
  await gpu.readBuffer.mapAsync(GPUMapMode.READ);
  const scores = new Float32Array(gpu.count);
  scores.set(new Float32Array(gpu.readBuffer.getMappedRange()));
  gpu.readBuffer.unmap();
  return scores;
}

function scoreCpuBatch(
  track: CompiledTrackJson,
  vehicle: VehicleSettings,
  incumbentLine: ReturnType<typeof lineFromSearchDelta>,
  incumbent: Float32Array,
  sigma: number,
  count: number,
): Float32Array {
  const scores = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const line = candidateLineFromSearch(
      track, incumbentLine, incumbent, i, batch, sigma, searchSeed,
    );
    scores[i] = measureSweptRectangle(track, line, vehicle).valid
      ? evaluateProfile(line, vehicle, 128).lapTime
      : Infinity;
  }
  return scores;
}

function publishCandidates(
  track: CompiledTrackJson,
  incumbentLine: ReturnType<typeof lineFromSearchDelta>,
  incumbent: Float32Array,
  sigma: number,
): void {
  if (!command) return;
  const lines: number[] = [];
  const offsets: number[] = [];
  const visible = Math.min(command.optimizer.candidateVisibility, 8);
  for (let i = 0; i < visible; i++) {
    const line = candidateLineFromSearch(
      track, incumbentLine, incumbent, i, batch, sigma, searchSeed,
    );
    if (!measureSweptRectangle(track, line, command.vehicle, 512).valid) continue;
    offsets.push(lines.length);
    lines.push(...tessellateLine(line, 0.8));
  }
  send({
    type: "displayCandidates",
    lines: Float32Array.from(lines),
    lineOffsets: Uint32Array.from(offsets),
  });
}

function smoothedGlobalDelta(globalDelta: Float32Array): Float32Array<ArrayBuffer> {
  let local = Float32Array.from(globalDelta.slice(0, SEARCH_LOCAL_MODE_COUNT));
  for (let pass = 0; pass < 3; pass++) {
    const next = local.slice();
    for (let i = 0; i < SEARCH_LOCAL_MODE_COUNT; i++) {
      next[i] = Math.fround(
        0.25 * local[(i + SEARCH_LOCAL_MODE_COUNT - 1) % SEARCH_LOCAL_MODE_COUNT]! +
        0.5 * local[i]! +
        0.25 * local[(i + 1) % SEARCH_LOCAL_MODE_COUNT]!,
      );
    }
    local = next;
  }
  const restart = Float32Array.from(globalDelta);
  for (let i = 0; i < SEARCH_LOCAL_MODE_COUNT; i++) restart[i] = Math.fround(0.7 * local[i]!);
  return restart;
}

function restartBasin(
  track: CompiledTrackJson,
  vehicle: VehicleSettings,
  globalDelta: Float32Array,
  restartIndex: number,
): { delta: Float32Array<ArrayBuffer>; line: ReturnType<typeof lineFromSearchDelta>; lap: number } {
  const candidates: Float32Array<ArrayBuffer>[] = [];
  if (restartIndex % 3 === 1) candidates.push(smoothedGlobalDelta(globalDelta));
  const mediumStart = SEARCH_LOCAL_MODE_COUNT;
  const broadStart = mediumStart + SEARCH_MEDIUM_MODE_COUNT;
  const randomBase = restartIndex % 2 === 0
    ? new Float32Array(SEARCH_MODE_COUNT)
    : smoothedGlobalDelta(globalDelta);
  for (const scale of [1, 0.6, 0.35]) {
    const proposal = randomBase.slice();
    for (let mode = mediumStart; mode < SEARCH_PREIMAGE_MODE_COUNT; mode++) {
      const bits = hash32(
        searchSeed ^ Math.imul(restartIndex + 1, 0x9e3779b9) ^ Math.imul(mode + 1, 0x85ebca6b),
      );
      const unit = ((bits & 0x00ffffff) / 0x00800000) - 1;
      const amplitude = mode < broadStart ? 0.22 : 0.38;
      proposal[mode] = Math.fround(Math.max(-0.5, Math.min(0.5,
        proposal[mode]! + scale * amplitude * unit,
      )));
    }
    const startBits = hash32(searchSeed ^ Math.imul(restartIndex + 1, 0x27d4eb2d));
    proposal[SEARCH_START_MODE] = Math.fround(
      scale * 0.3 * (((startBits & 0x00ffffff) / 0x00800000) - 1),
    );
    candidates.push(proposal);
  }
  candidates.push(new Float32Array(SEARCH_MODE_COUNT));
  for (const delta of candidates) {
    const line = lineFromSearchDelta(track, delta);
    if (!measureSweptRectangle(track, line, vehicle, 1024).valid) continue;
    return { delta, line, lap: evaluateProfile(line, vehicle, 1024).lapTime };
  }
  const delta = new Float32Array(SEARCH_MODE_COUNT);
  const line = lineFromSearchDelta(track, delta);
  return { delta, line, lap: evaluateProfile(line, vehicle, 1024).lapTime };
}

async function run(): Promise<void> {
  if (!command || running) return;
  running = true;
  stopping = false;
  const started = performance.now();
  const track = command.compiledTrack;
  const vehicle = command.vehicle;
  let globalDelta = bestDelta.slice();
  let globalLine = lineFromSearchDelta(track, globalDelta);
  let globalLap = evaluateProfile(globalLine, vehicle, 1024).lapTime;
  let activeDelta = globalDelta.slice();
  let activeLine = globalLine;
  let activeLap = globalLap;
  let basinBatch = 0;
  let stagnantBatches = 0;
  let restartIndex = command.optimizer.deterministic ? 0 : 2 + searchSeed % 1024;
  if (!command.optimizer.deterministic) {
    if (restartIndex % 3 === 1) restartIndex++;
    const restart = restartBasin(track, vehicle, globalDelta, restartIndex);
    activeDelta = restart.delta;
    activeLine = restart.line;
    activeLap = restart.lap;
  }
  const gpu = await createGpu(track, vehicle, GPU_CANDIDATES);
  send({
    type: "ready",
    adapterInfo: gpu
      ? `${adapterLabel(gpu.adapter)} · ${GPU_CANDIDATES.toLocaleString()} candidates/dispatch`
      : "C99-compatible CPU fallback",
    cpuFallback: !gpu,
  });
  const batchSize = gpu?.count ?? CPU_CANDIDATES;

  while (!stopping) {
    const incumbent = activeDelta.slice();
    const incumbentLine = activeLine;
    const sigma = Math.max(0.01, 0.14 / Math.sqrt(1 + basinBatch / 12));
    const t0 = performance.now();
    const scores = gpu
      ? await scoreGpuBatch(gpu, incumbentLine, incumbent, sigma)
      : scoreCpuBatch(track, vehicle, incumbentLine, incumbent, sigma, batchSize);
    const topIndices: number[] = [];
    const topScores: number[] = [];
    let validCount = 0;
    for (let i = 0; i < scores.length; i++) {
      const score = scores[i]!;
      if (score < 1e30) validCount++;
      insertTopCandidate(topIndices, topScores, i, score);
    }

    let winningLine = null as ReturnType<typeof lineFromSearchDelta> | null;
    let winningDelta = null as Float32Array<ArrayBuffer> | null;
    let winningLap = activeLap;
    let winningCandidate = -1;
    const recheckIndices = Array.from(new Set([
      ...topIndices,
      ...Array.from({ length: 32 }, (_, i) => 1 + ((32 * batch + i) % (2 * SEARCH_MODE_COUNT))),
    ]));
    for (const index of recheckIndices) {
      const delta = candidateSearchDelta(incumbent, index, batch, sigma, searchSeed);
      const line = candidateLineFromSearch(
        track, incumbentLine, incumbent, index, batch, sigma, searchSeed,
      );
      if (!measureSweptRectangle(track, line, vehicle, 512).valid) continue;
      const profile = evaluateProfile(line, vehicle, 1024);
      if (profile.lapTime < winningLap - 1e-6) {
        winningLine = line;
        winningDelta = delta;
        winningLap = profile.lapTime;
        winningCandidate = index;
      }
    }
    if (winningLine && winningDelta) {
      activeLap = winningLap;
      activeDelta = winningDelta;
      activeLine = winningLine;
      stagnantBatches = 0;
      if (winningLap < globalLap - 1e-6) {
        globalLap = winningLap;
        globalDelta = winningDelta.slice();
        globalLine = winningLine;
        send({
          type: "provisionalBest",
          lapTime: globalLap,
          genotype: genotypeForLine(track, winningLine),
          preimage: winningLine.preimage,
          candidateId: candidates + winningCandidate,
        });
      }
    } else {
      stagnantBatches++;
    }

    if (batch % 2 === 0) publishCandidates(track, incumbentLine, incumbent, sigma);
    batch++;
    basinBatch++;
    candidates += batchSize;
    const latency = performance.now() - t0;
    send({
      type: "progress",
      elapsedMs: performance.now() - started,
      batches: batch,
      candidates,
      validPercent: (100 * validCount) / batchSize,
      rejectionCounts: Array(13).fill(0),
      provisionalLapTime: Number.isFinite(globalLap) ? globalLap : null,
      batchLatencyMs: { median: latency, p95: latency, worst: latency },
    });
    if (!stopping &&
      (stagnantBatches >= STAGNANT_BATCH_LIMIT || basinBatch >= BASIN_BATCH_LIMIT)) {
      restartIndex++;
      searchSeed = hash32(searchSeed ^ Math.imul(restartIndex, 0x9e3779b9)) & 0x00ffffff;
      const restart = restartBasin(track, vehicle, globalDelta, restartIndex);
      activeDelta = restart.delta;
      activeLine = restart.line;
      activeLap = restart.lap;
      basinBatch = 0;
      stagnantBatches = 0;
      if (activeLap < globalLap - 1e-6) {
        globalLap = activeLap;
        globalDelta = activeDelta.slice();
        globalLine = activeLine;
        send({
          type: "provisionalBest",
          lapTime: globalLap,
          genotype: genotypeForLine(track, globalLine),
          preimage: globalLine.preimage,
          candidateId: candidates,
        });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  bestDelta = globalDelta;
  bestLap = globalLap;
  send({ type: "stopped", checkpoint: new ArrayBuffer(0) });
  running = false;
}

self.addEventListener("message", (event: MessageEvent<OptimizerCommand>) => {
  const message = event.data;
  if (message.type === "init") {
    command = message;
    batch = 0;
    candidates = 0;
    bestDelta = new Float32Array(SEARCH_MODE_COUNT);
    searchSeed = gpuSearchSeed({
      lo: message.optimizer.seedLo,
      hi: message.optimizer.seedHi,
    });
    send({ type: "ready", adapterInfo: "initializing", cpuFallback: false });
  } else if (message.type === "start") {
    void run();
  } else if (message.type === "stop") {
    stopping = true;
  } else if (message.type === "shutdown") {
    stopping = true;
    self.close();
  }
});
