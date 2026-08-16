import { describe, expect, it } from "vitest";

import { DEFAULT_VEHICLE } from "@/model/contracts";
import { BUILT_IN_TRACKS } from "@/model/catalog";
import { evaluateProfile } from "@/optimizer/profile";
import {
  centerlineSpec,
  evaluateLineFrame,
  lineDistancesAtParameters,
  spanDisplacement,
  spanPreimageBezier,
  tessellateBoundary,
} from "@/renderer/ph-tessellate";

describe("built-in PH catalog", () => {
  it("contains distinct mock circuits with fixed PH topology", () => {
    expect(BUILT_IN_TRACKS).toHaveLength(6);
    expect(new Set(BUILT_IN_TRACKS.map((t) => t.source.name)).size).toBe(6);
    for (const track of BUILT_IN_TRACKS) {
      expect(track.centerPreimageControls).toHaveLength(128);
      expect(track.gatePoints).toHaveLength(64);
      expect(track.cells).toHaveLength(256);
      expect(track.source.leftWidthM).toBeGreaterThanOrEqual(8);
    }
  });

  it("keeps materially different catalog silhouettes", () => {
    const signatures = BUILT_IN_TRACKS.map(track => {
      const frames = Array.from({ length: 512 }, (_, i) =>
        evaluateLineFrame(centerlineSpec(track), 64 * i / 512),
      );
      const meanX = frames.reduce((sum, frame) => sum + frame.x, 0) / frames.length;
      const meanY = frames.reduce((sum, frame) => sum + frame.y, 0) / frames.length;
      let xx = 0, xy = 0, yy = 0;
      for (const frame of frames) {
        const x = frame.x - meanX, y = frame.y - meanY;
        xx += x * x; xy += x * y; yy += y * y;
      }
      const angle = .5 * Math.atan2(2 * xy, xx - yy);
      const minX = Math.min(...frames.map(frame => frame.x));
      const maxX = Math.max(...frames.map(frame => frame.x));
      const minY = Math.min(...frames.map(frame => frame.y));
      const maxY = Math.max(...frames.map(frame => frame.y));
      const ratio = Math.min(maxX - minX, maxY - minY) / Math.max(maxX - minX, maxY - minY);
      const occupied = new Set(frames.map(frame => {
        const x = Math.min(7, Math.floor(8 * (frame.x - minX) / Math.max(maxX - minX, 1e-9)));
        const y = Math.min(7, Math.floor(8 * (frame.y - minY) / Math.max(maxY - minY, 1e-9)));
        return 8 * y + x;
      }));
      return { angle, ratio, occupancy: [...occupied].sort((a, b) => a - b).join(",") };
    });
    expect(Math.max(...signatures.map(value => value.ratio)) - Math.min(...signatures.map(value => value.ratio))).toBeGreaterThan(.28);
    expect(new Set(signatures.map(value => value.occupancy)).size).toBe(BUILT_IN_TRACKS.length);
  });

  it("each preimage closes by exact PH displacement", () => {
    for (const track of BUILT_IN_TRACKS) {
      const spec = centerlineSpec(track);
      let dx = 0;
      let dy = 0;
      for (let j = 0; j < 128; j++) {
        const d = spanDisplacement(spanPreimageBezier(spec.preimage, j));
        dx += d[0];
        dy += d[1];
      }
      expect(Math.hypot(dx, dy)).toBeLessThan(1e-10);
    }
  });

  it("stores and renders both exact rational offsets as closed loops", () => {
    for (const track of BUILT_IN_TRACKS) {
      for (const boundary of [track.leftBoundary, track.rightBoundary]) {
        expect(boundary).toHaveLength(128);
        for (const span of boundary) {
          expect(span.h).toHaveLength(10);
          expect(span.w).toHaveLength(10);
          expect(Math.min(...span.w)).toBeGreaterThan(0);
        }
        for (let i = 0; i < boundary.length; i++) {
          const a = boundary[i]!;
          const b = boundary[(i + 1) % boundary.length]!;
          expect(a.h[9]![0] / a.w[9]!).toBeCloseTo(b.h[0]![0] / b.w[0]!, 10);
          expect(a.h[9]![1] / a.w[9]!).toBeCloseTo(b.h[0]![1] / b.w[0]!, 10);
        }
        const first = boundary[0]!;
        const last = boundary.at(-1)!;
        expect(last.h[9]![0] / last.w[9]!).toBe(first.h[0]![0] / first.w[0]!);
        expect(last.h[9]![1] / last.w[9]!).toBe(first.h[0]![1] / first.w[0]!);
        const rendered = tessellateBoundary(boundary, 0.1);
        expect(rendered.at(-2)).toBe(rendered[0]);
        expect(rendered.at(-1)).toBe(rendered[1]);
      }
    }
  });

  it("contains at least 900 degrees of opposing turn drama", () => {
    for (const track of BUILT_IN_TRACKS) {
      const spec = centerlineSpec(track);
      const frames = Array.from({ length: 1024 }, (_, i) =>
        evaluateLineFrame(spec, (64 * i) / 1024),
      );
      const curvature = frames.map(frame => frame.kappa);
      const minX = Math.min(...frames.map(frame => frame.x));
      const maxX = Math.max(...frames.map(frame => frame.x));
      const minY = Math.min(...frames.map(frame => frame.y));
      const maxY = Math.max(...frames.map(frame => frame.y));
      let absoluteTurn = 0;
      let signedTurn = 0;
      const turns: number[] = [];
      let straightLength = 0;
      let currentStraight = 0;
      for (let i = 0; i < frames.length; i++) {
        const a = frames[i]!;
        const b = frames[(i + 1) % frames.length]!;
        const angle = Math.atan2(a.tx * b.ty - a.ty * b.tx, a.tx * b.tx + a.ty * b.ty);
        const distance = Math.hypot(b.x - a.x, b.y - a.y);
        absoluteTurn += Math.abs(angle);
        signedTurn += angle;
        turns.push(angle);
        if (Math.abs(a.kappa) < 0.001) {
          currentStraight += distance;
          straightLength = Math.max(straightLength, currentStraight);
        } else currentStraight = 0;
      }
      let hairpinTurn = 0;
      for (let start = 0; start < frames.length; start++) {
        let turn = 0;
        for (let offset = 0; offset < frames.length / 4; offset++)
          turn += turns[(start + offset) % turns.length]!;
        hairpinTurn = Math.max(hairpinTurn, Math.abs(turn));
      }
      const minimum = Math.min(...curvature);
      const maximum = Math.max(...curvature);
      let peaks = 0;
      for (let i = 0; i < curvature.length; i++) {
        const before = Math.abs(curvature[(i + curvature.length - 1) % curvature.length]!);
        const value = Math.abs(curvature[i]!);
        const after = Math.abs(curvature[(i + 1) % curvature.length]!);
        if (value > before && value >= after && value > 0.004) peaks++;
      }
      expect(minimum, `${track.source.name} needs a right-hand bend`).toBeLessThan(-0.0005);
      expect(maximum, `${track.source.name} needs a left-hand bend`).toBeGreaterThan(0.0005);
      expect(peaks, `${track.source.name} needs multiple distinct corners`).toBeGreaterThanOrEqual(4);
      expect(absoluteTurn, `${track.source.name} needs 900° of total turning`).toBeGreaterThanOrEqual(5 * Math.PI);
      expect(signedTurn, `${track.source.name} must close with one net turn`).toBeCloseTo(2 * Math.PI, 8);
      expect(straightLength, `${track.source.name} needs a real straight`).toBeGreaterThan(50);
      expect(hairpinTurn, `${track.source.name} needs a hairpin sector`).toBeGreaterThan(170 * Math.PI / 180);
      const width = maxX - minX;
      const height = maxY - minY;
      expect(Math.max(width, height), `${track.source.name} must stay compact`).toBeLessThan(400);
      expect(Math.min(width, height) / Math.max(width, height), `${track.source.name} must not be circular`).toBeLessThan(0.9);
    }
  });

  it("produces finite periodic profiles with the default vehicle", () => {
    for (const track of BUILT_IN_TRACKS) {
      const profile = evaluateProfile(centerlineSpec(track), DEFAULT_VEHICLE, 128);
      expect(profile.lapTime).toBeGreaterThan(0);
      expect(Number.isFinite(profile.lapTime)).toBe(true);
      expect(profile.nodes).toHaveLength(128);
    }
  });

  it("maps profile parameters to monotone exact centerline distance", () => {
    for (const track of BUILT_IN_TRACKS) {
      const parameters = Array.from({ length: 65 }, (_, i) => i);
      const axis = lineDistancesAtParameters(centerlineSpec(track), parameters);
      expect(axis.distances[0]).toBe(0);
      expect(axis.distances.at(-1)).toBeCloseTo(axis.totalLength, 11);
      for (let i = 1; i < axis.distances.length; i++) {
        expect(axis.distances[i]).toBeGreaterThan(axis.distances[i - 1]!);
      }
    }
  });
});
