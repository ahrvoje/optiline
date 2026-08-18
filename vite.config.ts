import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("./src", import.meta.url));
const publicRoot = fileURLToPath(new URL("./public", import.meta.url));

// Static build (§6.3). Cross-origin isolation headers enable
// SharedArrayBuffer for low-latency STOP and shared diagnostics; the
// production host must send the same headers.
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  root: sourceRoot,
  publicDir: publicRoot,
  base: "./",
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  assetsInclude: ["**/*.wgsl", "**/*.wasm"],
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  worker: { format: "es" },
});
