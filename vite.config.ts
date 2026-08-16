import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Static build (§6.3). Cross-origin isolation headers enable
// SharedArrayBuffer for low-latency STOP and shared diagnostics; the
// production host must send the same headers.
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  base: "./",
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  assetsInclude: ["**/*.wgsl", "**/*.wasm"],
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  build: {
    target: "es2022",
    sourcemap: true,
    assetsInlineLimit: 0,
  },
  worker: { format: "es" },
});
