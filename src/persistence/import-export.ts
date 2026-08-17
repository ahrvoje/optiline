/**
 * Import/export of .opprofile.json and .optrack.json files (§16.2,
 * §20.1, §20.3, §26).
 *
 * Import policy: this module performs only the input-safety gate (size
 * limit, nesting depth, JSON well-formedness, structural shape). All
 * mathematical claims in an imported file are ignored until the
 * certifier worker revalidates them (§20.3); after a successful
 * revalidation the caller stores the canonical reserialized version.
 *
 * Error text identifies the offending field and rule and never renders
 * raw untrusted content (§26).
 */
import type {
  SavedProfileJson,
  TrackSourceJson,
  V2RepresentationsJson,
  VehicleSettings,
} from "@/model/contracts";
import { GATE_COUNT } from "@/model/contracts";

export const MAX_IMPORT_BYTES = 20 * 1024 * 1024; // 20 MiB (§26)
export const MAX_IMPORT_DEPTH = 16; // (§26)

export class ImportError extends Error {
  constructor(
    public readonly field: string,
    public readonly rule: string,
  ) {
    super(`${field}: ${rule}`);
    this.name = "ImportError";
  }
}

/** Read, size-check, parse, and depth-check one imported JSON file. */
export async function readImportedJson(file: File): Promise<unknown> {
  if (file.size > MAX_IMPORT_BYTES) {
    throw new ImportError("file", `size exceeds the 20 MiB import limit (${file.size} bytes)`);
  }
  const text = await file.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ImportError("file", "content is not well-formed JSON");
  }
  const depth = jsonDepth(value, 0);
  if (depth > MAX_IMPORT_DEPTH) {
    throw new ImportError("file", `JSON nesting depth ${depth} exceeds the limit of 16`);
  }
  return value;
}

function jsonDepth(value: unknown, current: number): number {
  if (value === null || typeof value !== "object") return current;
  let max = current + 1;
  if (Array.isArray(value)) {
    for (const item of value) max = Math.max(max, jsonDepth(item, current + 1));
  } else {
    for (const key of Object.keys(value)) {
      max = Math.max(max, jsonDepth((value as Record<string, unknown>)[key], current + 1));
    }
  }
  return max;
}

/* ------------------------------ shape validation ------------------------------ */

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ImportError(field, "must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, field: string, maxLength = 4096): string {
  const v = obj[field];
  if (typeof v !== "string") throw new ImportError(field, "must be a string");
  if (v.length > maxLength) throw new ImportError(field, `must not exceed ${maxLength} characters`);
  return v;
}

function requireFiniteNumber(obj: Record<string, unknown>, field: string): number {
  const v = obj[field];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ImportError(field, "must be a finite number");
  }
  return v;
}

function requireBoundedArray(
  obj: Record<string, unknown>,
  field: string,
  maxLength: number,
): unknown[] {
  const v = obj[field];
  if (!Array.isArray(v)) throw new ImportError(field, "must be an array");
  if (v.length > maxLength) {
    throw new ImportError(field, `array length ${v.length} exceeds the bound ${maxLength}`);
  }
  return v;
}

/**
 * Structural check of a track source file (§20.1). Unknown fields are
 * rejected. Mathematical validity (closure, offsets, corridor cells) is
 * exclusively the certifier worker's compileTrack job.
 */
