/**
 * Minimal Node ambient declarations for type-checking the test configs
 * (playwright.config.ts, vitest.config.ts) without @types/node, which
 * is not in the fixed package.json dependency set.
 *
 * This file is included only by tests/tsconfig.e2e.json. DELETE it if
 * @types/node is ever added to devDependencies, because the real
 * declarations would collide with these.
 */

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

declare const process: {
  env: Record<string, string | undefined>;
};
