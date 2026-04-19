import type {
  ApprovalMode,
  PlanningSpec,
  PlanningTaskInput,
  PolicySnapshot,
  RiskClass,
  TaskManifest
} from "@reddwarf/contracts";
import {
  assessEligibility,
  buildPolicySnapshot,
  classifyRisk,
  getPolicyVersion,
  resolveApprovalMode,
  type EligibilityAssessment
} from "@reddwarf/policy";

// Feature 182 — Shadow-run replay harness (policy-layer only, v1).
//
// Re-runs the deterministic policy layer against archived task manifests +
// planning specs and diffs the result against the recorded policy snapshot.
// Answers "if we were to re-decide these tasks with the current pack, what
// would change?" without spending any LLM tokens or touching GitHub.
//
// Scope boundaries (see FEATURE_BOARD.md M24 F-182):
//   • NO LLM dispatch. The architect pass (Holly) is out of scope here.
//   • NO mutations. No DB writes, no GitHub calls, no OpenClaw sessions.
//   • Only the policy evaluator at @reddwarf/policy is exercised.

export interface ShadowRunTaskFixture {
  manifest: TaskManifest;
  planningSpec: PlanningSpec;
  archivedPolicySnapshot: PolicySnapshot;
  archivedApprovalMode: ApprovalMode;
  archivedRiskClass: RiskClass;
}

export interface ShadowRunInput {
  planningTaskInput: PlanningTaskInput;
  recordedSnapshot: PolicySnapshot;
  recordedApprovalMode: ApprovalMode;
  recordedRiskClass: RiskClass;
  taskId: string;
  repo: string;
  issueNumber: number | null;
  archivedPolicyVersion: string;
}

export interface ListDiff {
  added: string[];
  removed: string[];
}

export interface ShadowRunDiff {
  taskId: string;
  repo: string;
  issueNumber: number | null;
  archivedPolicyVersion: string;
  candidatePolicyVersion: string;
  eligibilityChanged: boolean;
  archivedEligibility: EligibilityAssessment;
  candidateEligibility: EligibilityAssessment;
  riskClassChanged: boolean;
  archivedRiskClass: RiskClass;
  candidateRiskClass: RiskClass;
  approvalModeChanged: boolean;
  archivedApprovalMode: ApprovalMode;
  candidateApprovalMode: ApprovalMode;
  snapshotChanges: {
    allowedPaths: ListDiff;
    deniedPaths: ListDiff;
    blockedPhases: ListDiff;
    allowedCapabilities: ListDiff;
    allowedSecretScopes: ListDiff;
    reasons: ListDiff;
  };
  anyChange: boolean;
}

// ── Input reconstruction ─────────────────────────────────────────────────────
//
// Rebuild the PlanningTaskInput that the policy evaluator expects from the
// bits of the archived task that we have on disk. Labels are not persisted on
// the manifest, so we stamp ["ai-eligible"] — the replay is running against
// tasks that made it through intake, so that label was present at the time.

export function buildShadowRunInput(
  fixture: ShadowRunTaskFixture
): ShadowRunInput {
  const planningTaskInput: PlanningTaskInput = {
    source: fixture.manifest.source,
    title: fixture.manifest.title,
    summary: fixture.manifest.summary,
    priority: fixture.manifest.priority,
    dryRun: fixture.manifest.dryRun,
    labels: ["ai-eligible"],
    acceptanceCriteria: fixture.planningSpec.acceptanceCriteria ?? [],
    affectedPaths: fixture.planningSpec.affectedAreas ?? [],
    requestedCapabilities: fixture.manifest.requestedCapabilities,
    metadata: {}
  };
  return {
    planningTaskInput,
    recordedSnapshot: fixture.archivedPolicySnapshot,
    recordedApprovalMode: fixture.archivedApprovalMode,
    recordedRiskClass: fixture.archivedRiskClass,
    taskId: fixture.manifest.taskId,
    repo: fixture.manifest.source.repo,
    issueNumber: fixture.manifest.source.issueNumber ?? null,
    archivedPolicyVersion: fixture.archivedPolicySnapshot.policyVersion
  };
}

// ── Diff helpers ─────────────────────────────────────────────────────────────

