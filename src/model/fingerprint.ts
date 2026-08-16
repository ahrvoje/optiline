/**
 * Canonical JSON and SHA-256 fingerprints (§20.5).
 *
 * Canonical form: UTF-8, object keys sorted by code unit, no
 * insignificant whitespace, arrays in stored order, and decimal numbers
 * serialized with the ECMAScript shortest round-tripping representation.
 * `JSON.stringify` of a finite number already IS the ECMAScript
 * shortest round-trip representation (ECMA-262 Number::toString), so it
 * is used directly for number serialization; this module only adds key
 * sorting, whitespace removal, and nonfinite rejection.
 */
import type { OptimizerSettings, TrackSourceJson, VehicleSettings } from "@/model/contracts";

export function canonicalJson(value: unknown): string {
  const parts: string[] = [];
  writeCanonical(value, parts, "$");
  return parts.join("");
}

function writeCanonical(value: unknown, out: string[], path: string): void {
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`canonicalJson: nonfinite number at ${path}`);
      }
      // ECMAScript shortest round-trip representation (see module doc).
      out.push(JSON.stringify(value));
      return;
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "object": {
      if (Array.isArray(value)) {
        out.push("[");
        for (let i = 0; i < value.length; i++) {
          if (i > 0) out.push(",");
          writeCanonical(value[i], out, `${path}[${i}]`);
        }
        out.push("]");
        return;
      }
      const keys = Object.keys(value as Record<string, unknown>).sort();
      out.push("{");
      let first = true;
      for (const key of keys) {
        const v = (value as Record<string, unknown>)[key];
        if (v === undefined) {
          throw new Error(`canonicalJson: undefined value at ${path}.${key}`);
        }
        if (!first) out.push(",");
        first = false;
        out.push(JSON.stringify(key), ":");
        writeCanonical(v, out, `${path}.${key}`);
      }
      out.push("}");
      return;
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value} at ${path}`);
  }
}

export async function sha256HexOfString(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return hex(new Uint8Array(digest));
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, "0");
  }
  return s;
}

/** Track fingerprint = SHA-256 of the canonical source record (§7.1, §20.5). */
export function trackFingerprint(source: TrackSourceJson): Promise<string> {
  return sha256HexOfString(canonicalJson(source));
}

/**
 * Settings fingerprint for the message envelope and run checkpoints.
 * Covers all vehicle/dynamics settings plus the optimizer seed and
 * deterministic flag, because a resumed run must reproduce the same
 * search (§16.4, §23.2). `candidateVisibility` is display-only and is
 * deliberately excluded so a display change never invalidates a run.
 */
export function settingsFingerprint(
  vehicle: VehicleSettings,
  optimizer: OptimizerSettings,
): Promise<string> {
  return sha256HexOfString(
    canonicalJson({
      optimizer: {
        deterministic: optimizer.deterministic,
        seedHi: optimizer.seedHi,
        seedLo: optimizer.seedLo,
      },
      vehicle,
    }),
  );
}

/**
 * Canonical string of vehicle/dynamics settings only. §16.3 marks the
 * current result `settings changed` when geometry or dynamics change;
 * optimizer-group changes (seed, determinism, visibility) do not.
 */
export function vehicleSettingsCanonical(vehicle: VehicleSettings): string {
  return canonicalJson(vehicle);
}
