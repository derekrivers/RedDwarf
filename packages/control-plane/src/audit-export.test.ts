import { describe, expect, it } from "vitest";
import type { ApprovalRequest, TaskManifest } from "@reddwarf/contracts";
import {
  buildAuditEntries,
  filterAuditEntriesByRepo,
  renderAuditCsv
} from "./audit-export.js";

function makeApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: "task-1:approval:1",
    taskId: "task-1",
    runId: "run-1",
    phase: "policy_gate",
    dryRun: false,
    confidenceLevel: null,
    confidenceReason: null,
    approvalMode: "review_required",
    status: "approved",
    riskClass: "medium",
    summary: "Ship it.",
    requestedCapabilities: ["can_write_code"],
    allowedPaths: ["src/**"],
    blockedPhases: [],
    policyReasons: [],
    requestedBy: "policy",
    decidedBy: "derek",
    decision: "approve",
    decisionSummary: "Looks good, \"shipping\" now.",
    comment: null,
    createdAt: "2026-04-19T10:00:00.000Z",
    updatedAt: "2026-04-19T10:05:00.000Z",
    resolvedAt: "2026-04-19T10:05:00.000Z",
    ...overrides
  };
}

function makeManifest(overrides: Partial<TaskManifest> = {}): TaskManifest {
  return {
    taskId: "task-1",
    source: {
      kind: "github_issue",
      repo: "derekrivers/FirstVoyage",
      issueNumber: 42,
      issueId: "issue-42",
      url: "https://github.com/derekrivers/FirstVoyage/issues/42"
    },
    title: "Do the thing",
    summary: "Thing needs doing.",
    priority: 1,
    dryRun: false,
    riskClass: "medium",
    approvalMode: "review_required",
    currentPhase: "development",
    lifecycleStatus: "active",
    assignedAgentType: "lister",
    requestedCapabilities: ["can_write_code"],
    retryCount: 0,
    evidenceLinks: [],
    workspaceId: null,
    branchName: "reddwarf/task-1",
    prNumber: 99,
    policyVersion: "v14",
    createdAt: "2026-04-19T09:00:00.000Z",
    updatedAt: "2026-04-19T10:05:00.000Z",
    ...overrides
  } as TaskManifest;
}

describe("buildAuditEntries", () => {
  it("joins approvals with manifests and derives the PR URL", () => {
    const approvals = [makeApproval()];
    const manifests = new Map([["task-1", makeManifest()]]);
    const entries = buildAuditEntries(approvals, manifests);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      requestId: "task-1:approval:1",
      repo: "derekrivers/FirstVoyage",
      issueNumber: 42,
      phase: "policy_gate",
      decision: "approve",
      decidedBy: "derek",
      riskClass: "medium",
      policyVersion: "v14",
      prNumber: 99,
      prUrl: "https://github.com/derekrivers/FirstVoyage/pull/99"
    });
  });

  it("leaves repo and pr fields null when no manifest is available", () => {
    const entries = buildAuditEntries([makeApproval()], new Map());
    expect(entries[0]).toMatchObject({
      repo: null,
      issueNumber: null,
      policyVersion: null,
      prNumber: null,
      prUrl: null
    });
  });

  it("leaves prUrl null when prNumber is missing even if repo is present", () => {
    const manifests = new Map([
      ["task-1", makeManifest({ prNumber: null as unknown as number })]
    ]);
    const entries = buildAuditEntries([makeApproval()], manifests);
    expect(entries[0]!.prUrl).toBeNull();
  });
});

