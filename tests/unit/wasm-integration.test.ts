import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { BUILT_IN_TRACKS } from "@/model/catalog";
import { DEFAULT_VEHICLE } from "@/model/contracts";
import {
  chordStraightenedGenotype,
  curvatureHotspotControls,
  measureSweptRectangle,
  smoothPreimageWindow,
} from "@/optimizer/ph-search";
import { racingLineFromPreimage } from "@/renderer/ph-tessellate";

type Reactor = Record<string, CallableFunction> & { memory: WebAssembly.Memory };

async function instantiate(name: string): Promise<Reactor> {
  const bytes = await readFile(new URL(`../../public/${name}`, import.meta.url));
  const noOp = (): number => 0;
  const imports: Record<string, CallableFunction> = {
    fd_write: noOp,
    proc_exit: (code: number) => { throw new Error(`unexpected proc_exit(${code})`); },
  };
  const wasi = new Proxy(imports, {
    get(target, key: string) {
      return target[key] ?? (() => { throw new Error(`unexpected WASI import ${key}`); });
    },
  });
  const result = await WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: wasi });
  return result.instance.exports as Reactor;
}

function writeJson(wasm: Reactor, region: number, value: unknown): number {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  new Uint8Array(wasm.memory.buffer, Number(wasm["op_buf_ptr"]!(region)), bytes.length).set(bytes);
  return bytes.length;
}

