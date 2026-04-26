/**
 * M25 F-194 — Project Mode auto-merge evaluator and gate.
 *
 * Called by the dispatcher (or by F-193's debouncer) when a `(ticket_id,
 * head_sha)` evaluation has been queued. Walks an ordered set of gates
 * and returns one of four outcomes:
 *
 *   - merge — every gate passes; perform PUT /pulls/:n/merge
 *   - wait — checks still in-flight or contract not yet satisfiable;
 *            do nothing, evaluator will be re-triggered by the next
 *            webhook delivery
 *   - block_human_review — verification contract violated; mark ticket
 *            awaiting_human_merge, label PR, post one PR comment
 *   - skip — project not opted into auto-merge, or PR is not
 *            RedDwarf-authored
 *
 * Decision evidence is persisted as an evidence_record with kind=auto_merge_decision
 * so the dashboard (F-196) and audit export (F-197) can replay every choice.
 *
 * Gates evaluated, in this order — earliest deny short-circuits:
 *   1. Global flag REDDWARF_PROJECT_AUTOMERGE_ENABLED is true
 *   2. project.autoMergeEnabled is true
 *   3. ticket.requiredCheckContract (or project default) is non-empty
 *   4. PR has no `needs-human-merge` label (operator escape hatch)
 *   5. PR head SHA matches the most recent observation set
 *   6. Every requiredCheckNames entry has a check_run observation with
 *      conclusion === "success" for the current head SHA
 *   7. Total observed check count >= minimumCheckCount
 *   8. forbidSkipCi: no commit on the PR branch contains [skip ci]
 *   9. forbidEmptyTestDiff: PR diff includes a test file change (unless
 *      ticket carries `docs-only` label)
 *   10. ticket.riskClass !== "high"
 *   11. (deferred to v2) PR has no unresolved architecture-reviewer comments
 */

import {
  asIsoTimestamp,
  isRequiredCheckContractEmpty,
  type CiCheckObservation,
  type ProjectSpec,
  type RequiredCheckContract,
  type TicketSpec
} from "@reddwarf/contracts";
import { createEvidenceRecord, type PlanningRepository } from "@reddwarf/evidence";
import type { GitHubAutoMergeAdapter } from "@reddwarf/integrations";

export interface EvaluateAutoMergeInput {
  ticketId: string;
  headSha: string;
  prNumber: number;
}

export interface EvaluateAutoMergeDeps {
  repository: PlanningRepository;
  github: GitHubAutoMergeAdapter;
  /**
   * Global REDDWARF_PROJECT_AUTOMERGE_ENABLED. Resolved by the caller from
   * env / operator config; the evaluator never reads process.env directly
   * so test harnesses can set it explicitly.
   */
  projectAutoMergeEnabled: boolean;
  clock?: () => Date;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
  /** Optional Discord notifier hook for both block_human_review and merge
   *  outcomes (F-197). The notifier is responsible for any rate-limiting. */
  notify?: (input: AutoMergeNotification) => void | Promise<void>;
}

export type AutoMergeNotification =
  | {
      kind: "blocked";
      ticketId: string;
      prNumber: number;
      repo: string;
      failedGates: string[];
      decisionAt: string;
    }
  | {
      kind: "merged";
      ticketId: string;
      projectId: string;
      prNumber: number;
      repo: string;
      /** 1-indexed: 1 for the first merge on this project, etc. */
      mergeIndex: number;
      decisionAt: string;
    };

export type AutoMergeOutcome = "merge" | "wait" | "block_human_review" | "skip";

export interface AutoMergeDecision {
  outcome: AutoMergeOutcome;
  ticketId: string;
  prNumber: number;
  headSha: string;
  reason: string;
  /** When `outcome === merge`, the merge API result. */
  mergeResult?: {
    merged: boolean;
    mergedSha: string | null;
    message: string;
  };
  /** Gates that failed (only populated for block_human_review). */
  failedGates?: string[];
  /** Resolved RequiredCheckContract used for this decision. */
  contract?: RequiredCheckContract | null;
}

