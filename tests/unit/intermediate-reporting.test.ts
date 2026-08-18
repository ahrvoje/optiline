import { describe, expect, it } from "vitest";
import {
  buildIntermediatePreview,
  completedReportingInterval,
  INTERMEDIATE_REPORT_INTERVAL_MS,
} from "@/optimizer/intermediate-reporting";
import { DEFAULT_VEHICLE } from "@/model/contracts";
import type { CandidateEvaluation } from "@/optimizer/minimum-lap";

describe("optimizer intermediate reporting", () => {
  it("advances only after each complete 30-second interval", () => {
    expect(completedReportingInterval(INTERMEDIATE_REPORT_INTERVAL_MS - 1)).toBe(0);
    expect(completedReportingInterval(INTERMEDIATE_REPORT_INTERVAL_MS)).toBe(1);
    expect(completedReportingInterval(2 * INTERMEDIATE_REPORT_INTERVAL_MS + 123)).toBe(2);
  });

  it("rejects invalid elapsed times", () => {
    expect(() => completedReportingInterval(-1)).toThrow(RangeError);
    expect(() => completedReportingInterval(Infinity)).toThrow(RangeError);
  });

  it("builds a time-consistent uniform-distance profile", () => {
    const count = 16;
    const radius = 10;
    const length = 2 * Math.PI * radius;
    const score = {
      feasible: true,
      violation: 0,
      lapTime: length / 10,
      proxyTime: length / 10,
      regularizer: 0,
      lapLengthM: length,
      minClearanceM: 1,
      minPathMetric: length,
      minProgress: 1,
      maxAbsCurvature: 1 / radius,
      maxAbsCurvatureL: 0,
      maxAbsCurvatureLL: 0,
      maxLateralJerk: 0,
      rmsLateralJerk: 0,
      speedOptimalityResidual: 0,
      speedSquared: Float64Array.from({ length: count }, () => 100),
      distances: Float64Array.from({ length: count }, () => length / count),
      frames: Array.from({ length: count }, (_, i) => {
        const angle = 2 * Math.PI * i / count;
        return {
          u: i / count,
          x: radius * Math.cos(angle),
          y: radius * Math.sin(angle),
          tx: -Math.sin(angle),
          ty: Math.cos(angle),
          q: length,
          d: 0,
          kappa: 1 / radius,
          kappaL: 0,
          kappaLL: 0,
          progress: 1,
          relativeYaw: 0,
          clearanceM: 1,
        };
      }),
    } satisfies CandidateEvaluation;
    const preview = buildIntermediatePreview(score, DEFAULT_VEHICLE, 32);
    expect(preview.lineLengthM).toBeCloseTo(length, 12);
    expect(preview.lapTime).toBeCloseTo(length / 10, 12);
    expect(preview.profileNodes).toHaveLength(32);
    expect(preview.pathSamples).toHaveLength(160);
    expect(Math.max(...preview.profileNodes.map(node => Math.abs(node.q - 100)))).toBeLessThan(1e-12);
  });
});
