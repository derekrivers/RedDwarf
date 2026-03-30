import { describe, expect, it, vi } from "vitest";
import {
  DeterministicPlanningAgent,
  createBufferedPlanningLogger,
  createGitHubIssuePollingDaemon,
  runPlanningPipeline
} from "@reddwarf/control-plane";
import {
  FixtureGitHubAdapter
} from "@reddwarf/integrations";
import {
  InMemoryPlanningRepository
} from "@reddwarf/evidence";

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
});
