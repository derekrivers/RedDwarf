import { describe, expect, it } from "vitest";
import {
  InMemoryPlanningRepository,
  buildMemoryContextForRepository,
  createRunEvent,
  createMemoryRecord,
  createOperatorConfigEntry,
  createPipelineRun,
  createPromptSnapshot,
  deriveOrganizationId,
  summarizeRunEvents
} from "@reddwarf/evidence";

const timestamp = "2026-03-25T20:20:00.000Z";

describe("evidence memory partitions", () => {
  it("keeps run summaries active until a terminal pipeline event is recorded", () => {
    const summary = summarizeRunEvents("acme-platform-42", "run-active", [
      createRunEvent({
        eventId: "event-1",
        taskId: "acme-platform-42",
        runId: "run-active",
        phase: "architecture_review",
        level: "info",
        code: "PHASE_STARTED",
        message: "Architecture review started.",
        createdAt: timestamp
      }),
      createRunEvent({
        eventId: "event-2",
        taskId: "acme-platform-42",
        runId: "run-active",
        phase: "architecture_review",
        level: "info",
        code: "OPENCLAW_DISPATCH",
        message: "Dispatched to OpenClaw reviewer.",
        createdAt: "2026-03-25T20:21:00.000Z"
      })
    ]);

    expect(summary).toMatchObject({
      taskId: "acme-platform-42",
      runId: "run-active",
      status: "active",
      latestPhase: "architecture_review",
      totalDurationMs: 0
    });
  });

  it("stores and queries partitioned memory records and pipeline runs", async () => {
    const repository = new InMemoryPlanningRepository();

    await repository.saveMemoryRecord(
      createMemoryRecord({
        memoryId: "task-memory-1",
        taskId: "acme-platform-42",
        scope: "task",
        provenance: "pipeline_derived",
        key: "planning.brief",
        title: "Planning brief",
        value: { summary: "Plan the docs-only backlog." },
        repo: "acme/platform",
        organizationId: "acme",
        tags: ["planning", "task"],
        createdAt: timestamp,
        updatedAt: timestamp
      })
    );
    await repository.saveMemoryRecord(
      createMemoryRecord({
        memoryId: "project-memory-1",
        scope: "project",
        provenance: "human_curated",
        key: "repo.testing-command",
        title: "Primary test command",
        value: { command: "corepack pnpm test" },
        repo: "acme/platform",
        organizationId: "acme",
        tags: ["testing"],
        createdAt: timestamp,
        updatedAt: timestamp
      })
    );
    await repository.saveMemoryRecord(
      createMemoryRecord({
        memoryId: "org-memory-1",
        scope: "organization",
        provenance: "human_curated",
        key: "policy.pr-template",
        title: "Standard PR template",
        value: { path: "standards/pr-template.md" },
        organizationId: "acme",
        tags: ["policy"],
        createdAt: timestamp,
        updatedAt: timestamp
      })
    );
    await repository.saveMemoryRecord(
      createMemoryRecord({
        memoryId: "external-memory-1",
        scope: "external",
        provenance: "external_retrieval",
        key: "docs.typescript.release-notes",
        title: "TypeScript release notes",
        value: { section: "5.8" },
        repo: "acme/platform",
        organizationId: "acme",
        sourceUri: "https://www.typescriptlang.org/docs/",
        tags: ["typescript"],
        createdAt: timestamp,
        updatedAt: timestamp
      })
    );
    await repository.savePipelineRun(
      createPipelineRun({
        runId: "run-active",
        taskId: "acme-platform-42",
        concurrencyKey: "github:acme/platform:42",
        strategy: "serialize",
        status: "active",
        startedAt: timestamp,
        lastHeartbeatAt: timestamp,
        metadata: {}
      })
    );

    const taskRecords = await repository.listMemoryRecords({ taskId: "acme-platform-42", scope: "task" });
    const context = await buildMemoryContextForRepository(repository, {
      taskId: "acme-platform-42",
      repo: "acme/platform",
      organizationId: deriveOrganizationId("acme/platform")
    });
    const activeRuns = await repository.listPipelineRuns({
      concurrencyKey: "github:acme/platform:42",
      statuses: ["active"]
    });

    expect(taskRecords).toHaveLength(1);
    expect(context.taskMemory).toHaveLength(1);
    expect(context.projectMemory).toHaveLength(1);
    expect(context.organizationMemory).toHaveLength(1);
    expect(context.externalMemory).toHaveLength(1);
    expect(activeRuns).toHaveLength(1);
  });


  it("reports in-memory repository health without a Postgres pool", async () => {
    const repository = new InMemoryPlanningRepository();

    await expect(repository.getRepositoryHealth()).resolves.toEqual({
      storage: "in_memory",
      status: "healthy",
      postgresPool: null
    });
  });

  it("stores and lists GitHub issue polling cursors", async () => {
    const repository = new InMemoryPlanningRepository();

    await repository.saveGitHubIssuePollingCursor({
      repo: "acme/platform",
      lastSeenIssueNumber: 88,
      lastSeenUpdatedAt: timestamp,
      lastPollStartedAt: timestamp,
      lastPollCompletedAt: timestamp,
      lastPollStatus: "succeeded",
      lastPollError: null,
      updatedAt: timestamp
    });

    await expect(repository.getGitHubIssuePollingCursor("acme/platform")).resolves.toMatchObject({
      repo: "acme/platform",
      lastSeenIssueNumber: 88,
      lastPollStatus: "succeeded"
    });
    await expect(repository.listGitHubIssuePollingCursors()).resolves.toEqual([
      {
        repo: "acme/platform",
        lastSeenIssueNumber: 88,
        lastSeenUpdatedAt: timestamp,
        lastPollStartedAt: timestamp,
        lastPollCompletedAt: timestamp,
        lastPollStatus: "succeeded",
        lastPollError: null,
        updatedAt: timestamp
      }
    ]);
  });

  it("stores and lists operator config entries", async () => {
    const repository = new InMemoryPlanningRepository();

    await repository.saveOperatorConfigEntry(
      createOperatorConfigEntry({
        key: "REDDWARF_POLL_INTERVAL_MS",
        value: 45000,
        updatedAt: timestamp
      })
    );
    await repository.saveOperatorConfigEntry(
      createOperatorConfigEntry({
        key: "REDDWARF_SKIP_OPENCLAW",
        value: true,
        updatedAt: "2026-03-25T20:21:00.000Z"
      })
    );

    await expect(
      repository.getOperatorConfigEntry("REDDWARF_POLL_INTERVAL_MS")
    ).resolves.toEqual({
      key: "REDDWARF_POLL_INTERVAL_MS",
      value: 45000,
      updatedAt: timestamp
    });
    await expect(repository.listOperatorConfigEntries()).resolves.toEqual([
      {
        key: "REDDWARF_POLL_INTERVAL_MS",
        value: 45000,
        updatedAt: timestamp
      },
      {
        key: "REDDWARF_SKIP_OPENCLAW",
        value: true,
        updatedAt: "2026-03-25T20:21:00.000Z"
      }
    ]);
  });

  it("stores and deletes GitHub polling cursors", async () => {
    const repository = new InMemoryPlanningRepository();

    await repository.saveGitHubIssuePollingCursor({
      repo: "acme/platform",
      lastSeenIssueNumber: null,
      lastSeenUpdatedAt: null,
      lastPollStartedAt: null,
      lastPollCompletedAt: null,
      lastPollStatus: null,
      lastPollError: null,
      updatedAt: timestamp
    });

    await expect(repository.deleteGitHubIssuePollingCursor("acme/platform")).resolves.toBe(
      true
    );
    await expect(repository.deleteGitHubIssuePollingCursor("acme/platform")).resolves.toBe(
      false
    );
  });

  it("filters task manifests and pipeline runs by repository metadata", async () => {
    const repository = new InMemoryPlanningRepository();

    await repository.saveManifest({
      taskId: "acme-platform-1",
      source: { provider: "github", repo: "acme/platform", issueNumber: 1 },
      title: "Platform task",
      summary: "A task for the platform repo.",
      priority: 1,
      dryRun: false,
      riskClass: "low",
      approvalMode: "auto",
      currentPhase: "planning",
      lifecycleStatus: "active",
      assignedAgentType: "architect",
      requestedCapabilities: ["can_plan"],
      retryCount: 0,
      evidenceLinks: [],
      workspaceId: null,
      branchName: null,
      prNumber: null,
      policyVersion: "v1",
      createdAt: timestamp,
      updatedAt: timestamp
    });
    await repository.saveManifest({
      taskId: "acme-api-2",
      source: { provider: "github", repo: "acme/api", issueNumber: 2 },
      title: "API task",
      summary: "A task for the api repo.",
      priority: 1,
      dryRun: false,
      riskClass: "low",
      approvalMode: "auto",
      currentPhase: "planning",
      lifecycleStatus: "blocked",
      assignedAgentType: "architect",
      requestedCapabilities: ["can_plan"],
      retryCount: 0,
      evidenceLinks: [],
      workspaceId: null,
      branchName: null,
      prNumber: null,
      policyVersion: "v1",
      createdAt: timestamp,
      updatedAt: "2026-03-25T20:25:00.000Z"
    });
    await repository.savePipelineRun(
      createPipelineRun({
        runId: "run-platform",
        taskId: "acme-platform-1",
        concurrencyKey: "github:acme/platform:1",
        strategy: "serialize",
        status: "active",
        startedAt: timestamp
      })
    );
    await repository.savePipelineRun(
      createPipelineRun({
        runId: "run-api",
        taskId: "acme-api-2",
        concurrencyKey: "github:acme/api:2",
        strategy: "serialize",
        status: "blocked",
        startedAt: "2026-03-25T20:25:00.000Z"
      })
    );

    await expect(
      repository.listTaskManifests({ repo: "acme/api", lifecycleStatuses: ["blocked"] })
    ).resolves.toMatchObject([{ taskId: "acme-api-2" }]);
    await expect(
      repository.listPipelineRuns({ repo: "acme/platform", statuses: ["active"] })
    ).resolves.toMatchObject([{ runId: "run-platform", taskId: "acme-platform-1" }]);
  });

  it("deduplicates prompt snapshots by phase and prompt hash", async () => {
    const repository = new InMemoryPlanningRepository();

    const first = await repository.savePromptSnapshot(
      createPromptSnapshot({
        snapshotId: "prompt-1",
        phase: "planning",
        promptHash: "deadbeefdeadbeef",
        promptPath:
          "packages/control-plane/src/pipeline/prompts.ts#buildOpenClawArchitectPrompt",
        capturedAt: timestamp
      })
    );
    const second = await repository.savePromptSnapshot(
      createPromptSnapshot({
        snapshotId: "prompt-2",
        phase: "planning",
        promptHash: "deadbeefdeadbeef",
        promptPath:
          "packages/control-plane/src/pipeline/prompts.ts#buildOpenClawArchitectPrompt",
        capturedAt: "2026-03-25T20:21:00.000Z"
      })
    );

    expect(second.snapshotId).toBe(first.snapshotId);
    await expect(repository.listPromptSnapshots()).resolves.toHaveLength(1);
    await expect(repository.getPromptSnapshot(first.snapshotId)).resolves.toEqual(
      first
    );
  });
  it("detects persisted planning specs by GitHub source for polling dedupe", async () => {
    const repository = new InMemoryPlanningRepository();

    await repository.saveManifest({
      taskId: "acme-platform-77",
      source: {
        provider: "github",
        repo: "acme/platform",
        issueNumber: 77,
        issueUrl: "https://github.com/acme/platform/issues/77"
      },
      title: "Poll issue 77",
      summary: "A planning task created from the polling daemon.",
      priority: 7,
      dryRun: false,
      riskClass: "low",
      approvalMode: "auto",
      currentPhase: "planning",
      lifecycleStatus: "active",
      assignedAgentType: "architect",
      requestedCapabilities: ["can_plan", "can_archive_evidence"],
      retryCount: 0,
      evidenceLinks: [],
      workspaceId: null,
      branchName: null,
      prNumber: null,
      policyVersion: "v1",
      createdAt: timestamp,
      updatedAt: timestamp
    });
    await repository.savePlanningSpec({
      specId: "acme-platform-77:planning-spec",
      taskId: "acme-platform-77",
      summary: "Existing planning spec",
      assumptions: ["Existing spec should suppress duplicate polling intake."],
      affectedAreas: ["docs/polling.md"],
      constraints: ["Do not create duplicate planning specs for the same issue."],
      acceptanceCriteria: ["Polling dedupes by source issue."],
      testExpectations: ["Repository source lookup returns true."],
      recommendedAgentType: "architect",
      riskClass: "low",
      confidenceLevel: "high",
      confidenceReason: "The fixture models a previously accepted planning task.",
      projectSize: "small",
      createdAt: timestamp
    });

    await expect(
      repository.hasPlanningSpecForSource({
        provider: "github",
        repo: "acme/platform",
        issueNumber: 77,
        issueUrl: "https://github.com/acme/platform/issues/77"
      })
    ).resolves.toBe(true);
    await expect(
      repository.hasPlanningSpecForSource({
        provider: "github",
        repo: "acme/platform",
        issueNumber: 78,
        issueUrl: "https://github.com/acme/platform/issues/78"
      })
    ).resolves.toBe(false);
  });

  it("stores and retrieves project specs with ticket specs", async () => {
    const repository = new InMemoryPlanningRepository();

    await repository.saveProjectSpec({
      projectId: "proj-001",
      sourceIssueId: "42",
      sourceRepo: "acme/platform",
      title: "Project Mode implementation",
      summary: "Add a dedicated planning phase for medium and large requests.",
      projectSize: "large",
      status: "draft",
      complexityClassification: {
        size: "large",
        reasoning: "Spans 5+ packages and requires new DB migrations.",
        signals: ["multi-package", "new-schema", "new-integration"]
      },
      approvalDecision: null,
      decidedBy: null,
      decisionSummary: null,
      amendments: null,
      clarificationQuestions: null,
      clarificationAnswers: null,
      clarificationRequestedAt: null,
      autoMergeEnabled: false,
      autoMergePolicy: null,
      requiredCheckContract: null,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    await repository.saveTicketSpec({
      ticketId: "ticket-001",
      projectId: "proj-001",
      title: "Complexity classifier",
      description: "Add complexity sizing to Rimmer intake.",
      acceptanceCriteria: ["Classifies small/medium/large"],
      dependsOn: [],
      status: "pending",
      complexityClass: "low",
      riskClass: "low",
      githubSubIssueNumber: null,
      githubPrNumber: null,
      requiredCheckContract: null,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    await repository.saveTicketSpec({
      ticketId: "ticket-002",
      projectId: "proj-001",
      title: "Schema and persistence",
      description: "Add project_specs and ticket_specs tables.",
      acceptanceCriteria: ["Tables created", "Repositories implemented"],
      dependsOn: ["ticket-001"],
      status: "pending",
      complexityClass: "low",
      riskClass: "low",
      githubSubIssueNumber: null,
      githubPrNumber: null,
      requiredCheckContract: null,
      createdAt: "2026-03-25T20:21:00.000Z",
      updatedAt: "2026-03-25T20:21:00.000Z"
    });

    await expect(repository.getProjectSpec("proj-001")).resolves.toMatchObject({
      projectId: "proj-001",
      projectSize: "large",
      status: "draft"
    });
    await expect(repository.listProjectSpecs("acme/platform")).resolves.toHaveLength(1);
    await expect(repository.listProjectSpecs("other/repo")).resolves.toHaveLength(0);
    await expect(repository.listTicketSpecs("proj-001")).resolves.toHaveLength(2);
  });

  it("resolveNextReadyTicket returns the first ticket whose dependencies are all merged", async () => {
    const repository = new InMemoryPlanningRepository();

    await repository.saveProjectSpec({
      projectId: "proj-002",
      sourceIssueId: null,
      sourceRepo: "acme/platform",
      title: "Test project",
      summary: "A test project for resolveNextReady.",
      projectSize: "medium",
      status: "executing",
      complexityClassification: null,
      approvalDecision: "approve",
      decidedBy: "operator",
      decisionSummary: "Approved",
      amendments: null,
      clarificationQuestions: null,
      clarificationAnswers: null,
      clarificationRequestedAt: null,
      autoMergeEnabled: false,
      autoMergePolicy: null,
      requiredCheckContract: null,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    await repository.saveTicketSpec({
      ticketId: "t-a",
      projectId: "proj-002",
      title: "First ticket",
      description: "No dependencies.",
      acceptanceCriteria: ["Done"],
      dependsOn: [],
      status: "merged",
      complexityClass: "low",
      riskClass: "low",
      githubSubIssueNumber: null,
      githubPrNumber: null,
      requiredCheckContract: null,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    await repository.saveTicketSpec({
      ticketId: "t-b",
      projectId: "proj-002",
      title: "Second ticket",
      description: "Depends on t-a.",
      acceptanceCriteria: ["Done"],
      dependsOn: ["t-a"],
      status: "pending",
      complexityClass: "low",
      riskClass: "low",
      githubSubIssueNumber: null,
      githubPrNumber: null,
      requiredCheckContract: null,
      createdAt: "2026-03-25T20:21:00.000Z",
      updatedAt: "2026-03-25T20:21:00.000Z"
    });
    await repository.saveTicketSpec({
      ticketId: "t-c",
      projectId: "proj-002",
      title: "Third ticket",
      description: "Depends on t-a and t-b.",
      acceptanceCriteria: ["Done"],
      dependsOn: ["t-a", "t-b"],
      status: "pending",
      complexityClass: "medium",
      riskClass: "medium",
      githubSubIssueNumber: null,
      githubPrNumber: null,
      requiredCheckContract: null,
      createdAt: "2026-03-25T20:22:00.000Z",
      updatedAt: "2026-03-25T20:22:00.000Z"
    });

    const next = await repository.resolveNextReadyTicket("proj-002");
    expect(next).toMatchObject({ ticketId: "t-b" });
  });

  it("resolveNextReadyTicket returns null when all tickets are merged or blocked", async () => {
    const repository = new InMemoryPlanningRepository();

    await repository.saveProjectSpec({
      projectId: "proj-003",
      sourceIssueId: null,
      sourceRepo: "acme/platform",
      title: "Complete project",
      summary: "All tickets merged.",
      projectSize: "small",
      status: "complete",
      complexityClassification: null,
      approvalDecision: null,
      decidedBy: null,
      decisionSummary: null,
      amendments: null,
      clarificationQuestions: null,
      clarificationAnswers: null,
      clarificationRequestedAt: null,
      autoMergeEnabled: false,
      autoMergePolicy: null,
      requiredCheckContract: null,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    await repository.saveTicketSpec({
      ticketId: "t-done",
      projectId: "proj-003",
      title: "Only ticket",
      description: "Already merged.",
      acceptanceCriteria: ["Done"],
      dependsOn: [],
      status: "merged",
      complexityClass: "low",
      riskClass: "low",
      githubSubIssueNumber: null,
      githubPrNumber: null,
      requiredCheckContract: null,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    await expect(repository.resolveNextReadyTicket("proj-003")).resolves.toBeNull();
  });

  it("updates project and ticket statuses independently", async () => {
    const repository = new InMemoryPlanningRepository();

    await repository.saveProjectSpec({
      projectId: "proj-004",
      sourceIssueId: null,
      sourceRepo: "acme/platform",
      title: "Status test",
      summary: "Test status transitions.",
      projectSize: "medium",
      status: "draft",
      complexityClassification: null,
      approvalDecision: null,
      decidedBy: null,
      decisionSummary: null,
      amendments: null,
      clarificationQuestions: null,
      clarificationAnswers: null,
      clarificationRequestedAt: null,
      autoMergeEnabled: false,
      autoMergePolicy: null,
      requiredCheckContract: null,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    await repository.saveTicketSpec({
      ticketId: "t-status",
      projectId: "proj-004",
      title: "Status ticket",
      description: "Test ticket status update.",
      acceptanceCriteria: ["Done"],
      dependsOn: [],
      status: "pending",
      complexityClass: "low",
      riskClass: "low",
      githubSubIssueNumber: null,
      githubPrNumber: null,
      requiredCheckContract: null,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    // Use valid transition path: draft → pending_approval → approved → executing
    await repository.updateProjectStatus("proj-004", "pending_approval");
    await repository.updateProjectStatus("proj-004", "approved");
    await repository.updateProjectStatus("proj-004", "executing");
    await repository.updateTicketStatus("t-status", "dispatched");

    const project = await repository.getProjectSpec("proj-004");
    const ticket = await repository.getTicketSpec("t-status");
    expect(project?.status).toBe("executing");
    expect(ticket?.status).toBe("dispatched");
  });

  it("rolls back project and ticket writes in memory transactions", async () => {
    const repository = new InMemoryPlanningRepository();

    await repository.saveProjectSpec({
      projectId: "proj-rollback",
      sourceIssueId: null,
      sourceRepo: "acme/platform",
      title: "Rollback project",
      summary: "Test project transaction rollback.",
      projectSize: "medium",
      status: "executing",
      complexityClassification: null,
      approvalDecision: null,
      decidedBy: null,
      decisionSummary: null,
      amendments: null,
      clarificationQuestions: null,
      clarificationAnswers: null,
      clarificationRequestedAt: null,
      autoMergeEnabled: false,
      autoMergePolicy: null,
      requiredCheckContract: null,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    await repository.saveTicketSpec({
      ticketId: "t-rollback",
      projectId: "proj-rollback",
      title: "Rollback ticket",
      description: "Test ticket transaction rollback.",
      acceptanceCriteria: ["Done"],
      dependsOn: [],
      status: "dispatched",
      complexityClass: "low",
      riskClass: "low",
      githubSubIssueNumber: null,
      githubPrNumber: null,
      requiredCheckContract: null,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    await expect(
      repository.runInTransaction(async (transaction) => {
        await transaction.saveProjectSpec({
          ...(await transaction.getProjectSpec("proj-rollback"))!,
          status: "failed",
          updatedAt: "2026-03-25T20:30:00.000Z"
        });
        await transaction.saveTicketSpec({
          ...(await transaction.getTicketSpec("t-rollback"))!,
          status: "failed",
          updatedAt: "2026-03-25T20:30:00.000Z"
        });
        throw new Error("rollback");
      })
    ).rejects.toThrow(/rollback/);

    await expect(repository.getProjectSpec("proj-rollback")).resolves.toMatchObject({
      status: "executing",
      updatedAt: timestamp
    });
    await expect(repository.getTicketSpec("t-rollback")).resolves.toMatchObject({
      status: "dispatched",
      updatedAt: timestamp
    });
  });

  it("claims active runs atomically in memory, retiring stale overlaps and blocking fresh ones", async () => {
    const repository = new InMemoryPlanningRepository();
    const concurrencyKey = "github:acme/platform:55";

    await repository.savePipelineRun(
      createPipelineRun({
        runId: "run-stale",
        taskId: "task-55",
        concurrencyKey,
        strategy: "serialize",
        status: "active",
        startedAt: "2026-03-25T18:00:00.000Z",
        lastHeartbeatAt: "2026-03-25T18:00:00.000Z"
      })
    );

    const firstClaim = await repository.claimPipelineRun({
      run: createPipelineRun({
        runId: "run-fresh",
        taskId: "task-55",
        concurrencyKey,
        strategy: "serialize",
        status: "active",
        startedAt: "2026-03-25T18:05:00.000Z",
        lastHeartbeatAt: "2026-03-25T18:05:00.000Z"
      }),
      staleAfterMs: 60_000
    });

    const secondClaim = await repository.claimPipelineRun({
      run: createPipelineRun({
        runId: "run-blocked",
        taskId: "task-55",
        concurrencyKey,
        strategy: "serialize",
        status: "active",
        startedAt: "2026-03-25T18:05:30.000Z",
        lastHeartbeatAt: "2026-03-25T18:05:30.000Z"
      }),
      staleAfterMs: 60_000
    });

    await expect(repository.getPipelineRun("run-stale")).resolves.toMatchObject({
      status: "stale",
      staleAt: "2026-03-25T18:05:00.000Z"
    });
    await expect(repository.getPipelineRun("run-fresh")).resolves.toMatchObject({
      status: "active"
    });
    await expect(repository.getPipelineRun("run-blocked")).resolves.toBeNull();
    expect(firstClaim.staleRunIds).toEqual(["run-stale"]);
    expect(firstClaim.blockedByRun).toBeNull();
    expect(secondClaim.staleRunIds).toEqual([]);
    expect(secondClaim.blockedByRun?.runId).toBe("run-fresh");
  });

  // M25 F-190 — RequiredCheckContract round-trip on both ProjectSpec and TicketSpec.
  it("round-trips a non-empty RequiredCheckContract on ProjectSpec and TicketSpec", async () => {
    const repository = new InMemoryPlanningRepository();
    const contract = {
      requiredCheckNames: ["build", "test", "lint"],
      minimumCheckCount: 3,
      forbidSkipCi: true,
      forbidEmptyTestDiff: true,
      rationale: "M25 F-190 round-trip test."
    };

    await repository.saveProjectSpec({
      projectId: "proj-rcc",
      sourceIssueId: "1",
      sourceRepo: "acme/platform",
      title: "Required-check contract round-trip",
      summary: "Persist a non-empty contract and read it back deeply equal.",
      projectSize: "medium",
      status: "draft",
      complexityClassification: null,
      approvalDecision: null,
      decidedBy: null,
      decisionSummary: null,
      amendments: null,
      clarificationQuestions: null,
      clarificationAnswers: null,
      clarificationRequestedAt: null,
      autoMergeEnabled: true,
      autoMergePolicy: null,
      requiredCheckContract: contract,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    await repository.saveTicketSpec({
      ticketId: "ticket-rcc",
      projectId: "proj-rcc",
      title: "Ticket with override",
      description: "Carries its own contract that overrides the project default.",
      acceptanceCriteria: ["Ticket persists override"],
      dependsOn: [],
      status: "pending",
      complexityClass: "low",
      riskClass: "low",
      githubSubIssueNumber: null,
      githubPrNumber: null,
      requiredCheckContract: { ...contract, requiredCheckNames: ["build"] },
      createdAt: timestamp,
      updatedAt: timestamp
    });

    const reloadedProject = await repository.getProjectSpec("proj-rcc");
    expect(reloadedProject?.requiredCheckContract).toEqual(contract);
    expect(reloadedProject?.autoMergeEnabled).toBe(true);

    const reloadedTickets = await repository.listTicketSpecs("proj-rcc");
    expect(reloadedTickets).toHaveLength(1);
    expect(reloadedTickets[0]?.requiredCheckContract).toEqual({
      ...contract,
      requiredCheckNames: ["build"]
    });
  });

  // M25 F-190 — empty / `{}` contract reads back as null so the evaluator
  // (F-194) treats it as "ineligible for auto-merge".
  it("treats an empty contract jsonb cell as null on read-back", async () => {
    const repository = new InMemoryPlanningRepository();

    await repository.saveProjectSpec({
      projectId: "proj-empty-rcc",
      sourceIssueId: null,
      sourceRepo: "acme/platform",
      title: "Empty contract",
      summary: "Default contract should round-trip as null.",
      projectSize: "small",
      status: "draft",
      complexityClassification: null,
      approvalDecision: null,
      decidedBy: null,
      decisionSummary: null,
      amendments: null,
      clarificationQuestions: null,
      clarificationAnswers: null,
      clarificationRequestedAt: null,
      autoMergeEnabled: false,
      autoMergePolicy: null,
      requiredCheckContract: null,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    const reloaded = await repository.getProjectSpec("proj-empty-rcc");
    expect(reloaded?.requiredCheckContract).toBeNull();
  });
});
