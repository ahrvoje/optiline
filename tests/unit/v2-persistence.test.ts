import { describe, expect, it } from "vitest";

import { DEFAULT_VEHICLE } from "@/model/contracts";
import { validateProfileShape } from "@/persistence/import-export";

function profileWithV2() {
  const residuals = { turn: 0, x: 0, y: 0, maxAbs: 0 };
  return {
    schemaVersion: 2,
    profileId: "12345678-1234-4123-8123-123456789abc",
    name: "V2 profile",
    createdAt: "2026-08-17T00:00:00.000Z",
    trackId: "track",
    trackFingerprint: "a".repeat(64),
    vehicleSettings: { ...DEFAULT_VEHICLE },
    dynamicSettings: { seedLo: 1, seedHi: 2, deterministic: true, candidateVisibility: 8 },
    optimizerSeed: [1, 2],
    lineLengthM: 100,
    lapTimeS: 10,
    profileNodes: [{
      parameter: 0,
      distance: 0,
      time: 0,
      q: 100,
      acceleration: 0,
      curvature: 0.01,
      stability: 1,
    }],
    certificate: {},
    v2Representations: {
      discovery: {
        schemaVersion: 2,
        kernelChartId: "hash:fourier-kernel",
        kernelModeCount: 8,
        lateralFourierModes: 1,
        lateralFourierCoefficients: [0, 0, 0],
        residualControlCount: 0,
        residualCoefficients: [],
        corridor: { lowerM: -2, upperM: 2, betaSafeRad: 0.2 },
      },
      curvature: {
        schemaVersion: 2,
        pathLengthM: 100,
        winding: 1,
        fourierModes: 1,
        fourierCoefficients: [2 * Math.PI, 0, 0],
        residualControlCount: 0,
        residualCoefficients: [],
        closureModes: [
          { kind: "constant" },
          { kind: "cos", harmonic: 1 },
          { kind: "sin", harmonic: 1 },
        ],
        closureCoefficients: [0, 0, 0],
        rigidTransform: { rotationRad: 0, translationM: [0, 0] },
        seamPhase: 0,
        closureResiduals: residuals,
      },
      optimality: {
        closure: residuals,
        geometry: {
          lengthM: 100,
          maxAbsCurvature: 0.1,
          maxAbsCurvatureL: 0,
          maxAbsCurvatureLL: 0,
          minPathMetric: 100,
          minProgress: 1,
        },
        rectangle: { minimumClearanceM: 1, continuouslyBounded: true },
        dynamics: {
          minimumSpeedMps: 10,
          maximumSpeedMps: 20,
          maximumAccelerationMps2: 1,
          maximumBrakingMps2: 1,
          maximumLateralAccelerationMps2: 1,
          maximumSuperellipseUtilization: 1,
          maximumDragAccelerationMps2: 1,
          maximumDownforceMultiplier: 1,
          speedOptimalityResidual: 0,
          maxLateralJerk: 0,
          rmsLateralJerk: 0,
        },
        convergence: {
          meshLapTimesS: [10, 10, 10],
          meshLapTimeDeltaS: 0,
          bestTestedDescentS: null,
          fourierExtensionImprovementS: null,
          splineRefinementImprovementS: null,
          curvatureRefinementImprovementS: null,
        },
      },
    },
  };
}

describe("V2 persisted output", () => {
  it("preserves validated discovery, curvature, and optimality data", () => {
    const validated = validateProfileShape(profileWithV2());
    expect(validated.v2Representations?.curvature.closureResiduals.maxAbs).toBe(0);
    expect(validated.v2Representations?.discovery.lateralFourierCoefficients).toEqual([0, 0, 0]);
  });

  it("rejects a curvature correction block without a reserved turn mode", () => {
    const profile = profileWithV2();
    profile.v2Representations.curvature.closureModes[0] = { kind: "cos", harmonic: 2 };
    expect(() => validateProfileShape(profile)).toThrow(/closureModes\[0\]/);
  });

  it("rejects PH-only legacy profiles", () => {
    const profile = profileWithV2() as Record<string, unknown>;
    profile["schemaVersion"] = 1;
    delete profile["v2Representations"];
    expect(() => validateProfileShape(profile)).toThrow(/schemaVersion/);
  });
});
