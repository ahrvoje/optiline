import { readFile, writeFile } from "node:fs/promises";

import { BUILT_IN_TRACKS } from "@/model/catalog";
import { DEFAULT_VEHICLE } from "@/model/contracts";
import {
  centerlineSpec,
  racingLineFromPreimage,
  sampleLineFrames,
  tessellateBoundary,
  tessellateLine,
  type LineSpec,
} from "@/renderer/ph-tessellate";
import { rectangleCorners } from "@/renderer/vehicle-draw";

type Reactor = Record<string, CallableFunction> & { memory: WebAssembly.Memory };

async function certifier(): Promise<Reactor> {
  const bytes = await readFile(new URL("../public/optiline_certifier.wasm", import.meta.url));
  const noOp = (): number => 0;
  const wasi = new Proxy<Record<string, CallableFunction>>({ fd_write: noOp }, {
    get: (target, key: string) => target[key] ?? noOp,
  });
  const result = await WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: wasi });
  return result.instance.exports as Reactor;
}

function writeJson(wasm: Reactor, region: number, value: unknown): number {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  new Uint8Array(wasm.memory.buffer, Number(wasm["op_buf_ptr"]!(region)), bytes.length).set(bytes);
  return bytes.length;
}

const trackIndex = Number(process.argv[2] ?? 4);
const track = BUILT_IN_TRACKS[trackIndex];
if (!track) throw new Error(`unknown catalog track index ${trackIndex}`);
const wasm = await certifier();
wasm["_initialize"]!();
wasm["op_ws_init"]!();
wasm["op_ctx_load"]!(writeJson(wasm, 0, track), writeJson(wasm, 1, DEFAULT_VEHICLE));
wasm["op_certify_candidate"]!();
const certificateRegion = new Float64Array(wasm.memory.buffer, Number(wasm["op_buf_ptr"]!(6)), 16);
const genotypeRegion = new Float64Array(wasm.memory.buffer, Number(wasm["op_buf_ptr"]!(3)), 64);
const preimageRegion = new Float64Array(wasm.memory.buffer, Number(wasm["op_buf_ptr"]!(4)), 256);
const centerLap = certificateRegion[0]!;
let genotype = new Float64Array(64);
let warm = preimageRegion.slice();
let certifiedGenotype = genotype.slice();
let certifiedWarm = warm.slice();
let certifiedLap = centerLap;
genotypeRegion.set(genotype);
preimageRegion.set(warm);
if (Number(wasm["op_score_candidate_warm"]!()) <= 0) throw new Error("center score failed");
let lowResolutionLap = certificateRegion[0]!;
warm = preimageRegion.slice();
const moves = [
  { steps: [8], halfWidth: 8 },
  { steps: [6, 3, 1.5], halfWidth: 4 },
  { steps: [2, 1], halfWidth: 2 },
  { steps: [.5], halfWidth: 0 },
];
for (const move of moves) for (const step of move.steps) {
  for (let gate = 0; gate < 64; gate++) {
    let nextLap = lowResolutionLap;
    let nextGenotype = genotype;
    let nextWarm = warm;
    for (const sign of [-1, 1]) {
      const proposal = genotype.slice();
      for (let offset = -move.halfWidth; offset <= move.halfWidth; offset++) {
        const index = (gate + offset + 64) % 64;
        const weight = move.halfWidth === 0
          ? 1
          : .5 * (1 + Math.cos(Math.PI * offset / (move.halfWidth + 1)));
        proposal[index] = Math.max(
          -track.source.rightWidthM,
          Math.min(track.source.leftWidthM, proposal[index]! + sign * step * weight),
        );
      }
      genotypeRegion.set(proposal);
      preimageRegion.set(warm);
      if (Number(wasm["op_score_candidate_warm"]!()) <= 0) continue;
      if (certificateRegion[0]! < nextLap) {
        nextLap = certificateRegion[0]!;
        nextGenotype = proposal;
        nextWarm = preimageRegion.slice();
      }
    }
    genotype = nextGenotype;
    warm = nextWarm;
    lowResolutionLap = nextLap;
  }

  genotypeRegion.set(genotype);
  preimageRegion.set(warm);
  const checkpointEdges = Number(wasm["op_certify_candidate_warm"]!());
  if (checkpointEdges > 0 && certificateRegion[9] === 0) {
    const checkpointLap = certificateRegion[0]!;
    const checkpointWarm = preimageRegion.slice();
    if (checkpointLap < certifiedLap - 1e-6) {
      certifiedLap = checkpointLap;
      certifiedGenotype = genotype.slice();
      certifiedWarm = checkpointWarm;
    }
    warm = checkpointWarm;
  } else {
    genotype = certifiedGenotype.slice();
    warm = certifiedWarm.slice();
  }
  genotypeRegion.set(genotype);
  preimageRegion.set(warm);
  if (Number(wasm["op_score_candidate_warm"]!()) <= 0)
    throw new Error("certified checkpoint could not be restored");
  lowResolutionLap = certificateRegion[0]!;
  warm = preimageRegion.slice();
}
for (const step of [6, 3, 1.5, .75]) {
  let nextLap = lowResolutionLap;
  let nextGenotype = genotype;
  let nextWarm = warm;
  for (const approach of [-1, 0, 1]) for (const start of [-1, 0, 1])
    for (const exit of [-1, 0, 1]) {
      if (approach === 0 && start === 0 && exit === 0) continue;
      const proposal = genotype.slice();
      const values = [0, approach * step, start * step, exit * step, 0];
      for (let offset = -12; offset <= 12; offset++) {
        const segment = Math.min(3, Math.floor((offset + 12) / 6));
        const t = (offset + 12 - 6 * segment) / 6;
        const smooth = t * t * (3 - 2 * t);
        const delta = values[segment]! + smooth * (values[segment + 1]! - values[segment]!);
        const index = (offset + 64) % 64;
        proposal[index] = Math.max(
          -track.source.rightWidthM,
          Math.min(track.source.leftWidthM, proposal[index]! + delta),
        );
      }
      genotypeRegion.set(proposal);
      preimageRegion.set(warm);
      if (Number(wasm["op_score_candidate_warm"]!()) <= 0) continue;
      if (certificateRegion[0]! < nextLap) {
        nextLap = certificateRegion[0]!;
        nextGenotype = proposal;
        nextWarm = preimageRegion.slice();
      }
    }
  genotype = nextGenotype;
  warm = nextWarm;
  lowResolutionLap = nextLap;

  genotypeRegion.set(genotype);
  preimageRegion.set(warm);
  const checkpointEdges = Number(wasm["op_certify_candidate_warm"]!());
  if (checkpointEdges > 0 && certificateRegion[9] === 0) {
    const checkpointLap = certificateRegion[0]!;
    const checkpointWarm = preimageRegion.slice();
    if (checkpointLap < certifiedLap - 1e-6) {
      certifiedLap = checkpointLap;
      certifiedGenotype = genotype.slice();
      certifiedWarm = checkpointWarm;
    }
    warm = checkpointWarm;
  } else {
    genotype = certifiedGenotype.slice();
    warm = certifiedWarm.slice();
  }
  genotypeRegion.set(genotype);
  preimageRegion.set(warm);
  if (Number(wasm["op_score_candidate_warm"]!()) <= 0)
    throw new Error("certified seam checkpoint could not be restored");
  lowResolutionLap = certificateRegion[0]!;
  warm = preimageRegion.slice();
}
genotype = certifiedGenotype.slice();
warm = certifiedWarm.slice();
genotypeRegion.set(genotype);
preimageRegion.set(warm);
if (Number(wasm["op_certify_candidate_warm"]!()) <= 0) throw new Error("final binary64 certification failed");
certifiedLap = certificateRegion[0]!;
if (certificateRegion[9] !== 0 || certificateRegion[5]! > 1)
  throw new Error("final binary64 certificate failed");
