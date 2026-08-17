import { expect, test } from "@playwright/test";

interface WorkerAuditRecord {
  direction: "command" | "event";
  type: string;
  candidateSpace?: "discovery" | "curvature";
  lapTime?: number;
  certificatePass?: boolean;
  batches?: number;
  seedLo?: number;
  seedHi?: number;
}

test("certifies optimizer finalists and displays the fastest result", async ({ page }) => {
  await page.addInitScript(() => {
    const records: WorkerAuditRecord[] = [];
    Object.defineProperty(window, "__workerAudit", { value: records });
    const NativeWorker = window.Worker;
    class AuditedWorker extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", event => {
          const value = event.data as Record<string, unknown> | null;
          if (value === null || typeof value !== "object" || typeof value["type"] !== "string") {
            return;
          }
          records.push({
            direction: "event",
            type: value["type"],
            ...(typeof value["candidateSpace"] === "string"
              ? { candidateSpace: value["candidateSpace"] as "discovery" | "curvature" }
              : {}),
            ...(typeof value["lapTime"] === "number" ? { lapTime: value["lapTime"] } : {}),
            ...(typeof value["batches"] === "number" ? { batches: value["batches"] } : {}),
            ...(typeof (value["certificate"] as Record<string, unknown> | undefined)?.["pass"] ===
              "boolean"
              ? {
                  certificatePass: (value["certificate"] as Record<string, unknown>)["pass"] as
                    boolean,
                }
              : {}),
          });
        });
      }

      override postMessage(message: unknown, transfer?: Transferable[]): void {
        const value = message as Record<string, unknown> | null;
        records.push({
          direction: "command",
          type: typeof value?.["type"] === "string" ? value["type"] : "unknown",
          ...(typeof value?.["optimizer"] === "object" && value["optimizer"] !== null
            ? {
                seedLo: (value["optimizer"] as Record<string, number>)["seedLo"],
                seedHi: (value["optimizer"] as Record<string, number>)["seedHi"],
              }
            : {}),
        });
        if (transfer === undefined) super.postMessage(message);
        else super.postMessage(message, transfer);
      }
    }
    Object.defineProperty(window, "Worker", { value: AuditedWorker });
  });

  await page.goto("/");
  await expect(page.locator("#engine-status")).toContainText("Certified", { timeout: 30_000 });
  await page.locator("#optimize-button").click();
  await page.waitForFunction(() => {
    const records = (window as unknown as { __workerAudit: WorkerAuditRecord[] }).__workerAudit;
    return records.some(record =>
      record.direction === "event" && record.type === "progress" && (record.batches ?? 0) >= 2
    );
  });
  await page.locator("#optimize-button").click();
  await expect(page.locator("#engine-status")).toContainText("Stopped", { timeout: 60_000 });
  await expect(page.locator("#work-overlay")).toBeHidden();

  const audit = await page.evaluate(() =>
    (window as unknown as { __workerAudit: WorkerAuditRecord[] }).__workerAudit
  );
  const finalists = audit.filter(record =>
    record.direction === "event" && record.type === "provisionalBest"
  );
  const spaces = new Set(finalists.map(record => record.candidateSpace));
  expect(spaces.has("discovery")).toBe(true);
  expect(audit.some(record => record.direction === "command" && record.type === "polishCandidate"))
    .toBe(false);

  const certifiedLaps = audit
    .filter(record =>
      record.direction === "event" &&
      (record.type === "certified" || record.type === "curvatureCertified") &&
      record.certificatePass === true
    )
    .map(record => record.lapTime!)
    .filter(Number.isFinite);
  expect(certifiedLaps.length).toBeGreaterThanOrEqual(3);
  const displayedLap = Number((await page.locator("#lap-time").textContent())?.replace("s", "").trim());
  expect(Math.abs(displayedLap - Math.min(...certifiedLaps))).toBeLessThanOrEqual(0.00051);
});