function diffList(archived: readonly string[], candidate: readonly string[]): ListDiff {
  const archivedSet = new Set(archived);
  const candidateSet = new Set(candidate);
  const added: string[] = [];
  const removed: string[] = [];
  for (const value of candidateSet) {
    if (!archivedSet.has(value)) added.push(value);
  }
  for (const value of archivedSet) {
    if (!candidateSet.has(value)) removed.push(value);
  }
  return { added: added.sort(), removed: removed.sort() };
}

function listChanged(diff: ListDiff): boolean {
  return diff.added.length > 0 || diff.removed.length > 0;
}

// ── Replay ───────────────────────────────────────────────────────────────────

export function replayShadowRun(input: ShadowRunInput): ShadowRunDiff {
  const candidateEligibility = assessEligibility(input.planningTaskInput);
  const candidateRiskClass = classifyRisk(input.planningTaskInput);
  const candidateApprovalMode = resolveApprovalMode({
    phase: "planning",
    riskClass: candidateRiskClass,
    requestedCapabilities: input.planningTaskInput.requestedCapabilities
  });
  const candidateSnapshot = buildPolicySnapshot(
    input.planningTaskInput,
    candidateRiskClass,
    candidateApprovalMode
  );

  // The archived eligibility assessment isn't persisted directly, but the
  // task reached the approval stage so the recorded assessment must have
  // returned `eligible: true` with no reasons.
  const archivedEligibility: EligibilityAssessment = {
    eligible: true,
    reasons: []
  };

  const snapshotChanges = {
    allowedPaths: diffList(
      input.recordedSnapshot.allowedPaths,
      candidateSnapshot.allowedPaths
    ),
    deniedPaths: diffList(
      input.recordedSnapshot.deniedPaths,
      candidateSnapshot.deniedPaths
    ),
    blockedPhases: diffList(
      input.recordedSnapshot.blockedPhases,
      candidateSnapshot.blockedPhases
    ),
    allowedCapabilities: diffList(
      input.recordedSnapshot.allowedCapabilities,
      candidateSnapshot.allowedCapabilities
    ),
    allowedSecretScopes: diffList(
      input.recordedSnapshot.allowedSecretScopes,
      candidateSnapshot.allowedSecretScopes
    ),
    reasons: diffList(
      input.recordedSnapshot.reasons,
      candidateSnapshot.reasons
    )
  };

  const anyChange =
    candidateEligibility.eligible !== archivedEligibility.eligible ||
    candidateRiskClass !== input.recordedRiskClass ||
    candidateApprovalMode !== input.recordedApprovalMode ||
    listChanged(snapshotChanges.allowedPaths) ||
    listChanged(snapshotChanges.deniedPaths) ||
    listChanged(snapshotChanges.blockedPhases) ||
    listChanged(snapshotChanges.allowedCapabilities) ||
    listChanged(snapshotChanges.allowedSecretScopes) ||
    listChanged(snapshotChanges.reasons);

  return {
    taskId: input.taskId,
    repo: input.repo,
    issueNumber: input.issueNumber,
    archivedPolicyVersion: input.archivedPolicyVersion,
    candidatePolicyVersion: getPolicyVersion(),
    eligibilityChanged: candidateEligibility.eligible !== archivedEligibility.eligible,
    archivedEligibility,
    candidateEligibility,
    riskClassChanged: candidateRiskClass !== input.recordedRiskClass,
    archivedRiskClass: input.recordedRiskClass,
    candidateRiskClass,
    approvalModeChanged: candidateApprovalMode !== input.recordedApprovalMode,
    archivedApprovalMode: input.recordedApprovalMode,
    candidateApprovalMode,
    snapshotChanges,
    anyChange
  };
}

// ── Report rendering ─────────────────────────────────────────────────────────

export interface ShadowRunReportSummary {
  totalReplayed: number;
  changed: number;
  eligibilityChanged: number;
  riskClassChanged: number;
  approvalModeChanged: number;
  snapshotChanged: number;
  archivedPolicyVersions: string[];
  candidatePolicyVersion: string;
  generatedAt: string;
}

