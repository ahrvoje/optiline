import { expect, test } from "@playwright/test";

interface AuditRecord {
  direction: "command" | "event";
  type: string;
  batches?: number;
  stage?: string;
  candidateSpace?: string;
  candidateKey?: string;
  lapTime?: number;
  provisionalLapTime?: number | null;
  genotype?: number[];
  elapsedMs?: number;
  batchLatencyMs?: unknown;
  seedLo?: number;
  seedHi?: number;
  certificatePass?: boolean;
  maxCurvatureSlope?: number;
  accelerationTotalVariation?: number;
  errorMessage?: string;
  certificateMetrics?: Record<string, number | boolean>;
}

test.skip(!process.env["OPTILINE_BENCHMARK"], "manual performance benchmark");

test("benchmarks the complete Silver Delta pipeline", async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  const forcedSeedLo = Number(process.env["OPTILINE_BENCHMARK_SEED_LO"] ?? NaN);
  const forcedSeedHi = Number(process.env["OPTILINE_BENCHMARK_SEED_HI"] ?? NaN);
  await page.addInitScript(({ seedLo, seedHi }) => {
    const records: AuditRecord[] = [];
    Object.defineProperty(window, "__optimizerAudit", { value: records });
    const NativeWorker = window.Worker;
    class AuditedWorker extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", event => {
          const value = event.data as Record<string, unknown> | null;
          if (value === null || typeof value !== "object" || typeof value["type"] !== "string") {
            return;
          }
          const genotype = value["genotype"];
          const certificate = value["certificate"] as Record<string, unknown> | undefined;
          const error = value["error"] as Record<string, unknown> | undefined;
          const profile = value["profileNodes"];
          let maxCurvatureSlope: number | undefined;
          let accelerationTotalVariation: number | undefined;
          if (profile instanceof Float64Array && profile.length >= 14) {
            maxCurvatureSlope = 0;
            accelerationTotalVariation = 0;
            const count = profile.length / 7;
            for (let i = 0; i < count; i++) {
              const next = (i + 1) % count;
              const distance = next === 0
                ? Number(value["lineLengthM"] ??
                  (profile[7 * i + 1]! + profile[8]! - profile[1]!)) - profile[7 * i + 1]!
                : profile[7 * next + 1]! - profile[7 * i + 1]!;
              maxCurvatureSlope = Math.max(maxCurvatureSlope,
                Math.abs(profile[7 * next + 5]! - profile[7 * i + 5]!) /
                Math.max(distance, 1e-9));
              accelerationTotalVariation += Math.abs(
                profile[7 * next + 4]! - profile[7 * i + 4]!,
              );
            }
          }
          records.push({
            direction: "event",
            type: value["type"],
            ...(typeof value["batches"] === "number" ? { batches: value["batches"] } : {}),
            ...(typeof value["stage"] === "string" ? { stage: value["stage"] } : {}),
            ...(typeof value["candidateSpace"] === "string"
              ? { candidateSpace: value["candidateSpace"] }
              : {}),
            ...(typeof value["candidateKey"] === "string"
              ? { candidateKey: value["candidateKey"] }
              : {}),
            ...(typeof value["lapTime"] === "number" ? { lapTime: value["lapTime"] } : {}),
            ...(typeof value["provisionalLapTime"] === "number" ||
                value["provisionalLapTime"] === null
              ? { provisionalLapTime: value["provisionalLapTime"] as number | null }
              : {}),
            ...(typeof value["elapsedMs"] === "number" ? { elapsedMs: value["elapsedMs"] } : {}),
            ...(typeof value["batchLatencyMs"] === "object"
              ? { batchLatencyMs: value["batchLatencyMs"] }
              : {}),
            ...(genotype instanceof Float64Array ? { genotype: Array.from(genotype) } : {}),
            ...(typeof certificate?.["pass"] === "boolean"
              ? { certificatePass: certificate["pass"] as boolean }
              : {}),
            ...(certificate === undefined ? {} : {
              certificateMetrics: Object.fromEntries(Object.entries(certificate).filter(
                ([, metric]) => typeof metric === "number" || typeof metric === "boolean",
              )) as Record<string, number | boolean>,
            }),
            ...(maxCurvatureSlope === undefined ? {} : { maxCurvatureSlope }),
            ...(accelerationTotalVariation === undefined ? {} : { accelerationTotalVariation }),
            ...(typeof error?.["message"] === "string" || typeof value["message"] === "string"
              ? { errorMessage: String(error?.["message"] ?? value["message"]) }
              : {}),
          });
        });
      }

      override postMessage(message: unknown, transfer?: Transferable[]): void {
        const value = message as Record<string, unknown> | null;
        if (value?.["type"] === "init" && typeof value["optimizer"] === "object" &&
            value["optimizer"] !== null && Number.isFinite(seedLo) && Number.isFinite(seedHi)) {
          const optimizer = value["optimizer"] as Record<string, unknown>;
          optimizer["seedLo"] = seedLo;
          optimizer["seedHi"] = seedHi;
        }
        records.push({
          direction: "command",
          type: typeof value?.["type"] === "string" ? value["type"] : "unknown",
          ...(typeof (value?.["optimizer"] as Record<string, unknown> | undefined)?.["seedLo"] ===
              "number"
            ? { seedLo: (value!["optimizer"] as Record<string, number>)["seedLo"] }
            : {}),
          ...(typeof (value?.["optimizer"] as Record<string, unknown> | undefined)?.["seedHi"] ===
              "number"
            ? { seedHi: (value!["optimizer"] as Record<string, number>)["seedHi"] }
            : {}),
        });
        if (transfer === undefined) super.postMessage(message);
        else super.postMessage(message, transfer);
      }
    }
    Object.defineProperty(window, "Worker", { value: AuditedWorker });
  }, { seedLo: forcedSeedLo, seedHi: forcedSeedHi });

  await page.goto("/");
  await page.locator(".track-card", { hasText: "Silver Delta" }).click();
  await expect(page.locator("#engine-status")).toContainText("Certified", { timeout: 30_000 });
  const runMode = process.env["OPTILINE_BENCHMARK_MODE"] === "random"
    ? "random"
    : "deterministic";
  await page.locator("#setting-run-mode").selectOption(runMode);
  const startIndex = await page.evaluate(() =>
    (window as unknown as { __optimizerAudit: AuditRecord[] }).__optimizerAudit.length
  );
  await page.locator("#optimize-button").click();
  const targetBatches = Number(process.env["OPTILINE_BENCHMARK_BATCHES"] ?? 8);
  await page.waitForFunction((target: number) => {
    const records = (window as unknown as { __optimizerAudit: AuditRecord[] }).__optimizerAudit;
    return records.some(record => record.type === "progress" && (record.batches ?? 0) >= target);
  }, targetBatches, { timeout: 720_000 });
  await page.locator("#optimize-button").click();
  await expect(page.locator("#engine-status")).toContainText("Stopped", { timeout: 180_000 });
  await expect(page.locator("#work-overlay")).toBeHidden({ timeout: 180_000 });

  const report = await page.evaluate((from: number) => ({
    records: (window as unknown as { __optimizerAudit: AuditRecord[] }).__optimizerAudit.slice(from),
    displayedLapTime: Number(document.querySelector("#lap-time")?.textContent?.replace("s", "")),
    status: document.querySelector("#engine-status")?.textContent ?? "",
  }), startIndex);
  await testInfo.attach("silver-delta-pipeline.json", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
  const maximumLapTime = Number(process.env["OPTILINE_BENCHMARK_MAX_SECONDS"] ?? NaN);
  if (Number.isFinite(maximumLapTime)) {
    expect(report.displayedLapTime).toBeLessThan(maximumLapTime);
  }
  const compact = process.env["OPTILINE_BENCHMARK_COMPACT"] === "1";
  const summary = {
    seed: report.records.find(record => record.type === "init" && record.seedLo !== undefined),
    displayedLapTime: report.displayedLapTime,
    status: report.status,
    progress: report.records.filter(record => record.type === "progress").map(record => ({
      batches: record.batches,
      stage: record.stage,
      provisionalLapTime: record.provisionalLapTime,
      elapsedMs: record.elapsedMs,
      batchLatencyMs: record.batchLatencyMs,
    })),
    finalists: report.records.filter(record => record.type === "provisionalBest").map(record => ({
      candidateSpace: record.candidateSpace,
      candidateKey: record.candidateKey,
      lapTime: record.lapTime,
    })),
    certified: report.records.filter(record =>
      record.direction === "event" &&
      (record.type === "certified" || record.type === "curvatureCertified")
    ).map(record => ({
      type: record.type,
      lapTime: record.lapTime,
      pass: record.certificatePass,
      maxCurvatureSlope: record.maxCurvatureSlope,
      accelerationTotalVariation: record.accelerationTotalVariation,
      certificateMetrics: record.certificateMetrics,
    })),
  };
  console.log(JSON.stringify(compact ? {
    seed: summary.seed,
    displayedLapTime: summary.displayedLapTime,
    status: summary.status,
    finalTruthLapTime: summary.progress.at(-1)?.provisionalLapTime,
    certifiedCount: summary.certified.length,
    finalCertificate: summary.certified.at(-1),
    curvatureFinalist: summary.finalists.find(record => record.candidateSpace === "curvature"),
    eventCounts: Object.fromEntries(Object.entries(report.records.reduce<Record<string, number>>(
      (counts, record) => ({ ...counts, [record.type]: (counts[record.type] ?? 0) + 1 }),
      {},
    ))),
    failures: report.records.filter(record => record.errorMessage).map(record => ({
      type: record.type,
      message: record.errorMessage,
    })),
  } : summary));
});
