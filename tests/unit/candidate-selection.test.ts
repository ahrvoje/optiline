import { describe, expect, it } from "vitest";

import {
  shouldAdoptCertifiedLap,
  upsertPendingCandidate,
  type PendingCandidate,
} from "@/optimizer/candidate-selection";

interface TestCandidate extends PendingCandidate {
  id: string;
  hasV2Metadata: boolean;
}

describe("cross-representation candidate selection", () => {
  it("does not let a curvature candidate evict a faster discovery candidate", () => {
    const discovery: TestCandidate = {
      id: "discovery-fast",
      source: "discovery",
      queueKey: "discovery-final-0",
      provisionalLapTime: 31,
      hasV2Metadata: false,
    };
    const curvature: TestCandidate = {
      id: "curvature-slower",
      source: "curvature",
      queueKey: "curvature-final",
      provisionalLapTime: 32,
      hasV2Metadata: true,
    };

    const queue = upsertPendingCandidate(
      upsertPendingCandidate<TestCandidate>([], discovery),
      curvature,
    );
    expect(queue.map(candidate => candidate.id)).toEqual([
      "discovery-fast",
      "curvature-slower",
    ]);
  });

  it("retains only the fastest pending candidate within one score domain", () => {
    const first: TestCandidate = {
      id: "first",
      source: "discovery",
      queueKey: "discovery-live",
      provisionalLapTime: 32,
      hasV2Metadata: false,
    };
    const faster = { ...first, id: "faster", provisionalLapTime: 31 };
    const slower = { ...first, id: "slower", provisionalLapTime: 33 };
    let queue = upsertPendingCandidate<TestCandidate>([], first);
    queue = upsertPendingCandidate(queue, faster);
    queue = upsertPendingCandidate(queue, slower);
    expect(queue).toEqual([faster]);
  });

  it("retains separate discovery finalists for authoritative certification", () => {
    const finalists: TestCandidate[] = [31, 31.1, 31.2].map((lapTime, index) => ({
      id: `final-${index}`,
      source: "discovery",
      queueKey: `discovery-final-${index}`,
      provisionalLapTime: lapTime,
      hasV2Metadata: false,
    }));
    const queue = finalists.reduce<TestCandidate[]>(
      (pending, candidate) => upsertPendingCandidate(pending, candidate),
      [],
    );
    expect(queue).toEqual(finalists);
  });

  it("adopts certified results monotonically regardless of completion order", () => {
    let incumbent = Infinity;
    for (const completed of [32, 31, 31.5, 30.75]) {
      if (shouldAdoptCertifiedLap(completed, incumbent)) incumbent = completed;
    }
    expect(incumbent).toBe(30.75);
    expect(shouldAdoptCertifiedLap(30.7500005, incumbent)).toBe(false);
  });
});
