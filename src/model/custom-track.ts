import type { CompiledTrackJson, TrackSourceJson } from "@/model/contracts";

type Point = [number, number];

export function nextCustomTrackName(tracks: readonly CompiledTrackJson[]): string {
  const used = new Set<number>();
  for (const track of tracks) {
    const match = /^Custom #(\d+)$/.exec(track.source.name.trim());
    if (match) used.add(Number(match[1]));
  }
  let number = 1;
  while (used.has(number)) number++;
  return `Custom #${number}`;
}

function customId(): string {
  return `custom-${crypto.randomUUID()}`;
}

function commonSource(name: string, nodes: Point[], widthM: number): TrackSourceJson {
  return {
    schemaVersion: 1,
    id: customId(),
    name,
    description: "Editable custom circuit",
    direction: "counterclockwise",
    centerGatesM: nodes,
    leftWidthM: widthM,
    rightWidthM: widthM,
    startGate: 0,
    tags: ["custom", "editable"],
    sourceVersion: 1,
  };
}

/** A 16-node wide stadium oval with two long straights. */
export function createOvalTrackSource(name: string, widthM = 10): TrackSourceJson {
  const nodes: Point[] = [
    [120, 60], [60, 60], [0, 60], [-60, 60], [-120, 60],
    [-145, 42], [-155, 0], [-145, -42],
    [-120, -60], [-60, -60], [0, -60], [60, -60], [120, -60],
    [145, -42], [155, 0], [145, 42],
  ];
  return commonSource(name, nodes, widthM);
}

export function duplicateTrackSource(track: CompiledTrackJson, name: string): TrackSourceJson {
  return commonSource(
    name,
    track.source.centerGatesM.map(([x, y]) => [x, y]),
    0.5 * (track.source.leftWidthM + track.source.rightWidthM),
  );
}

export function forkTrackSource(source: TrackSourceJson, name: string): TrackSourceJson {
  return {
    ...source,
    id: customId(),
    name,
    centerGatesM: source.centerGatesM.map(([x, y]) => [x, y]),
    sourceVersion: 1,
  };
}

