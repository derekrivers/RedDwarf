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

export function normalizeDeniedPaths(values: readonly string[]): string[] {
  return normalizeAllowedPaths(values);
}

export function normalizeChangedRepoPath(value: string): string {
  return normalizeRepoRelativePath(value);
}

const defaultDeniedRepoPaths = [
  ".git/**",
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  ".secrets",
  "**/.secrets",
  "runtime-data/**"
] as const;

const ignoredGeneratedRepoPathPatterns = [
  /^node_modules(?:\/|$)/i
] as const;

const manifestLockfilePairs = new Map<string, string[]>([
  ["package.json", ["package-lock.json", ".gitignore"]],
  ["pnpm-workspace.yaml", ["pnpm-lock.yaml"]],
  ["pnpm-workspace.yml", ["pnpm-lock.yaml"]],
  ["yarn.lock", []]
]);

// tsconfig.json at any path implies its sub-tsconfig variants are also needed.
const tsConfigSubPattern = "tsconfig.*.json";

// vite.config.* and vitest.config.* are always deployment companions; Vite
// also needs index.html as the entry point HTML shell.
const viteConfigPattern = /^(.*\/)?vite\.config\.[^/]+$/;
const vitestConfigPattern = /^(.*\/)?vitest\.config\.[^/]+$/;

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
    // Manifest → lockfile companions (package.json, pnpm-workspace, etc.)
    const pairedLockfiles = manifestLockfilePairs.get(allowedPath);
    if (pairedLockfiles) {
      for (const lockfile of pairedLockfiles) {
        expanded.add(lockfile);
      }
    }

    // tsconfig.json at any depth → tsconfig.*.json sub-configs at the same level.
    // Matches both root-level "tsconfig.json" and package-rooted "packages/foo/tsconfig.json".
    if (allowedPath === "tsconfig.json" || allowedPath.endsWith("/tsconfig.json")) {
      const prefix = allowedPath.slice(0, allowedPath.lastIndexOf("tsconfig.json"));
      expanded.add(`${prefix}${tsConfigSubPattern}`);
    }

    // vite.config.* → vitest.config.* companion and index.html entry shell.
    const viteMatch = viteConfigPattern.exec(allowedPath);
    if (viteMatch) {
      const prefix = viteMatch[1] ?? "";
      expanded.add(`${prefix}vitest.config.*`);
      expanded.add(`${prefix}index.html`);
    }

    // vitest.config.* → vite.config.* companion (the two always ship together).
    const vitestMatch = vitestConfigPattern.exec(allowedPath);
    if (vitestMatch) {
      const prefix = vitestMatch[1] ?? "";
      expanded.add(`${prefix}vite.config.*`);
    }
  }

  return [...expanded];
}

export function createDefaultDeniedPaths(): string[] {
  return [...defaultDeniedRepoPaths];
}