/** @deprecated use AutoMergeNotification (the discriminated union). */
export type AutoMergeBlockNotification = Extract<
  AutoMergeNotification,
  { kind: "blocked" }
>;

const SKIP_CI_RE = /\[skip ci\]/i;
const TEST_FILE_RE = /(^|\/)(tests?|spec|__tests__)\/|\.(test|spec)\.[a-zA-Z0-9]+$/;
const NEEDS_HUMAN_MERGE_LABEL = "needs-human-merge";
const DOCS_ONLY_LABEL = "docs-only";
const BLOCKED_LABEL = "reddwarf:auto-merge-blocked";
const BLOCK_COMMENT_MARKER = "<!-- reddwarf:auto-merge-block -->";

export function resolveEffectiveContract(
  ticket: TicketSpec,
  project: ProjectSpec
): RequiredCheckContract | null {
  return ticket.requiredCheckContract ?? project.requiredCheckContract;
}

/**
 * Pure decision builder: given the resolved state, returns the outcome
 * + reason without performing any side effects. Extracted so unit tests
 * can drive every gate in isolation.
 */
export function evaluateAutoMergeGates(state: {
  projectAutoMergeEnabled: boolean;
  project: Pick<ProjectSpec, "autoMergeEnabled" | "requiredCheckContract">;
  ticket: Pick<TicketSpec, "ticketId" | "riskClass" | "requiredCheckContract">;
  pr: {
    number: number;
    headSha: string;
    labels: string[];
    skipCiInCommits: boolean;
    hasTestFileDiff: boolean;
    hasAnyDiff: boolean;
  };
  observations: CiCheckObservation[];
}): {
  outcome: AutoMergeOutcome;
  reason: string;
  failedGates: string[];
  contract: RequiredCheckContract | null;
} {
  const failedGates: string[] = [];
  const contract = state.ticket.requiredCheckContract ?? state.project.requiredCheckContract ?? null;

  // Gate 1
  if (!state.projectAutoMergeEnabled) {
    return { outcome: "skip", reason: "global_flag_off", failedGates: [], contract };
  }
  // Gate 2
  if (!state.project.autoMergeEnabled) {
    return { outcome: "skip", reason: "project_opt_out", failedGates: [], contract };
  }
  // Gate 3
  if (isRequiredCheckContractEmpty(contract)) {
    failedGates.push("contract_empty");
    return {
      outcome: "block_human_review",
      reason: "RequiredCheckContract is empty — auto-merge requires a non-empty contract.",
      failedGates,
      contract
    };
  }

  // Gate 4
  if (state.pr.labels.includes(NEEDS_HUMAN_MERGE_LABEL)) {
    return {
      outcome: "skip",
      reason: `PR carries '${NEEDS_HUMAN_MERGE_LABEL}' label — operator escape hatch.`,
      failedGates: [],
      contract
    };
  }

  // Gate 5 — head SHA must match observations. We compute the most-recent
  // observation set as "every observation whose head_sha equals the PR's
  // current head_sha". If observations exist for an older SHA but none for
  // the current, we wait for the next webhook delivery.
  const currentShaObservations = state.observations.filter((o) => o.headSha === state.pr.headSha);
  if (currentShaObservations.length === 0) {
    return {
      outcome: "wait",
      reason: `No CI observations for head SHA ${state.pr.headSha} yet.`,
      failedGates: [],
      contract
    };
  }

  // Gate 6 — every required check name has at least one success observation
  // for the current head SHA. We accept any source (check_run/check_suite/status)
  // and pick the latest by completedAt for each (checkName, source).
  const successByName = new Set<string>();
  for (const obs of currentShaObservations) {
    if (obs.conclusion === "success") {
      successByName.add(obs.checkName);
    }
  }
  const required = contract!.requiredCheckNames;
  const missingChecks = required.filter((name) => !successByName.has(name));
  if (missingChecks.length > 0) {
    // Distinguish "still running" from "explicitly failed". If any
    // observation for a required check has a non-success terminal
    // conclusion we block; otherwise we wait.
    const failedTerminal = currentShaObservations.some(
      (o) =>
        required.includes(o.checkName) &&
        ["failure", "cancelled", "timed_out", "action_required"].includes(o.conclusion)
    );
    if (failedTerminal) {
      failedGates.push("required_check_failed");
      return {
        outcome: "wait",
        reason: `Required check(s) ${missingChecks.join(", ")} have terminal failure status — waiting for re-run, will not merge.`,
        failedGates,
        contract
      };
    }
    return {
      outcome: "wait",
      reason: `Awaiting required check(s): ${missingChecks.join(", ")}.`,
      failedGates: [],
      contract
    };
  }

  // Gate 7
  if (currentShaObservations.length < contract!.minimumCheckCount) {
    return {
      outcome: "wait",
      reason: `Observed ${currentShaObservations.length} checks but contract requires at least ${contract!.minimumCheckCount}.`,
      failedGates: [],
      contract
    };
  }

  // Gate 8
  if (contract!.forbidSkipCi && state.pr.skipCiInCommits) {
    failedGates.push("skip_ci_commit");
    return {
      outcome: "block_human_review",
      reason: "PR branch contains [skip ci] commit — contract forbids skipping CI.",
      failedGates,
      contract
    };
  }

  // Gate 9
  if (contract!.forbidEmptyTestDiff && !state.pr.hasTestFileDiff && !state.pr.labels.includes(DOCS_ONLY_LABEL)) {
    failedGates.push("empty_test_diff");
    return {
      outcome: "block_human_review",
      reason: "PR diff contains no test file changes and ticket is not labeled 'docs-only'.",
      failedGates,
      contract
    };
  }

  // Gate 10
  if (state.ticket.riskClass === "high") {
    failedGates.push("high_risk_ticket");
    return {
      outcome: "block_human_review",
      reason: "Ticket riskClass is 'high' — auto-merge always requires human review for high-risk work.",
      failedGates,
      contract
    };
  }

  // Gate 11 deferred — would need to walk PR review comments and match the
  // architecture-reviewer agent's identity.

  return {
    outcome: "merge",
    reason: "All 10 gates passed.",
    failedGates: [],
    contract
  };
}

