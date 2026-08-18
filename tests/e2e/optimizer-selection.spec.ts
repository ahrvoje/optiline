import { expect, test } from "@playwright/test";

interface WorkerAuditRecord {
  direction: "command" | "event";
  type: string;
  candidateSpace?: "curvature";
  lapTime?: number;
  certificatePass?: boolean;
  batches?: number;
  completed?: number;
  sequence?: number;
  seedLo?: number;
  seedHi?: number;
  atMs: number;
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
            atMs: performance.now(),
            ...(typeof value["candidateSpace"] === "string"
              ? { candidateSpace: value["candidateSpace"] as "curvature" }
              : {}),
            ...(typeof value["lapTime"] === "number" ? { lapTime: value["lapTime"] } : {}),
            ...(typeof value["batches"] === "number" ? { batches: value["batches"] } : {}),
            ...(typeof value["completed"] === "number"
              ? { completed: value["completed"] }
              : {}),
            ...(typeof value["sequence"] === "number"
              ? { sequence: value["sequence"] }
              : {}),
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
          atMs: performance.now(),
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
    return records.some(record => record.direction === "event" &&
      record.type === "liveProductCertified" && record.certificatePass === true);
  }, undefined, { timeout: 180_000 });
  const beforeStop = await page.locator("#lap-time").textContent();
  const beforeLength = await page.locator("#line-length").textContent();
  await page.locator("#optimize-button").click();
  await expect(page.locator("#engine-status")).toContainText("Stopped", { timeout: 30_000 });
  await expect(page.locator("#work-overlay")).toBeHidden({ timeout: 30_000 });
  await expect(page.locator("#lap-time")).toHaveText(beforeStop!);
  await expect(page.locator("#line-length")).toHaveText(beforeLength!);

  const audit = await page.evaluate(() =>
    (window as unknown as { __workerAudit: WorkerAuditRecord[] }).__workerAudit
  );
  expect(audit.some(record => record.direction === "event" && record.type === "discoverySnapshot"))
    .toBe(true);
  expect(audit.some(record =>
    record.direction === "command" && record.type === "prepareLiveProduct"
  )).toBe(true);
  expect(audit.some(record =>
    record.direction === "event" && record.type === "liveProductCertified" &&
    record.certificatePass === true
  )).toBe(true);
  expect(audit.some(record => record.type === "provisionalBest")).toBe(false);
  expect(audit.some(record => record.type === "certifyCurvature")).toBe(false);
  const stopAt = audit.filter(record =>
    record.direction === "command" && record.type === "stop"
  ).at(-1)!.atMs;
  const presentationProgress = audit.filter(record =>
    record.direction === "event" && record.type === "presentationProgress" &&
    record.sequence === 1
  );
  expect(presentationProgress.map(record => record.completed)).toEqual(
    Array.from({ length: 11 }, (_, index) => index),
  );
  expect(audit.some(record =>
    record.atMs >= stopAt &&
    (record.type === "prepareLiveProduct" || record.type === "liveProductCertified")
  )).toBe(false);
  const stoppedAt = audit.find(record =>
    record.direction === "event" && record.type === "stopped" && record.atMs >= stopAt
  )!.atMs;
  expect(stoppedAt - stopAt).toBeLessThan(5_000);

  const certifiedLaps = audit
    .filter(record =>
      record.direction === "event" &&
      (record.type === "centerlineCertified" || record.type === "liveProductCertified") &&
      record.certificatePass === true
    )
    .map(record => record.lapTime!)
    .filter(Number.isFinite);
  expect(certifiedLaps.length).toBeGreaterThanOrEqual(1);
  const displayedLap = Number((await page.locator("#lap-time").textContent())?.replace("s", "").trim());
  expect(Math.abs(displayedLap - Math.min(...certifiedLaps))).toBeLessThanOrEqual(0.00051);
});
