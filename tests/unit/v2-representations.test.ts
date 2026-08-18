import { describe, expect, it } from "vitest";

import { BUILT_IN_TRACKS } from "@/model/catalog";
import { DEFAULT_VEHICLE } from "@/model/contracts";
import {
  curvatureRepresentationFromJson,
  curvatureRepresentationToJson,
  fitCurvatureRepresentation,
  measureCurvatureClosure,
  projectCurvatureClosure,
  projectCurvaturePerturbation,
  reconstructCurvaturePath,
  type CurvatureRepresentation,
} from "@/optimizer/curvature-closure";
import { evaluateCurvatureCandidate } from "@/optimizer/curvature-evaluation";
import {
  certifyCurvatureCandidate,
  CURVATURE_CERTIFICATION_STAGE_COUNT,
} from "@/optimizer/curvature-certificate";
import { evaluateFourierSeries, fitRealFourier } from "@/optimizer/fourier";
import {
  buildHybridPeriodicBasis,
  decodeBoundedHybridField,
  evaluateHybridField,
  hybridCoefficientCount,
  projectHybridResidual,
  remapHybridCoefficients,
} from "@/optimizer/hybrid-basis";
import { sampleRacingLine } from "@/optimizer/racing-line";

describe("V2 Fourier and high-pass residual", () => {
  it("fits a periodic Fourier field and its analytic derivatives", () => {
    const samples = Float64Array.from({ length: 128 }, (_, i) => {
      const u = i / 128;
      return 1.25 + 0.7 * Math.cos(4 * Math.PI * u) - 0.2 * Math.sin(6 * Math.PI * u);
    });
    const coefficients = fitRealFourier(samples, 4);
    const value = evaluateFourierSeries(coefficients, 0.173, 4);
    const u = 0.173;
    expect(value[0]).toBeCloseTo(
      1.25 + 0.7 * Math.cos(4 * Math.PI * u) - 0.2 * Math.sin(6 * Math.PI * u),
      12,
    );
    expect(value[1]).toBeCloseTo(
      -0.7 * 4 * Math.PI * Math.sin(4 * Math.PI * u) -
        0.2 * 6 * Math.PI * Math.cos(6 * Math.PI * u),
      10,
    );
  });

  it("removes every sampled low Fourier moment from the spline residual", () => {
    const model = buildHybridPeriodicBasis(4, 24, 4096);
    const coefficients = new Float64Array(hybridCoefficientCount(model));
    const firstResidual = 1 + 2 * model.fourierModes;
    for (let i = 0; i < model.residualControlCount; i++) {
      coefficients[firstResidual + i] =
        0.6 * Math.sin(10 * Math.PI * i / model.residualControlCount) +
        0.2 * Math.cos(14 * Math.PI * i / model.residualControlCount);
    }
    const moments = new Float64Array(1 + 2 * model.fourierModes);
    const count = 4096;
    for (let i = 0; i < count; i++) {
      const u = i / count;
      const residual = evaluateHybridField(model, coefficients, u)[0]!;
      moments[0] = moments[0]! + residual / count;
      for (let mode = 1; mode <= model.fourierModes; mode++) {
        moments[2 * mode - 1] = moments[2 * mode - 1]! +
          residual * Math.cos(2 * Math.PI * mode * u) / count;
        moments[2 * mode] = moments[2 * mode]! +
          residual * Math.sin(2 * Math.PI * mode * u) / count;
      }
    }
    expect(Math.max(...Array.from(moments, Math.abs))).toBeLessThan(2e-12);
  });

  it("decodes inside the corridor and closes through fourth derivative", () => {
    const model = buildHybridPeriodicBasis(3, 17);
    const coefficients = Float64Array.from(
      { length: hybridCoefficientCount(model) },
      (_, i) => 0.4 * Math.sin(1.7 * i),
    );
    const corridor = { lower: -3, upper: 5 };
    const start = decodeBoundedHybridField(model, coefficients, 0, corridor, 4);
    const seam = decodeBoundedHybridField(model, coefficients, 1, corridor, 4);
    expect(start[0]).toBeGreaterThan(corridor.lower);
    expect(start[0]).toBeLessThan(corridor.upper);
    for (let derivative = 0; derivative <= 4; derivative++) {
      expect(seam[derivative]).toBeCloseTo(start[derivative]!, Math.max(3, 10 - derivative));
    }
  });

  it("reuses the residual projection without changing the field", () => {
    const model = buildHybridPeriodicBasis(7, 31);
    const coefficients = Float64Array.from(
      { length: hybridCoefficientCount(model) },
      (_, i) => 0.35 * Math.sin(0.73 * i) - 0.17 * Math.cos(1.11 * i),
    );
    const projection = projectHybridResidual(model, coefficients);
    for (let i = 0; i < 97; i++) {
      const u = (i + 0.37) / 97;
      expect(evaluateHybridField(model, coefficients, u, 4, projection))
        .toEqual(evaluateHybridField(model, coefficients, u, 4));
      expect(decodeBoundedHybridField(
        model, coefficients, u, { lower: -2.5, upper: 4.25 }, 4, projection,
      )).toEqual(decodeBoundedHybridField(
        model, coefficients, u, { lower: -2.5, upper: 4.25 }, 4,
      ));
    }
  });

  it("preserves the field under exact residual knot insertion", () => {
    const coarse = buildHybridPeriodicBasis(3, 13);
    const fine = buildHybridPeriodicBasis(3, 26);
    const coefficients = Float64Array.from(
      { length: hybridCoefficientCount(coarse) },
      (_, i) => 0.3 * Math.sin(0.9 * i),
    );
    const refined = remapHybridCoefficients(coarse, fine, coefficients);
    for (let i = 0; i < 100; i++) {
      const before = evaluateHybridField(coarse, coefficients, (i + 0.31) / 100, 4);
      const after = evaluateHybridField(fine, refined, (i + 0.31) / 100, 4);
      for (let derivative = 0; derivative <= 4; derivative++) {
        expect(after[derivative]).toBeCloseTo(before[derivative]!, Math.max(2, 8 - derivative));
      }
    }
  });
});

