import { writeFile } from "node:fs/promises";

import { BUILT_IN_TRACKS } from "@/model/catalog";
import { centerlineSpec, tessellateBoundary, tessellateLine } from "@/renderer/ph-tessellate";

const cellWidth = 600;
const cellHeight = 360;
const width = 3 * cellWidth;
const height = 2 * cellHeight;
const stride = Math.ceil(width * 3 / 4) * 4;
const pixels = Buffer.alloc(stride * height, 20);
const colors = {
  lane: [36, 42, 49],
  edge: [220, 225, 230],
  center: [255, 138, 31],
} as const;

function dot(x: number, y: number, color: readonly number[], radius: number): void {
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    if (dx * dx + dy * dy > radius * radius) continue;
    const px = x + dx, py = y + dy;
    if (px < 0 || py < 0 || px >= width || py >= height) continue;
    const at = (height - 1 - py) * stride + px * 3;
    pixels[at] = color[2]!; pixels[at + 1] = color[1]!; pixels[at + 2] = color[0]!;
  }
}

function stroke(points: ArrayLike<number>, map: (x: number, y: number) => [number, number], color: readonly number[], radius: number): void {
  for (let i = 0; i + 3 < points.length; i += 2) {
    const a = map(points[i]!, points[i + 1]!);
    const b = map(points[i + 2]!, points[i + 3]!);
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      dot(Math.round(a[0] + t * (b[0] - a[0])), Math.round(a[1] + t * (b[1] - a[1])), color, radius);
    }
  }
}

for (let trackIndex = 0; trackIndex < BUILT_IN_TRACKS.length; trackIndex++) {
  const track = BUILT_IN_TRACKS[trackIndex]!;
  const column = trackIndex % 3;
  const row = Math.floor(trackIndex / 3);
  const left = tessellateBoundary(track.leftBoundary, .2);
  const right = tessellateBoundary(track.rightBoundary, .2);
  const center = tessellateLine(centerlineSpec(track), .2);
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  for (let i=0;i<center.length;i+=2) {
    minX=Math.min(minX,center[i]!);maxX=Math.max(maxX,center[i]!);
    minY=Math.min(minY,center[i+1]!);maxY=Math.max(maxY,center[i+1]!);
  }
  const scale=Math.min((cellWidth-50)/(maxX-minX),(cellHeight-50)/(maxY-minY));
  const xPad=(cellWidth-(maxX-minX)*scale)/2;
  const yPad=(cellHeight-(maxY-minY)*scale)/2;
  const map=(x:number,y:number):[number,number]=>[
    Math.round(column*cellWidth+xPad+(x-minX)*scale),
    Math.round(row*cellHeight+yPad+(maxY-y)*scale),
  ];
  stroke(center,map,colors.lane,Math.max(3,Math.round(track.source.leftWidthM*scale)));
  stroke(left,map,colors.edge,1);
  stroke(right,map,colors.edge,1);
  stroke(center,map,colors.center,1);
}

const header=Buffer.alloc(54);
header.write("BM",0);header.writeUInt32LE(54+pixels.length,2);header.writeUInt32LE(54,10);
header.writeUInt32LE(40,14);header.writeInt32LE(width,18);header.writeInt32LE(height,22);
header.writeUInt16LE(1,26);header.writeUInt16LE(24,28);header.writeUInt32LE(pixels.length,34);
await writeFile(new URL("../build/catalog-acceptance.bmp",import.meta.url),Buffer.concat([header,pixels]));