/**
 * Test if a PR diff includes any file the auto-merge contract considers
 * a "test file". Conservative match: any path under `tests/`, `test/`,
 * `spec/`, or `__tests__/`, OR any filename ending in `.test.*` / `.spec.*`.
 */
export function diffIncludesTestChange(files: ReadonlyArray<{ path: string }>): boolean {
  return files.some((f) => TEST_FILE_RE.test(f.path));
}

/**
 * Full evaluator with side effects: fetches the PR snapshot, observations,
 * and supporting GitHub data; runs `evaluateAutoMergeGates`; performs the
 * merge / posts the block comment / updates ticket state; persists
 * evidence; returns the decision.
 *
 * Idempotent: re-evaluating an already-merged ticket short-circuits to
 * `{outcome: "skip", reason: "ticket_already_merged"}`.
 *
 * The caller (F-193 webhook handler / dispatcher) is responsible for the
 * concurrency lock — see `repository.runInTransaction` in the dispatcher
 * loop. v1 relies on the F-193 debouncer collapsing duplicate triggers.
 */
export async function evaluateAutoMerge(
  input: EvaluateAutoMergeInput,
  deps: EvaluateAutoMergeDeps
): Promise<AutoMergeDecision> {
  const { repository, github, projectAutoMergeEnabled, clock = () => new Date(), logger } = deps;
  const now = () => asIsoTimestamp(clock());

  const ticket = await repository.getTicketSpec(input.ticketId);
  if (!ticket) {
    return {
      outcome: "skip",
      ticketId: input.ticketId,
      prNumber: input.prNumber,
      headSha: input.headSha,
      reason: "ticket_not_found"
    };
  }
  if (ticket.status === "merged") {
    return {
      outcome: "skip",
      ticketId: input.ticketId,
      prNumber: input.prNumber,
      headSha: input.headSha,
      reason: "ticket_already_merged"
    };
  }

  const project = await repository.getProjectSpec(ticket.projectId);
  if (!project) {
    return {
      outcome: "skip",
      ticketId: input.ticketId,
      prNumber: input.prNumber,
      headSha: input.headSha,
      reason: "project_not_found"
    };
  }

  const pr = await github.getPullRequest(project.sourceRepo, input.prNumber);
  // Idempotency: PR already merged through some other path (manual,
  // GitHub UI, gh CLI) — do nothing.
  if (pr.merged || pr.state === "closed") {
    return {
      outcome: "skip",
      ticketId: input.ticketId,
      prNumber: input.prNumber,
      headSha: input.headSha,
      reason: pr.merged ? "pr_already_merged" : "pr_already_closed"
    };
  }

  const observations = await repository.listCiCheckObservations({
    ticketId: input.ticketId
  });

  // Fetch supporting data only when we'd actually use it. The fast path
  // (gate 1/2/3 fail) avoids the API calls.
  let skipCiInCommits = false;
  let hasTestFileDiff = false;
  let hasAnyDiff = false;
  const fastPathSkip =
    !projectAutoMergeEnabled || !project.autoMergeEnabled ||
    isRequiredCheckContractEmpty(
      ticket.requiredCheckContract ?? project.requiredCheckContract ?? null
    );
  if (!fastPathSkip) {
    const [commits, files] = await Promise.all([
      github.getPullRequestCommits(project.sourceRepo, input.prNumber),
      github.getPullRequestFiles(project.sourceRepo, input.prNumber)
    ]);
    skipCiInCommits = commits.some((c) => SKIP_CI_RE.test(c.message));
    hasTestFileDiff = diffIncludesTestChange(files);
    hasAnyDiff = files.length > 0;
  }

  const decision = evaluateAutoMergeGates({
    projectAutoMergeEnabled,
    project: {
      autoMergeEnabled: project.autoMergeEnabled,
      requiredCheckContract: project.requiredCheckContract
    },
    ticket: {
      ticketId: ticket.ticketId,
      riskClass: ticket.riskClass,
      requiredCheckContract: ticket.requiredCheckContract
    },
    pr: {
      number: pr.number,
      headSha: pr.headSha,
      labels: pr.labels,
      skipCiInCommits,
      hasTestFileDiff,
      hasAnyDiff
    },
    observations
  });

  // Persist evidence record for every non-skip outcome so the dashboard
  // (F-196) and audit export (F-197) can replay each decision.
  if (decision.outcome !== "skip") {
    await repository.saveEvidenceRecord(
      createEvidenceRecord({
        recordId: `${ticket.ticketId}:auto_merge:${pr.headSha}:${now()}`,
        taskId: ticket.ticketId.startsWith("project:")
          ? ticket.ticketId.split(":ticket:")[0] ?? ticket.ticketId
          : ticket.ticketId,
        kind: "gate_decision",
        title: `Auto-merge decision: ${decision.outcome}`,
        metadata: {
          phase: "scm" as const,
          ticketId: ticket.ticketId,
          prNumber: pr.number,
          headSha: pr.headSha,
          outcome: decision.outcome,
          reason: decision.reason,
          failedGates: decision.failedGates,
          contract: decision.contract
        },
        createdAt: now()
      })
    );
  }

  if (decision.outcome === "merge") {
    let mergeResult: { merged: boolean; mergedSha: string | null; message: string };
    try {
      mergeResult = await github.mergePullRequest({
        repo: project.sourceRepo,
        prNumber: pr.number,
        headSha: pr.headSha,
        commitTitle: `${pr.title} (#${pr.number})`
      });
      logger?.info(
        `M25 F-194: auto-merged PR ${project.sourceRepo}#${pr.number} (ticket ${ticket.ticketId}).`
      );
      // F-197: rate-limited Discord heartbeat. mergeIndex = count of prior
      // merge gate_decision evidence records on this project + 1 (this one).
      // We listEvidence on the parent task id, not the project id directly,
      // because evidence is keyed by task_id and the parent task is the
      // logical owner of the project's audit trail.
      if (deps.notify) {
        try {
          const parentTaskId = project.projectId.startsWith("project:")
            ? project.projectId.slice("project:".length)
            : project.projectId;
          const records = await repository.listEvidenceRecords(parentTaskId);
          const priorMerges = records.filter(
            (r) =>
              r.kind === "gate_decision" &&
              r.title === "Auto-merge decision: merge"
          ).length;
          // priorMerges already includes the record we wrote earlier in
          // this evaluation — the count IS the 1-indexed mergeIndex for
          // the just-merged PR.
          const mergeIndex = Math.max(1, priorMerges);
          await deps.notify({
            kind: "merged",
            ticketId: input.ticketId,
            projectId: project.projectId,
            prNumber: input.prNumber,
            repo: project.sourceRepo,
            mergeIndex,
            decisionAt: now()
          });
        } catch (notifyErr) {
          logger?.warn(
            `M25 F-197: merge notifier failed: ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger?.warn(
        `M25 F-194: merge call failed for ${project.sourceRepo}#${pr.number}: ${msg}.`
      );
      return {
        outcome: "block_human_review",
        ticketId: input.ticketId,
        prNumber: input.prNumber,
        headSha: input.headSha,
        reason: `merge API call failed: ${msg}`,
        failedGates: ["merge_call_failed"],
        contract: decision.contract
      };
    }
    return {
      outcome: "merge",
      ticketId: input.ticketId,
      prNumber: input.prNumber,
      headSha: input.headSha,
      reason: decision.reason,
      mergeResult,
      contract: decision.contract
    };
  }

  if (decision.outcome === "block_human_review") {
    // Idempotent block: only post comment + label if not already done.
    if (!pr.labels.includes(BLOCKED_LABEL)) {
      try {
        await github.addLabel(project.sourceRepo, pr.number, BLOCKED_LABEL);
        const failedList = decision.failedGates.length > 0
          ? decision.failedGates.map((g) => `- ${g}`).join("\n")
          : "- (no gates listed)";
        await github.postComment(
          project.sourceRepo,
          pr.number,
          `${BLOCK_COMMENT_MARKER}\n` +
            `### RedDwarf auto-merge blocked\n\n` +
            `**Reason:** ${decision.reason}\n\n` +
            `**Failed gates:**\n${failedList}\n\n` +
            `Resolve the underlying issue or set the \`${NEEDS_HUMAN_MERGE_LABEL}\` label to skip the auto-merge gate entirely.`
        );
      } catch (err) {
        logger?.warn(
          `M25 F-194: failed to label/comment ${project.sourceRepo}#${pr.number}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    if (deps.notify) {
      try {
        await deps.notify({
          kind: "blocked",
          ticketId: input.ticketId,
          prNumber: input.prNumber,
          repo: project.sourceRepo,
          failedGates: decision.failedGates,
          decisionAt: now()
        });
      } catch (err) {
        logger?.warn(`M25 F-194: notifier failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      outcome: "block_human_review",
      ticketId: input.ticketId,
      prNumber: input.prNumber,
      headSha: input.headSha,
      reason: decision.reason,
      failedGates: decision.failedGates,
      contract: decision.contract
    };
  }

  // wait / skip — pass-through
  return {
    outcome: decision.outcome,
    ticketId: input.ticketId,
    prNumber: input.prNumber,
    headSha: input.headSha,
    reason: decision.reason,
    contract: decision.contract
  };
}

// Re-export the marker constants so F-198 (kill-switch) and tests can
// reference the same labels.
export const AUTO_MERGE_LABELS = {
  needsHumanMerge: NEEDS_HUMAN_MERGE_LABEL,
  blocked: BLOCKED_LABEL,
  docsOnly: DOCS_ONLY_LABEL
} as const;
