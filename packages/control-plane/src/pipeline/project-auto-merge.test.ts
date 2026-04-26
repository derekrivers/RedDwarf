import { describe, expect, it, vi } from "vitest";
import { InMemoryPlanningRepository } from "@reddwarf/evidence";
import type {
  CiCheckObservation,
  ProjectSpec,
  RequiredCheckContract,
  TicketSpec
} from "@reddwarf/contracts";
import type {
  GitHubAutoMergeAdapter,
  MergePullRequestResult,
  PullRequestCommit,
  PullRequestFile,
  PullRequestSnapshot
} from "@reddwarf/integrations";
import {
  diffIncludesTestChange,
  evaluateAutoMerge,
  evaluateAutoMergeGates,
  resolveEffectiveContract,
  AUTO_MERGE_LABELS
} from "./project-auto-merge.js";

const NOW = "2026-04-26T13:00:00.000Z";

function buildContract(overrides: Partial<RequiredCheckContract> = {}): RequiredCheckContract {
  return {
    requiredCheckNames: ["build", "test"],
    minimumCheckCount: 2,
    forbidSkipCi: true,
    forbidEmptyTestDiff: true,
    rationale: "test contract",
    ...overrides
  };
}

function buildProject(overrides: Partial<ProjectSpec> = {}): ProjectSpec {
  return {
    projectId: "project:auto-1",
    sourceIssueId: "1",
    sourceRepo: "acme/platform",
    title: "Auto-merge test project",
    summary: "Drives the F-194 evaluator under test.",
    projectSize: "small",
    status: "executing",
    complexityClassification: null,
    approvalDecision: "approve",
    decidedBy: "operator",
    decisionSummary: "Approved.",
    amendments: null,
    clarificationQuestions: null,
    clarificationAnswers: null,
    clarificationRequestedAt: null,
    autoMergeEnabled: true,
    autoMergePolicy: null,
    requiredCheckContract: buildContract(),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function buildTicket(overrides: Partial<TicketSpec> = {}): TicketSpec {
  return {
    ticketId: "project:auto-1:ticket:1",
    projectId: "project:auto-1",
    title: "Open PR ticket",
    description: "PR is open at #99.",
    acceptanceCriteria: ["PR opens"],
    dependsOn: [],
    status: "pr_open",
    complexityClass: "low",
    riskClass: "low",
    githubSubIssueNumber: null,
    githubPrNumber: 99,
    requiredCheckContract: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function buildObservation(
  overrides: Partial<CiCheckObservation> = {}
): CiCheckObservation {
  return {
    id: `obs-${Math.random().toString(36).slice(2)}`,
    ticketId: "project:auto-1:ticket:1",
    prNumber: 99,
    headSha: "deadbeef",
    source: "check_run",
    checkName: "build",
    conclusion: "success",
    completedAt: NOW,
    rawPayloadEvidenceId: null,
    createdAt: NOW,
    ...overrides
  };
}

function buildPrSnapshot(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    number: 99,
    state: "open",
    merged: false,
    headSha: "deadbeef",
    headRef: "feature/x",
    baseRef: "main",
    title: "Test PR",
    body: "PR body",
    labels: [],
    ...overrides
  };
}

interface FixtureAdapter extends GitHubAutoMergeAdapter {
  putComments: Array<{ repo: string; prNumber: number; body: string }>;
  putLabels: Array<{ repo: string; prNumber: number; label: string }>;
  mergeCalls: Array<{ repo: string; prNumber: number; headSha: string }>;
}

function buildFixtureAdapter(opts: {
  pr?: PullRequestSnapshot;
  files?: PullRequestFile[];
  commits?: PullRequestCommit[];
  mergeResult?: MergePullRequestResult;
}): FixtureAdapter {
  const putComments: FixtureAdapter["putComments"] = [];
  const putLabels: FixtureAdapter["putLabels"] = [];
  const mergeCalls: FixtureAdapter["mergeCalls"] = [];
  return {
    putComments,
    putLabels,
    mergeCalls,
    async getPullRequest() {
      return opts.pr ?? buildPrSnapshot();
    },
    async getPullRequestFiles() {
      return opts.files ?? [{ path: "tests/foo.test.ts", status: "modified", additions: 1, deletions: 0 }];
    },
    async getPullRequestCommits() {
      return opts.commits ?? [{ sha: "deadbeef", message: "feat: add foo" }];
    },
    async addLabel(repo, prNumber, label) {
      putLabels.push({ repo, prNumber, label });
    },
    async postComment(repo, prNumber, body) {
      putComments.push({ repo, prNumber, body });
    },
    async mergePullRequest(input) {
      mergeCalls.push({ repo: input.repo, prNumber: input.prNumber, headSha: input.headSha });
      return opts.mergeResult ?? { merged: true, mergedSha: "merged-sha", message: "Merged." };
    }
  };
}

describe("M25 F-194 — evaluateAutoMergeGates (pure decision table)", () => {
  function baseState(overrides: Partial<Parameters<typeof evaluateAutoMergeGates>[0]> = {}) {
    return {
      projectAutoMergeEnabled: true,
      project: { autoMergeEnabled: true, requiredCheckContract: buildContract() },
      ticket: {
        ticketId: "t-1",
        riskClass: "low" as const,
        requiredCheckContract: null
      },
      pr: {
        number: 99,
        headSha: "deadbeef",
        labels: [],
        skipCiInCommits: false,
        hasTestFileDiff: true,
        hasAnyDiff: true
      },
      observations: [
        buildObservation({ checkName: "build", conclusion: "success" }),
        buildObservation({ checkName: "test", conclusion: "success" })
      ],
      ...overrides
    };
  }

  it("merges when every gate passes", () => {
    const decision = evaluateAutoMergeGates(baseState());
    expect(decision.outcome).toBe("merge");
  });

  it("gate 1: skip when global flag is off", () => {
    const decision = evaluateAutoMergeGates(baseState({ projectAutoMergeEnabled: false }));
    expect(decision.outcome).toBe("skip");
    expect(decision.reason).toBe("global_flag_off");
  });

  it("gate 2: skip when project opted out", () => {
    const decision = evaluateAutoMergeGates(
      baseState({ project: { autoMergeEnabled: false, requiredCheckContract: buildContract() } })
    );
    expect(decision.outcome).toBe("skip");
    expect(decision.reason).toBe("project_opt_out");
  });

  it("gate 3: block when contract is empty", () => {
    const decision = evaluateAutoMergeGates(
      baseState({ project: { autoMergeEnabled: true, requiredCheckContract: null } })
    );
    expect(decision.outcome).toBe("block_human_review");
    expect(decision.failedGates).toContain("contract_empty");
  });

  it("gate 4: skip when needs-human-merge label is present", () => {
    const decision = evaluateAutoMergeGates(
      baseState({
        pr: {
          number: 99,
          headSha: "deadbeef",
          labels: [AUTO_MERGE_LABELS.needsHumanMerge],
          skipCiInCommits: false,
          hasTestFileDiff: true,
          hasAnyDiff: true
        }
      })
    );
    expect(decision.outcome).toBe("skip");
  });

  it("gate 5: wait when no observations exist for the current head SHA", () => {
    const decision = evaluateAutoMergeGates(
      baseState({
        observations: [
          buildObservation({ checkName: "build", conclusion: "success", headSha: "old-sha" })
        ]
      })
    );
    expect(decision.outcome).toBe("wait");
  });

  it("gate 6: wait when a required check name has no success observation yet", () => {
    const decision = evaluateAutoMergeGates(
      baseState({
        observations: [
          buildObservation({ checkName: "build", conclusion: "success" })
          // no `test` observation
        ]
      })
    );
    expect(decision.outcome).toBe("wait");
    expect(decision.reason).toMatch(/test/);
  });

  it("gate 6: wait (not merge) when a required check has terminal failure", () => {
    const decision = evaluateAutoMergeGates(
      baseState({
        observations: [
          buildObservation({ checkName: "build", conclusion: "success" }),
          buildObservation({ checkName: "test", conclusion: "failure" })
        ]
      })
    );
    expect(decision.outcome).toBe("wait");
  });

  it("gate 7: wait when minimumCheckCount is greater than observed", () => {
    const decision = evaluateAutoMergeGates(
      baseState({
        project: {
          autoMergeEnabled: true,
          requiredCheckContract: buildContract({
            minimumCheckCount: 5
          })
        }
      })
    );
    expect(decision.outcome).toBe("wait");
  });

  it("gate 8: block when forbidSkipCi and a commit message contains [skip ci]", () => {
    const decision = evaluateAutoMergeGates(
      baseState({
        pr: {
          number: 99,
          headSha: "deadbeef",
          labels: [],
          skipCiInCommits: true,
          hasTestFileDiff: true,
          hasAnyDiff: true
        }
      })
    );
    expect(decision.outcome).toBe("block_human_review");
    expect(decision.failedGates).toContain("skip_ci_commit");
  });

  it("gate 9: block when forbidEmptyTestDiff and PR has no test changes", () => {
    const decision = evaluateAutoMergeGates(
      baseState({
        pr: {
          number: 99,
          headSha: "deadbeef",
          labels: [],
          skipCiInCommits: false,
          hasTestFileDiff: false,
          hasAnyDiff: true
        }
      })
    );
    expect(decision.outcome).toBe("block_human_review");
    expect(decision.failedGates).toContain("empty_test_diff");
  });

  it("gate 9: docs-only label allows merge without test changes", () => {
    const decision = evaluateAutoMergeGates(
      baseState({
        pr: {
          number: 99,
          headSha: "deadbeef",
          labels: [AUTO_MERGE_LABELS.docsOnly],
          skipCiInCommits: false,
          hasTestFileDiff: false,
          hasAnyDiff: true
        }
      })
    );
    expect(decision.outcome).toBe("merge");
  });

  it("gate 10: block when ticket riskClass is high (non-overridable)", () => {
    const decision = evaluateAutoMergeGates(
      baseState({
        ticket: { ticketId: "t-1", riskClass: "high", requiredCheckContract: null }
      })
    );
    expect(decision.outcome).toBe("block_human_review");
    expect(decision.failedGates).toContain("high_risk_ticket");
  });
});

describe("M25 F-194 — diffIncludesTestChange", () => {
  it.each([
    ["tests/foo.test.ts", true],
    ["packages/x/__tests__/y.spec.ts", true],
    ["src/foo.test.tsx", true],
    ["src/foo.spec.js", true],
    ["src/foo.ts", false],
    ["README.md", false]
  ])("classifies %s correctly", (path, expected) => {
    expect(diffIncludesTestChange([{ path }])).toBe(expected);
  });
});

describe("M25 F-194 — resolveEffectiveContract", () => {
  it("prefers ticket contract over project contract when set", () => {
    const ticket = buildTicket({
      requiredCheckContract: buildContract({ requiredCheckNames: ["only-ticket"] })
    });
    const project = buildProject({
      requiredCheckContract: buildContract({ requiredCheckNames: ["only-project"] })
    });
    const resolved = resolveEffectiveContract(ticket, project);
    expect(resolved?.requiredCheckNames).toEqual(["only-ticket"]);
  });

  it("falls back to project contract when ticket contract is null", () => {
    const ticket = buildTicket({ requiredCheckContract: null });
    const project = buildProject({
      requiredCheckContract: buildContract({ requiredCheckNames: ["fallback"] })
    });
    const resolved = resolveEffectiveContract(ticket, project);
    expect(resolved?.requiredCheckNames).toEqual(["fallback"]);
  });
});

describe("M25 F-194 — evaluateAutoMerge (full evaluator with side effects)", () => {
  async function setup(opts: {
    project?: Partial<ProjectSpec>;
    ticket?: Partial<TicketSpec>;
    observations?: CiCheckObservation[];
  } = {}) {
    const repository = new InMemoryPlanningRepository();
    const project = buildProject(opts.project);
    const ticket = buildTicket(opts.ticket);
    await repository.saveProjectSpec(project);
    await repository.saveTicketSpec(ticket);
    for (const obs of opts.observations ?? [
      buildObservation({ checkName: "build", conclusion: "success" }),
      buildObservation({ checkName: "test", conclusion: "success" })
    ]) {
      await repository.saveCiCheckObservation({
        ticketId: obs.ticketId,
        prNumber: obs.prNumber,
        headSha: obs.headSha,
        source: obs.source,
        checkName: obs.checkName,
        conclusion: obs.conclusion,
        completedAt: obs.completedAt,
        rawPayloadEvidenceId: obs.rawPayloadEvidenceId
      });
    }
    return { repository, project, ticket };
  }

  it("merges when every gate passes and returns the merge result", async () => {
    const { repository } = await setup();
    const adapter = buildFixtureAdapter({});
    const decision = await evaluateAutoMerge(
      { ticketId: "project:auto-1:ticket:1", headSha: "deadbeef", prNumber: 99 },
      { repository, github: adapter, projectAutoMergeEnabled: true }
    );
    expect(decision.outcome).toBe("merge");
    expect(adapter.mergeCalls).toHaveLength(1);
    expect(adapter.mergeCalls[0]?.headSha).toBe("deadbeef");
  });

  it("is idempotent: re-evaluating an already-merged ticket returns skip without calling the merge API", async () => {
    const { repository } = await setup({
      ticket: { status: "merged", githubPrNumber: 99 }
    });
    const adapter = buildFixtureAdapter({});
    const decision = await evaluateAutoMerge(
      { ticketId: "project:auto-1:ticket:1", headSha: "deadbeef", prNumber: 99 },
      { repository, github: adapter, projectAutoMergeEnabled: true }
    );
    expect(decision.outcome).toBe("skip");
    expect(decision.reason).toBe("ticket_already_merged");
    expect(adapter.mergeCalls).toHaveLength(0);
  });

  it("posts exactly one PR comment + label on block_human_review (idempotent across re-fires)", async () => {
    const { repository } = await setup({
      ticket: { riskClass: "high" }
    });
    const adapter = buildFixtureAdapter({});
    const first = await evaluateAutoMerge(
      { ticketId: "project:auto-1:ticket:1", headSha: "deadbeef", prNumber: 99 },
      { repository, github: adapter, projectAutoMergeEnabled: true }
    );
    expect(first.outcome).toBe("block_human_review");
    expect(adapter.putLabels).toHaveLength(1);
    expect(adapter.putComments).toHaveLength(1);

    // Second invocation: PR now carries the blocked label, so we should
    // not re-comment.
    const adapterWithLabel = buildFixtureAdapter({
      pr: buildPrSnapshot({ labels: [AUTO_MERGE_LABELS.blocked] })
    });
    await evaluateAutoMerge(
      { ticketId: "project:auto-1:ticket:1", headSha: "deadbeef", prNumber: 99 },
      { repository, github: adapterWithLabel, projectAutoMergeEnabled: true }
    );
    expect(adapterWithLabel.putComments).toHaveLength(0);
    expect(adapterWithLabel.putLabels).toHaveLength(0);
  });

  it("notifier hook fires on block_human_review with the failed gates list", async () => {
    const { repository } = await setup({ ticket: { riskClass: "high" } });
    const adapter = buildFixtureAdapter({});
    const notifications: Array<{ kind: string; failedGates?: string[] }> = [];
    await evaluateAutoMerge(
      { ticketId: "project:auto-1:ticket:1", headSha: "deadbeef", prNumber: 99 },
      {
        repository,
        github: adapter,
        projectAutoMergeEnabled: true,
        notify: (n) => {
          notifications.push({
            kind: n.kind,
            ...(n.kind === "blocked" ? { failedGates: n.failedGates } : {})
          });
        }
      }
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.kind).toBe("blocked");
    expect(notifications[0]?.failedGates).toContain("high_risk_ticket");
  });

  it("notifier hook fires on merge with kind='merged' and an incrementing mergeIndex", async () => {
    const { repository } = await setup();
    const adapter = buildFixtureAdapter({});
    const notifications: Array<{ kind: string; mergeIndex?: number }> = [];
    await evaluateAutoMerge(
      { ticketId: "project:auto-1:ticket:1", headSha: "deadbeef", prNumber: 99 },
      {
        repository,
        github: adapter,
        projectAutoMergeEnabled: true,
        notify: (n) => {
          notifications.push({
            kind: n.kind,
            ...(n.kind === "merged" ? { mergeIndex: n.mergeIndex } : {})
          });
        }
      }
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.kind).toBe("merged");
    expect(notifications[0]?.mergeIndex).toBe(1);
  });

  it("does not call merge API when global flag is off", async () => {
    const { repository } = await setup();
    const adapter = buildFixtureAdapter({});
    await evaluateAutoMerge(
      { ticketId: "project:auto-1:ticket:1", headSha: "deadbeef", prNumber: 99 },
      { repository, github: adapter, projectAutoMergeEnabled: false }
    );
    expect(adapter.mergeCalls).toHaveLength(0);
  });

  it("returns block_human_review with merge_call_failed when merge throws", async () => {
    const { repository } = await setup();
    const failing: GitHubAutoMergeAdapter = {
      ...buildFixtureAdapter({}),
      async mergePullRequest() {
        throw new Error("merge conflict");
      }
    };
    const decision = await evaluateAutoMerge(
      { ticketId: "project:auto-1:ticket:1", headSha: "deadbeef", prNumber: 99 },
      { repository, github: failing, projectAutoMergeEnabled: true }
    );
    expect(decision.outcome).toBe("block_human_review");
    expect(decision.failedGates).toContain("merge_call_failed");
  });

  it("persists a gate_decision evidence record for non-skip outcomes", async () => {
    const { repository } = await setup();
    const adapter = buildFixtureAdapter({});
    await evaluateAutoMerge(
      { ticketId: "project:auto-1:ticket:1", headSha: "deadbeef", prNumber: 99 },
      { repository, github: adapter, projectAutoMergeEnabled: true }
    );
    // The evidence record taskId is the parent task id (project:<x>).
    const records = await repository.listEvidenceRecords("project:auto-1");
    const autoMerge = records.filter((r) => r.title.startsWith("Auto-merge decision"));
    expect(autoMerge).toHaveLength(1);
    expect(autoMerge[0]?.kind).toBe("gate_decision");
  });
});
