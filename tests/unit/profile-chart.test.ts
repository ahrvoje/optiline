import { describe, expect, it } from "vitest";

import { CHART_COLORS, type ProfileNodeJson } from "@/model/contracts";
import { drawProfileChart, profileTimeAtCanvasX } from "@/renderer/profile-chart";

const nodes: ProfileNodeJson[] = [
  { parameter: 0, distance: 0, time: 0, q: 1, acceleration: 0, curvature: 0, stability: 0 },
  { parameter: 16, distance: 100, time: 2, q: 1, acceleration: 0, curvature: 0, stability: 0 },
  { parameter: 32, distance: 300, time: 5, q: 1, acceleration: 0, curvature: 0, stability: 0 },
  { parameter: 48, distance: 450, time: 8, q: 1, acceleration: 0, curvature: 0, stability: 0 },
];

function canvasAt(left = 20): HTMLCanvasElement {
  return {
    getBoundingClientRect: () => ({ left, width: 1000, height: 260 }),
  } as unknown as HTMLCanvasElement;
}

describe("profile chart selection", () => {
  it("maps a click to lap time after the six independent Y axes", () => {
    const profile = { nodes, lapTime: 10, lineLength: 600 };
    // Plot begins at client x=464 and is 538 px wide for this test canvas.
    expect(profileTimeAtCanvasX(canvasAt(), profile, "time", 464)).toBeCloseTo(0);
    expect(profileTimeAtCanvasX(canvasAt(), profile, "time", 733)).toBeCloseTo(5);
    expect(profileTimeAtCanvasX(canvasAt(), profile, "time", 1002)).toBeCloseTo(10);
  });

  it("interpolates selected distance back to profile time", () => {
    const profile = {
      nodes,
      lapTime: 10,
      lineLength: 570,
      axisDistances: [0, 50, 400, 500],
      axisLength: 600,
    };
    expect(profileTimeAtCanvasX(canvasAt(), profile, "distance", 733)).toBeCloseTo(4.142857);
    expect(profileTimeAtCanvasX(canvasAt(), profile, "distance", 867.5)).toBeCloseTo(6.5);
  });

  it("draws a dotted purple zero-curvature reference", () => {
    const strokes: Array<{ color: string; dash: number[] }> = [];
    let dash: number[] = [];
    const context = {
      strokeStyle: "",
      fillStyle: "",
      lineWidth: 1,
      globalAlpha: 1,
      font: "",
      textAlign: "left",
      setTransform() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
      fillText() {}, save() {}, restore() {},
      measureText(text: string) { return { width: text.length * 7 }; },
      setLineDash(values: number[]) { dash = [...values]; },
      stroke() { strokes.push({ color: String(this.strokeStyle), dash: [...dash] }); },
    };
    const canvas = {
      width: 0,
      height: 0,
      getBoundingClientRect: () => ({ left: 0, width: 1000, height: 260 }),
      getContext: () => context,
    } as unknown as HTMLCanvasElement;
    const priorWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { devicePixelRatio: 1 },
    });
    try {
      drawProfileChart(canvas, {
        nodes: nodes.map((node, index) => ({
          ...node,
          curvature: [-0.02, -0.005, 0.01, 0.025][index]!,
        })),
        lapTime: 10,
        lineLength: 600,
      });
    } finally {
      if (priorWindow === undefined) Reflect.deleteProperty(globalThis, "window");
      else Object.defineProperty(globalThis, "window", { configurable: true, value: priorWindow });
    }
    expect(strokes).toContainEqual({ color: CHART_COLORS.curvature, dash: [3, 5] });
  });
});