export function validateTrackSourceShape(value: unknown): TrackSourceJson {
  const obj = requireObject(value, "track");
  const known = new Set([
    "schemaVersion",
    "id",
    "name",
    "description",
    "direction",
    "centerGatesM",
    "leftWidthM",
    "rightWidthM",
    "startGate",
    "tags",
    "sourceVersion",
  ]);
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) throw new ImportError(key, "unknown field is rejected (§20.1)");
  }
  if (obj["schemaVersion"] !== 1) throw new ImportError("schemaVersion", "must be 1");
  const id = requireString(obj, "id", 128);
  if (!/^[a-z0-9-]+$/.test(id)) {
    throw new ImportError("id", "must contain only lowercase letters, digits, and hyphens");
  }
  const name = requireString(obj, "name", 200);
  const description = requireString(obj, "description", 4096);
  const direction = obj["direction"];
  if (direction !== "counterclockwise" && direction !== "clockwise") {
    throw new ImportError("direction", 'must be "counterclockwise" or "clockwise"');
  }
  const gates = requireBoundedArray(obj, "centerGatesM", GATE_COUNT);
  if (gates.length !== GATE_COUNT) {
    throw new ImportError("centerGatesM", `must contain exactly ${GATE_COUNT} gate pairs`);
  }
  const centerGatesM: [number, number][] = gates.map((g, i) => {
    if (
      !Array.isArray(g) ||
      g.length !== 2 ||
      typeof g[0] !== "number" ||
      typeof g[1] !== "number" ||
      !Number.isFinite(g[0]) ||
      !Number.isFinite(g[1])
    ) {
      throw new ImportError(`centerGatesM[${i}]`, "must be a pair of finite numbers");
    }
    return [g[0], g[1]];
  });
  const leftWidthM = requireFiniteNumber(obj, "leftWidthM");
  const rightWidthM = requireFiniteNumber(obj, "rightWidthM");
  if (leftWidthM <= 0) throw new ImportError("leftWidthM", "must be positive");
  if (rightWidthM <= 0) throw new ImportError("rightWidthM", "must be positive");
  if (obj["startGate"] !== 0) throw new ImportError("startGate", "must be 0");
  const tagsRaw = requireBoundedArray(obj, "tags", 16);
  const tags = tagsRaw.map((t, i) => {
    if (typeof t !== "string" || t.length > 40) {
      throw new ImportError(`tags[${i}]`, "must be a string of at most 40 characters");
    }
    return t;
  });
  const sourceVersion = requireFiniteNumber(obj, "sourceVersion");
  if (!Number.isInteger(sourceVersion) || sourceVersion < 1) {
    throw new ImportError("sourceVersion", "must be a positive integer");
  }
  return {
    schemaVersion: 1,
    id,
    name,
    description,
    direction,
    centerGatesM,
    leftWidthM,
    rightWidthM,
    startGate: 0,
    tags,
    sourceVersion,
  };
}

/**
 * Structural check of a saved profile file (§20.3). Every stored claim
 * (lap time, certificates, nodes) remains untrusted; the certifier
 * worker recomputes all of it from the genotype before the profile is
 * accepted.
 */
