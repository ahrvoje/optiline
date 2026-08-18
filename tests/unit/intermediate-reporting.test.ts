import { describe, expect, it } from "vitest";
import {
  completedReportingInterval,
  INTERMEDIATE_REPORT_INTERVAL_MS,
} from "@/optimizer/intermediate-reporting";

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
});