const certifiedPreimage = preimageRegion.slice();
const certified: LineSpec = racingLineFromPreimage(track, genotype, certifiedPreimage);
if (!(certifiedLap < centerLap)) throw new Error("search found no binary64-certified improvement");

const width = 1200;
const height = 900;
const stride = Math.ceil((width * 3) / 4) * 4;
const pixels = Buffer.alloc(stride * height);
const rgb = (hex: string) => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
] as const;
const background = rgb("#14171b");
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const offset = (height - 1 - y) * stride + x * 3;
  pixels[offset] = background[2]; pixels[offset + 1] = background[1]; pixels[offset + 2] = background[0];
}

const left = tessellateBoundary(track.leftBoundary, 0.15);
const right = tessellateBoundary(track.rightBoundary, 0.15);
const center = tessellateLine(centerlineSpec(track), 0.15);
const winner = tessellateLine(certified, 0.15);
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
for (const points of [left, right]) for (let i = 0; i < points.length; i += 2) {
  minX = Math.min(minX, points[i]!); maxX = Math.max(maxX, points[i]!);
  minY = Math.min(minY, points[i + 1]!); maxY = Math.max(maxY, points[i + 1]!);
}
const scale = Math.min((width - 80) / (maxX - minX), (height - 80) / (maxY - minY));
const map = (x: number, y: number) => [
  Math.round(40 + (x - minX) * scale),
  Math.round(height - 40 - (y - minY) * scale),
] as const;

