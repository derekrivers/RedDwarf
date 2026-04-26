/**
 * M25 F-191 — GitHub Actions workflow surveyor.
 *
 * Walks `.github/workflows/*.{yml,yaml}` in the target repo, extracts the
 * top-level `jobs.<id>` keys (and any `name:` overrides), and returns the
 * unique set of check names that GitHub Checks will report on a PR head SHA.
 *
 * The auto-merge evaluator (F-194) reads this list (frozen on the
 * RequiredCheckContract at planning time) to decide whether "build green"
 * is meaningful. The surveyor is deterministic and never asks the LLM —
 * Holly is forbidden to invent check names.
 *
 * Parser is a small subset of YAML (key: value, nested blocks, hyphen
 * lists). It handles the shapes seen in practice on GitHub Actions
 * workflow files. Anything unparseable is silently dropped — if a workflow
 * file is so weird that the surveyor can't read it, the contract will be
 * empty and the PR falls back to human review, which is the safe default.
 */

export interface WorkflowFileContent {
  /** Path relative to repo root, e.g. `.github/workflows/ci.yml`. */
  path: string;
  /** Raw YAML contents of the workflow file. */
  content: string;
}

export interface WorkflowSurveyAdapter {
  /**
   * Lists every `.github/workflows/*.yml` (and `.yaml`) file in the repo,
   * returning each path and content. Returns `[]` if the directory does
   * not exist. Callers should treat any thrown error as "survey failed";
   * the surveyor wraps this in best-effort handling.
   */
  listWorkflowYamlFiles(repo: string): Promise<WorkflowFileContent[]>;
}

export interface WorkflowSurvey {
  /** Sorted, deduplicated job names that produce GitHub check_runs on a PR. */
  checkNames: string[];
  /** Workflow filenames the surveyor parsed (for evidence/audit). */
  workflowFiles: string[];
  /** True when no workflow files were found at all. F-192 reads this. */
  hasNoWorkflows: boolean;
}

/**
 * Parse a workflow YAML file and return the job names it would produce as
 * GitHub Checks. We extract:
 *   - top-level `jobs:` block
 *   - each immediate child key (the job id)
 *   - if the job has a `name:` override one indent deeper, prefer that
 *
 * GitHub reports the check name as the job's display name when set, or the
 * job id otherwise. Matrix expansions are ignored (they add suffixes at
 * runtime; the static name is the prefix the merge gate matches against).
 */
