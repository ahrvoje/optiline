import { describe, expect, it } from "vitest";
import { selectDiverseTimeArchive } from "@/optimizer/elite-archive";

describe("elite archive", () => {
  it("retains physically distinct alternatives across time bands", () => {
    const entries = [
      { lapTime: 30.01, signature: [0, 0], id: "fast" },
      { lapTime: 30.02, signature: [0.01, 0], id: "duplicate" },
      { lapTime: 30.08, signature: [1, 0], id: "same-band-alternative" },
      { lapTime: 30.31, signature: [2, 0], id: "next-band" },
      { lapTime: 30.61, signature: [3, 0], id: "third-band" },
    ];
    const selected = selectDiverseTimeArchive(entries, 4, 0.25, 2, 0.05);
    expect(selected.map(entry => entry.id)).toEqual([
      "fast", "same-band-alternative", "next-band", "third-band",
    ]);
  });
});