describe("renderAuditCsv", () => {
  it("emits an RFC 4180 header row followed by one data row per entry", () => {
    const approvals = [makeApproval()];
    const manifests = new Map([["task-1", makeManifest()]]);
    const csv = renderAuditCsv(buildAuditEntries(approvals, manifests));
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(
      "kind,requestId,taskId,runId,repo,issueNumber,phase,status,decision,decidedBy,decisionSummary,riskClass,policyVersion,prNumber,prUrl,gateFailures,headSha,createdAt,updatedAt,resolvedAt"
    );
    expect(lines[1]).toContain("task-1:approval:1");
    expect(lines[1]).toContain("https://github.com/derekrivers/FirstVoyage/pull/99");
  });

  it("quotes and escapes cells that contain commas, quotes, or newlines", () => {
    // decisionSummary in makeApproval contains an embedded quote
    const csv = renderAuditCsv(
      buildAuditEntries([makeApproval()], new Map([["task-1", makeManifest()]]))
    );
    expect(csv).toContain('"Looks good, ""shipping"" now."');
  });

  it("emits an empty data section when there are no entries", () => {
    expect(renderAuditCsv([])).toBe(
      "kind,requestId,taskId,runId,repo,issueNumber,phase,status,decision,decidedBy,decisionSummary,riskClass,policyVersion,prNumber,prUrl,gateFailures,headSha,createdAt,updatedAt,resolvedAt\r\n"
    );
  });
});

// M25 F-197 — auto-merge audit entry builder + CSV row.
describe("buildAutoMergeAuditEntries", () => {
  it("renders a kind=auto_merge row with gateFailures, headSha, and outcome populated", async () => {
    const { buildAutoMergeAuditEntries, renderAuditCsv } = await import(
      "./audit-export.js"
    );
    const records = [
      {
        recordId: "rec-1",
        taskId: "p1",
        kind: "gate_decision" as const,
        title: "Auto-merge decision: block_human_review",
        location: "db://gate_decision/rec-1",
        metadata: {
          phase: "scm" as const,
          ticketId: "project:p1:ticket:1",
          prNumber: 99,
          headSha: "deadbeef",
          outcome: "block_human_review",
          reason: "high risk",
          failedGates: ["high_risk_ticket", "empty_test_diff"]
        },
        createdAt: "2026-04-26T13:00:00.000Z"
      }
    ];
    const manifests = new Map([["p1", makeManifest()]]);
    const entries = buildAutoMergeAuditEntries(records, manifests);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.kind).toBe("auto_merge");
    expect(entry.decision).toBe("block_human_review");
    expect(entry.gateFailures).toBe("high_risk_ticket|empty_test_diff");
    expect(entry.headSha).toBe("deadbeef");

    const csv = renderAuditCsv(entries);
    expect(csv).toContain("auto_merge,rec-1");
    expect(csv).toContain("deadbeef");
  });

  it("ignores evidence records that are not auto-merge gate decisions", async () => {
    const { buildAutoMergeAuditEntries } = await import("./audit-export.js");
    const records = [
      {
        recordId: "rec-2",
        taskId: "p1",
        kind: "phase_record" as const,
        title: "Some other record",
        location: "db://phase_record/rec-2",
        metadata: { phase: "planning" as const },
        createdAt: "2026-04-26T13:00:00.000Z"
      }
    ];
    expect(
      buildAutoMergeAuditEntries(records, new Map([["p1", makeManifest()]]))
    ).toEqual([]);
  });
});

describe("filterAuditEntriesByRepo", () => {
  it("returns a shallow copy when no repo filter is provided", () => {
    const entries = buildAuditEntries(
      [makeApproval()],
      new Map([["task-1", makeManifest()]])
    );
    const filtered = filterAuditEntriesByRepo(entries, null);
    expect(filtered).toEqual(entries);
    expect(filtered).not.toBe(entries);
  });

  it("matches the repo case-insensitively", () => {
    const entries = buildAuditEntries(
      [makeApproval()],
      new Map([["task-1", makeManifest()]])
    );
    expect(filterAuditEntriesByRepo(entries, "DEREKRIVERS/firstvoyage")).toHaveLength(1);
    expect(filterAuditEntriesByRepo(entries, "someone-else/repo")).toHaveLength(0);
  });

  it("drops entries that have no repo when a repo filter is set", () => {
    const entries = buildAuditEntries([makeApproval()], new Map());
    expect(filterAuditEntriesByRepo(entries, "anything")).toHaveLength(0);
  });
});