describe("browser reactors", () => {
  it("loads every catalog track and certifies its center genotype", async () => {
    const wasm = await instantiate("optiline_certifier.wasm");
    wasm["_initialize"]!();
    expect(wasm["op_ws_init"]!()).toBe(0);
    const failures: string[] = [];
    for (const track of BUILT_IN_TRACKS) {
      const assetLength = writeJson(wasm, 0, track);
      const vehicleLength = writeJson(wasm, 1, DEFAULT_VEHICLE);
      expect(wasm["op_ctx_load"]!(assetLength, vehicleLength)).toBe(0);
      const edges = Number(wasm["op_certify_candidate"]!());
      const error = Array.from(new Float64Array(
        wasm.memory.buffer,
        Number(wasm["op_buf_ptr"]!(7)),
        3,
      ));
      if (edges <= 0) failures.push(`${track.source.id}: ${error.join(":")}`);
    }
    expect(failures).toEqual([]);
  });

  it("loads the playback reactor and inverts a quintic PH span length", async () => {
    const wasm = await instantiate("optiline_playback.wasm");
    wasm["_initialize"]!();
    expect(wasm["op_ws_init"]!()).toBe(0);
    const track = BUILT_IN_TRACKS[0]!;
    const input = new Float64Array(
      wasm.memory.buffer,
      Number(wasm["op_buf_ptr"]!(0)),
      384,
    );
    input.set(track.centerPreimageControls.flat(), 0);
    input.set(track.gatePoints.flat(), 256);
    expect(wasm["op_line_load"]!()).toBe(0);
    const length = Number(wasm["op_span_length_e"]!(0));
    const halfLength = Number(wasm["op_span_arc_forward_e"]!(0, 0.5));
    expect(length).toBeGreaterThan(0);
    expect(Number(wasm["op_arc_inverse_e"]!(0, halfLength))).toBeCloseTo(0.5, 12);
    expect(wasm["op_eval_frame_e"]!(0, 0.5)).toBe(0);
    const frame = new Float64Array(
      wasm.memory.buffer,
      Number(wasm["op_buf_ptr"]!(1)),
      5,
    );
    expect(Math.hypot(frame[2]!, frame[3]!)).toBeCloseTo(1, 12);
  });

  it("independently certifies a faster corner-using search result", async () => {
    const track = BUILT_IN_TRACKS[4]!;
    const wasm = await instantiate("optiline_certifier.wasm");
    wasm["_initialize"]!();
    expect(wasm["op_ws_init"]!()).toBe(0);
    const assetLength = writeJson(wasm, 0, track);
    const vehicleLength = writeJson(wasm, 1, DEFAULT_VEHICLE);
    expect(wasm["op_ctx_load"]!(assetLength, vehicleLength)).toBe(0);
    expect(Number(wasm["op_certify_candidate"]!())).toBeGreaterThan(0);
    const centerCertifiedLap = new Float64Array(
      wasm.memory.buffer,
      Number(wasm["op_buf_ptr"]!(6)),
      16,
    )[0]!;

    const genotype = Float64Array.from([
      1,0,0,0,-.5,-.5,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,-.5,0,0,0,0,.5,-.5,-1,
      0,0,.5,0,0,0,0,-.5,0,0,0,-.5,0,1.5,1.5,-.5,-3,-2,-1.5,-1,0,0,0,0,1,1,-.5,-2.5,-2,-2,.5,
    ]);
    const genotypeRegion = new Float64Array(
      wasm.memory.buffer, Number(wasm["op_buf_ptr"]!(3)), 64,
    );
    const scoreRegion = new Float64Array(
      wasm.memory.buffer, Number(wasm["op_buf_ptr"]!(6)), 16,
    );
    genotypeRegion.set(genotype);
    const edges = Number(wasm["op_certify_candidate"]!());
    const certifiedLap = scoreRegion[0]!;
    expect(edges).toBeGreaterThan(0);
    expect(certifiedLap).toBeLessThan(centerCertifiedLap - 0.005);
    const certificate = scoreRegion;
    expect(certificate[9]).toBe(0);
    const certifiedPreimage = new Float64Array(
      wasm.memory.buffer,
      Number(wasm["op_buf_ptr"]!(4)),
      256,
    ).slice();
    const certifiedLine = racingLineFromPreimage(track, genotype, certifiedPreimage);
    expect(Math.hypot(
      certifiedLine.gates[0]! - track.gatePoints[0]![0],
      certifiedLine.gates[1]! - track.gatePoints[0]![1],
    )).toBeCloseTo(Math.abs(genotype[0]!), 10);
    const certifiedContainment = measureSweptRectangle(
      track,
      certifiedLine,
      DEFAULT_VEHICLE,
      1024,
    );
    expect(certifiedContainment.valid).toBe(true);
    expect(certificate[5]).toBeGreaterThan(0.95);
  }, 30_000);

  it("keeps the dense polishing score close to the certified Silver Delta profile", async () => {
    const track = BUILT_IN_TRACKS[1]!;
    const wasm = await instantiate("optiline_certifier.wasm");
    wasm["_initialize"]!();
    expect(wasm["op_ws_init"]!()).toBe(0);
    const assetLength = writeJson(wasm, 0, track);
    const vehicleLength = writeJson(wasm, 1, { ...DEFAULT_VEHICLE, axMinus0: 24 });
    expect(wasm["op_ctx_load"]!(assetLength, vehicleLength)).toBe(0);
    const genotype = new Float64Array(
      wasm.memory.buffer,
      Number(wasm["op_buf_ptr"]!(3)),
      64,
    );
    for (let i = 0; i < genotype.length; i++) genotype[i] = 0.4 * Math.sin(Math.PI * i / 4);
    expect(Number(wasm["op_score_candidate_dense"]!())).toBeGreaterThan(0);
    const certificate = new Float64Array(
      wasm.memory.buffer,
      Number(wasm["op_buf_ptr"]!(6)),
      16,
    );
    const refinedLap = certificate[0]!;
    expect(Number(wasm["op_certify_candidate"]!())).toBeGreaterThan(0);
    const certifiedLap = certificate[0]!;
    expect(Math.abs(refinedLap - certifiedLap) / certifiedLap).toBeLessThan(0.01);

    const shortlist: Array<{
      fastLap: number;
      genotype: Float64Array<ArrayBuffer>;
    }> = [];
    const initialGenotype = genotype.slice();
    for (const radius of [8, 4]) for (let center = 0; center < 64; center += 2) {
      for (const blend of [1, 0.5]) {
        const proposal = chordStraightenedGenotype(
          track, initialGenotype, center, radius, blend,
        );
        genotype.set(proposal);
        if (Number(wasm["op_score_candidate"]!()) <= 0) continue;
        shortlist.push({ fastLap: certificate[0]!, genotype: proposal });
      }
    }
    shortlist.sort((a, b) => a.fastLap - b.fastLap);
    let bestLap = refinedLap;
    let bestGenotype = initialGenotype;
    for (const candidate of shortlist.slice(0, 8)) {
      genotype.set(candidate.genotype);
      if (Number(wasm["op_score_candidate_dense"]!()) <= 0) continue;
      if (certificate[0]! < bestLap) {
        bestLap = certificate[0]!;
        bestGenotype = candidate.genotype;
      }
    }
    expect(bestLap).toBeLessThan(refinedLap - 0.005);
    genotype.set(bestGenotype);
    const edgeCount = Number(wasm["op_certify_candidate"]!());
    expect(edgeCount).toBeGreaterThan(0);
    const finalLap = certificate[0]!;
    expect(finalLap).toBeLessThan(certifiedLap - 0.005);

    const preimage = new Float64Array(
      wasm.memory.buffer, Number(wasm["op_buf_ptr"]!(4)), 256,
    );
    const profile = new Float64Array(
      wasm.memory.buffer, Number(wasm["op_buf_ptr"]!(5)), edgeCount * 7,
    );
    const baselineWarm = preimage.slice();
    const baselineProfile = profile.slice();
    const hotspots = curvatureHotspotControls(baselineProfile, edgeCount, 10);
    genotype.set(bestGenotype);
    preimage.set(baselineWarm);
    expect(Number(wasm["op_score_candidate_dense_warm"]!())).toBeGreaterThan(0);
    const denseBaseline = certificate[0]!;
    let smoothLap = denseBaseline;
    let smoothWarm = preimage.slice();
    for (const blend of [1, 0.5, 0.25]) for (const control of hotspots)
      for (const radius of [1, 2, 4]) {
        genotype.set(bestGenotype);
        preimage.set(smoothPreimageWindow(baselineWarm, control, radius, blend));
        if (Number(wasm["op_score_candidate_dense_warm"]!()) <= 0) continue;
        if (certificate[0]! < smoothLap) {
          smoothLap = certificate[0]!;
          smoothWarm = preimage.slice();
        }
      }
    expect(smoothLap).toBeLessThan(denseBaseline - 0.005);
    genotype.set(bestGenotype);
    preimage.set(smoothWarm);
    const smoothEdges = Number(wasm["op_certify_candidate_warm"]!());
    expect(smoothEdges).toBe(edgeCount);
    expect(certificate[0]).toBeLessThan(finalLap - 0.005);
    const certifiedProfile = profile.slice();
    const maxCurvature = (values: Float64Array): number => {
      let maximum = 0;
      for (let i = 0; i < edgeCount; i++) {
        maximum = Math.max(maximum, Math.abs(values[7 * i + 5]!));
      }
      return maximum;
    };
    expect(maxCurvature(certifiedProfile)).toBeLessThan(maxCurvature(baselineProfile));
  }, 60_000);
});