function dot(x: number, y: number, color: readonly number[], radius: number): void {
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    if (dx * dx + dy * dy > radius * radius) continue;
    const px = x + dx, py = y + dy;
    if (px < 0 || py < 0 || px >= width || py >= height) continue;
    const offset = (height - 1 - py) * stride + px * 3;
    pixels[offset] = color[2]!; pixels[offset + 1] = color[1]!; pixels[offset + 2] = color[0]!;
  }
}

function line(points: ArrayLike<number>, color: readonly number[], radius: number, dashed = false): void {
  for (let i = 0; i + 3 < points.length; i += 2) {
    const a = map(points[i]!, points[i + 1]!);
    const b = map(points[i + 2]!, points[i + 3]!);
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
    for (let step = 0; step <= steps; step++) {
      if (dashed && Math.floor((i + step) / 10) % 2 === 1) continue;
      const mix = step / steps;
      dot(Math.round(a[0] + mix * (b[0] - a[0])), Math.round(a[1] + mix * (b[1] - a[1])), color, radius);
    }
  }
}

line(center, rgb("#242a31"), Math.max(2, Math.round(track.source.leftWidthM * scale)));
line(center, rgb("#58616b"), 1, true);
line(left, rgb("#f1f3f5"), 2);
line(right, rgb("#c8cdd2"), 2);
line(winner, rgb("#ff8a1f"), 3);

const centerFrames = sampleLineFrames(centerlineSpec(track), 2048);
const winnerFrames = sampleLineFrames(certified, 2048);
let vehicleIndex = 0;
let maximumUse = -Infinity;
const halfLength = DEFAULT_VEHICLE.lengthM / 2 + DEFAULT_VEHICLE.safetyMarginM;
const halfWidth = DEFAULT_VEHICLE.widthM / 2 + DEFAULT_VEHICLE.safetyMarginM;
for (let i = 0; i < winnerFrames.length; i++) {
  const c = centerFrames[i]!, p = winnerFrames[i]!;
  const nx = -c.ty, ny = c.tx;
  const lateral = (p.x - c.x) * nx + (p.y - c.y) * ny;
  const extent = halfLength * Math.abs(p.tx * nx + p.ty * ny) + halfWidth * Math.abs(-p.ty * nx + p.tx * ny);
  const use = Math.max((lateral + extent) / track.source.leftWidthM, (-lateral + extent) / track.source.rightWidthM);
  if (use > maximumUse) { maximumUse = use; vehicleIndex = i; }
}
const pose = winnerFrames[vehicleIndex]!;
const corners = rectangleCorners(pose, DEFAULT_VEHICLE.lengthM, DEFAULT_VEHICLE.widthM);
line([...corners, corners[0]!, corners[1]!], rgb("#ffffff"), 2);

const header = Buffer.alloc(54);
header.write("BM", 0); header.writeUInt32LE(54 + pixels.length, 2); header.writeUInt32LE(54, 10);
header.writeUInt32LE(40, 14); header.writeInt32LE(width, 18); header.writeInt32LE(height, 22);
header.writeUInt16LE(1, 26); header.writeUInt16LE(24, 28); header.writeUInt32LE(pixels.length, 34);
const output = new URL(`../build/search-acceptance-${track.source.id}.bmp`, import.meta.url);
await writeFile(output, Buffer.concat([header, pixels]));
console.info(JSON.stringify({
  output: output.pathname,
  centerLapS: centerLap,
  certifiedLapS: certifiedLap,
  gainS: centerLap - certifiedLap,
  certifiedMaxUtilizationBound: certificateRegion[5],
  lateralGateOffsetsM: Array.from(genotype),
}, null, 2));
