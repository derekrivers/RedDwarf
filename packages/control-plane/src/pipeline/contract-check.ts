import type { Capability, PolicySnapshot } from "@reddwarf/contracts";

// Feature 184 — Deterministic pre-flight contract checks.
//
// Pure aggregation over a workspace diff that catches "obviously bad" patches
// before any LLM-backed validator burns tokens explaining why they're bad.
// Intended to fail fast and produce a structured `contract_violation` failure
// class with per-file reasons.
//
// v1 placement: this lives at SCM time as the first deterministic gate
// (right where the existing AllowedPathViolationError already runs). The
// board originally framed this as a phase between Developer and Validator,
// but the diff is materialised at SCM time today and moving it earlier would
// require persisting / re-mounting the dev's diff into the validator
// workspace. The catch happens before the PR opens either way.

export type ContractViolationKind =
  | "denied_path"
  | "dependency_mutation"
  | "schema_drift"
  | "large_file"
  | "binary_file";

export interface ContractViolation {
  kind: ContractViolationKind;
  file: string;
  reason: string;
}

export interface ContractCheckOptions {
  /** Files (relative to repo root) that the workspace has staged or modified. */
  changedFiles: readonly string[];
  /** Capabilities the operator approved for this task. */
  requestedCapabilities: readonly Capability[];
  /** Policy snapshot used for deniedPaths only — F-184 doesn't override allowed paths. */
  policySnapshot: Pick<PolicySnapshot, "deniedPaths">;
  /**
   * Per-file size in bytes. Pass an empty map (or omit) to skip size-based
   * checks; the helper does not read the filesystem itself.
   */
  fileSizes?: ReadonlyMap<string, number>;
  /** Bytes above which a file trips `large_file`. Default 1 MiB. */
  largeFileBytes?: number;
  /**
   * Repo paths whose addition or modification trips `binary_file` regardless
   * of size. Used by callers that already detected binary-ness via mime type.
   */
  binaryFiles?: readonly string[];
}

const DEPENDENCY_MUTATION_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "npm-shrinkwrap.json"
];

const SCHEMA_DRIFT_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)drizzle\/.+\.sql$/,
  /(?:^|\/)migrations?\/.+\.sql$/,
  /(?:^|\/)schema\.ts$/,
  /(?:^|\/)schema\.sql$/
];

const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "pdf",
  "zip",
  "tar",
  "gz",
  "tgz",
  "exe",
  "dll",
  "so",
  "dylib",
  "wasm",
  "node",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "mp3",
  "mp4",
  "mov",
  "avi"
]);

const DEFAULT_LARGE_FILE_BYTES = 1024 * 1024;

function isLeafName(file: string, leaf: string): boolean {
  const lower = file.toLowerCase();
  return lower === leaf || lower.endsWith(`/${leaf}`);
}

function fileExtension(file: string): string {
  const idx = file.lastIndexOf(".");
  if (idx < 0) return "";
  return file.slice(idx + 1).toLowerCase();
}

function deniedPathMatches(file: string, deniedPath: string): boolean {
  // Mirror the simple-glob semantics used elsewhere in the codebase: trailing
  // `/**` or `/*` is treated as a directory prefix, otherwise the value is
  // matched as an exact path or a directory prefix.
  const normalised = deniedPath.replace(/\/\*\*$/, "").replace(/\/\*$/, "").replace(/\/$/, "");
  if (normalised.length === 0) return false;
  if (file === normalised) return true;
  return file.startsWith(`${normalised}/`);
}

export function evaluateContractViolations(
  options: ContractCheckOptions
): ContractViolation[] {
  const violations: ContractViolation[] = [];
  const seen = new Set<string>();

  function add(violation: ContractViolation) {
    const key = `${violation.kind}:${violation.file}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push(violation);
  }

  const allowsDeps = options.requestedCapabilities.includes(
    "can_modify_dependencies"
  );
  const allowsSchema = options.requestedCapabilities.includes(
    "can_modify_schema"
  );
  const largeFileBytes = options.largeFileBytes ?? DEFAULT_LARGE_FILE_BYTES;
  const binaryFiles = new Set((options.binaryFiles ?? []).map((p) => p));
  const fileSizes = options.fileSizes ?? new Map<string, number>();

  for (const file of options.changedFiles) {
    if (!file || file.length === 0) continue;

    // Denied path — already enforced at SCM elsewhere, but mirroring it here
    // means contract-check produces a single structured violation set.
    for (const denied of options.policySnapshot.deniedPaths) {
      if (deniedPathMatches(file, denied)) {
        add({
          kind: "denied_path",
          file,
          reason: `Path matches denied pattern '${denied}'.`
        });
        break;
      }
    }

    if (
      !allowsDeps &&
      DEPENDENCY_MUTATION_FILES.some((leaf) => isLeafName(file, leaf))
    ) {
      add({
        kind: "dependency_mutation",
        file,
        reason:
          "Dependency manifest changed without 'can_modify_dependencies' capability."
      });
    }

    if (!allowsSchema && SCHEMA_DRIFT_PATTERNS.some((re) => re.test(file))) {
      add({
        kind: "schema_drift",
        file,
        reason:
          "Schema/migration file changed without 'can_modify_schema' capability."
      });
    }

    const size = fileSizes.get(file);
    if (typeof size === "number" && size > largeFileBytes) {
      add({
        kind: "large_file",
        file,
        reason: `File size ${size} bytes exceeds the ${largeFileBytes}-byte contract-check threshold.`
      });
    }

    if (
      binaryFiles.has(file) ||
      BINARY_EXTENSIONS.has(fileExtension(file))
    ) {
      add({
        kind: "binary_file",
        file,
        reason: `Binary-class file extension '.${fileExtension(file)}' is rejected by default; rebuild artifacts elsewhere.`
      });
    }
  }

  return violations;
}

export function summariseContractViolations(
  violations: readonly ContractViolation[]
): string {
  if (violations.length === 0) return "No contract violations.";
  const byKind = new Map<ContractViolationKind, number>();
  for (const v of violations) {
    byKind.set(v.kind, (byKind.get(v.kind) ?? 0) + 1);
  }
  const parts = [...byKind.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, count]) => `${count} ${kind}`);
  return `${violations.length} contract violation(s): ${parts.join(", ")}.`;
}
