/**
 * M25 F-195 — deterministic auto-merge eligibility pre-flight.
 *
 * Runs at SCM time, immediately after the project-ticket PR is opened.
 * The point of this pre-flight is to fail loud the moment a ticket is on
 * a path that can never auto-merge — instead of silently waiting forever
 * for required checks that will never run.
 *
 * Sibling to F-184's `evaluate_contract_violations`, but inputs and
 * concerns are different (this looks at workflow check names, PR diff
 * for tests, commit messages, base ref) so we keep it in its own module.
 *
 * On failure: the SCM phase wraps these violations in a
 * `contract_violation` failure class (existing F-184 enum value), labels
 * the PR with `reddwarf:auto-merge-blocked`, posts a single PR comment,
 * and moves the ticket to `awaiting_human_merge`. The F-194 evaluator
 * then sees the label on its first webhook trigger and short-circuits to
 * `skip` — no race.
 */

import {
  isRequiredCheckContractEmpty,
  type ProjectSpec,
  type RequiredCheckContract,
  type TicketSpec
} from "@reddwarf/contracts";

const SKIP_CI_RE = /\[skip ci\]/i;
const TEST_FILE_RE = /(^|\/)(tests?|spec|__tests__)\/|\.(test|spec)\.[a-zA-Z0-9]+$/;
const DOCS_ONLY_LABEL = "docs-only";

export type AutoMergePreflightViolationKind =
  | "missing_required_check"
  | "no_test_diff"
  | "skip_ci_commit"
  | "wrong_base_branch"
  | "empty_contract"
  | "high_risk_ticket";

export interface AutoMergePreflightViolation {
  kind: AutoMergePreflightViolationKind;
  detail: string;
}

export interface AutoMergePreflightInput {
  /** The project this PR belongs to. Drives autoMergeEnabled + project-level contract. */
  project: Pick<ProjectSpec, "autoMergeEnabled" | "requiredCheckContract">;
  /** The ticket whose PR was just opened. Drives ticket-level contract + risk class. */
  ticket: Pick<TicketSpec, "ticketId" | "riskClass" | "requiredCheckContract">;
  /** Sorted list of check names the surveyor (F-191) found in the repo's workflows. */
  surveyedCheckNames: readonly string[];
  /** Files changed by the PR (path-only is enough for the test-diff check). */
  prFiles: readonly { path: string }[];
  /** Commit messages on the PR branch (used for [skip ci] detection). */
  commitMessages: readonly string[];
  /** Labels currently on the PR. Used for the docs-only escape hatch. */
  prLabels: readonly string[];
  /** Base branch the PR is targeted at (e.g. "main"). */
  prBaseRef: string;
  /** Expected base branch — typically the project's default branch. */
  expectedBaseRef: string;
}

export interface AutoMergePreflightResult {
  /** True when the project has not opted into auto-merge — the pre-flight is a no-op. */
  skipped: boolean;
  /** True when there are no violations and the PR is eligible for auto-merge. */
  passed: boolean;
  violations: AutoMergePreflightViolation[];
}

/**
 * Pure pre-flight check. No side effects, no I/O — the caller (SCM
 * phase) supplies fully-resolved inputs and reacts to the result.
 *
 * Skips entirely when the project has not opted into auto-merge —
 * pre-flight overhead never falls on opt-out projects.
 */
export function evaluateAutoMergePreflight(
  input: AutoMergePreflightInput
): AutoMergePreflightResult {
  if (!input.project.autoMergeEnabled) {
    return { skipped: true, passed: true, violations: [] };
  }

  const violations: AutoMergePreflightViolation[] = [];
  const contract: RequiredCheckContract | null =
    input.ticket.requiredCheckContract ?? input.project.requiredCheckContract ?? null;

  // Empty contract is a violation at PR-open time even though the F-194
  // evaluator would also reject it. Failing here lets the operator see
  // the problem the moment the PR opens, not whenever the first check
  // happens to fire.
  if (isRequiredCheckContractEmpty(contract)) {
    violations.push({
      kind: "empty_contract",
      detail:
        "Project opted into auto-merge but has no RequiredCheckContract — the F-194 evaluator will refuse to merge."
    });
    // Short-circuit the rest: every other check would compare against an
    // empty list and produce false-positive violations.
    return { skipped: false, passed: false, violations };
  }

  // Wrong base ref: the merge gate matches branch-protection rules on the
  // expected branch, so a PR targeted at the wrong one will never satisfy
  // the contract.
  if (input.prBaseRef !== input.expectedBaseRef) {
    violations.push({
      kind: "wrong_base_branch",
      detail: `PR base is '${input.prBaseRef}' but project expects '${input.expectedBaseRef}'.`
    });
  }

  // Required check names must exist in the repo's surveyed workflow
  // list. Otherwise the F-194 evaluator will sit forever waiting for a
  // check_run that GitHub will never produce.
  const surveyed = new Set(input.surveyedCheckNames);
  const missing = contract!.requiredCheckNames.filter((n) => !surveyed.has(n));
  if (missing.length > 0) {
    violations.push({
      kind: "missing_required_check",
      detail: `Required check(s) ${missing.join(", ")} are not present in the repo's workflow files. The auto-merge gate would wait forever.`
    });
  }

  // [skip ci]: the contract default forbids it, and a PR with [skip ci]
  // commits will never produce check_runs at all.
  if (contract!.forbidSkipCi) {
    const skipCi = input.commitMessages.find((m) => SKIP_CI_RE.test(m));
    if (skipCi) {
      violations.push({
        kind: "skip_ci_commit",
        detail: `Commit message contains [skip ci]: "${skipCi.slice(0, 80)}".`
      });
    }
  }

  // forbidEmptyTestDiff: a code-only PR with no test files cannot
  // auto-merge unless the docs-only label is present. Catch at PR-open
  // time so the developer agent can be redirected before checks fire.
  if (contract!.forbidEmptyTestDiff && !input.prLabels.includes(DOCS_ONLY_LABEL)) {
    const hasTestChange = input.prFiles.some((f) => TEST_FILE_RE.test(f.path));
    if (!hasTestChange) {
      violations.push({
        kind: "no_test_diff",
        detail: "PR diff has no test file changes and the ticket is not labeled 'docs-only'."
      });
    }
  }

  // High-risk tickets always require human merge — surface the same
  // signal at PR-open time so the operator triage queue (F-186) shows
  // it immediately.
  if (input.ticket.riskClass === "high") {
    violations.push({
      kind: "high_risk_ticket",
      detail: "Ticket riskClass is 'high'; auto-merge always requires human review for high-risk work."
    });
  }

  return {
    skipped: false,
    passed: violations.length === 0,
    violations
  };
}

/**
 * Build a single human-readable comment body from a list of violations.
 * Used by the SCM phase when posting the PR comment that explains why
 * the ticket has been moved to awaiting_human_merge.
 */
export function buildPreflightCommentBody(
  result: AutoMergePreflightResult
): string {
  const items = result.violations.map((v) => `- **${v.kind}** — ${v.detail}`).join("\n");
  return [
    "<!-- reddwarf:auto-merge-preflight -->",
    "### RedDwarf auto-merge pre-flight failed",
    "",
    "This PR is opted into auto-merge, but the deterministic pre-flight at PR-open time found contract violations that would prevent the F-194 evaluator from ever merging it.",
    "",
    items,
    "",
    "Resolve the violations above (or set the `needs-human-merge` label to opt this PR out of auto-merge) and the gate will re-evaluate on the next webhook delivery."
  ].join("\n");
}
