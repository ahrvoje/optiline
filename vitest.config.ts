import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Unit tests run in the plain "node" environment. They exercise pure
// TypeScript modules (Philox, GPU byte layouts, canonical JSON, batch
// tuner, unit conversion) and need no DOM. Web Crypto (§20.5) is
// available in Node >= 20 as globalThis.crypto.subtle, so neither jsdom
// nor happy-dom is required. Add an environment only if a future unit
// suite genuinely needs DOM APIs.
export default defineConfig({
  resolve: {
    // Mirror tsconfig.json "paths": { "@/*": ["src/*"] }.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    // Contract tests are deterministic; keep retries at zero so a flaky
    // numeric assertion is a bug, not noise.
    retry: 0,
  },
});