export function validateProfileShape(value: unknown): SavedProfileJson {
  const obj = requireObject(value, "profile");
  if (obj["schemaVersion"] !== 1) throw new ImportError("schemaVersion", "must be 1");
  const profileId = requireString(obj, "profileId", 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(profileId)) {
    throw new ImportError("profileId", "must be a UUID v4");
  }
  const name = requireString(obj, "name", 480);
  const createdAt = requireString(obj, "createdAt", 64);
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new ImportError("createdAt", "must be an ISO-8601 date/time");
  }
  const trackId = requireString(obj, "trackId", 128);
  const trackFingerprint = requireString(obj, "trackFingerprint", 64);
  if (!/^[0-9a-f]{64}$/.test(trackFingerprint)) {
    throw new ImportError("trackFingerprint", "must be a 64-hex-digit SHA-256");
  }
  const vehicleSettings = validateVehicleShape(obj["vehicleSettings"]);
  const dyn = requireObject(obj["dynamicSettings"], "dynamicSettings");
  const seedArr = requireBoundedArray(obj, "optimizerSeed", 2);
  if (
    seedArr.length !== 2 ||
    typeof seedArr[0] !== "number" ||
    typeof seedArr[1] !== "number" ||
    !isU32(seedArr[0]) ||
    !isU32(seedArr[1])
  ) {
    throw new ImportError("optimizerSeed", "must be two u32 values");
  }
  const genotypeRaw = requireBoundedArray(obj, "genotypeD", GATE_COUNT);
  if (genotypeRaw.length !== GATE_COUNT) {
    throw new ImportError("genotypeD", `must contain exactly ${GATE_COUNT} values`);
  }
  const genotypeD = genotypeRaw.map((v, i) => {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new ImportError(`genotypeD[${i}]`, "must be a finite number");
    }
    return v;
  });
  const preRaw = requireBoundedArray(obj, "preimageControls", 128);
  if (preRaw.length !== 128) {
    throw new ImportError("preimageControls", "must contain exactly 128 complex pairs");
  }
  const preimageControls: [number, number][] = preRaw.map((p, i) => {
    if (
      !Array.isArray(p) ||
      p.length !== 2 ||
      typeof p[0] !== "number" ||
      typeof p[1] !== "number" ||
      !Number.isFinite(p[0]) ||
      !Number.isFinite(p[1])
    ) {
      throw new ImportError(`preimageControls[${i}]`, "must be a pair of finite numbers");
    }
    return [p[0], p[1]];
  });
  const lineLengthM = requireFiniteNumber(obj, "lineLengthM");
  const lapTimeS = requireFiniteNumber(obj, "lapTimeS");
  const nodesRaw = requireBoundedArray(obj, "profileNodes", 8192 + 1);
  const profileNodes = nodesRaw.map((n, i) => {
    const node = requireObject(n, `profileNodes[${i}]`);
    const fields = [
      "parameter",
      "distance",
      "time",
      "q",
      "acceleration",
      "curvature",
      "stability",
    ] as const;
    const out: Record<string, number> = {};
    for (const f of fields) {
      const v = node[f];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new ImportError(`profileNodes[${i}].${f}`, "must be a finite number");
      }
      out[f] = v;
    }
    return out as unknown as SavedProfileJson["profileNodes"][number];
  });
  const certificate = requireObject(obj["certificate"], "certificate");
  const v2Representations = obj["v2Representations"] === undefined
    ? undefined
    : validateV2Representations(obj["v2Representations"]);
  // The imported profile object is passed to the certifier worker; the
  // worker recomputes and replaces every certificate field, so only the
  // structural presence is checked here.
  return {
    schemaVersion: 1,
    profileId,
    name,
    createdAt,
    trackId,
    trackFingerprint,
    vehicleSettings,
    dynamicSettings: {
      seedLo: numberOr(dyn["seedLo"], 0),
      seedHi: numberOr(dyn["seedHi"], 0),
      deterministic: dyn["deterministic"] === true,
      candidateVisibility: numberOr(dyn["candidateVisibility"], 0),
    },
    optimizerSeed: [seedArr[0], seedArr[1]],
    genotypeD,
    preimageControls,
    lineLengthM,
    lapTimeS,
    profileNodes,
    certificate: certificate as unknown as SavedProfileJson["certificate"],
    ...(v2Representations === undefined ? {} : { v2Representations }),
  };
}

function finiteArray(value: unknown, field: string, exactLength: number): number[] {
  if (!Array.isArray(value) || value.length !== exactLength ||
      value.some(item => typeof item !== "number" || !Number.isFinite(item))) {
    throw new ImportError(field, `must contain exactly ${exactLength} finite numbers`);
  }
  return value as number[];
}

function nullableFinite(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ImportError(field, "must be null or a finite number");
  }
  return value;
}

