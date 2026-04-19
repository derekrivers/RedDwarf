import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  playbookSchema,
  type Playbook,
  type PlaybookCatalogue
} from "@reddwarf/contracts";

// Feature 187 — Task playbooks loader + label-to-playbook resolver.
//
// The catalogue is a flat directory of JSON files under playbooks/ at the
// repo root. Each file parses through `playbookSchema` so a malformed entry
// fails fast at load time rather than at intake. We use JSON in v1 so the
// runtime stays free of new dependencies; the loader is shape-agnostic and
// can swap to YAML in a future revision by changing one line.

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve the default `playbooks/` location relative to the repo root.
 *  This module lives at packages/control-plane/src/playbooks/ in source and
 *  packages/control-plane/dist/playbooks/ when compiled, so we walk up until
 *  we find a sibling `playbooks/` directory or hit the filesystem root. */
async function findDefaultPlaybooksRoot(): Promise<string | null> {
  let cursor = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const candidate = resolve(cursor, "playbooks");
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) return candidate;
    } catch {
      // not present at this level — climb one
    }
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
  return null;
}

export interface LoadPlaybooksOptions {
  /** Override the directory to scan. Defaults to the auto-discovered repo root. */
  rootDir?: string;
  /** Return a duplicate-id error instead of dropping the second entry. */
  failOnDuplicate?: boolean;
}

export interface PlaybookLoaderResult {
  rootDir: string | null;
  playbooks: PlaybookCatalogue;
  errors: Array<{ file: string; reason: string }>;
}

export async function loadPlaybooks(
  options: LoadPlaybooksOptions = {}
): Promise<PlaybookLoaderResult> {
  const rootDir =
    options.rootDir ?? (await findDefaultPlaybooksRoot());
  if (!rootDir) {
    return { rootDir: null, playbooks: [], errors: [] };
  }

  let entries: string[];
  try {
    entries = await readdir(rootDir);
  } catch {
    return { rootDir, playbooks: [], errors: [] };
  }

  const playbooks: Playbook[] = [];
  const errors: PlaybookLoaderResult["errors"] = [];
  const seen = new Set<string>();

  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    const filePath = join(rootDir, entry);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      errors.push({
        file: entry,
        reason: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      errors.push({
        file: entry,
        reason: `JSON parse error: ${error instanceof Error ? error.message : String(error)}`
      });
      continue;
    }
    const result = playbookSchema.safeParse(parsed);
    if (!result.success) {
      errors.push({
        file: entry,
        reason: `Schema validation failed: ${result.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`
      });
      continue;
    }
    if (seen.has(result.data.id)) {
      const message = `Duplicate playbook id '${result.data.id}'.`;
      errors.push({ file: entry, reason: message });
      if (options.failOnDuplicate) continue;
      continue;
    }
    seen.add(result.data.id);
    playbooks.push(result.data);
  }

  return { rootDir, playbooks, errors };
}

// ── Resolver ─────────────────────────────────────────────────────────────────
//
// Match an issue's labels (or a free-form string list) against the catalogue.
// First-match-wins keyed by alphabetic playbook id when multiple playbooks
// each have a matching label; in practice operators should give labels enough
// signal to pick one. Comparison is case-insensitive.

export function resolvePlaybookForLabels(
  catalogue: ReadonlyArray<Playbook>,
  labels: ReadonlyArray<string>
): Playbook | null {
  if (catalogue.length === 0 || labels.length === 0) return null;
  const labelSet = new Set(labels.map((l) => l.toLowerCase()));
  const matches = catalogue.filter((playbook) =>
    playbook.matchLabels.some((label) => labelSet.has(label.toLowerCase()))
  );
  if (matches.length === 0) return null;
  // Deterministic tie-break: alphabetic by id.
  matches.sort((a, b) => a.id.localeCompare(b.id));
  return matches[0]!;
}
