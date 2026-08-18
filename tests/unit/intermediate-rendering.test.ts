import { describe, expect, it } from "vitest";
import { LINE_COLORS } from "@/model/contracts";
import { buildDisplayList } from "@/renderer/display-list";
import { TessellationCache } from "@/renderer/ph-tessellate";
import { emptyScene } from "@/renderer/scene";

describe("optimizer intermediate rendering", () => {
  it("draws the intermediate discovery line as provisional", () => {
    const scene = emptyScene();
    scene.showCenterline = false;
    scene.provisionalBest = {
      kind: "curvature",
      pathLengthM: 8,
      samples: Float64Array.from({ length: 40 }, (_, index) => {
        const sample = Math.floor(index / 5);
        const field = index % 5;
        const angle = 2 * Math.PI * sample / 8;
        return [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 1][field]!;
      }),
    };
    const primitive = buildDisplayList(scene, 800, 600, new TessellationCache()).find(
      item => item.kind === "line" && item.color === LINE_COLORS.provisionalBest,
    );
    expect(primitive).toMatchObject({
      kind: "line",
      color: LINE_COLORS.provisionalBest,
      widthPx: 2,
      dash: [8, 6],
    });
    expect(primitive?.kind === "line" ? primitive.pts.length : 0).toBe(18);
  });
});
