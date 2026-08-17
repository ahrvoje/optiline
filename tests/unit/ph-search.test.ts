import { describe, expect, it } from "vitest";

import { BUILT_IN_TRACKS } from "@/model/catalog";
import { DEFAULT_VEHICLE } from "@/model/contracts";
import {
  candidateSearchDelta,
  curvatureHotspotControls,
  genotypeForLine,
  lineFromSearchDelta,
  measureSweptRectangle,
  SEARCH_BASIS_COUNT,
  SEARCH_BROAD_MODE_COUNT,
  SEARCH_LOCAL_MODE_COUNT,
  SEARCH_MEDIUM_MODE_COUNT,
  SEARCH_MODE_COUNT,
  SEARCH_PREIMAGE_MODE_COUNT,
  SEARCH_SMOOTH_FIRST_CANDIDATE,
  SEARCH_START_MODE,
  searchModeBasis,
  smoothPreimageWindow,
} from "@/optimizer/ph-search";
import { evaluateProfile } from "@/optimizer/profile";
import shaderSource from "@/workers/optimizer.wgsl?raw";

describe("PH harmonic search", () => {
  it("has a faster deterministic coordinate probe in the first dispatch", () => {
    const track = BUILT_IN_TRACKS[0]!;
    const incumbent = new Float32Array(SEARCH_MODE_COUNT);
    const centerLap = evaluateProfile(
      lineFromSearchDelta(track, incumbent),
      DEFAULT_VEHICLE,
      1024,
    ).lapTime;
    let probeLap = centerLap;
    for (let candidate = 1; candidate <= 2 * SEARCH_MODE_COUNT; candidate++) {
      const delta = candidateSearchDelta(incumbent, candidate, 0, 0.01, 1);
      const line = lineFromSearchDelta(track, delta);
      if (!measureSweptRectangle(track, line, DEFAULT_VEHICLE, 512).valid) continue;
      probeLap = Math.min(probeLap, evaluateProfile(line, DEFAULT_VEHICLE, 1024).lapTime);
    }
    expect(probeLap).toBeLessThan(centerLap - 0.005);
  });

  it("exposes local, medium, and broad PH shape coordinates and an independent start offset", () => {
    expect(SEARCH_LOCAL_MODE_COUNT).toBe(128);
    expect(SEARCH_MEDIUM_MODE_COUNT).toBe(32);
    expect(SEARCH_BROAD_MODE_COUNT).toBe(16);
    expect(SEARCH_PREIMAGE_MODE_COUNT).toBe(176);
    expect(SEARCH_MODE_COUNT).toBe(177);
    const track = BUILT_IN_TRACKS[0]!;
    const delta = new Float64Array(SEARCH_MODE_COUNT);
    delta[17] = 0.2;
    const line = lineFromSearchDelta(track, delta);
    const genotype = genotypeForLine(track, line);
    const basis = searchModeBasis(track);
    const nonzeroControls = Array.from({ length: 128 }, (_, control) => {
      const index = 2 * (SEARCH_BASIS_COUNT * control + 17);
      return Math.hypot(basis[index]!, basis[index + 1]!) > 1e-8;
    }).filter(Boolean).length;
    expect(genotype).toHaveLength(64);
    expect(Math.max(...Array.from(genotype, Math.abs))).toBeGreaterThan(0.01);
    expect(nonzeroControls).toBe(7);

    const support = (mode: number) => Array.from({ length: 128 }, (_, control) => {
      const index = 2 * (SEARCH_BASIS_COUNT * control + mode);
      return Math.hypot(basis[index]!, basis[index + 1]!) > 1e-8;
    }).filter(Boolean).length;
    expect(support(SEARCH_LOCAL_MODE_COUNT)).toBe(25);
    expect(support(SEARCH_LOCAL_MODE_COUNT + SEARCH_MEDIUM_MODE_COUNT)).toBe(49);

    const translated = new Float64Array(SEARCH_MODE_COUNT);
    translated[SEARCH_START_MODE] = 0.25;
    const translatedGenotype = genotypeForLine(track, lineFromSearchDelta(track, translated));
    expect(translatedGenotype[0]).toBeGreaterThan(1);
  });

  it("uses coupled PH coordinates for global candidates", () => {
    const incumbent = new Float32Array(SEARCH_MODE_COUNT);
    const delta = candidateSearchDelta(incumbent, 1024, 3, 0.08, 17);
    const changed = Array.from(delta).filter(value => value !== 0).length;
    expect(changed).toBe(4);

    let startCoupled: Float32Array | null = null;
    for (let candidate = 2 * SEARCH_MODE_COUNT + 1; candidate < 4096; candidate++) {
      const proposal = candidateSearchDelta(incumbent, candidate, 3, 0.08, 17);
      if (proposal[SEARCH_START_MODE] !== 0) {
        startCoupled = proposal;
        break;
      }
    }
    expect(startCoupled).not.toBeNull();
    expect(Array.from(startCoupled!).filter(value => value !== 0)).toHaveLength(4);
  });

  it("uses the seed reproducibly while different seeds explore different proposals", () => {
    const incumbent = new Float32Array(SEARCH_MODE_COUNT);
    const candidate = 4097;
    const first = candidateSearchDelta(incumbent, candidate, 11, 0.12, 0x123456);
    const repeated = candidateSearchDelta(incumbent, candidate, 11, 0.12, 0x123456);
    const different = candidateSearchDelta(incumbent, candidate, 11, 0.12, 0x654321);
    expect(Array.from(repeated)).toEqual(Array.from(first));
    expect(Array.from(different)).not.toEqual(Array.from(first));

    const firstProbe = candidateSearchDelta(incumbent, 1, 0, 0.12, 0x123456);
    const repeatedProbe = candidateSearchDelta(incumbent, 1, 0, 0.12, 0x123456);
    const differentProbe = candidateSearchDelta(incumbent, 1, 0, 0.12, 0x654321);
    expect(Array.from(repeatedProbe)).toEqual(Array.from(firstProbe));
    expect(Array.from(differentProbe)).not.toEqual(Array.from(firstProbe));
  });

  it("offers coordinated smoothing candidates for noisy local PH coordinates", () => {
    const incumbent = new Float32Array(SEARCH_MODE_COUNT);
    incumbent[0] = 0.4;
    const full = candidateSearchDelta(
      incumbent, SEARCH_SMOOTH_FIRST_CANDIDATE, 0, 0.12, 1,
    );
    const half = candidateSearchDelta(
      incumbent, SEARCH_SMOOTH_FIRST_CANDIDATE + 1, 0, 0.12, 1,
    );
    expect(full[0]).toBeCloseTo(0.2, 6);
    expect(half[0]).toBeCloseTo(0.3, 6);
  });

  it("finds certified curvature hotspots and smooths the antiperiodic PH seam", () => {
    const edgeCount = 64;
    const nodes = new Float64Array(edgeCount * 7);
    for (let i = 0; i < edgeCount; i++) {
      nodes[7 * i] = i / 2;
      nodes[7 * i + 3] = 2500;
    }
    nodes[7 * 42 + 3] = 400;
    nodes[7 * 42 + 5] = 0.08;
    expect(curvatureHotspotControls(nodes, edgeCount, 4)[0]).toBe(42);

    const preimage = new Float64Array(256);
    preimage[0] = 10;
    preimage[2] = 2;
    preimage[254] = -2;
    const smoothed = smoothPreimageWindow(preimage, 0, 0, 1);
    expect(smoothed[0]).toBeCloseTo(6, 12);
  });

  it("gives Silver Delta a directly useful broad-sector move", () => {
    const track = BUILT_IN_TRACKS[1]!;
    const incumbent = new Float32Array(SEARCH_MODE_COUNT);
    const centerLap = evaluateProfile(lineFromSearchDelta(track, incumbent), DEFAULT_VEHICLE, 1024).lapTime;
    const firstBroadMode = SEARCH_LOCAL_MODE_COUNT + SEARCH_MEDIUM_MODE_COUNT;
    let broadLap = centerLap;
    for (let mode = firstBroadMode; mode < SEARCH_PREIMAGE_MODE_COUNT; mode++) {
      for (const candidate of [1 + 2 * mode, 2 + 2 * mode]) {
        const delta = candidateSearchDelta(incumbent, candidate, 0, 0.01, 1);
        const line = lineFromSearchDelta(track, delta);
        if (!measureSweptRectangle(track, line, DEFAULT_VEHICLE, 512).valid) continue;
        broadLap = Math.min(broadLap, evaluateProfile(line, DEFAULT_VEHICLE, 1024).lapTime);
      }
    }
    expect(broadLap).toBeLessThan(centerLap - 0.005);
  });

  it("uses the periodic lateral-field WGSL contract", () => {
    expect(shaderSource).toContain("coefficients: array<f32>");
    expect(shaderSource).toContain("referenceGeometry: array<vec4f>");
    expect(shaderSource).toContain("basisTable: array<vec4f>");
    expect(shaderSource).toContain(
      "for (var coefficientIndex = 0u; coefficientIndex < coefficientCount; coefficientIndex++)",
    );
    expect(shaderSource).toContain("let eta = tanh(z)");
    expect(shaderSource).toContain("let station = flatIndex / candidateCount");
    expect(shaderSource).toContain("let r1 = c1 + d1 * n0 + d * n1");
    expect(shaderSource).toContain("let curvature = cross2(r1, r2)");
    expect(shaderSource).toContain("lateralCapacity * downforce");
    expect(shaderSource).not.toContain("PREIMAGE_MODE_COUNT");
  });
});
