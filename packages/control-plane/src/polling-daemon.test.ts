import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PlanningAgent } from "@reddwarf/contracts";
import {
  DeterministicPlanningAgent,
  createBufferedPlanningLogger,
  createGitHubIssuePollingDaemon,
  parseAuthorAllowlistFromEnv,
  runPlanningPipeline
} from "@reddwarf/control-plane";
import {
  FixtureGitHubAdapter,
  FixtureOpenClawDispatchAdapter
} from "@reddwarf/integrations";
import {
  InMemoryPlanningRepository
} from "@reddwarf/evidence";

function createFixtureWorkspaceRepoBootstrapper() {
  return {
    async ensureRepo(input: {
      workspace: { workspaceRoot: string };
      baseBranch: string;
      manifest: { source: { repo: string } };
    }) {
      const repoRoot = join(input.workspace.workspaceRoot, "repo");
      await mkdir(join(repoRoot, "docs"), { recursive: true });
      await writeFile(join(repoRoot, "README.md"), "# Fixture repo\n", "utf8");
      await writeFile(
        join(repoRoot, "docs", "rollout-plan.md"),
        "# Rollout plan\n",
        "utf8"
      );
      await writeFile(
        join(repoRoot, "docs", "rollout-checklist.md"),
        "# Rollout checklist\n",
        "utf8"
      );
      return {
        repoRoot,
        baseBranch: input.baseBranch,
        remoteUrl: `https://github.com/${input.manifest.source.repo}.git`
      };
    }
  };
}