function validateV2Representations(value: unknown): V2RepresentationsJson {
  const root = requireObject(value, "v2Representations");
  const discovery = requireObject(root["discovery"], "v2Representations.discovery");
  const curvature = requireObject(root["curvature"], "v2Representations.curvature");
  const optimality = requireObject(root["optimality"], "v2Representations.optimality");
  if (discovery["schemaVersion"] !== 2 || curvature["schemaVersion"] !== 2) {
    throw new ImportError("v2Representations.schemaVersion", "both representations must be V2");
  }
  const lateralModes = requireInteger(
    discovery,
    "lateralFourierModes",
    "v2Representations.discovery.lateralFourierModes",
    0,
    128,
  );
  const residualCount = requireInteger(
    discovery,
    "residualControlCount",
    "v2Representations.discovery.residualControlCount",
    0,
    1024,
  );
  const corridor = requireObject(
    discovery["corridor"],
    "v2Representations.discovery.corridor",
  );
  const curvatureModes = requireInteger(
    curvature,
    "fourierModes",
    "v2Representations.curvature.fourierModes",
    0,
    128,
  );
  const curvatureResidualCount = requireInteger(
    curvature,
    "residualControlCount",
    "v2Representations.curvature.residualControlCount",
    0,
    1024,
  );
  const closureModesRaw = requireBoundedArray(curvature, "closureModes", 3);
  if (closureModesRaw.length !== 3) {
    throw new ImportError("v2Representations.curvature.closureModes", "must contain three modes");
  }
  const closureModes = closureModesRaw.map((raw, index) => {
    const mode = requireObject(raw, `v2Representations.curvature.closureModes[${index}]`);
    const kind = mode["kind"];
    if (kind === "constant") return { kind: "constant" as const };
    if (kind === "cos" || kind === "sin") {
      return {
        kind: kind as "cos" | "sin",
        harmonic: requireInteger(
          mode,
          "harmonic",
          `v2Representations.curvature.closureModes[${index}].harmonic`,
          1,
          128,
        ),
      };
    }
    if (kind === "bspline") {
      return {
        kind: "bspline" as const,
        controlCount: requireInteger(
          mode,
          "controlCount",
          `v2Representations.curvature.closureModes[${index}].controlCount`,
          6,
          1024,
        ),
        index: requireInteger(
          mode,
          "index",
          `v2Representations.curvature.closureModes[${index}].index`,
          0,
          1023,
        ),
      };
    }
    throw new ImportError(
      `v2Representations.curvature.closureModes[${index}].kind`,
      "must identify a supported closure mode",
    );
  });
  if (closureModes[0]?.kind !== "constant") {
    throw new ImportError(
      "v2Representations.curvature.closureModes[0]",
      "must reserve the constant total-turn correction",
    );
  }
  for (const [index, mode] of closureModes.entries()) {
    if (mode.kind === "bspline" && mode.index >= mode.controlCount) {
      throw new ImportError(
        `v2Representations.curvature.closureModes[${index}].index`,
        "must be less than controlCount",
      );
    }
  }
  const transform = requireObject(
    curvature["rigidTransform"],
    "v2Representations.curvature.rigidTransform",
  );
  const translation = finiteArray(
    transform["translationM"],
    "v2Representations.curvature.rigidTransform.translationM",
    2,
  );
  const closure = requireObject(
    curvature["closureResiduals"],
    "v2Representations.curvature.closureResiduals",
  );
  const reportClosure = requireObject(
    optimality["closure"],
    "v2Representations.optimality.closure",
  );
  const geometry = requireObject(
    optimality["geometry"],
    "v2Representations.optimality.geometry",
  );
  const rectangle = requireObject(
    optimality["rectangle"],
    "v2Representations.optimality.rectangle",
  );
  const dynamics = requireObject(
    optimality["dynamics"],
    "v2Representations.optimality.dynamics",
  );
  const convergence = requireObject(
    optimality["convergence"],
    "v2Representations.optimality.convergence",
  );
  const residualObject = (object: Record<string, unknown>, prefix: string) => ({
    turn: finiteFrom(object, "turn", prefix),
    x: finiteFrom(object, "x", prefix),
    y: finiteFrom(object, "y", prefix),
    maxAbs: finiteFrom(object, "maxAbs", prefix),
  });
  const meshRaw = convergence["meshLapTimesS"];
  const meshLapTimesS = meshRaw === null
    ? null
    : finiteArray(meshRaw, "v2Representations.optimality.convergence.meshLapTimesS", 3) as
      [number, number, number];
  const winding = curvature["winding"];
  if (winding !== -1 && winding !== 1) {
    throw new ImportError("v2Representations.curvature.winding", "must be -1 or +1");
  }
  const lowerM = finiteFrom(corridor, "lowerM", "v2Representations.discovery.corridor");
  const upperM = finiteFrom(corridor, "upperM", "v2Representations.discovery.corridor");
  if (lowerM > upperM) {
    throw new ImportError("v2Representations.discovery.corridor", "lowerM exceeds upperM");
  }
  return {
    discovery: {
      schemaVersion: 2,
      kernelChartId: requireString(discovery, "kernelChartId", 256),
      kernelModeCount: requireInteger(
        discovery, "kernelModeCount", "v2Representations.discovery.kernelModeCount", 1, 256,
      ),
      lateralFourierModes: lateralModes,
      lateralFourierCoefficients: finiteArray(
        discovery["lateralFourierCoefficients"],
        "v2Representations.discovery.lateralFourierCoefficients",
        1 + 2 * lateralModes,
      ),
      residualControlCount: residualCount,
      residualCoefficients: finiteArray(
        discovery["residualCoefficients"],
        "v2Representations.discovery.residualCoefficients",
        residualCount,
      ),
      corridor: {
        lowerM,
        upperM,
        betaSafeRad: finiteFrom(corridor, "betaSafeRad", "v2Representations.discovery.corridor"),
      },
    },
    curvature: {
      schemaVersion: 2,
      pathLengthM: finiteFrom(curvature, "pathLengthM", "v2Representations.curvature"),
      winding,
      fourierModes: curvatureModes,
      fourierCoefficients: finiteArray(
        curvature["fourierCoefficients"],
        "v2Representations.curvature.fourierCoefficients",
        1 + 2 * curvatureModes,
      ),
      residualControlCount: curvatureResidualCount,
      residualCoefficients: finiteArray(
        curvature["residualCoefficients"],
        "v2Representations.curvature.residualCoefficients",
        curvatureResidualCount,
      ),
      closureModes,
      closureCoefficients: finiteArray(
        curvature["closureCoefficients"],
        "v2Representations.curvature.closureCoefficients",
        3,
      ),
      rigidTransform: {
        rotationRad: finiteFrom(
          transform, "rotationRad", "v2Representations.curvature.rigidTransform",
        ),
        translationM: [translation[0]!, translation[1]!],
      },
      seamPhase: finiteFrom(curvature, "seamPhase", "v2Representations.curvature"),
      closureResiduals: residualObject(closure, "v2Representations.curvature.closureResiduals"),
    },
    optimality: {
      closure: residualObject(reportClosure, "v2Representations.optimality.closure"),
      geometry: {
        lengthM: finiteFrom(geometry, "lengthM", "v2Representations.optimality.geometry"),
        maxAbsCurvature: finiteFrom(geometry, "maxAbsCurvature", "v2Representations.optimality.geometry"),
        maxAbsCurvatureL: finiteFrom(geometry, "maxAbsCurvatureL", "v2Representations.optimality.geometry"),
        maxAbsCurvatureLL: finiteFrom(geometry, "maxAbsCurvatureLL", "v2Representations.optimality.geometry"),
        minPathMetric: finiteFrom(geometry, "minPathMetric", "v2Representations.optimality.geometry"),
        minProgress: finiteFrom(geometry, "minProgress", "v2Representations.optimality.geometry"),
      },
      rectangle: {
        minimumClearanceM: finiteFrom(rectangle, "minimumClearanceM", "v2Representations.optimality.rectangle"),
        continuouslyBounded: rectangle["continuouslyBounded"] === true,
      },
      dynamics: {
        minimumSpeedMps: finiteFrom(dynamics, "minimumSpeedMps", "v2Representations.optimality.dynamics"),
        maximumSpeedMps: finiteFrom(dynamics, "maximumSpeedMps", "v2Representations.optimality.dynamics"),
        maximumAccelerationMps2: finiteFrom(dynamics, "maximumAccelerationMps2", "v2Representations.optimality.dynamics"),
        maximumBrakingMps2: finiteFrom(dynamics, "maximumBrakingMps2", "v2Representations.optimality.dynamics"),
        maximumLateralAccelerationMps2: finiteFrom(dynamics, "maximumLateralAccelerationMps2", "v2Representations.optimality.dynamics"),
        maximumSuperellipseUtilization: finiteFrom(dynamics, "maximumSuperellipseUtilization", "v2Representations.optimality.dynamics"),
        maximumDragAccelerationMps2: finiteFrom(dynamics, "maximumDragAccelerationMps2", "v2Representations.optimality.dynamics"),
        maximumDownforceMultiplier: finiteFrom(dynamics, "maximumDownforceMultiplier", "v2Representations.optimality.dynamics"),
        speedOptimalityResidual: finiteFrom(dynamics, "speedOptimalityResidual", "v2Representations.optimality.dynamics"),
        maxLateralJerk: finiteFrom(dynamics, "maxLateralJerk", "v2Representations.optimality.dynamics"),
        rmsLateralJerk: finiteFrom(dynamics, "rmsLateralJerk", "v2Representations.optimality.dynamics"),
      },
      convergence: {
        meshLapTimesS,
        meshLapTimeDeltaS: nullableFinite(convergence["meshLapTimeDeltaS"], "v2Representations.optimality.convergence.meshLapTimeDeltaS"),
        bestTestedDescentS: nullableFinite(convergence["bestTestedDescentS"], "v2Representations.optimality.convergence.bestTestedDescentS"),
        fourierExtensionImprovementS: nullableFinite(convergence["fourierExtensionImprovementS"], "v2Representations.optimality.convergence.fourierExtensionImprovementS"),
        splineRefinementImprovementS: nullableFinite(convergence["splineRefinementImprovementS"], "v2Representations.optimality.convergence.splineRefinementImprovementS"),
        curvatureRefinementImprovementS: nullableFinite(convergence["curvatureRefinementImprovementS"], "v2Representations.optimality.convergence.curvatureRefinementImprovementS"),
      },
    },
  };
}

