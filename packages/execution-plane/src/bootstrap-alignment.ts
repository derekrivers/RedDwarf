import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  OpenClawAgentRoleDefinition,
  OpenClawBootstrapFile
} from "@reddwarf/contracts";
import { openClawBootstrapFileKinds } from "@reddwarf/contracts";

// ── Expected file-name patterns per bootstrap kind ─────────────────────────

/**
 * Map from bootstrap kind to the expected file name in the path.
 * OpenClaw resolves these by name at the workspace root.
 */
export const expectedBootstrapFileNames: Record<
  (typeof openClawBootstrapFileKinds)[number],
  string
> = {
  identity: "IDENTITY.md",
  soul: "SOUL.md",
  agents: "AGENTS.md",
  tools: "TOOLS.md",
  skill: "SKILL.md"
};

/**
 * Structural markers that OpenClaw expects to find in each bootstrap file kind.
 * Each kind has a set of regex patterns that must appear in the file content
 * to confirm it matches the expected consumption format.
 */
export const bootstrapStructuralMarkers: Record<
  (typeof openClawBootstrapFileKinds)[number],
  { label: string; pattern: RegExp }[]
> = {
  identity: [
    { label: "heading or name marker", pattern: /^#\s+.+/m },
    { label: "role declaration", pattern: /role/i }
  ],
  soul: [
    { label: "heading", pattern: /^#\s+.+/m },
    { label: "operating posture or principles", pattern: /posture|principle|purpose|temperament/i }
  ],
  agents: [
    { label: "heading", pattern: /^#\s+.+/m },
    { label: "agent roster entry", pattern: /coordinator|analyst|validator|rimmer|holly|kryten/i }
  ],
  tools: [
    { label: "heading", pattern: /^#\s+.+/m },
    { label: "tool profile reference", pattern: /tool\s*profile|sandbox|allow|deny/i }
  ],
  skill: [
    { label: "heading or frontmatter", pattern: /^(#\s+.+|---)/m },
    { label: "skill process or objective", pattern: /process|objective|skill|output/i }
  ]
};

// ── Validation result types ────────────────────────────────────────────────

export interface BootstrapFileViolation {
  agentId: string;
  kind: string;
  relativePath: string;
  message: string;
}

export interface BootstrapAlignmentResult {
  valid: boolean;
  agentId: string;
  filesChecked: number;
  violations: BootstrapFileViolation[];
}

export interface FullBootstrapAlignmentResult {
  valid: boolean;
  agents: BootstrapAlignmentResult[];
  totalViolations: number;
}

// ── Single-file validation ─────────────────────────────────────────────────

/**
 * Validate that a single bootstrap file matches the expected OpenClaw
 * consumption format for its declared kind.
 */
export function validateBootstrapFileContent(
  file: OpenClawBootstrapFile,
  content: string,
  agentId: string
): BootstrapFileViolation[] {
  const violations: BootstrapFileViolation[] = [];
  const kind = file.kind as (typeof openClawBootstrapFileKinds)[number];

  // Check filename matches expected convention
  const expectedName = expectedBootstrapFileNames[kind];
  if (expectedName && !file.relativePath.endsWith(expectedName)) {
    violations.push({
      agentId,
      kind: file.kind,
      relativePath: file.relativePath,
      message: `File path does not end with expected name "${expectedName}" for kind "${kind}".`
    });
  }

  // Check minimum content length
  if (content.trim().length < 50) {
    violations.push({
      agentId,
      kind: file.kind,
      relativePath: file.relativePath,
      message: `File content is too short (${content.trim().length} chars). Bootstrap files should have substantial content.`
    });
  }

  // Check structural markers
  const markers = bootstrapStructuralMarkers[kind];
  if (markers) {
    for (const marker of markers) {
      if (!marker.pattern.test(content)) {
        violations.push({
          agentId,
          kind: file.kind,
          relativePath: file.relativePath,
          message: `Missing expected structural marker: ${marker.label} (pattern: ${marker.pattern.source}).`
        });
      }
    }
  }

  return violations;
}

// ── Per-agent validation ───────────────────────────────────────────────────

/**
 * Validate all bootstrap files for a single agent role definition.
 * Reads each file from disk and checks format alignment.
 */
export async function validateAgentBootstrapAlignment(
  role: OpenClawAgentRoleDefinition,
  repoRoot: string
): Promise<BootstrapAlignmentResult> {
  const violations: BootstrapFileViolation[] = [];

  // Check all 5 required kinds are present
  const declaredKinds = new Set(role.bootstrapFiles.map((f) => f.kind));
  for (const requiredKind of openClawBootstrapFileKinds) {
    if (!declaredKinds.has(requiredKind)) {
      violations.push({
        agentId: role.agentId,
        kind: requiredKind,
        relativePath: "",
        message: `Missing required bootstrap file kind "${requiredKind}".`
      });
    }
  }

  // Check for duplicate kinds
  if (declaredKinds.size !== role.bootstrapFiles.length) {
    violations.push({
      agentId: role.agentId,
      kind: "all",
      relativePath: "",
      message: `Duplicate bootstrap file kinds detected. Expected ${openClawBootstrapFileKinds.length} unique kinds.`
    });
  }

  // Validate each file
  for (const file of role.bootstrapFiles) {
    const absolutePath = resolve(repoRoot, file.relativePath);

    let content: string;
    try {
      content = await readFile(absolutePath, "utf8");
    } catch {
      violations.push({
        agentId: role.agentId,
        kind: file.kind,
        relativePath: file.relativePath,
        message: `Bootstrap file not found at ${file.relativePath}.`
      });
      continue;
    }

    violations.push(
      ...validateBootstrapFileContent(file, content, role.agentId)
    );
  }

  return {
    valid: violations.length === 0,
    agentId: role.agentId,
    filesChecked: role.bootstrapFiles.length,
    violations
  };
}

// ── Full alignment validation ──────────────────────────────────────────────

/**
 * Validate bootstrap alignment for all OpenClaw agent role definitions.
 * Returns a combined result with per-agent detail.
 */
export async function validateAllBootstrapAlignment(
  roles: OpenClawAgentRoleDefinition[],
  repoRoot: string
): Promise<FullBootstrapAlignmentResult> {
  const agents = await Promise.all(
    roles.map((role) => validateAgentBootstrapAlignment(role, repoRoot))
  );

  const totalViolations = agents.reduce(
    (sum, agent) => sum + agent.violations.length,
    0
  );

  return {
    valid: totalViolations === 0,
    agents,
    totalViolations
  };
}
