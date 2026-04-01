import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DeterministicDeveloperAgent,
  DeterministicPlanningAgent,
  DeterministicScmAgent,
  DeterministicValidationAgent,
  createWorkspaceContextBundleFromSnapshot,
  destroyTaskWorkspace,
  provisionTaskWorkspace,
  resolveApprovalRequest,
  runDeveloperPhase,
  runPlanningPipeline,
  runScmPhase,
  runValidationPhase
} from "@reddwarf/control-plane";
import {
  createPostgresPlanningRepository,
  createEvidenceRecord,
  createMemoryRecord,
  createPipelineRun,
  deriveOrganizationId
} from "@reddwarf/evidence";
import { FixtureGitHubAdapter } from "@reddwarf/integrations";
import type { PlanningTaskInput } from "@reddwarf/contracts";

const connectionString =
  process.env.HOST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDatabase = connectionString ? describe : describe.skip;

describeIfDatabase("postgres planning repository", () => {
  const repository = createPostgresPlanningRepository(connectionString!);

  beforeAll(async () => {
    await repository.healthcheck();
  });

  afterAll(async () => {
    await repository.close();
  });

  it("reports configured Postgres pool limits and live telemetry", async () => {
    const poolAwareRepository = createPostgresPlanningRepository(connectionString!, {
      max: 3,
      connectionTimeoutMillis: 2_500,
      idleTimeoutMillis: 12_000,
      queryTimeoutMillis: 9_000,
      statementTimeoutMillis: 8_000,
      maxLifetimeSeconds: 45
    });

    try {
      await poolAwareRepository.healthcheck();
      const health = await poolAwareRepository.getRepositoryHealth();

      expect(health.storage).toBe("postgres");
      expect(health.status).toBe("healthy");
      expect(health.postgresPool).toMatchObject({
        status: "healthy",
        maxConnections: 3,
        connectionTimeoutMs: 2_500,
        idleTimeoutMs: 12_000,
        queryTimeoutMs: 9_000,
        statementTimeoutMs: 8_000,
        maxLifetimeSeconds: 45,
        errorCount: 0,
        lastErrorAt: null,
        lastErrorMessage: null
      });
      expect(health.postgresPool?.totalConnections).toBeGreaterThanOrEqual(0);
      expect(health.postgresPool?.idleConnections).toBeGreaterThanOrEqual(0);
      expect(health.postgresPool?.waitingRequests).toBeGreaterThanOrEqual(0);
    } finally {
      await poolAwareRepository.close();
    }
  });

  it("persists a planning pipeline run and can provision and destroy a managed workspace", async () => {
    const issueNumber = Date.now();
    const repo = `acme-${issueNumber}/platform-${issueNumber}`;
    const input: PlanningTaskInput = {
      source: {
        provider: "github",
        repo,
        issueNumber,
        issueUrl: `https://github.com/${repo}/issues/${issueNumber}`
      },
      title: "Persist a docs-safe planning run",
      summary:
        "Persist a docs-safe planning run into Postgres and verify the durable audit, observability, memory, pipeline-run records, and managed workspace lifecycle are queryable.",
      priority: 1,
      dryRun: false,
      labels: ["ai-eligible"],
      acceptanceCriteria: [
        "The planning spec exists",
        "Audit records can be queried"
      ],
      affectedPaths: ["docs/postgres-verification.md"],
      requestedCapabilities: ["can_plan", "can_archive_evidence"],
      metadata: {}
    };

    const result = await runPlanningPipeline(input, {
      repository,
      planner: new DeterministicPlanningAgent()
    });

    const organizationId = deriveOrganizationId(input.source.repo);
    await repository.saveMemoryRecord(
      createMemoryRecord({
        memoryId: `${result.manifest.taskId}:project:test-command`,
        scope: "project",
        provenance: "human_curated",
        key: "repo.testing-command",
        title: "Primary test command",
        value: { command: "corepack pnpm test" },
        repo: input.source.repo,
        organizationId,
        tags: ["testing"],
        createdAt: result.manifest.updatedAt,
        updatedAt: result.manifest.updatedAt
      })
    );
    await repository.saveMemoryRecord(
      createMemoryRecord({
        memoryId: `${result.manifest.taskId}:organization:policy`,
        scope: "organization",
        provenance: "human_curated",
        key: "policy.approval",
        title: "Approval policy",
        value: { requiresHuman: ["can_write_code"] },
        organizationId,
        tags: ["policy"],
        createdAt: result.manifest.updatedAt,
        updatedAt: result.manifest.updatedAt
      })
    );
    await repository.saveMemoryRecord(
      createMemoryRecord({
        memoryId: `${result.manifest.taskId}:external:typescript`,
        scope: "external",
        provenance: "external_retrieval",
        key: "docs.typescript.release-notes",
        title: "TypeScript notes",
        value: { section: "5.8" },
        repo: input.source.repo,
        organizationId,
        sourceUri: "https://www.typescriptlang.org/docs/",
        tags: ["typescript"],
        createdAt: result.manifest.updatedAt,
        updatedAt: result.manifest.updatedAt
      })
    );

    const snapshot = await repository.getTaskSnapshot(result.manifest.taskId);
    const runSummary = await repository.getRunSummary(
      result.manifest.taskId,
      result.runId
    );
    const memoryContext = await repository.getMemoryContext({
      taskId: result.manifest.taskId,
      repo: input.source.repo,
      organizationId
    });
    const tempRoot = await mkdtemp(
      join(tmpdir(), "reddwarf-postgres-context-")
    );

    try {
      expect(snapshot.manifest?.taskId).toBe(result.manifest.taskId);
      expect(snapshot.spec?.taskId).toBe(result.manifest.taskId);
      expect(snapshot.policySnapshot?.approvalMode).toBe("auto");
      expect(snapshot.phaseRecords).toHaveLength(5);
      expect(snapshot.phaseRecords.map((record) => record.phase)).toEqual([
        "intake",
        "eligibility",
        "planning",
        "policy_gate",
        "archive"
      ]);
      expect(snapshot.evidenceRecords.length).toBeGreaterThanOrEqual(3);
      expect(snapshot.runEvents.length).toBeGreaterThanOrEqual(7);
      expect(snapshot.memoryRecords).toHaveLength(1);
      expect(snapshot.memoryRecords[0]?.key).toBe("planning.brief");
      expect(snapshot.pipelineRuns).toHaveLength(1);
      expect(snapshot.pipelineRuns[0]?.status).toBe("completed");
      expect(runSummary?.status).toBe("completed");
      expect(runSummary?.eventCounts.info).toBeGreaterThanOrEqual(6);
      expect(runSummary?.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(memoryContext.taskMemory).toHaveLength(1);
      expect(memoryContext.projectMemory).toHaveLength(1);
      expect(memoryContext.organizationMemory).toHaveLength(1);
      expect(memoryContext.externalMemory).toHaveLength(1);

      const bundle = createWorkspaceContextBundleFromSnapshot(snapshot);
      const provisioned = await provisionTaskWorkspace({
        snapshot,
        repository,
        targetRoot: tempRoot,
        workspaceId: `${result.manifest.taskId}-integration`
      });
      const descriptor = JSON.parse(
        await readFile(provisioned.workspace.stateFile, "utf8")
      );
      const policySnapshot = JSON.parse(
        await readFile(provisioned.workspace.files.policySnapshotJson, "utf8")
      );
      const soulMd = await readFile(
        provisioned.workspace.instructions.files.soulMd,
        "utf8"
      );
      const toolsMd = await readFile(
        provisioned.workspace.instructions.files.toolsMd,
        "utf8"
      );
      const taskSkillMd = await readFile(
        provisioned.workspace.instructions.files.taskSkillMd,
        "utf8"
      );

      expect(bundle.allowedPaths).toEqual(["docs/postgres-verification.md"]);
      expect(policySnapshot.allowedPaths).toEqual([
        "docs/postgres-verification.md"
      ]);
      expect(descriptor.status).toBe("provisioned");
      expect(soulMd).toContain(result.manifest.taskId);
      expect(toolsMd).toContain("can_archive_evidence");
      expect(taskSkillMd).toContain(".context/spec.md");

      const destroyed = await destroyTaskWorkspace({
        manifest: provisioned.manifest,
        repository,
        targetRoot: tempRoot
      });
      const persistedManifest = await repository.getManifest(
        result.manifest.taskId
      );
      const evidenceRecords = await repository.listEvidenceRecords(
        result.manifest.taskId
      );

      expect(destroyed.manifest.workspaceId).toBeNull();
      expect(destroyed.workspace.removed).toBe(true);
      expect(destroyed.workspace.descriptor?.status).toBe("destroyed");
      expect(persistedManifest?.workspaceId).toBeNull();
      expect(
        evidenceRecords.some((record) =>
          record.recordId.endsWith(":provisioned")
        )
      ).toBe(true);
      expect(
        evidenceRecords.some((record) => record.recordId.endsWith(":destroyed"))
      ).toBe(true);
      await expect(
        access(provisioned.workspace.workspaceRoot)
      ).rejects.toThrow();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists approval requests and decision outcomes in Postgres", async () => {
    const issueNumber = Date.now() + 1;
    const repo = `approval-${issueNumber}/platform-${issueNumber}`;
    const input: PlanningTaskInput = {
      source: {
        provider: "github",
        repo,
        issueNumber,
        issueUrl: `https://github.com/${repo}/issues/${issueNumber}`
      },
      title: "Persist a human approval workflow",
      summary:
        "Persist a planning run that requires human approval, verify the approval queue entry is durable, and confirm approval resolution updates the manifest and evidence state.",
      priority: 1,
      dryRun: false,
      labels: ["ai-eligible"],
      acceptanceCriteria: [
        "Approval request is stored",
        "Approval decisions update manifest state"
      ],
      affectedPaths: ["src/approval-flow.ts"],
      requestedCapabilities: ["can_write_code"],
      metadata: {}
    };

    const result = await runPlanningPipeline(input, {
      repository,
      planner: new DeterministicPlanningAgent(),
      clock: () => new Date("2026-03-25T18:00:00.000Z"),
      idGenerator: () => `approval-${issueNumber}`
    });
    const snapshot = await repository.getTaskSnapshot(result.manifest.taskId);
    const runSummary = await repository.getRunSummary(
      result.manifest.taskId,
      result.runId
    );

    expect(result.manifest.lifecycleStatus).toBe("blocked");
    expect(result.approvalRequest?.status).toBe("pending");
    expect(snapshot.approvalRequests).toHaveLength(1);
    expect(snapshot.pipelineRuns[0]?.status).toBe("blocked");
    expect(runSummary?.status).toBe("blocked");

    const resolved = await resolveApprovalRequest(
      {
        requestId: result.approvalRequest!.requestId,
        decision: "approve",
        decidedBy: "operator",
        decisionSummary: "Approved for developer orchestration.",
        comment: "Queue is behaving as expected."
      },
      {
        repository,
        clock: () => new Date("2026-03-25T18:05:00.000Z")
      }
    );
    const persistedRequest = await repository.getApprovalRequest(
      result.approvalRequest!.requestId
    );
    const persistedManifest = await repository.getManifest(
      result.manifest.taskId
    );
    const evidenceRecords = await repository.listEvidenceRecords(
      result.manifest.taskId
    );

    expect(resolved.manifest.lifecycleStatus).toBe("ready");
    expect(persistedRequest?.status).toBe("approved");
    expect(persistedRequest?.decision).toBe("approve");
    expect(persistedManifest?.lifecycleStatus).toBe("ready");
    expect(
      evidenceRecords.some((record) =>
        record.recordId.includes(":approval-decision:")
      )
    ).toBe(true);
  });

  it("rolls back Postgres repository transactions on failure", async () => {
    const issueNumber = Date.now() + 1;
    const repo = `approval-${issueNumber}/platform-${issueNumber}`;
    const result = await runPlanningPipeline(
      {
        source: {
          provider: "github",
          repo,
          issueNumber,
          issueUrl: `https://github.com/${repo}/issues/${issueNumber}`
        },
        title: "Rollback Postgres repository transaction",
        summary:
          "Verify Postgres-backed repository transactions roll back manifest and evidence writes when a later statement fails.",
        priority: 1,
        labels: ["ai-eligible"],
        acceptanceCriteria: [
          "Transactional writes roll back on error"
        ],
        affectedPaths: ["src/postgres-transaction.ts"],
        requestedCapabilities: ["can_write_code"],
        metadata: {}
      },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-29T16:00:00.000Z"),
        idGenerator: () => `transaction-${issueNumber}`
      }
    );

    const updatedManifest = {
      ...result.manifest,
      lifecycleStatus: "ready" as const,
      updatedAt: "2026-03-29T16:05:00.000Z"
    };
    const evidenceRecordId = `${result.manifest.taskId}:transaction-rollback`;

    await expect(
      repository.runInTransaction(async (transactionalRepository) => {
        await transactionalRepository.updateManifest(updatedManifest);
        await transactionalRepository.saveEvidenceRecord(
          createEvidenceRecord({
            recordId: evidenceRecordId,
            taskId: result.manifest.taskId,
            kind: "gate_decision",
            title: "Transaction rollback sentinel",
            metadata: { step: "before-throw" },
            createdAt: "2026-03-29T16:05:00.000Z"
          })
        );
        throw new Error("Injected Postgres transaction failure.");
      })
    ).rejects.toThrow("Injected Postgres transaction failure.");

    const persistedManifest = await repository.getManifest(result.manifest.taskId);
    const evidenceRecords = await repository.listEvidenceRecords(result.manifest.taskId);

    expect(persistedManifest?.lifecycleStatus).toBe(result.manifest.lifecycleStatus);
    expect(
      evidenceRecords.some((record) => record.recordId === evidenceRecordId)
    ).toBe(false);
  });

  it("persists developer phase orchestration with code writing disabled", async () => {
    const issueNumber = Date.now() + 2;
    const repo = `developer-${issueNumber}/platform-${issueNumber}`;
    const tempRoot = await mkdtemp(
      join(tmpdir(), "reddwarf-postgres-development-")
    );
    const planningResult = await runPlanningPipeline(
      {
        source: {
          provider: "github",
          repo,
          issueNumber,
          issueUrl: `https://github.com/${repo}/issues/${issueNumber}`
        },
        title: "Persist developer phase orchestration",
        summary:
          "Persist a developer-phase run after human approval, verify the workspace handoff is captured, and confirm code writing stays disabled by default.",
        priority: 1,
        labels: ["ai-eligible"],
        acceptanceCriteria: [
          "Developer workspace is provisioned",
          "Developer handoff is queryable"
        ],
        affectedPaths: ["src/developer-phase.ts"],
        requestedCapabilities: ["can_write_code"],
        metadata: {}
      },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-25T18:00:00.000Z"),
        idGenerator: () => `developer-plan-${issueNumber}`
      }
    );

    await resolveApprovalRequest(
      {
        requestId: planningResult.approvalRequest!.requestId,
        decision: "approve",
        decidedBy: "operator",
        decisionSummary: "Approved for developer orchestration.",
        comment: "Keep code writing disabled."
      },
      {
        repository,
        clock: () => new Date("2026-03-25T18:05:00.000Z")
      }
    );

    try {
      const development = await runDeveloperPhase(
        {
          taskId: planningResult.manifest.taskId,
          targetRoot: tempRoot,
          workspaceId: `${planningResult.manifest.taskId}-development`
        },
        {
          repository,
          developer: new DeterministicDeveloperAgent(),
          clock: () => new Date("2026-03-25T18:10:00.000Z"),
          idGenerator: () => `developer-run-${issueNumber}`
        }
      );
      const persistedManifest = await repository.getManifest(
        planningResult.manifest.taskId
      );
      const snapshot = await repository.getTaskSnapshot(
        planningResult.manifest.taskId
      );
      const runSummary = await repository.getRunSummary(
        planningResult.manifest.taskId,
        development.runId
      );
      const handoffMarkdown = await readFile(development.handoffPath!, "utf8");

      expect(development.nextAction).toBe("await_validation");
      expect(development.workspace?.descriptor.toolPolicy.mode).toBe(
        "development_readonly"
      );
      expect(
        development.workspace?.descriptor.toolPolicy.codeWriteEnabled
      ).toBe(false);
      expect(persistedManifest?.currentPhase).toBe("development");
      expect(persistedManifest?.lifecycleStatus).toBe("blocked");
      expect(
        snapshot.phaseRecords.some((record) => record.phase === "development")
      ).toBe(true);
      expect(
        snapshot.memoryRecords.some(
          (record) => record.key === "development.handoff"
        )
      ).toBe(true);
      expect(
        snapshot.evidenceRecords.some((record) =>
          record.recordId.includes(":handoff")
        )
      ).toBe(true);
      expect(runSummary?.status).toBe("blocked");
      expect(runSummary?.latestPhase).toBe("development");
      expect(handoffMarkdown).toContain("Development Handoff");

      await destroyTaskWorkspace({
        manifest: development.manifest,
        repository,
        targetRoot: tempRoot
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists validation phase results and blocks pending review", async () => {
    const issueNumber = Date.now() + 3;
    const repo = `validation-${issueNumber}/platform-${issueNumber}`;
    const tempRoot = await mkdtemp(
      join(tmpdir(), "reddwarf-postgres-validation-")
    );
    const planningResult = await runPlanningPipeline(
      {
        source: {
          provider: "github",
          repo,
          issueNumber,
          issueUrl: `https://github.com/${repo}/issues/${issueNumber}`
        },
        title: "Persist validation phase orchestration",
        summary:
          "Persist a validation-phase run after developer handoff, verify deterministic command results are archived, and confirm the task blocks cleanly pending review.",
        priority: 1,
        labels: ["ai-eligible"],
        acceptanceCriteria: [
          "Validation commands are archived",
          "Validation summary is queryable"
        ],
        affectedPaths: ["src/validation-phase.ts"],
        requestedCapabilities: ["can_write_code"],
        metadata: {}
      },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-25T18:00:00.000Z"),
        idGenerator: () => `validation-plan-${issueNumber}`
      }
    );

    await resolveApprovalRequest(
      {
        requestId: planningResult.approvalRequest!.requestId,
        decision: "approve",
        decidedBy: "operator",
        decisionSummary: "Approved for validation orchestration.",
        comment: "Run deterministic validation checks."
      },
      {
        repository,
        clock: () => new Date("2026-03-25T18:05:00.000Z")
      }
    );

    try {
      await runDeveloperPhase(
        {
          taskId: planningResult.manifest.taskId,
          targetRoot: tempRoot,
          workspaceId: `${planningResult.manifest.taskId}-validation`
        },
        {
          repository,
          developer: new DeterministicDeveloperAgent(),
          clock: () => new Date("2026-03-25T18:10:00.000Z"),
          idGenerator: () => `validation-dev-${issueNumber}`
        }
      );
      const validation = await runValidationPhase(
        {
          taskId: planningResult.manifest.taskId,
          targetRoot: tempRoot
        },
        {
          repository,
          validator: new DeterministicValidationAgent(),
          clock: () => new Date("2026-03-25T18:15:00.000Z"),
          idGenerator: () => `validation-run-${issueNumber}`
        }
      );
      const persistedManifest = await repository.getManifest(
        planningResult.manifest.taskId
      );
      const snapshot = await repository.getTaskSnapshot(
        planningResult.manifest.taskId
      );
      const runSummary = await repository.getRunSummary(
        planningResult.manifest.taskId,
        validation.runId
      );
      const reportMarkdown = await readFile(validation.reportPath!, "utf8");

      expect(validation.nextAction).toBe("await_review");
      expect(validation.workspace?.descriptor.toolPolicy.mode).toBe(
        "validation_only"
      );
      expect(persistedManifest?.currentPhase).toBe("validation");
      expect(persistedManifest?.lifecycleStatus).toBe("blocked");
      expect(
        snapshot.phaseRecords.some((record) => record.phase === "validation")
      ).toBe(true);
      expect(
        snapshot.memoryRecords.some(
          (record) => record.key === "validation.summary"
        )
      ).toBe(true);
      expect(
        snapshot.evidenceRecords.some((record) =>
          record.recordId.includes(":validation:")
        )
      ).toBe(true);
      expect(runSummary?.status).toBe("blocked");
      expect(runSummary?.latestPhase).toBe("validation");
      expect(reportMarkdown).toContain("Validation Report");

      await destroyTaskWorkspace({
        manifest: validation.manifest,
        repository,
        targetRoot: tempRoot
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists SCM phase orchestration and completes the task after validation", async () => {
    const issueNumber = Date.now() + 5;
    const repo = `scm-${issueNumber}/platform-${issueNumber}`;
    const tempRoot = await mkdtemp(join(tmpdir(), "reddwarf-postgres-scm-"));
    const evidenceRoot = await mkdtemp(join(tmpdir(), "reddwarf-postgres-evidence-"));
    const planningResult = await runPlanningPipeline(
      {
        source: {
          provider: "github",
          repo,
          issueNumber,
          issueUrl: `https://github.com/${repo}/issues/${issueNumber}`
        },
        title: "Persist SCM phase orchestration",
        summary:
          "Persist a task that requires validation before opening an approved branch and pull request, then confirm the Postgres-backed records capture the SCM completion state.",
        priority: 1,
        labels: ["ai-eligible"],
        acceptanceCriteria: [
          "SCM summary is stored",
          "Branch and pull request metadata are persisted"
        ],
        affectedPaths: ["src/scm-phase.ts"],
        requestedCapabilities: ["can_write_code", "can_open_pr"],
        metadata: {
          github: {
            baseBranch: "main"
          }
        }
      },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-25T18:00:00.000Z"),
        idGenerator: () => `scm-plan-${issueNumber}`
      }
    );

    await resolveApprovalRequest(
      {
        requestId: planningResult.approvalRequest!.requestId,
        decision: "approve",
        decidedBy: "operator",
        decisionSummary: "Approved for SCM orchestration.",
        comment: "Open the branch and PR after validation."
      },
      {
        repository,
        clock: () => new Date("2026-03-25T18:05:00.000Z")
      }
    );

    try {
      await runDeveloperPhase(
        {
          taskId: planningResult.manifest.taskId,
          targetRoot: tempRoot,
          workspaceId: `${planningResult.manifest.taskId}-scm`,
          evidenceRoot
        },
        {
          repository,
          developer: new DeterministicDeveloperAgent(),
          clock: () => new Date("2026-03-25T18:10:00.000Z"),
          idGenerator: () => `scm-dev-${issueNumber}`
        }
      );
      const validation = await runValidationPhase(
        {
          taskId: planningResult.manifest.taskId,
          targetRoot: tempRoot,
          evidenceRoot
        },
        {
          repository,
          validator: new DeterministicValidationAgent(),
          clock: () => new Date("2026-03-25T18:15:00.000Z"),
          idGenerator: () => `scm-validation-${issueNumber}`
        }
      );
      const scm = await runScmPhase(
        {
          taskId: planningResult.manifest.taskId,
          targetRoot: tempRoot,
          evidenceRoot
        },
        {
          repository,
          scm: new DeterministicScmAgent(),
          github: new FixtureGitHubAdapter({
            candidates: [
              {
                repo,
                issueNumber,
                title: planningResult.manifest.title,
                body: planningResult.manifest.summary,
                labels: ["ai-eligible"],
                url: `https://github.com/${repo}/issues/${issueNumber}`,
                state: "open"
              }
            ],
            mutations: {
              allowBranchCreation: true,
              allowPullRequestCreation: true,
              pullRequestNumberStart: 81
            }
          }),
          clock: () => new Date("2026-03-25T18:20:00.000Z"),
          idGenerator: () => `scm-run-${issueNumber}`
        }
      );
      const snapshot = await repository.getTaskSnapshot(planningResult.manifest.taskId);
      const archivedArtifacts = snapshot.evidenceRecords.filter(
        (record) => typeof record.metadata.archivePath === "string"
      );
      const runSummary = await repository.getRunSummary(
        planningResult.manifest.taskId,
        scm.runId
      );

      expect(validation.nextAction).toBe("await_scm");
      expect(scm.nextAction).toBe("complete");
      expect(snapshot.manifest?.currentPhase).toBe("scm");
      expect(snapshot.manifest?.lifecycleStatus).toBe("completed");
      expect(snapshot.manifest?.branchName).toBe(scm.branch?.branchName ?? null);
      expect(snapshot.manifest?.prNumber).toBe(81);
      expect(snapshot.memoryRecords.some((record) => record.key === "scm.summary")).toBe(true);
      expect(runSummary?.status).toBe("completed");
      expect(runSummary?.latestPhase).toBe("scm");
      expect(
        archivedArtifacts.map((record) => record.metadata.artifactClass)
      ).toEqual(
        expect.arrayContaining(["handoff", "log", "report", "test_result", "diff"])
      );

      await destroyTaskWorkspace({
        manifest: scm.manifest,
        repository,
        targetRoot: tempRoot,
        evidenceRoot
      });

      for (const record of archivedArtifacts) {
        await expect(access(record.metadata.archivePath as string)).resolves.toBeUndefined();
        expect(record.location.startsWith("evidence://")).toBe(true);
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it("marks stale overlapping runs and blocks fresh overlaps in Postgres", async () => {
    const issueNumber = Date.now() + 4;
    const repo = `concurrency-${issueNumber}/platform-${issueNumber}`;
    const concurrencyKey = `github:${repo}:${issueNumber}`;
    const taskId = `${repo.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase()}-${issueNumber}`;

    await repository.savePipelineRun(
      createPipelineRun({
        runId: `stale-${issueNumber}`,
        taskId,
        concurrencyKey,
        strategy: "serialize",
        status: "active",
        startedAt: "2026-03-25T17:45:00.000Z",
        lastHeartbeatAt: "2026-03-25T17:45:00.000Z",
        metadata: {}
      })
    );

    const input: PlanningTaskInput = {
      source: {
        provider: "github",
        repo,
        issueNumber,
        issueUrl: `https://github.com/${repo}/issues/${issueNumber}`
      },
      title: "Verify concurrency controls",
      summary:
        "Verify that stale overlapping runs are retired and fresh overlaps are blocked conservatively in the Postgres-backed planning pipeline.",
      priority: 1,
      dryRun: false,
      labels: ["ai-eligible"],
      acceptanceCriteria: [
        "Stale runs are marked",
        "Fresh overlaps are blocked"
      ],
      affectedPaths: ["docs/concurrency-verification.md"],
      requestedCapabilities: ["can_plan", "can_archive_evidence"],
      metadata: {}
    };

    const staleResult = await runPlanningPipeline(input, {
      repository,
      planner: new DeterministicPlanningAgent(),
      clock: () => new Date("2026-03-25T18:00:00.000Z"),
      idGenerator: () => `fresh-${issueNumber}`,
      concurrency: {
        staleAfterMs: 60_000
      }
    });

    await repository.savePipelineRun(
      createPipelineRun({
        runId: `active-${issueNumber}`,
        taskId,
        concurrencyKey,
        strategy: "serialize",
        status: "active",
        startedAt: "2026-03-25T18:00:01.000Z",
        lastHeartbeatAt: "2026-03-25T18:00:01.000Z",
        metadata: {}
      })
    );

    const blockedResult = await runPlanningPipeline(input, {
      repository,
      planner: new DeterministicPlanningAgent(),
      clock: () => new Date("2026-03-25T18:00:05.000Z"),
      idGenerator: () => `blocked-${issueNumber}`,
      concurrency: {
        staleAfterMs: 60_000
      }
    });

    const pipelineRuns = await repository.listPipelineRuns({
      concurrencyKey,
      limit: 10
    });
    const blockedSummary = await repository.getRunSummary(
      taskId,
      `blocked-${issueNumber}`
    );

    expect(staleResult.concurrencyDecision.staleRunIds).toEqual([
      `stale-${issueNumber}`
    ]);
    expect(blockedResult.concurrencyDecision.action).toBe("block");
    expect(blockedResult.concurrencyDecision.blockedByRunId).toBe(
      `active-${issueNumber}`
    );
    expect(blockedSummary?.status).toBe("blocked");
    expect(blockedSummary?.failureClass).toBe("execution_loop");
    expect(
      pipelineRuns.find((run) => run.runId === `stale-${issueNumber}`)?.status
    ).toBe("stale");
    expect(
      pipelineRuns.find((run) => run.runId === `fresh-${issueNumber}`)?.status
    ).toBe("completed");
    expect(
      pipelineRuns.find((run) => run.runId === `blocked-${issueNumber}`)?.status
    ).toBe("blocked");
  });

  it("claims only one active owner for concurrent Postgres run claims", async () => {
    const issueNumber = Date.now() + 6;
    const repo = `claim-${issueNumber}/platform-${issueNumber}`;
    const concurrencyKey = `github:${repo}:${issueNumber}`;
    const taskId = `${repo.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase()}-${issueNumber}`;
    const runA = createPipelineRun({
      runId: `claim-a-${issueNumber}`,
      taskId,
      concurrencyKey,
      strategy: "serialize",
      status: "active",
      startedAt: "2026-03-25T18:30:00.000Z",
      lastHeartbeatAt: "2026-03-25T18:30:00.000Z"
    });
    const runB = createPipelineRun({
      runId: `claim-b-${issueNumber}`,
      taskId,
      concurrencyKey,
      strategy: "serialize",
      status: "active",
      startedAt: "2026-03-25T18:30:00.000Z",
      lastHeartbeatAt: "2026-03-25T18:30:00.000Z"
    });

    const [claimA, claimB] = await Promise.all([
      repository.claimPipelineRun({ run: runA, staleAfterMs: 60_000 }),
      repository.claimPipelineRun({ run: runB, staleAfterMs: 60_000 })
    ]);
    const claimResults = [
      { runId: runA.runId, result: claimA },
      { runId: runB.runId, result: claimB }
    ];
    const claimed = claimResults.filter((entry) => entry.result.blockedByRun === null);
    const blocked = claimResults.filter((entry) => entry.result.blockedByRun !== null);
    const activeRuns = await repository.listPipelineRuns({
      concurrencyKey,
      statuses: ["active"],
      limit: 10
    });

    expect(claimed).toHaveLength(1);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.result.blockedByRun?.runId).toBe(claimed[0]?.runId);
    expect(activeRuns.map((run) => run.runId)).toEqual([claimed[0]!.runId]);
    await expect(repository.getPipelineRun(blocked[0]!.runId)).resolves.toBeNull();
  });
  it("persists GitHub polling cursors in Postgres", async () => {
    const repo = `polling-${Date.now()}/platform`;

    await repository.saveGitHubIssuePollingCursor({
      repo,
      lastSeenIssueNumber: 88,
      lastSeenUpdatedAt: "2026-03-27T10:00:00.000Z",
      lastPollStartedAt: "2026-03-27T10:01:00.000Z",
      lastPollCompletedAt: "2026-03-27T10:01:05.000Z",
      lastPollStatus: "succeeded",
      lastPollError: null,
      updatedAt: "2026-03-27T10:01:05.000Z"
    });

    const cursor = await repository.getGitHubIssuePollingCursor(repo);
    const cursors = await repository.listGitHubIssuePollingCursors();

    expect(cursor).toMatchObject({
      repo,
      lastSeenIssueNumber: 88,
      lastPollStatus: "succeeded"
    });
    expect(cursors.some((entry) => entry.repo === repo)).toBe(true);
  });
});