describe("GitHub issue polling daemon", () => {
  it("polls configured repositories and runs planning for new issue candidates", async () => {
    const repository = new InMemoryPlanningRepository();
    const github = new FixtureGitHubAdapter({
      candidates: [
        {
          repo: "acme/platform",
          issueNumber: 71,
          title: "Poll the first issue",
          body: [
            "This issue should be ingested by the polling daemon.",
            "",
            "Acceptance Criteria:",
            "- Planning input is created from polling",
            "",
            "Affected Paths:",
            "- docs/polling.md",
            "",
            "Requested Capabilities:",
            "- can_plan",
            "- can_archive_evidence"
          ].join("\n"),
          labels: ["ai-eligible", "priority:4"],
          url: "https://github.com/acme/platform/issues/71",
          state: "open"
        }
      ]
    });
    const daemon = createGitHubIssuePollingDaemon(
      {
        intervalMs: 5_000,
        repositories: [{ repo: "acme/platform" }],
        runOnStart: false
      },
      {
        repository,
        github,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-27T09:00:00.000Z"),
        idGenerator: () => "poll-run-001"
      }
    );

    const cycle = await daemon.pollOnce();

    expect(cycle.plannedIssueCount).toBe(1);
    expect(cycle.skippedIssueCount).toBe(0);
    expect(cycle.decisions[0]).toMatchObject({
      repo: "acme/platform",
      issueNumber: 71,
      action: "planned"
    });
    expect(repository.planningSpecs.size).toBe(1);
  });


  it("advances per-repo cursors and only ingests newer issues", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveGitHubIssuePollingCursor({
      repo: "acme/platform",
      lastSeenIssueNumber: 71,
      lastSeenUpdatedAt: "2026-03-27T08:59:00.000Z",
      lastPollStartedAt: "2026-03-27T08:59:00.000Z",
      lastPollCompletedAt: "2026-03-27T08:59:10.000Z",
      lastPollStatus: "succeeded",
      lastPollError: null,
      updatedAt: "2026-03-27T08:59:10.000Z"
    });
    const github = new FixtureGitHubAdapter({
      candidates: [
        {
          repo: "acme/platform",
          issueNumber: 71,
          title: "Already seen",
          body: "Previously seen issue.",
          labels: ["ai-eligible"],
          url: "https://github.com/acme/platform/issues/71",
          state: "open",
          updatedAt: "2026-03-27T08:59:00.000Z"
        },
        {
          repo: "acme/platform",
          issueNumber: 72,
          title: "New issue",
          body: [
            "This issue should advance the polling cursor.",
            "",
            "Acceptance Criteria:",
            "- Only newer issues are planned"
          ].join("\n"),
          labels: ["ai-eligible", "priority:4"],
          url: "https://github.com/acme/platform/issues/72",
          state: "open",
          updatedAt: "2026-03-27T09:02:00.000Z"
        }
      ]
    });
    const daemon = createGitHubIssuePollingDaemon(
      {
        intervalMs: 5_000,
        repositories: [{ repo: "acme/platform" }],
        runOnStart: false
      },
      {
        repository,
        github,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-27T09:03:00.000Z"),
        idGenerator: () => "poll-run-cursor-001"
      }
    );

    const cycle = await daemon.pollOnce();
    const cursor = await repository.getGitHubIssuePollingCursor("acme/platform");

    expect(cycle.decisions).toHaveLength(1);
    expect(cycle.decisions[0]).toMatchObject({
      repo: "acme/platform",
      issueNumber: 72,
      action: "planned"
    });
    expect(cursor).toMatchObject({
      repo: "acme/platform",
      lastSeenIssueNumber: 72,
      lastSeenUpdatedAt: "2026-03-27T09:02:00.000Z",
      lastPollStatus: "succeeded"
    });
  });

  it("polls repositories sourced from persisted cursor state when no static repo list is configured", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveGitHubIssuePollingCursor({
      repo: "acme/platform",
      lastSeenIssueNumber: null,
      lastSeenUpdatedAt: null,
      lastPollStartedAt: null,
      lastPollCompletedAt: null,
      lastPollStatus: null,
      lastPollError: null,
      updatedAt: "2026-03-27T09:00:00.000Z"
    });
    const github = new FixtureGitHubAdapter({
      candidates: [
        {
          repo: "acme/platform",
          issueNumber: 73,
          title: "DB-managed repo intake",
          body: [
            "This issue should be planned from a repo managed only in the database.",
            "",
            "Acceptance Criteria:",
            "- Polling uses persisted repo state"
          ].join("\n"),
          labels: ["ai-eligible", "priority:4"],
          url: "https://github.com/acme/platform/issues/73",
          state: "open"
        }
      ]
    });
    const daemon = createGitHubIssuePollingDaemon(
      {
        intervalMs: 5_000,
        repositories: [],
        runOnStart: false
      },
      {
        repository,
        github,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-27T09:05:00.000Z"),
        idGenerator: () => "poll-run-db-managed-001"
      }
    );

    const cycle = await daemon.pollOnce();

    expect(cycle.plannedIssueCount).toBe(1);
    expect(cycle.decisions[0]).toMatchObject({
      repo: "acme/platform",
      issueNumber: 73,
      action: "planned"
    });
  });

  it("routes medium GitHub issues into project mode when OpenClaw planning deps are available", async () => {
    const repository = new InMemoryPlanningRepository();
    const github = new FixtureGitHubAdapter({
      candidates: [
        {
          repo: "acme/platform",
          issueNumber: 74,
          title: "Break down a multi-step rollout",
          body: [
            "## Summary",
            "",
            "This request should enter project mode instead of the single-issue path.",
            "",
            "## Acceptance Criteria",
            "",
            "- The issue is classified above small",
            "- Project planning persists a ProjectSpec",
            "- Ticket decomposition contains at least two tickets",
            "- The planning spec preserves the classified project size",
            "",
            "## Affected Paths",
            "",
            "- docs/rollout-plan.md",
            "- docs/rollout-checklist.md",
            "",
            "## Requested Capabilities",
            "",
            "- can_plan",
            "- can_archive_evidence"
          ].join("\n"),
          labels: ["ai-eligible", "priority:4"],
          url: "https://github.com/acme/platform/issues/74",
          state: "open"
        }
      ]
    });
    const architectTargetRoot = await mkdtemp(join(tmpdir(), "poll-project-mode-"));
    const daemon = createGitHubIssuePollingDaemon(
      {
        intervalMs: 5_000,
        repositories: [{ repo: "acme/platform" }],
        runOnStart: false
      },
      {
        repository,
        github,
        planner: new DeterministicPlanningAgent(),
        openClawDispatch: new FixtureOpenClawDispatchAdapter({
          fixedSessionId: "session-project-mode-001"
        }),
        architectTargetRoot,
        workspaceRepoBootstrapper: createFixtureWorkspaceRepoBootstrapper(),
        openClawArchitectAwaiter: {
          async waitForCompletion(input: {
            workspace: { workspaceId: string; artifactsDir: string };
          }) {
            const isProjectMode = input.workspace.workspaceId.endsWith(
              "-project-architect"
            );
            const handoffPath = join(
              input.workspace.artifactsDir,
              isProjectMode
                ? "project-architect-handoff.md"
                : "architect-handoff.md"
            );
            await writeFile(
              handoffPath,
              (
                isProjectMode
                  ? [
                      "# Project Architecture Handoff",
                      "",
                      "- Task ID: acme-platform-74",
                      "- Repository: acme/platform",
                      "- Architect: Holly (reddwarf-analyst)",
                      "- Confidence: high",
                      "- Confidence reason: The work is broad enough to benefit from ticket decomposition.",
                      "",
                      "## Project Title",
                      "",
                      "Rollout Planning Corridor",
                      "",
                      "## Project Summary",
                      "",
                      "Break the rollout into sequential planning and execution tickets.",
                      "",
                      "## Tickets",
                      "",
                      "### Ticket: Draft the rollout plan",
                      "",
                      "- Complexity: low",
                      "- Depends on: none",
                      "",
                      "#### Description",
                      "",
                      "Create the initial rollout plan document.",
                      "",
                      "#### Acceptance Criteria",
                      "",
                      "- Draft plan exists",
                      "- Stakeholders can review it",
                      "",
                      "### Ticket: Finalize rollout checklist",
                      "",
                      "- Complexity: medium",
                      "- Depends on: Draft the rollout plan",
                      "",
                      "#### Description",
                      "",
                      "Turn the approved plan into a final checklist for execution.",
                      "",
                      "#### Acceptance Criteria",
                      "",
                      "- Checklist reflects the approved rollout plan",
                      "- Dependencies are captured",
                      ""
                    ]
                  : [
                      "# Architecture Handoff",
                      "",
                      "- Task ID: acme-platform-74",
                      "- Repository: acme/platform",
                      "- Architect: Holly (reddwarf-analyst)",
                      "- Confidence: high",
                      "- Confidence reason: The issue has enough detail for a deterministic planning pass.",
                      "",
                      "## Summary",
                      "",
                      "Plan the rollout work before decomposing it into project tickets.",
                      "",
                      "## Implementation Approach",
                      "",
                      "Capture the rollout scope, affected documents, and validation expectations.",
                      "",
                      "## Affected Files",
                      "",
                      "- docs/rollout-plan.md",
                      "- docs/rollout-checklist.md",
                      "",
                      "## Risks and Assumptions",
                      "",
                      "- The rollout can be broken into at least two serial tickets.",
                      "",
                      "## Test Strategy",
                      "",
                      "- Verify the plan and checklist stay aligned.",
                      "",
                      "## Non-Goals",
                      "",
                      "- Do not execute the rollout during planning."
                    ]
              ).join("\n"),
              "utf8"
            );
            return { handoffPath, repoRoot: null };
          }
        } as never,
        clock: () => new Date("2026-03-27T09:06:00.000Z"),
        idGenerator: () => "poll-run-project-mode-001"
      }
    );

    try {
      const cycle = await daemon.pollOnce();
      const planningSpec = [...repository.planningSpecs.values()][0];
      const projectSpec = await repository.getProjectSpec(
        "project:acme-platform-74"
      );
      const ticketSpecs = await repository.listTicketSpecs("project:acme-platform-74");

      expect(cycle.plannedIssueCount).toBe(1);
      expect(cycle.decisions[0]).toMatchObject({
        repo: "acme/platform",
        issueNumber: 74,
        action: "planned"
      });
      expect(planningSpec?.projectSize).toBe("medium");
      expect(projectSpec?.projectSize).toBe("medium");
      expect(projectSpec?.status).toBe("pending_approval");
      expect(ticketSpecs).toHaveLength(2);
    } finally {
      await rm(architectTargetRoot, { recursive: true, force: true });
    }
  });

  it("skips issues that already have a persisted planning spec", async () => {
    const repository = new InMemoryPlanningRepository();
    const github = new FixtureGitHubAdapter({
      candidates: [
        {
          repo: "acme/platform",
          issueNumber: 72,
          title: "Poll the duplicate issue",
          body: [
            "This issue already has a planning spec and should be skipped.",
            "",
            "Acceptance Criteria:",
            "- Duplicate issues are skipped"
          ].join("\n"),
          labels: ["ai-eligible", "priority:4"],
          url: "https://github.com/acme/platform/issues/72",
          state: "open"
        }
      ]
    });

    await runPlanningPipeline(
      {
        source: {
          provider: "github",
          repo: "acme/platform",
          issueNumber: 72,
          issueUrl: "https://github.com/acme/platform/issues/72"
        },
        title: "Pre-existing planning issue",
        summary:
          "This planning task already exists and should cause the polling daemon to skip duplicate intake.",
        priority: 4,
        dryRun: false,
        labels: ["ai-eligible"],
        acceptanceCriteria: ["Duplicate intake is skipped."],
        affectedPaths: ["docs/polling.md"],
        requestedCapabilities: ["can_plan", "can_archive_evidence"],
        metadata: {}
      },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-27T09:01:00.000Z"),
        idGenerator: () => "poll-existing-001"
      }
    );

    const daemon = createGitHubIssuePollingDaemon(
      {
        intervalMs: 5_000,
        repositories: [{ repo: "acme/platform" }],
        runOnStart: false
      },
      {
        repository,
        github,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-27T09:02:00.000Z"),
        idGenerator: () => "poll-run-002"
      }
    );

    const cycle = await daemon.pollOnce();

    expect(cycle.plannedIssueCount).toBe(0);
    expect(cycle.skippedIssueCount).toBe(1);
    expect(cycle.decisions).toEqual([
      {
        repo: "acme/platform",
        issueNumber: 72,
        action: "skipped",
        reason: "existing_planning_spec"
      }
    ]);
    expect(repository.planningSpecs.size).toBe(1);
  });
});