export function summarizeShadowRun(
  diffs: readonly ShadowRunDiff[],
  generatedAt: string
): ShadowRunReportSummary {
  return {
    totalReplayed: diffs.length,
    changed: diffs.filter((d) => d.anyChange).length,
    eligibilityChanged: diffs.filter((d) => d.eligibilityChanged).length,
    riskClassChanged: diffs.filter((d) => d.riskClassChanged).length,
    approvalModeChanged: diffs.filter((d) => d.approvalModeChanged).length,
    snapshotChanged: diffs.filter(
      (d) =>
        listChanged(d.snapshotChanges.allowedPaths) ||
        listChanged(d.snapshotChanges.deniedPaths) ||
        listChanged(d.snapshotChanges.blockedPhases) ||
        listChanged(d.snapshotChanges.allowedCapabilities) ||
        listChanged(d.snapshotChanges.allowedSecretScopes)
    ).length,
    archivedPolicyVersions: [
      ...new Set(diffs.map((d) => d.archivedPolicyVersion))
    ].sort(),
    candidatePolicyVersion:
      diffs[0]?.candidatePolicyVersion ?? getPolicyVersion(),
    generatedAt
  };
}

function renderListDiff(label: string, diff: ListDiff): string[] {
  if (!listChanged(diff)) return [];
  const lines = [`  - **${label}**:`];
  for (const value of diff.added) lines.push(`    - \`+ ${value}\``);
  for (const value of diff.removed) lines.push(`    - \`- ${value}\``);
  return lines;
}

export function formatShadowRunMarkdown(
  diffs: readonly ShadowRunDiff[],
  summary: ShadowRunReportSummary
): string {
  const lines: string[] = [];
  lines.push("# Shadow-run replay report");
  lines.push("");
  lines.push(`_Generated: ${summary.generatedAt}_`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Replayed: **${summary.totalReplayed}** task(s)`);
  lines.push(`- Any change: **${summary.changed}**`);
  lines.push(`- Eligibility changed: ${summary.eligibilityChanged}`);
  lines.push(`- Risk class changed: ${summary.riskClassChanged}`);
  lines.push(`- Approval mode changed: ${summary.approvalModeChanged}`);
  lines.push(`- Policy snapshot changed: ${summary.snapshotChanged}`);
  lines.push(
    `- Archived pack versions seen: ${summary.archivedPolicyVersions.join(", ") || "n/a"}`
  );
  lines.push(`- Candidate (current) pack version: ${summary.candidatePolicyVersion}`);
  lines.push("");

  const changed = diffs.filter((d) => d.anyChange);
  if (changed.length === 0) {
    lines.push("No decisions would change under the current policy pack.");
    lines.push("");
    return lines.join("\n");
  }

  lines.push("## Tasks whose decisions would change");
  lines.push("");
  for (const d of changed) {
    const issue = d.issueNumber ? `#${d.issueNumber}` : "";
    lines.push(`### ${d.taskId} — ${d.repo}${issue}`);
    lines.push("");
    if (d.eligibilityChanged) {
      lines.push(
        `- **Eligibility**: ${d.archivedEligibility.eligible} → ${d.candidateEligibility.eligible}`
      );
      if (d.candidateEligibility.reasons.length > 0) {
        for (const reason of d.candidateEligibility.reasons) {
          lines.push(`  - ${reason}`);
        }
      }
    }
    if (d.riskClassChanged) {
      lines.push(
        `- **Risk class**: \`${d.archivedRiskClass}\` → \`${d.candidateRiskClass}\``
      );
    }
    if (d.approvalModeChanged) {
      lines.push(
        `- **Approval mode**: \`${d.archivedApprovalMode}\` → \`${d.candidateApprovalMode}\``
      );
    }
    lines.push(...renderListDiff("Allowed paths", d.snapshotChanges.allowedPaths));
    lines.push(...renderListDiff("Denied paths", d.snapshotChanges.deniedPaths));
    lines.push(...renderListDiff("Blocked phases", d.snapshotChanges.blockedPhases));
    lines.push(
      ...renderListDiff("Allowed capabilities", d.snapshotChanges.allowedCapabilities)
    );
    lines.push(
      ...renderListDiff("Allowed secret scopes", d.snapshotChanges.allowedSecretScopes)
    );
    lines.push(...renderListDiff("Policy reasons", d.snapshotChanges.reasons));
    lines.push("");
  }
  return lines.join("\n");
}

export function formatShadowRunJson(
  diffs: readonly ShadowRunDiff[],
  summary: ShadowRunReportSummary
): string {
  return JSON.stringify({ summary, diffs }, null, 2);
}

export { listChanged };
