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
/**
 * Manual comment-stripping. Linear-time. Replaces a regex like `\s+#.*$`
 * which CodeQL flags for polynomial backtracking on adversarial input
 * (long whitespace runs with no `#`). YAML treats `#` as a comment when
 * it's at the start of the line OR preceded by whitespace; everything
 * after the comment marker through end-of-line is dropped, plus any
 * trailing whitespace before the marker.
 */
function stripTrailingComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      // Walk back over the whitespace immediately preceding the marker.
      let end = i;
      while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) {
        end -= 1;
      }
      return line.slice(0, end);
    }
  }
  return line;
}

// Bounded whitespace patterns — CodeQL accepts {n,m} as non-polynomial.
// 32 is well above any sane YAML indentation / spacing in a workflow file.
const WS_OPT = "[ \\t]{0,32}";
const WS_REQ = "[ \\t]{1,32}";

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
    const commentStripped = stripTrailingComment(rawLine);
    if (commentStripped.trim().length === 0) continue;

    const indent = commentStripped.match(/^( *)/)?.[1]?.length ?? 0;
    const trimmed = commentStripped.trim();

    if (!inJobsBlock) {
      // Look for the top-level `jobs:` key (indent 0).
      if (indent === 0 && new RegExp(`^jobs${WS_OPT}:${WS_OPT}$`).test(trimmed)) {
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
      if (indent === 0 && new RegExp(`^jobs${WS_OPT}:${WS_OPT}$`).test(trimmed)) {
        inJobsBlock = true;
        jobsIndent = 0;
      }
      continue;
    }

    // Job ID: a key one indent step inside the jobs block, ending in `:`.
    // We treat the first child indent we see as the job-id indent.
    if (currentJobIndent === null || indent === currentJobIndent) {
      const jobIdMatch = new RegExp(`^([a-zA-Z0-9_\\-]+)${WS_OPT}:${WS_OPT}$`).exec(trimmed);
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
      const nameMatch = new RegExp(`^name${WS_OPT}:${WS_OPT}(.+)$`).exec(trimmed);
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
 * Inspect a workflow YAML file's `on:` block and decide whether the
 * workflow would fire on a freshly-opened (or pushed-to) pull request.
 * The auto-merge evaluator only ever sees check_runs from workflows
 * that produce checks at PR-open / PR-update time — workflows that
 * fire only on `pull_request: closed` (e.g. RedDwarf's own
 * reddwarf-advance.yml) or schedule-only or workflow_dispatch-only
 * would otherwise be picked up as required checks and the gate would
 * wait forever for a check that never produces a check_run on the open
 * PR.
 *
 * Returns true when:
 *   - `on: push` is present (PR head pushes fire it), OR
 *   - `on: pull_request` is present with NO `types:` filter, OR
 *   - `on: pull_request` is present with a `types:` filter that
 *     includes one of `opened`, `synchronize`, or `reopened`.
 *
 * Returns false otherwise (closed-only, schedule-only, dispatch-only,
 * unparseable, or no `on:` block at all).
 */
export function workflowFiresOnPullRequestOpen(yaml: string): boolean {
  const lines = yaml.split(/\r?\n/);

  let inOnBlock = false;
  let onIndent = -1;
  let inPullRequest = false;
  let pullRequestIndent = -1;
  let inTypes = false;
  let typesIndent = -1;
  let pullRequestHasTypes = false;
  let pullRequestTypesAllowOpen = false;
  let hasPush = false;
  let hasPullRequest = false;

  const ALLOWED_PR_TYPES = new Set(["opened", "synchronize", "reopened"]);

  for (const rawLine of lines) {
    const commentStripped = stripTrailingComment(rawLine);
    if (commentStripped.trim().length === 0) continue;
    const indent = commentStripped.match(/^( *)/)?.[1]?.length ?? 0;
    const trimmed = commentStripped.trim();

    if (!inOnBlock) {
      // `on: push` or `on: pull_request` shorthand at top level.
      const onShorthand = new RegExp(`^on${WS_OPT}:${WS_OPT}(.+)$`).exec(trimmed);
      if (indent === 0 && onShorthand && onShorthand[1] && onShorthand[1] !== "") {
        const value = onShorthand[1].trim();
        // Could be `on: push` or `on: [push, pull_request]`.
        if (/\bpush\b/.test(value)) hasPush = true;
        if (/\bpull_request\b/.test(value)) {
          // Inline pull_request = no types filter = fires on open.
          hasPullRequest = true;
          pullRequestTypesAllowOpen = true;
        }
        continue;
      }
      if (indent === 0 && new RegExp(`^on${WS_OPT}:${WS_OPT}$`).test(trimmed)) {
        inOnBlock = true;
        onIndent = 0;
      }
      continue;
    }

    // Inside the `on:` block.
    if (indent <= onIndent) {
      // Block ended. Re-evaluate this line at the top level.
      inOnBlock = false;
      inPullRequest = false;
      inTypes = false;
      const onShorthand = new RegExp(`^on${WS_OPT}:${WS_OPT}(.+)$`).exec(trimmed);
      if (indent === 0 && onShorthand && onShorthand[1]) {
        const value = onShorthand[1].trim();
        if (/\bpush\b/.test(value)) hasPush = true;
        if (/\bpull_request\b/.test(value)) {
          hasPullRequest = true;
          pullRequestTypesAllowOpen = true;
        }
      }
      continue;
    }

    // First-level child of `on:`.
    if (pullRequestIndent === -1 || indent === pullRequestIndent) {
      if (new RegExp(`^push${WS_OPT}:${WS_OPT}$`).test(trimmed) || new RegExp(`^push${WS_OPT}:`).test(trimmed)) {
        hasPush = true;
        inPullRequest = false;
        inTypes = false;
        continue;
      }
      if (new RegExp(`^pull_request${WS_OPT}:${WS_OPT}$`).test(trimmed)) {
        hasPullRequest = true;
        inPullRequest = true;
        pullRequestIndent = indent;
        pullRequestHasTypes = false;
        pullRequestTypesAllowOpen = false;
        inTypes = false;
        continue;
      }
      const prInline = new RegExp(`^pull_request${WS_OPT}:${WS_OPT}\\[([^\\]]*)\\]${WS_OPT}$`).exec(trimmed);
      if (prInline && prInline[1]) {
        // pull_request: [opened, synchronize] inline form
        hasPullRequest = true;
        pullRequestHasTypes = true;
        for (const t of prInline[1].split(",").map((s) => s.trim())) {
          if (ALLOWED_PR_TYPES.has(t)) {
            pullRequestTypesAllowOpen = true;
          }
        }
        inPullRequest = false;
        inTypes = false;
        continue;
      }
      if (inPullRequest && indent <= pullRequestIndent) {
        inPullRequest = false;
        inTypes = false;
      }
    }

    // Inside pull_request:.
    if (inPullRequest && indent > pullRequestIndent) {
      if (typesIndent === -1 || indent === typesIndent) {
        if (new RegExp(`^types${WS_OPT}:${WS_OPT}$`).test(trimmed)) {
          inTypes = true;
          pullRequestHasTypes = true;
          typesIndent = indent;
          continue;
        }
        const typesInline = new RegExp(`^types${WS_OPT}:${WS_OPT}\\[([^\\]]*)\\]${WS_OPT}$`).exec(trimmed);
        if (typesInline && typesInline[1]) {
          pullRequestHasTypes = true;
          for (const t of typesInline[1].split(",").map((s) => s.trim())) {
            if (ALLOWED_PR_TYPES.has(t)) pullRequestTypesAllowOpen = true;
          }
          continue;
        }
      }
      if (inTypes && indent > typesIndent) {
        // List item under types: e.g. `  - opened`
        const item = new RegExp(`^-${WS_OPT}(.+)$`).exec(trimmed);
        if (item && item[1]) {
          const value = item[1].trim();
          if (ALLOWED_PR_TYPES.has(value)) pullRequestTypesAllowOpen = true;
        }
      }
    }
  }

  // If pull_request is present without an explicit types filter, GitHub
  // defaults to [opened, synchronize, reopened] — so it DOES fire on open.
  if (hasPullRequest && !pullRequestHasTypes) {
    pullRequestTypesAllowOpen = true;
  }

  return hasPush || (hasPullRequest && pullRequestTypesAllowOpen);
}

/**
 * Survey every workflow file the adapter can find and return the unique
 * set of check names the gate (F-194) will require to be green. Workflows
 * that don't fire on PR open / PR update are skipped — see
 * workflowFiresOnPullRequestOpen — so the contract never includes a check
 * the evaluator could wait on forever.
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
    if (!workflowFiresOnPullRequestOpen(file.content)) {
      // Skip workflows whose triggers wouldn't produce check_runs on a
      // freshly-opened PR (e.g. reddwarf-advance.yml fires only on close).
      continue;
    }
    workflowFiles.push(file.path);
    for (const name of parseWorkflowJobNames(file.content)) {
      checkNames.add(name);
    }
  }

  return {
    checkNames: Array.from(checkNames).sort(),
    workflowFiles: workflowFiles.sort(),
    // Distinguish "repo has no workflows" from "repo has workflows but none
    // fire on PR open". Both result in an empty contract, but only the
    // former is a true greenfield.
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
