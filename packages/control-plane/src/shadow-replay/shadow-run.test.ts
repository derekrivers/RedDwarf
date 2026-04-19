import { describe, expect, it } from "vitest";
import type {
  PlanningSpec,
  PolicySnapshot,
  TaskManifest
} from "@reddwarf/contracts";
import {
  buildShadowRunInput,
  formatShadowRunJson,
  formatShadowRunMarkdown,
  replayShadowRun,
  summarizeShadowRun
} from "./shadow-run.js";

function makeManifest(overrides: Partial<TaskManifest> = {}): TaskManifest {
  return {
    taskId: "acme-repo-42",
    source: { provider: "github", repo: "acme/repo", issueNumber: 42 },
    title: "Do the thing",
    summary: "A sufficiently long summary describing the thing to be done here.",
    priority: 2,
    dryRun: false,
    riskClass: "medium",
    approvalMode: "review_required",
    currentPhase: "policy_gate",
    lifecycleStatus: "blocked",
    assignedAgentType: "developer",
    requestedCapabilities: ["can_write_code", "can_archive_evidence"],
    retryCount: 0,
    evidenceLinks: [],
    workspaceId: null,
    branchName: null,
    prNumber: null,
    policyVersion: "v14",
    createdAt: "2026-04-01T10:00:00.000Z",
    updatedAt: "2026-04-01T10:05:00.000Z",
    ...overrides
  } as TaskManifest;
}

function makePlanningSpec(
  overrides: Partial<PlanningSpec> = {}
): PlanningSpec {
  return {
    specId: "acme-repo-42:spec:1",
    taskId: "acme-repo-42",
    summary: "Implement the thing in src.",
    assumptions: [],
    affectedAreas: ["src/thing.ts"],
    constraints: [],
    acceptanceCriteria: ["The thing exists", "Tests pass"],
    testExpectations: [],
    recommendedAgentType: "developer",
    riskClass: "medium",
    confidenceLevel: "high",
    confidenceReason: "Narrow change with good acceptance criteria.",
    projectSize: "small",
    createdAt: "2026-04-01T10:02:00.000Z",
    ...overrides
  } as PlanningSpec;
}

// Mirror the current policy evaluator's `createDeniedPaths()` so archived
// fixtures don't drift away from it by default — tests that want to prove a
// drift can override `deniedPaths` explicitly.
const CURRENT_DENIED_PATHS = [
  ".git/**",
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  ".secrets",
  "**/.secrets",
  "runtime-data/**"
];

function makeArchivedSnapshot(
  overrides: Partial<PolicySnapshot> = {}
): PolicySnapshot {
  return {
    policyVersion: "v14",
    approvalMode: "human_signoff_required",
    allowedCapabilities: ["can_archive_evidence", "can_run_tests"],
    allowedPaths: ["src/thing.ts"],
    deniedPaths: [...CURRENT_DENIED_PATHS],
    allowedSecretScopes: [],
    blockedPhases: ["review"],
    reasons: ["Archived reason A.", "Archived reason B."],
    ...overrides
  } as PolicySnapshot;
}

describe("buildShadowRunInput", () => {
  it("reassembles PlanningTaskInput from manifest + planning spec", () => {
    const manifest = makeManifest();
    const planningSpec = makePlanningSpec();
    const archivedPolicySnapshot = makeArchivedSnapshot();
    const input = buildShadowRunInput({
      manifest,
      planningSpec,
      archivedPolicySnapshot,
      archivedApprovalMode: "human_signoff_required",
      archivedRiskClass: "medium"
    });
    expect(input.planningTaskInput.title).toBe(manifest.title);
    expect(input.planningTaskInput.affectedPaths).toEqual(["src/thing.ts"]);
    expect(input.planningTaskInput.acceptanceCriteria).toEqual([
      "The thing exists",
      "Tests pass"
    ]);
    expect(input.planningTaskInput.labels).toEqual(["ai-eligible"]);
    expect(input.archivedPolicyVersion).toBe("v14");
  });
});

