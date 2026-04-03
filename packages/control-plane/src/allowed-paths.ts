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
