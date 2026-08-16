/**
 * Tolerant export resolution for unit suites that compile against
 * modules other agents implement concurrently (src/optimizer/*,
 * src/model/fingerprint.ts).
 *
 * The module *paths* are fixed by the project plan; the export *names*
 * are not. These helpers look an export up by a list of plausible
 * names (exact first, then case-insensitive) so the assertions stay
 * contract-driven (byte sizes, known-answer vectors, canonical bytes)
 * rather than name-driven. When a required export cannot be found the
 * caller fails with a message listing the exports that do exist, which
 * is actionable for whoever owns the module.
 */

export type AnyModule = Record<string, unknown>;

export function exportNames(mod: AnyModule): string[] {
  return Object.keys(mod).sort();
}

export function findExport(mod: AnyModule, names: readonly string[]): unknown {
  for (const name of names) {
    if (name in mod && mod[name] !== undefined) return mod[name];
  }
  const lower = new Map<string, unknown>();
  for (const key of Object.keys(mod)) {
    lower.set(key.toLowerCase().replace(/[_-]/g, ""), mod[key]);
  }
  for (const name of names) {
    const hit = lower.get(name.toLowerCase().replace(/[_-]/g, ""));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

export function findFunction(
  mod: AnyModule,
  names: readonly string[],
): ((...args: never[]) => unknown) | undefined {
  const hit = findExport(mod, names);
  return typeof hit === "function"
    ? (hit as (...args: never[]) => unknown)
    : undefined;
}

export function findNumber(mod: AnyModule, names: readonly string[]): number | undefined {
  const hit = findExport(mod, names);
  return typeof hit === "number" ? hit : undefined;
}

export function findObject(
  mod: AnyModule,
  names: readonly string[],
): Record<string, unknown> | undefined {
  const hit = findExport(mod, names);
  return typeof hit === "object" && hit !== null
    ? (hit as Record<string, unknown>)
    : undefined;
}

/** All numeric values found anywhere on an object (one level deep). */
export function numericValues(obj: Record<string, unknown>): number[] {
  const out: number[] = [];
  for (const value of Object.values(obj)) {
    if (typeof value === "number") out.push(value);
    else if (typeof value === "object" && value !== null) {
      for (const inner of Object.values(value as Record<string, unknown>)) {
        if (typeof inner === "number") out.push(inner);
      }
    }
  }
  return out;
}

export function missingExportMessage(
  what: string,
  tried: readonly string[],
  mod: AnyModule,
): string {
  return (
    `Could not resolve ${what}. Tried export names [${tried.join(", ")}]. ` +
    `Module exports: [${exportNames(mod).join(", ")}]. ` +
    `Either export one of the tried names or extend the name list in the test.`
  );
}