function circleRepresentation(): CurvatureRepresentation {
  const basis = buildHybridPeriodicBasis(3, 0);
  const coefficients = new Float64Array(hybridCoefficientCount(basis));
  coefficients[0] = 2 * Math.PI;
  return {
    schemaVersion: 2,
    pathLengthM: 2 * Math.PI * 20,
    winding: 1,
    basis,
    coefficients,
    correctionModes: [
      { kind: "constant" },
      { kind: "cos", harmonic: 1 },
      { kind: "sin", harmonic: 1 },
    ],
    correctionCoefficients: new Float64Array(3),
    rotationRad: 0,
    translation: [0, 0],
    seamPhase: 0,
    closureResiduals: { turn: Infinity, x: Infinity, y: Infinity, maxAbs: Infinity },
    closureIterations: 0,
    closureCondition: Infinity,
  };
}

describe("V2 curvature closure projector", () => {
  it("round-trips the complete certified curvature representation", () => {
    const projected = projectCurvatureClosure(circleRepresentation(), {
      tolerance: 1e-11,
      sampleCount: 1024,
    })!;
    projected.rotationRad = 0.25;
    projected.translation = [12, -8];
    projected.seamPhase = 0.125;
    const restored = curvatureRepresentationFromJson(
      curvatureRepresentationToJson(projected),
    );
    expect(restored.pathLengthM).toBe(projected.pathLengthM);
    expect(restored.rotationRad).toBe(projected.rotationRad);
    expect(restored.translation).toEqual(projected.translation);
    expect(restored.seamPhase).toBe(projected.seamPhase);
    expect(Array.from(restored.coefficients)).toEqual(Array.from(projected.coefficients));
    expect(Array.from(restored.correctionCoefficients))
      .toEqual(Array.from(projected.correctionCoefficients));
    expect(restored.closureResiduals).toEqual(projected.closureResiduals);
  });

  it("certifies and reconstructs a constant-curvature circle", () => {
    const projected = projectCurvatureClosure(circleRepresentation(), {
      tolerance: 1e-11,
      sampleCount: 1024,
    });
    expect(projected).not.toBeNull();
    expect(projected!.closureResiduals.maxAbs).toBeLessThan(1e-11);
    const path = reconstructCurvaturePath(projected!, 1024);
    expect(path.every(sample => Number.isFinite(sample.x) && Number.isFinite(sample.kappa))).toBe(true);
    expect(Math.max(...path.map(sample => Math.abs(sample.kappa - 1 / 20))))
      .toBeLessThan(1e-12);
  });

  it("projects a smooth local perturbation by deterministic homotopy", () => {
    const parent = projectCurvatureClosure(circleRepresentation(), { sampleCount: 1024 })!;
    const proposal = parent.coefficients.slice();
    proposal[1] = proposal[1]! + 0.3;
    proposal[4] = proposal[4]! - 0.15;
    const projected = projectCurvaturePerturbation(
      parent,
      proposal,
      parent.pathLengthM * 1.002,
      { tolerance: 1e-10, sampleCount: 1024 },
    );
    expect(projected).not.toBeNull();
    expect(projected!.closureResiduals.maxAbs).toBeLessThan(1e-10);
    const replay = projectCurvaturePerturbation(
      parent,
      proposal,
      parent.pathLengthM * 1.002,
      { tolerance: 1e-10, sampleCount: 1024 },
    );
    expect(Array.from(replay!.correctionCoefficients))
      .toEqual(Array.from(projected!.correctionCoefficients));
  });

  it("converts a feasible discovery line to the canonical curvature form", () => {
    const track = BUILT_IN_TRACKS[0]!;
    const lateralBasis = buildHybridPeriodicBasis(4, 16);
    const frames = sampleRacingLine(
      track,
      DEFAULT_VEHICLE,
      lateralBasis,
      new Float64Array(hybridCoefficientCount(lateralBasis)),
      512,
    );
    const representation = fitCurvatureRepresentation(frames, 24, 64);
    expect(representation.closureResiduals.maxAbs).toBeLessThan(1e-10);
    expect(measureCurvatureClosure(representation, 4096).maxAbs).toBeLessThan(1e-10);
    expect(representation.pathLengthM).toBeGreaterThan(0);
    const reconstructed = reconstructCurvaturePath(representation, 512);
    const rms = Math.sqrt(reconstructed.reduce((sum, sample) => {
      let nearest = Infinity;
      for (const frame of frames) {
        nearest = Math.min(nearest, (sample.x - frame.x) ** 2 + (sample.y - frame.y) ** 2);
      }
      return sum + nearest;
    }, 0) / reconstructed.length);
    expect(rms).toBeLessThan(0.5);
    const evaluation = evaluateCurvatureCandidate(
      track,
      DEFAULT_VEHICLE,
      representation,
      512,
    );
    expect(evaluation.feasible).toBe(true);
    expect(evaluation.lapTime).toBeGreaterThan(0);
    const doubled = evaluateCurvatureCandidate(track, DEFAULT_VEHICLE, representation, 1024);
    const quadrupled = evaluateCurvatureCandidate(track, DEFAULT_VEHICLE, representation, 2048);
    const converged = evaluateCurvatureCandidate(track, DEFAULT_VEHICLE, representation, 4096);
    expect(doubled.feasible && quadrupled.feasible && converged.feasible).toBe(true);
    expect(Math.abs(converged.lapTime - quadrupled.lapTime)).toBeLessThan(0.1);
    const reported: Array<{ completed: number; total: number }> = [];
    const certified = certifyCurvatureCandidate(
      track,
      DEFAULT_VEHICLE,
      representation,
      progress => reported.push(progress),
    );
    expect(certified.edgeCount).toBe(8192);
    expect(reported.map(progress => progress.completed)).toEqual(
      Array.from({ length: CURVATURE_CERTIFICATION_STAGE_COUNT + 1 }, (_, index) => index),
    );
    expect(reported.every(progress =>
      progress.total === CURVATURE_CERTIFICATION_STAGE_COUNT
    )).toBe(true);
  }, 30_000);

  it("preserves a noncenter Silver Delta discovery path", () => {
    const track = BUILT_IN_TRACKS.find(item => item.source.id === "silver-delta")!;
    const lateralBasis = buildHybridPeriodicBasis(8, 16);
    const coefficients = new Float64Array(hybridCoefficientCount(lateralBasis));
    coefficients[1] = 0.7;
    coefficients[4] = -0.45;
    coefficients[7] = 0.25;
    const source = sampleRacingLine(
      track,
      DEFAULT_VEHICLE,
      lateralBasis,
      coefficients,
      1024,
    );
    const representation = fitCurvatureRepresentation(source, 24, 64);
    const reconstructed = reconstructCurvaturePath(representation, 1024);
    const rms = Math.sqrt(reconstructed.reduce((sum, sample) => {
      let nearest = Infinity;
      for (const frame of source) {
        nearest = Math.min(nearest, (sample.x - frame.x) ** 2 + (sample.y - frame.y) ** 2);
      }
      return sum + nearest;
    }, 0) / reconstructed.length);
    expect(rms).toBeLessThan(0.5);
  });
});
