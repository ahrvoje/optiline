import { copyFile, cp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distRoot = join(projectRoot, "dist");
const rootAssets = join(projectRoot, "assets");

await rm(rootAssets, { recursive: true, force: true });
await cp(join(distRoot, "assets"), rootAssets, { recursive: true });
await copyFile(join(distRoot, "index.html"), join(projectRoot, "index.html"));
await copyFile(
  join(distRoot, "optiline_certifier.wasm"),
  join(projectRoot, "optiline_certifier.wasm"),
);
await copyFile(
  join(distRoot, "optiline_playback.wasm"),
  join(projectRoot, "optiline_playback.wasm"),
);
await writeFile(join(projectRoot, ".nojekyll"), "");

console.log("Staged GitHub Pages site in the repository root.");
