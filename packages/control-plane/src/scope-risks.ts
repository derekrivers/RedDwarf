import { findDeniedChangedFiles } from "./live-workflow.js";

const testFilePattern = /^(?:tests|test)\/.+\.(?:test|spec)\.[^/]+$/i;
const testSetupFilePattern = /^(?:tests|test)\/setup\.[^/]+$/i;
const viteConfigPattern = /^(?:vite|vitest)\.config\.[^/]+$/i;

/**
 * Parse file paths from the `## Affected Files` section of an architect handoff.
 * Strips parenthetical notes such as `(new)` and em-dash annotations so that
 * the extracted strings are bare repo-relative paths suitable for path enforcement.
 */
function normalizeArchitectAffectedPath(path: string): string {
  let normalized = path.trim();
  normalized = normalized.replace(/\s+\([^)]*\)\s*$/, "").trim();
  const emDashIndex = normalized.indexOf(" \u2014 ");
  if (emDashIndex > 0) {
    normalized = normalized.slice(0, emDashIndex).trim();
  }
  return normalized;
}

function extractArchitectAffectedPaths(hollyHandoffMarkdown: string): string[] {
  const sectionMatch = hollyHandoffMarkdown.match(
    /## Affected Files\n\n([\s\S]*?)(?:\n## |$)/
  );
  if (!sectionMatch) {
    return [];
  }

  return sectionMatch[1]!
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => normalizeArchitectAffectedPath(line.slice(2)))
    .filter((path) => path.length > 0 && !path.startsWith("#"));
}

export function detectArchitectAffectedPathViolations(
  affectedAreas: readonly string[],
  deniedPaths: readonly string[]
): string[] {
  const affectedPaths = affectedAreas
    .map((item) => normalizeArchitectAffectedPath(item))
    .filter((path) => path.length > 0 && !path.startsWith("#"));
  if (affectedPaths.length === 0) {
    return [];
  }
  return findDeniedChangedFiles(affectedPaths, [...deniedPaths]);
}

/**
 * Compare the files listed in an architect handoff against the approved allowed
 * paths. Returns any paths the architect expects to change that are not covered
 * by the approved scope. An early warning before developer dispatch avoids a
 * late AllowedPathViolationError at commit publication time.
 */
export function detectArchitectHandoffPathViolations(
  hollyHandoffMarkdown: string,
  deniedPaths: readonly string[]
): string[] {
  return detectArchitectAffectedPathViolations(
    extractArchitectAffectedPaths(hollyHandoffMarkdown),
    deniedPaths
  );
}

export function detectPreDispatchScopeRisks(
  deniedPaths: readonly string[]
): string[] {
  const hasDeniedTestFile = deniedPaths.some((path) => testFilePattern.test(path));
  const hasDeniedTestSetupFile = deniedPaths.some((path) =>
    testSetupFilePattern.test(path)
  );
  const hasDeniedViteConfig = deniedPaths.some((path) => viteConfigPattern.test(path));

  const warnings: string[] = [];

  if (hasDeniedTestFile || hasDeniedViteConfig || hasDeniedTestSetupFile) {
    warnings.push(
      "Blocked path rules include test or Vite surfaces. Double-check helper/setup file choices before dispatch so the developer does not touch a denied repo path."
    );
  }

  return warnings;
}