function finiteFrom(
  object: Record<string, unknown>,
  key: string,
  prefix: string,
): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ImportError(`${prefix}.${key}`, "must be a finite number");
  }
  return value;
}

function requireInteger(
  object: Record<string, unknown>,
  key: string,
  field: string,
  minimum: number,
  maximum: number,
): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isInteger(value) ||
      value < minimum || value > maximum) {
    throw new ImportError(field, `must be an integer in [${minimum}, ${maximum}]`);
  }
  return value;
}

function validateVehicleShape(value: unknown): VehicleSettings {
  const obj = requireObject(value, "vehicleSettings");
  const numeric = [
    "massKg",
    "lengthM",
    "widthM",
    "safetyMarginM",
    "vMaxMps",
    "axPlus0",
    "axMinus0",
    "ay0",
    "ellipseP",
    "dragAreaM2",
    "downforceAreaM2",
    "airDensity",
  ] as const;
  const out: Partial<Record<string, number>> = {};
  for (const f of numeric) {
    const v = obj[f];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new ImportError(`vehicleSettings.${f}`, "must be a finite number");
    }
    out[f] = v;
  }
  const kappa = obj["kappaMax"];
  if (kappa !== null && (typeof kappa !== "number" || !Number.isFinite(kappa))) {
    throw new ImportError("vehicleSettings.kappaMax", "must be null or a finite number");
  }
  return {
    massKg: out["massKg"]!,
    lengthM: out["lengthM"]!,
    widthM: out["widthM"]!,
    safetyMarginM: out["safetyMarginM"]!,
    vMaxMps: out["vMaxMps"]!,
    axPlus0: out["axPlus0"]!,
    axMinus0: out["axMinus0"]!,
    ay0: out["ay0"]!,
    ellipseP: out["ellipseP"]!,
    dragAreaM2: out["dragAreaM2"]!,
    downforceAreaM2: out["downforceAreaM2"]!,
    airDensity: out["airDensity"]!,
    kappaMax: kappa,
  };
}

function isU32(v: number): boolean {
  return Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/* ----------------------------------- export ----------------------------------- */

function download(fileName: string, json: string): void {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function safeFileStem(name: string): string {
  const stem = name.replace(/[^\p{L}\p{N} _.-]/gu, "_").slice(0, 80).trim();
  return stem.length > 0 ? stem : "export";
}

export function exportProfile(profile: SavedProfileJson): void {
  download(`${safeFileStem(profile.name)}.opprofile.json`, JSON.stringify(profile, null, 2));
}

export function exportTrackSource(source: TrackSourceJson): void {
  download(`${safeFileStem(source.name)}.optrack.json`, JSON.stringify(source, null, 2));
}

/** Open a file picker; resolves null when the user cancels. */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}