describe("GitHub issue polling daemon backoff", () => {
  it("applies exponential backoff after consecutive failures", async () => {
    const repository = new InMemoryPlanningRepository();
    const errorAdapter = new FixtureGitHubAdapter({ candidates: [] });
    errorAdapter.listIssueCandidates = async () => {
      throw new Error("GitHub API unavailable");
    };

    const logMessages: { level: string; msg: string; meta?: unknown }[] = [];
    const logger = {
      info: (msg: string, meta?: unknown) => logMessages.push({ level: "info", msg, meta }),
      warn: (msg: string, meta?: unknown) => logMessages.push({ level: "warn", msg, meta }),
      error: (msg: string, meta?: unknown) => logMessages.push({ level: "error", msg, meta }),
      child: () => logger
    };

    const daemon = createGitHubIssuePollingDaemon(
      {
        intervalMs: 5_000,
        repositories: [{ repo: "acme/platform" }],
        runOnStart: false
      },
      {
        repository,
        github: errorAdapter,
        planner: new DeterministicPlanningAgent(),
        logger
      }
    );

    expect(daemon.consecutiveFailures).toBe(0);

    await daemon.pollOnce().catch(() => {});
    expect(daemon.consecutiveFailures).toBe(1);

    await daemon.pollOnce().catch(() => {});
    expect(daemon.consecutiveFailures).toBe(2);

    const errorLogs = logMessages.filter((l) => l.level === "error");
    expect(errorLogs.length).toBeGreaterThanOrEqual(2);
    expect((errorLogs[1]?.meta as Record<string, unknown>)?.backoffMs).toBeGreaterThan(0);
  });

  it("resets backoff after a successful poll", async () => {
    const repository = new InMemoryPlanningRepository();
    let shouldFail = true;

    const adapter = new FixtureGitHubAdapter({ candidates: [] });
    const originalList = adapter.listIssueCandidates.bind(adapter);
    adapter.listIssueCandidates = async (query) => {
      if (shouldFail) throw new Error("temporary failure");
      return originalList(query);
    };

    const daemon = createGitHubIssuePollingDaemon(
      {
        intervalMs: 5_000,
        repositories: [{ repo: "acme/platform" }],
        runOnStart: false
      },
      {
        repository,
        github: adapter,
        planner: new DeterministicPlanningAgent()
      }
    );

    await daemon.pollOnce().catch(() => {});
    expect(daemon.consecutiveFailures).toBe(1);

    shouldFail = false;
    await daemon.pollOnce();
    expect(daemon.consecutiveFailures).toBe(0);
  });

  it("keeps the poller running after a startup-cycle failure and records degraded health", async () => {
    const repository = new InMemoryPlanningRepository();
    const adapter = new FixtureGitHubAdapter({ candidates: [] });
    const bufferedLogger = createBufferedPlanningLogger();
    adapter.listIssueCandidates = async () => {
      throw new Error("GitHub API unavailable");
    };

    const daemon = createGitHubIssuePollingDaemon(
      {
        intervalMs: 5_000,
        repositories: [{ repo: "acme/platform" }]
      },
      {
        repository,
        github: adapter,
        planner: new DeterministicPlanningAgent(),
        logger: bufferedLogger.logger,
        scheduler: {
          setInterval: () => ({ handle: "poll" }),
          clearInterval() {}
        },
        clock: () => new Date("2026-03-29T13:05:00.000Z")
      }
    );

    await expect(daemon.start()).resolves.toBeUndefined();
    expect(daemon.isRunning).toBe(true);
    expect(daemon.consecutiveFailures).toBe(1);
    expect(daemon.health.status).toBe("degraded");
    expect(daemon.health.startupStatus).toBe("degraded");
    expect(daemon.health.lastError).toBe("GitHub API unavailable");
    expect(
      bufferedLogger.records.some(
        (record) => record.bindings.code === "POLLING_STARTUP_DEGRADED"
      )
    ).toBe(true);

    await daemon.stop();
    expect(daemon.health.status).toBe("idle");
  });

  it("emits structured log records for successful poll cycles", async () => {
    const repository = new InMemoryPlanningRepository();
    const bufferedLogger = createBufferedPlanningLogger();
    const daemon = createGitHubIssuePollingDaemon(
      {
        intervalMs: 5_000,
        repositories: [{ repo: "acme/platform" }],
        runOnStart: false
      },
      {
        repository,
        github: new FixtureGitHubAdapter({ candidates: [] }),
        planner: new DeterministicPlanningAgent(),
        logger: bufferedLogger.logger,
        clock: () => new Date("2026-03-29T13:10:00.000Z")
      }
    );

    await daemon.pollOnce();

    expect(
      bufferedLogger.records.some(
        (record) =>
          record.bindings.code === "POLLING_CYCLE_COMPLETED" &&
          record.bindings.component === "github-poller"
      )
    ).toBe(true);
  });

  it("fails fast when a poll cycle exceeds the configured timeout", async () => {
    vi.useFakeTimers();

    try {
      const repository = new InMemoryPlanningRepository();
      const adapter = new FixtureGitHubAdapter({ candidates: [] });
      adapter.listIssueCandidates = async () => new Promise(() => {});

      const daemon = createGitHubIssuePollingDaemon(
        {
          intervalMs: 5_000,
          cycleTimeoutMs: 2_000,
          repositories: [{ repo: "acme/platform" }],
          runOnStart: false
        },
        {
          repository,
          github: adapter,
          planner: new DeterministicPlanningAgent(),
          clock: () => new Date("2026-03-29T13:00:00.000Z")
        }
      );

      const pending = daemon.pollOnce();
      const expectation = expect(pending).rejects.toThrow(
        "GitHub issue polling cycle for acme/platform timed out after 2000ms."
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await expectation;
      expect(daemon.consecutiveFailures).toBe(1);

      const cursor = await repository.getGitHubIssuePollingCursor("acme/platform");
      expect(cursor?.lastPollStatus).toBe("failed");
      expect(cursor?.lastPollError).toContain("timed out after 2000ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fail a poll cycle just because planning takes longer than the fetch timeout", async () => {
    vi.useFakeTimers();

    try {
      const repository = new InMemoryPlanningRepository();
      const github = new FixtureGitHubAdapter({
        candidates: [
          {
            repo: "acme/platform",
            issueNumber: 75,
            title: "Slow planning should still complete",
            body: [
              "This issue simulates a slow architect pass.",
              "",
              "Acceptance Criteria:",
              "- Polling still completes successfully",
              "",
              "Affected Paths:",
              "- docs/polling-timeouts.md",
              "",
              "Requested Capabilities:",
              "- can_plan",
              "- can_archive_evidence"
            ].join("\n"),
            labels: ["ai-eligible"],
            url: "https://github.com/acme/platform/issues/75",
            state: "open",
            updatedAt: "2026-03-29T13:00:00.000Z"
          }
        ]
      });
      const deterministicPlanner = new DeterministicPlanningAgent();
      const slowPlanner: PlanningAgent = {
        async createSpec(input, context) {
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          return deterministicPlanner.createSpec(input, context);
        }
      };

      const daemon = createGitHubIssuePollingDaemon(
        {
          intervalMs: 5_000,
          cycleTimeoutMs: 2_000,
          repositories: [{ repo: "acme/platform" }],
          runOnStart: false
        },
        {
          repository,
          github,
          planner: slowPlanner,
          clock: () => new Date("2026-03-29T13:00:00.000Z"),
          idGenerator: () => "slow-plan-001"
        }
      );

      const pending = daemon.pollOnce();
      await vi.advanceTimersByTimeAsync(3_000);
      const cycle = await pending;

      expect(cycle.plannedIssueCount).toBe(1);
      expect(cycle.decisions[0]).toMatchObject({
        repo: "acme/platform",
        issueNumber: 75,
        action: "planned"
      });

      const cursor = await repository.getGitHubIssuePollingCursor("acme/platform");
      expect(cursor?.lastSeenIssueNumber).toBe(75);
      expect(cursor?.lastPollStatus).toBe("succeeded");
      expect(daemon.consecutiveFailures).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Author allowlist
// ---------------------------------------------------------------------------

function makeIssueCandidate(
  overrides: Partial<{
    issueNumber: number;
    author: string;
    title: string;
  }> = {}
) {
  return {
    repo: "acme/platform",
    issueNumber: overrides.issueNumber ?? 100,
    title: overrides.title ?? "Allowlist test issue",
    body: [
      "Test issue for author allowlist.",
      "",
      "Acceptance Criteria:",
      "- Author allowlist is enforced",
      "",
      "Affected Paths:",
      "- docs/allowlist.md",
      "",
      "Requested Capabilities:",
      "- can_plan",
      "- can_archive_evidence"
    ].join("\n"),
    labels: ["ai-eligible"],
    url: `https://github.com/acme/platform/issues/${overrides.issueNumber ?? 100}`,
    state: "open" as const,
    author: overrides.author ?? "alice",
    updatedAt: "2026-03-30T10:00:00.000Z"
  };
}

describe("GitHub issue polling daemon – author allowlist", () => {
  it("accepts an issue from a listed author when allowlist is configured on daemon", async () => {
    const repository = new InMemoryPlanningRepository();
    const github = new FixtureGitHubAdapter({
      candidates: [makeIssueCandidate({ issueNumber: 101, author: "alice" })]
    });

    const daemon = createGitHubIssuePollingDaemon(
      {
        intervalMs: 5_000,
        repositories: [{ repo: "acme/platform" }],
        runOnStart: false,
        authorAllowlist: ["alice", "bob"]
      },
      {
        repository,
        github,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-30T10:01:00.000Z"),
        idGenerator: () => "allowlist-accept-001"
      }
    );

    const cycle = await daemon.pollOnce();

    expect(cycle.plannedIssueCount).toBe(1);
    expect(cycle.rejectedIssueCount).toBe(0);
    expect(cycle.decisions[0]).toMatchObject({
      repo: "acme/platform",
      issueNumber: 101,
      action: "planned"
    });
  });

  it("rejects an issue from a non-listed author when allowlist is configured on daemon", async () => {
    const repository = new InMemoryPlanningRepository();
    const bufferedLogger = createBufferedPlanningLogger();
    const github = new FixtureGitHubAdapter({
      candidates: [makeIssueCandidate({ issueNumber: 102, author: "mallory" })]
    });

    const daemon = createGitHubIssuePollingDaemon(
      {
        intervalMs: 5_000,
        repositories: [{ repo: "acme/platform" }],
        runOnStart: false,
        authorAllowlist: ["alice", "bob"]
      },
      {
        repository,
        github,
        planner: new DeterministicPlanningAgent(),
        logger: bufferedLogger.logger,
        clock: () => new Date("2026-03-30T10:02:00.000Z"),
        idGenerator: () => "allowlist-reject-001"
      }
    );

    const cycle = await daemon.pollOnce();

    expect(cycle.plannedIssueCount).toBe(0);
    expect(cycle.rejectedIssueCount).toBe(1);
    expect(cycle.decisions[0]).toMatchObject({
      repo: "acme/platform",
      issueNumber: 102,
      action: "rejected",
      reason: "author_not_allowlisted"
    });
    expect(repository.planningSpecs.size).toBe(0);
    // Verify the structured log record was emitted
    expect(
      bufferedLogger.records.some(
        (record) => record.bindings.code === "INTAKE_AUTHOR_REJECTED"
      )
    ).toBe(true);
  });

  it("accepts all issues when no allowlist is configured (backward compatibility)", async () => {
    const repository = new InMemoryPlanningRepository();
    const github = new FixtureGitHubAdapter({
      candidates: [
        makeIssueCandidate({ issueNumber: 103, author: "anyone" }),
        makeIssueCandidate({ issueNumber: 104, author: "anonymous" })
      ]
    });

    const daemon = createGitHubIssuePollingDaemon(
      {
        intervalMs: 5_000,
        repositories: [{ repo: "acme/platform" }],
        runOnStart: false
        // no authorAllowlist
      },
      {
        repository,
        github,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-30T10:03:00.000Z"),
        idGenerator: () => "no-allowlist-001"
      }
    );

    const cycle = await daemon.pollOnce();

    expect(cycle.plannedIssueCount).toBe(2);
    expect(cycle.rejectedIssueCount).toBe(0);
  });

  it("rejects all issues when allowlist is configured as empty array (full default-deny)", async () => {
    const repository = new InMemoryPlanningRepository();
    const github = new FixtureGitHubAdapter({
      candidates: [makeIssueCandidate({ issueNumber: 105, author: "alice" })]
    });

    const daemon = createGitHubIssuePollingDaemon(
      {
        intervalMs: 5_000,
        repositories: [{ repo: "acme/platform" }],
        runOnStart: false,
        authorAllowlist: []
      },
      {
        repository,
        github,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-30T10:04:00.000Z"),
        idGenerator: () => "empty-allowlist-001"
      }
    );

    const cycle = await daemon.pollOnce();

    expect(cycle.plannedIssueCount).toBe(0);
    expect(cycle.rejectedIssueCount).toBe(1);
    expect(cycle.decisions[0]).toMatchObject({
      action: "rejected",
      reason: "author_not_allowlisted"
    });
  });

  it("per-repo allowlist overrides the daemon-level allowlist", async () => {
    const repository = new InMemoryPlanningRepository();
    const github = new FixtureGitHubAdapter({
      candidates: [
        makeIssueCandidate({ issueNumber: 106, author: "carol" })
      ]
    });

    const daemon = createGitHubIssuePollingDaemon(
      {
        intervalMs: 5_000,
        repositories: [
          {
            repo: "acme/platform",
            // Per-repo allowlist includes "carol" even though daemon list does not
            authorAllowlist: ["carol"]
          }
        ],
        runOnStart: false,
        authorAllowlist: ["alice"] // daemon-level would reject "carol"
      },
      {
        repository,
        github,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-30T10:05:00.000Z"),
        idGenerator: () => "per-repo-override-001"
      }
    );

    const cycle = await daemon.pollOnce();

    expect(cycle.plannedIssueCount).toBe(1);
    expect(cycle.rejectedIssueCount).toBe(0);
  });

  it("rejects an issue when author field is absent and allowlist is configured", async () => {
    const repository = new InMemoryPlanningRepository();
    const { author: _dropped, ...candidateWithoutAuthor } = makeIssueCandidate({ issueNumber: 107 });
    const github = new FixtureGitHubAdapter({
      candidates: [candidateWithoutAuthor]
    });

    const daemon = createGitHubIssuePollingDaemon(
      {
        intervalMs: 5_000,
        repositories: [{ repo: "acme/platform" }],
        runOnStart: false,
        authorAllowlist: ["alice"]
      },
      {
        repository,
        github,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-30T10:06:00.000Z"),
        idGenerator: () => "no-author-reject-001"
      }
    );

    const cycle = await daemon.pollOnce();

    expect(cycle.rejectedIssueCount).toBe(1);
    expect(cycle.decisions[0]).toMatchObject({
      action: "rejected",
      reason: "author_not_allowlisted"
    });
  });
});

describe("parseAuthorAllowlistFromEnv", () => {
  it("returns undefined when env var is absent", () => {
    expect(parseAuthorAllowlistFromEnv(undefined)).toBeUndefined();
  });

  it("returns undefined when env var is blank", () => {
    expect(parseAuthorAllowlistFromEnv("   ")).toBeUndefined();
  });

  it("parses a single username", () => {
    expect(parseAuthorAllowlistFromEnv("alice")).toEqual(["alice"]);
  });

  it("parses comma-separated usernames and trims whitespace", () => {
    expect(parseAuthorAllowlistFromEnv(" alice , bob , carol ")).toEqual([
      "alice",
      "bob",
      "carol"
    ]);
  });

  it("discards empty entries from consecutive commas", () => {
    expect(parseAuthorAllowlistFromEnv("alice,,bob")).toEqual(["alice", "bob"]);
  });
});
