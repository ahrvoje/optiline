import { defineConfig } from "@playwright/test";

/**
 * Playwright configuration (PROJECT_SPECIFICATION.md §24.8, §24.9).
 *
 * - Runs against installed *stable* Chrome on Windows 11 via
 *   `channel: "chrome"` (§24.8). Run `npx playwright install chrome`
 *   once; it registers the installed stable browser, no download.
 * - WebGPU: stable Chrome ships WebGPU enabled on Windows, so
 *   `--enable-unsafe-webgpu` is NOT required and is deliberately not
 *   passed. The args below only make the GPU available in headless
 *   runs (ANGLE/D3D11 backend selection).
 * - The vite preview server serves the §6.3 cross-origin-isolation
 *   headers (see vite.config.ts `preview.headers`).
 * - Default viewport 1440x900 (§16.1); a dedicated 1024x700 project
 *   covers the §24.9 small-desktop captures.
 * - zoom-focus.spec.ts runs in four projects with deviceScaleFactor
 *   1, 1.25, 1.5, and 2 (§24.8 one-fifth rule at multiple DPRs).
 */

const BASE_URL = "http://localhost:4173";

const WEBGPU_ARGS = [
  "--enable-gpu",
  "--use-angle=d3d11",
];

export default defineConfig({
  testDir: "tests/e2e",
  // GPU optimization runs and IndexedDB state make parallel execution
  // unreliable on one machine; run serially.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Generous default: several specs run a real seeded optimization.
  timeout: 240_000,
  expect: {
    timeout: 15_000,
    // §24.9: the first run records baselines; later runs compare.
    // Canvas content is GPU/driver dependent, so allow a small ratio.
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    channel: "chrome",
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: { args: WEBGPU_ARGS },
  },
  webServer: {
    command: "npm run build && npm run preview",
    url: BASE_URL,
    reuseExistingServer: !process.env["CI"],
    timeout: 300_000,
  },
  projects: [
    {
      // Main functional suite at the primary desktop size (§16.1).
      // zoom-focus runs only in the DPR projects below (DPR 1 included
      // there), so it is excluded here to avoid duplication.
      name: "desktop",
      testIgnore: ["**/zoom-focus.spec.ts"],
    },
    {
      // §24.9 minimum supported desktop size, screenshots only.
      name: "desktop-small",
      use: { viewport: { width: 1024, height: 700 } },
      testMatch: ["**/visual-regression.spec.ts"],
    },
    // §24.8: repeat the one-fifth zoom measurements at DPR 1, 1.25,
    // 1.5, and 2. deviceScaleFactor is a browser-context option, so
    // each DPR is its own project.
    {
      name: "zoom-dpr-1",
      use: { deviceScaleFactor: 1 },
      testMatch: ["**/zoom-focus.spec.ts"],
    },
    {
      name: "zoom-dpr-1.25",
      use: { deviceScaleFactor: 1.25 },
      testMatch: ["**/zoom-focus.spec.ts"],
    },
    {
      name: "zoom-dpr-1.5",
      use: { deviceScaleFactor: 1.5 },
      testMatch: ["**/zoom-focus.spec.ts"],
    },
    {
      name: "zoom-dpr-2",
      use: { deviceScaleFactor: 2 },
      testMatch: ["**/zoom-focus.spec.ts"],
    },
    {
      // §24.4 WGSL conformance harness (>= 1e6 spans; long-running).
      name: "conformance",
      testDir: "tests/conformance",
      timeout: 1_800_000,
    },
  ],
});
