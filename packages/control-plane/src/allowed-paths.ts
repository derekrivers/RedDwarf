function normalizeRepoRelativePath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
}

export function normalizeAllowedPathEntry(value: string): string {
  const trimmed = value.trim();
  const annotatedPath = trimmed.split(/\s+—\s+/, 1)[0] ?? trimmed;
  return normalizeRepoRelativePath(annotatedPath);
}

export function normalizeAllowedPaths(values: readonly string[]): string[] {
  return [...new Set(
    values
      .map((value) => normalizeAllowedPathEntry(value))
      .filter((value) => value.length > 0)
  )];
}

export function normalizeChangedRepoPath(value: string): string {
  return normalizeRepoRelativePath(value);
}

const ignoredGeneratedRepoPathPatterns = [
  /^node_modules(?:\/|$)/i
] as const;

const manifestLockfilePairs = new Map<string, string[]>([
  ["package.json", ["package-lock.json"]],
  ["pnpm-workspace.yaml", ["pnpm-lock.yaml"]],
  ["pnpm-workspace.yml", ["pnpm-lock.yaml"]],
  ["yarn.lock", []]
]);

export function isIgnoredGeneratedRepoPath(value: string): boolean {
  const normalized = normalizeChangedRepoPath(value);
  return ignoredGeneratedRepoPathPatterns.some((pattern) => pattern.test(normalized));
}

export function expandAllowedPathsForGeneratedArtifacts(
  allowedPaths: readonly string[]
): string[] {
  const normalizedAllowedPaths = normalizeAllowedPaths(allowedPaths);
  const expanded = new Set(normalizedAllowedPaths);

  for (const allowedPath of normalizedAllowedPaths) {
    const pairedLockfiles = manifestLockfilePairs.get(allowedPath);
    if (!pairedLockfiles) {
      continue;
    }

    for (const lockfile of pairedLockfiles) {
      expanded.add(lockfile);
    }
  }

  return [...expanded];
}
