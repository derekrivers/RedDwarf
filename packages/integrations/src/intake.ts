import type { PlanningTaskInput } from "@reddwarf/contracts";

// Feature 188 — Intake Adapter Contract.
//
// Provider-agnostic seam between the control plane's intake/polling loop
// and whatever upstream system is producing tasks. RedDwarf v1 only knows
// about GitHub issues; this contract makes it cheap to add Linear, Jira,
// Slack, scheduled cron tasks, etc. without scattering provider conditionals
// through the polling daemon.
//
// v1 keeps the surface small and focused on what the polling daemon and
// webhook receiver actually need today:
//   • discoverCandidates  — list new candidate tasks from the source.
//   • fetchCanonicalTask   — fetch a single task by id (for webhook flows).
//   • toPlanningTaskInput  — convert a candidate into the planning input
//                            the rest of the pipeline already speaks.
//   • markProcessed        — let the source know a candidate moved through
//                            the pipeline (label, comment, no-op, etc.).
//
// `GitHubIntakeAdapter` is the first implementation and ships in this PR
// as a thin wrapper around the existing `GitHubAdapter`. `FixtureIntake-
// Adapter` is the in-process double used by tests and proves the seam
// works for callers other than GitHub.
//
// Migration notes (next PR): the polling daemon currently calls
// `GitHubAdapter.listIssueCandidates` directly. A subsequent change can
// thread an `IntakeAdapter` into the polling daemon and switch the call
// site over without altering daemon semantics.

/** Provider-prefixed identifier for an intake candidate, e.g. `"github:acme/repo#42"`.
 *  The shape is opaque to callers — only the producing adapter parses it. */
export type IntakeTaskId = string;

export type IntakeCandidateState = "open" | "closed";

export interface IntakeCandidate {
  /** Stable, provider-namespaced identifier (e.g. `github:acme/repo#42`). */
  id: IntakeTaskId;
  provider: string;
  repo: string;
  title: string;
  body: string;
  labels: string[];
  state: IntakeCandidateState;
  url: string;
  author: string | null;
  /** Source-specific extras (issue number, branch, milestone, etc.). */
  metadata: Record<string, unknown>;
}

export interface IntakeDiscoveryQuery {
  repo: string;
  labels?: string[];
  states?: IntakeCandidateState[];
  limit?: number;
}

export type IntakeOutcomeStatus =
  | "queued"
  | "skipped"
  | "rejected"
  | "completed"
  | "failed";

export interface IntakeOutcome {
  status: IntakeOutcomeStatus;
  reason?: string;
  /** Optional pointers back into RedDwarf evidence (run id, evidence URL, etc.). */
  evidenceLinks?: string[];
}

export interface IntakeAdapter {
  /** Provider id, e.g. `"github"` or `"linear"`. Stable across versions. */
  readonly provider: string;
  discoverCandidates(query: IntakeDiscoveryQuery): Promise<IntakeCandidate[]>;
  fetchCanonicalTask(id: IntakeTaskId): Promise<IntakeCandidate>;
  toPlanningTaskInput(candidate: IntakeCandidate): Promise<PlanningTaskInput>;
  /**
   * Persist the pipeline outcome upstream. Implementations may no-op when
   * the source provides no write surface (e.g. read-only webhook payloads).
   */
  markProcessed(id: IntakeTaskId, outcome: IntakeOutcome): Promise<void>;
}

// ── Helpers ──────────────────────────────────────────────────────────────

const ID_SEPARATOR = ":";
const REPO_ISSUE_SEPARATOR = "#";

export function buildIntakeTaskId(input: {
  provider: string;
  repo: string;
  externalId: string | number;
}): IntakeTaskId {
  return `${input.provider}${ID_SEPARATOR}${input.repo}${REPO_ISSUE_SEPARATOR}${input.externalId}`;
}

export function parseIntakeTaskId(
  id: IntakeTaskId
): { provider: string; repo: string; externalId: string } | null {
  const sepIndex = id.indexOf(ID_SEPARATOR);
  if (sepIndex <= 0 || sepIndex === id.length - 1) return null;
  const provider = id.slice(0, sepIndex);
  const remainder = id.slice(sepIndex + 1);
  const hashIndex = remainder.lastIndexOf(REPO_ISSUE_SEPARATOR);
  if (hashIndex <= 0 || hashIndex === remainder.length - 1) return null;
  return {
    provider,
    repo: remainder.slice(0, hashIndex),
    externalId: remainder.slice(hashIndex + 1)
  };
}
