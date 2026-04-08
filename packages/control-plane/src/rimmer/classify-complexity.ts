import type { ComplexityClassification } from "@reddwarf/contracts";

/**
 * Classifies the complexity of an incoming request to determine whether it
 * should enter Project Mode (medium/large) or continue through the existing
 * single-issue pipeline (small).
 *
 * The classifier uses a deterministic rubric based on observable request
 * signals rather than an LLM call, keeping intake fast and predictable.
 */
export function classifyComplexity(
  input: {
    summary: string;
    acceptanceCriteria: readonly string[];
    affectedPaths: readonly string[];
    requestedCapabilities: readonly string[];
    labels: readonly string[];
    metadata: Record<string, unknown>;
  },
  repoContext?: { packageCount?: number }
): ComplexityClassification {
  const signals: string[] = [];
  let score = 0;

  // Signal: number of affected paths
  const pathCount = input.affectedPaths.length;
  if (pathCount >= 5) {
    signals.push(`${pathCount} affected paths (>=5)`);
    score += 3;
  } else if (pathCount >= 2) {
    signals.push(`${pathCount} affected paths (2-4)`);
    score += 1;
  }

  // Signal: number of distinct packages touched (paths containing 'packages/')
  const packageDirs = new Set(
    input.affectedPaths
      .filter((p) => p.includes("packages/"))
      .map((p) => {
        const match = p.match(/packages\/([^/]+)/);
        return match ? match[1] : null;
      })
      .filter(Boolean)
  );
  if (packageDirs.size >= 5) {
    signals.push(`${packageDirs.size} packages touched (>=5)`);
    score += 3;
  } else if (packageDirs.size >= 2) {
    signals.push(`${packageDirs.size} packages touched (2-4)`);
    score += 1;
  }

  // Signal: acceptance criteria count
  const criteriaCount = input.acceptanceCriteria.length;
  if (criteriaCount >= 8) {
    signals.push(`${criteriaCount} acceptance criteria (>=8)`);
    score += 2;
  } else if (criteriaCount >= 4) {
    signals.push(`${criteriaCount} acceptance criteria (4-7)`);
    score += 1;
  }

  // Signal: sensitive capabilities requested
  const sensitiveCapabilities = ["can_modify_schema", "can_touch_sensitive_paths", "can_use_secrets"];
  const requestedSensitive = input.requestedCapabilities.filter((c) =>
    sensitiveCapabilities.includes(c)
  );
  if (requestedSensitive.length > 0) {
    signals.push(`sensitive capabilities: ${requestedSensitive.join(", ")}`);
    score += requestedSensitive.length;
  }

  // Signal: summary length and keyword indicators
  const summaryLower = input.summary.toLowerCase();
  const complexityKeywords = [
    "migration", "refactor", "cross-cutting", "multi-package",
    "integration", "new api", "new endpoint", "schema change",
    "breaking change", "new table"
  ];
  const matchedKeywords = complexityKeywords.filter((kw) => summaryLower.includes(kw));
  if (matchedKeywords.length >= 3) {
    signals.push(`complexity keywords: ${matchedKeywords.join(", ")}`);
    score += 2;
  } else if (matchedKeywords.length >= 1) {
    signals.push(`complexity keywords: ${matchedKeywords.join(", ")}`);
    score += 1;
  }

  // Signal: labels
  const projectLabels = ["project-mode", "multi-phase", "large"];
  const matchedLabels = input.labels.filter((l) =>
    projectLabels.includes(l.toLowerCase())
  );
  if (matchedLabels.length > 0) {
    signals.push(`project labels: ${matchedLabels.join(", ")}`);
    score += 2;
  }

  // Signal: repo context
  if (repoContext?.packageCount && repoContext.packageCount >= 5) {
    signals.push(`monorepo with ${repoContext.packageCount} packages`);
    // Only a contextual signal, no score bump
  }

  // Classify based on score
  let size: ComplexityClassification["size"];
  if (score >= 5) {
    size = "large";
  } else if (score >= 2) {
    size = "medium";
  } else {
    size = "small";
  }

  const reasoning = signals.length > 0
    ? `Classified as ${size} based on: ${signals.join("; ")}.`
    : `Classified as ${size}: no complexity signals detected.`;

  return { size, reasoning, signals };
}
