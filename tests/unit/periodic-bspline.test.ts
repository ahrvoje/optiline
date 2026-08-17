import { describe, expect, it } from "vitest";

import { BUILT_IN_TRACKS } from "@/model/catalog";
import { DEFAULT_VEHICLE } from "@/model/contracts";
import {
  evaluatePeriodicSpline,
  periodicBasisSample,
  refinePeriodicQuintic,
} from "@/optimizer/periodic-bspline";
import {
  buildLateralBasis,
  buildReferenceSpine,
  buildSafeCorridor,
  evaluateRacingLineFrame,
} from "@/optimizer/racing-line";

describe("periodic quintic lateral field", () => {
  it("forms a partition of unity with zero derivative sums", () => {
    for (const u of [0, 1e-9, 0.137, 0.5, 0.999999999]) {
      const sample = periodicBasisSample(5, 24, u, 4);
      expect(Array.from(sample.weights[0]!).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
      for (let derivative = 1; derivative <= 4; derivative++) {
        expect(Array.from(sample.weights[derivative]!).reduce((a, b) => a + b, 0))
          .toBeCloseTo(0, Math.max(3, 10 - derivative));
      }
    }
  });

  it("is periodic through derivative order four", () => {
    const coefficients = Float64Array.from({ length: 19 }, (_, i) =>
      0.7 * Math.sin(2 * Math.PI * i / 19) + 0.2 * Math.cos(6 * Math.PI * i / 19));
    const a = evaluatePeriodicSpline(coefficients, 5, 0, 4);
    const b = evaluatePeriodicSpline(coefficients, 5, 1, 4);
    for (let derivative = 0; derivative <= 4; derivative++) {
      expect(b[derivative]).toBeCloseTo(a[derivative]!, 8);
    }
  });

  it("preserves the continuous spline under dyadic knot insertion", () => {
    const coarse = Float64Array.from({ length: 17 }, (_, i) =>
      0.6 * Math.sin(4 * Math.PI * i / 17) - 0.15 * Math.cos(2 * Math.PI * i / 17));
    const fine = refinePeriodicQuintic(coarse);
    for (let i = 0; i < 100; i++) {
      const u = (i + 0.37) / 100;
      const before = evaluatePeriodicSpline(coarse, 5, u, 4);
      const after = evaluatePeriodicSpline(fine, 5, u, 4);
      for (let derivative = 0; derivative <= 4; derivative++) {
        expect(after[derivative]).toBeCloseTo(before[derivative]!, Math.max(3, 9 - derivative));
      }
    }
  });
});

describe("smooth reference chart", () => {
  it("is a forward lane chart for every built-in circuit", () => {
    for (const track of BUILT_IN_TRACKS) {
      const spine = buildReferenceSpine(track);
      expect(spine.maxFitErrorM).toBeLessThan(
        0.25 * Math.min(track.source.leftWidthM, track.source.rightWidthM),
      );
      expect(spine.minForwardProgress).toBeGreaterThan(0.5);
    }
  });

  it("interpolates the authoritative PH center samples and closes analytically", () => {
    const track = BUILT_IN_TRACKS[0]!;
    const spine = buildReferenceSpine(track);
    expect(spine.kind).toBe("fourier-kernel");
    expect(spine.modeCount).toBeGreaterThan(0);
    expect(spine.maxFitErrorM).toBeLessThan(0.01);
    expect(spine.minForwardProgress).toBeGreaterThan(0.99);
    const corridor = buildSafeCorridor(track, DEFAULT_VEHICLE);
    const basis = buildLateralBasis(track, 16, 4);
    const coefficients = new Float64Array(1 + 2 * basis.fourierModes + 16);
    const start = evaluateRacingLineFrame(
      spine, basis, coefficients, corridor, track, DEFAULT_VEHICLE, 0,
    );
    const seam = evaluateRacingLineFrame(
      spine, basis, coefficients, corridor, track, DEFAULT_VEHICLE, 1,
    );
    expect(Math.hypot(start.x - seam.x, start.y - seam.y)).toBeLessThan(1e-9);
    expect(Math.abs(start.kappa - seam.kappa)).toBeLessThan(1e-9);
    expect(Math.abs(start.kappaL - seam.kappaL)).toBeLessThan(1e-8);
    expect(start.q).toBeGreaterThan(0);
    expect(start.progress).toBeGreaterThan(0);
  });
});
