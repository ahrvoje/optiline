import { describe, expect, it } from "vitest";

import { DEFAULT_VEHICLE, type ProfileNodeJson } from "@/model/contracts";
import {
  CONSTRAINT_COLORS,
  limitingProfileConstraint,
  limitingProfileConstraints,
} from "@/optimizer/constraint-domain";

const node = (changes: Partial<ProfileNodeJson> = {}): ProfileNodeJson => ({
  parameter: 0,
  distance: 0,
  time: 0,
  q: 100,
  acceleration: 0,
  curvature: 0,
  stability: 0,
  ...changes,
});

describe("profile limiting-constraint classification", () => {
  it("keeps containment visually distinct from lateral grip", () => {
    const rgb = (hex: string): number[] => [1, 3, 5].map(offset =>
      Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
    const luminance = (hex: string): number => {
      const [r, g, b] = rgb(hex).map(channel => channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4);
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    expect(Math.abs(
      luminance(CONSTRAINT_COLORS.containment) - luminance(CONSTRAINT_COLORS.lateral),
    )).toBeGreaterThan(0.5);
  });

  it("excludes geometric containment and explicit curvature", () => {
    expect(limitingProfileConstraint(
      node({ curvature: 0.02 }),
      { ...DEFAULT_VEHICLE, kappaMax: 0.02 },
    )).toBe("none");
  });

  it("identifies the speed, acceleration, and braking envelopes", () => {
    expect(limitingProfileConstraint(
      node({ q: DEFAULT_VEHICLE.vMaxMps ** 2 }),
      DEFAULT_VEHICLE,
    )).toBe("speed");
    expect(limitingProfileConstraint(node({ q: 0, acceleration: 6 }), DEFAULT_VEHICLE))
      .toBe("acceleration");
    expect(limitingProfileConstraint(node({ q: 0, acceleration: -14 }), DEFAULT_VEHICLE))
      .toBe("braking");
  });

  it("keeps a validated speed-cap contact visible across adjacent intervals", () => {
    const qMax = DEFAULT_VEHICLE.vMaxMps ** 2;
    const domains = limitingProfileConstraints([
      node({ q: 0, acceleration: 6 }),
      node({ q: 0.997 * qMax }),
      node({ q: 0, acceleration: -14 }),
    ], DEFAULT_VEHICLE);
    expect(domains).toEqual(["speed", "speed", "braking"]);
  });

  it("does not invent a speed cap when the validated profile is below it", () => {
    const qMax = DEFAULT_VEHICLE.vMaxMps ** 2;
    expect(limitingProfileConstraints([
      node({ q: 0.98 * qMax }),
      node({ q: 0.9 * qMax }),
    ], DEFAULT_VEHICLE)).not.toContain("speed");
  });

  it("leaves an unconstrained arc neutral", () => {
    expect(limitingProfileConstraint(node(), DEFAULT_VEHICLE)).toBe("none");
  });
});