describe("replayShadowRun", () => {
  it("reports no changes when archived snapshot matches current policy output", () => {
    const input = buildShadowRunInput({
      manifest: makeManifest(),
      planningSpec: makePlanningSpec(),
      archivedPolicySnapshot: makeArchivedSnapshot({
        // Values that match what the current policy evaluator produces for
        // this manifest; see replay-produced diff for the expected shape.
        policyVersion: "v14",
        approvalMode: "human_signoff_required",
        allowedPaths: ["src/thing.ts"],
        allowedCapabilities: ["can_archive_evidence", "can_run_tests"],
        blockedPhases: ["review"],
        reasons: [
          "Developer orchestration may continue after human intervention, architecture review now runs before validation, SCM can open an approved branch and pull request after validation, and only the final post-validation review remains blocked in v1."
        ]
      }),
      archivedApprovalMode: "human_signoff_required",
      archivedRiskClass: "medium"
    });
    const diff = replayShadowRun(input);
    expect(diff.approvalModeChanged).toBe(false);
    expect(diff.riskClassChanged).toBe(false);
    expect(diff.snapshotChanges.allowedPaths.added).toEqual([]);
    expect(diff.snapshotChanges.allowedPaths.removed).toEqual([]);
  });

  it("detects a risk-class change when the archived record is stale", () => {
    const diff = replayShadowRun(
      buildShadowRunInput({
        manifest: makeManifest(),
        planningSpec: makePlanningSpec(),
        archivedPolicySnapshot: makeArchivedSnapshot(),
        archivedApprovalMode: "human_signoff_required",
        archivedRiskClass: "low" // archived value the current evaluator disagrees with
      })
    );
    expect(diff.riskClassChanged).toBe(true);
    expect(diff.candidateRiskClass).toBe("medium");
    expect(diff.anyChange).toBe(true);
  });

  it("reports allowed-paths drift when a list has changed", () => {
    const diff = replayShadowRun(
      buildShadowRunInput({
        manifest: makeManifest(),
        planningSpec: makePlanningSpec(),
        archivedPolicySnapshot: makeArchivedSnapshot({
          allowedPaths: ["src/old-layout/**"]
        }),
        archivedApprovalMode: "human_signoff_required",
        archivedRiskClass: "medium"
      })
    );
    expect(diff.snapshotChanges.allowedPaths.added).toContain("src/thing.ts");
    expect(diff.snapshotChanges.allowedPaths.removed).toContain(
      "src/old-layout/**"
    );
    expect(diff.anyChange).toBe(true);
  });
});

describe("summarizeShadowRun + formatters", () => {
  it("summarises counts across the diff set", () => {
    const diffs = [
      replayShadowRun(
        buildShadowRunInput({
          manifest: makeManifest(),
          planningSpec: makePlanningSpec(),
          archivedPolicySnapshot: makeArchivedSnapshot({
            allowedPaths: ["src/old/**"]
          }),
          archivedApprovalMode: "human_signoff_required",
          archivedRiskClass: "medium"
        })
      ),
      replayShadowRun(
        buildShadowRunInput({
          manifest: makeManifest({ taskId: "acme-repo-43" }),
          planningSpec: makePlanningSpec({
            taskId: "acme-repo-43",
            specId: "acme-repo-43:spec:1"
          }),
          archivedPolicySnapshot: makeArchivedSnapshot({
            allowedPaths: ["src/thing.ts"],
            allowedCapabilities: ["can_archive_evidence", "can_run_tests"],
            blockedPhases: ["review"],
            reasons: [
              "Developer orchestration may continue after human intervention, architecture review now runs before validation, SCM can open an approved branch and pull request after validation, and only the final post-validation review remains blocked in v1."
            ]
          }),
          archivedApprovalMode: "human_signoff_required",
          archivedRiskClass: "medium"
        })
      )
    ];
    const summary = summarizeShadowRun(diffs, "2026-04-19T12:00:00.000Z");
    expect(summary.totalReplayed).toBe(2);
    expect(summary.changed).toBe(1);
    expect(summary.archivedPolicyVersions).toEqual(["v14"]);

    const markdown = formatShadowRunMarkdown(diffs, summary);
    expect(markdown).toContain("Shadow-run replay report");
    expect(markdown).toContain("acme-repo-42");
    // The unchanged task should not show up as a per-task section
    expect(markdown).not.toMatch(/### acme-repo-43 /);

    const json = JSON.parse(formatShadowRunJson(diffs, summary));
    expect(json.summary.totalReplayed).toBe(2);
    expect(json.diffs).toHaveLength(2);
  });

  it("emits a 'no changes' message when nothing drifted", () => {
    const diffs: never[] = [];
    const summary = summarizeShadowRun(diffs, "2026-04-19T12:00:00.000Z");
    const markdown = formatShadowRunMarkdown(diffs, summary);
    expect(markdown).toContain("No decisions would change");
  });
});