export function parseWorkflowJobNames(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const names: string[] = [];

  let inJobsBlock = false;
  let jobsIndent: number | null = null;
  let currentJobId: string | null = null;
  let currentJobIndent: number | null = null;
  let currentJobName: string | null = null;

  const flushJob = (): void => {
    if (currentJobId !== null) {
      names.push(currentJobName ?? currentJobId);
      currentJobId = null;
      currentJobName = null;
      currentJobIndent = null;
    }
  };

  for (const rawLine of lines) {
    // Strip comments (treat `#` outside strings as a comment start; we
    // don't bother with quoted-string awareness since workflow files
    // rarely embed `#` in keys).
    const commentStripped = rawLine.replace(/\s+#.*$/, "");
    if (commentStripped.trim().length === 0) continue;

    const indent = commentStripped.match(/^( *)/)?.[1]?.length ?? 0;
    const trimmed = commentStripped.trim();

    if (!inJobsBlock) {
      // Look for the top-level `jobs:` key (indent 0).
      if (indent === 0 && /^jobs\s*:\s*$/.test(trimmed)) {
        inJobsBlock = true;
        jobsIndent = 0;
      }
      continue;
    }

    // Inside the jobs block. A line with indent <= jobsIndent ends it.
    if (indent <= (jobsIndent ?? 0)) {
      flushJob();
      inJobsBlock = false;
      jobsIndent = null;
      // Re-evaluate this line at the top level — could be another `jobs:`
      // (rare, but allowed) or unrelated key.
      if (indent === 0 && /^jobs\s*:\s*$/.test(trimmed)) {
        inJobsBlock = true;
        jobsIndent = 0;
      }
      continue;
    }

    // Job ID: a key one indent step inside the jobs block, ending in `:`.
    // We treat the first child indent we see as the job-id indent.
    if (currentJobIndent === null || indent === currentJobIndent) {
      const jobIdMatch = /^([a-zA-Z0-9_\-]+)\s*:\s*$/.exec(trimmed);
      if (jobIdMatch && jobIdMatch[1]) {
        flushJob();
        currentJobId = jobIdMatch[1];
        currentJobIndent = indent;
        continue;
      }
    }

    // Name override one indent deeper than the job id.
    if (
      currentJobId !== null &&
      currentJobIndent !== null &&
      indent > currentJobIndent
    ) {
      const nameMatch = /^name\s*:\s*(.+)$/.exec(trimmed);
      if (nameMatch && nameMatch[1]) {
        // Strip surrounding quotes, if any.
        const raw = nameMatch[1].trim();
        const stripped = /^(['"])(.*)\1$/.exec(raw);
        currentJobName = stripped ? stripped[2]! : raw;
      }
    }
  }

  // Final job at EOF.
  flushJob();

  // Dedup + stable sort so the contract is deterministic across runs.
  return Array.from(new Set(names)).sort();
}

/**
 * Survey every workflow file the adapter can find and return the unique
 * set of check names the gate (F-194) will require to be green.
 */
export async function surveyWorkflowFiles(
  adapter: WorkflowSurveyAdapter,
  repo: string
): Promise<WorkflowSurvey> {
  let files: WorkflowFileContent[];
  try {
    files = await adapter.listWorkflowYamlFiles(repo);
  } catch {
    // Best-effort: a survey failure is treated like "no workflows" so the
    // contract ends up empty and the auto-merge gate falls back to human
    // review. F-192's CI scaffold installer also looks at this signal.
    return { checkNames: [], workflowFiles: [], hasNoWorkflows: true };
  }

  const checkNames = new Set<string>();
  const workflowFiles: string[] = [];
  for (const file of files) {
    workflowFiles.push(file.path);
    for (const name of parseWorkflowJobNames(file.content)) {
      checkNames.add(name);
    }
  }

  return {
    checkNames: Array.from(checkNames).sort(),
    workflowFiles: workflowFiles.sort(),
    hasNoWorkflows: files.length === 0
  };
}

/**
 * Build a RequiredCheckContract from a workflow survey. Returns `null`
 * when the survey produced no check names — the auto-merge evaluator
 * (F-194) treats `null` as "ineligible for auto-merge" and falls back to
 * human review.
 *
 * Defaults `forbidSkipCi` and `forbidEmptyTestDiff` to true; operators or
 * later features (F-198 halt) can opt out per-ticket.
 */
export function buildRequiredCheckContractFromSurvey(
  survey: WorkflowSurvey
): {
  requiredCheckNames: string[];
  minimumCheckCount: number;
  forbidSkipCi: boolean;
  forbidEmptyTestDiff: boolean;
  rationale: string;
} | null {
  if (survey.checkNames.length === 0) {
    return null;
  }
  return {
    requiredCheckNames: [...survey.checkNames],
    minimumCheckCount: survey.checkNames.length,
    forbidSkipCi: true,
    forbidEmptyTestDiff: true,
    rationale: `Surveyed from ${survey.workflowFiles.length} workflow file(s): ${survey.workflowFiles.join(", ")}`
  };
}

/** In-memory adapter used by tests and by callers that already have file contents in hand. */
export class FixtureWorkflowSurveyAdapter implements WorkflowSurveyAdapter {
  constructor(private readonly files: Map<string, WorkflowFileContent[]>) {}

  async listWorkflowYamlFiles(repo: string): Promise<WorkflowFileContent[]> {
    return this.files.get(repo) ?? [];
  }
}
