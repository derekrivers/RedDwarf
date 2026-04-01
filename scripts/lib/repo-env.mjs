import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __libdir = dirname(fileURLToPath(import.meta.url));

export const repoRoot = resolve(__libdir, "..", "..");
export const repoEnvPath = resolve(repoRoot, ".env");
export const repoSecretsPath = resolve(repoRoot, ".secrets");

export function parseSimpleEnvFile(content) {
  const entries = new Map();

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex < 1) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    entries.set(key, value);
  }

  return entries;
}

export async function readSimpleEnvFile(path) {
  try {
    const content = await readFile(path, "utf8");
    return parseSimpleEnvFile(content);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return new Map();
    }

    throw error;
  }
}

export async function ensureRepoSecretsFile(path = repoSecretsPath) {
  try {
    await chmod(path, 0o600);
    return path;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  await writeFile(path, "", { encoding: "utf8", mode: 0o600, flag: "wx" }).catch(
    async (error) => {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
    }
  );
  await chmod(path, 0o600).catch(() => {});
  return path;
}

export async function writeSimpleEnvFile(path, entries, options = {}) {
  const { ensureFileMode = null } = options;
  const lines = [...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
  const content = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  const tempPath = `${path}.${randomUUID()}.tmp`;

  await writeFile(tempPath, content, {
    encoding: "utf8",
    mode: ensureFileMode ?? 0o600
  });
  if (ensureFileMode !== null) {
    await chmod(tempPath, ensureFileMode);
  }
  await rename(tempPath, path);
  if (ensureFileMode !== null) {
    await chmod(path, ensureFileMode);
  }
}

export async function loadRepoEnv(options = {}) {
  const { paths = [repoEnvPath, repoSecretsPath] } = options;

  for (const path of paths) {
    const entries = await readSimpleEnvFile(path);
    for (const [key, value] of entries) {
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  }
}
