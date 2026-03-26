import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DeterministicDeveloperAgent,
  DeterministicPlanningAgent,
  DeterministicScmAgent,
  DeterministicValidationAgent,
  PlanningPipelineFailure,
  assertPhaseLifecycleTransition,
  assertTaskLifecycleTransition,
  createBufferedPlanningLogger,
  createRuntimeInstructionArtifacts,
  createRuntimeInstructionLayer,
  createWorkspaceContextBundle,
  destroyTaskWorkspace,
  provisionTaskWorkspace,
  resolveApprovalRequest,
  runDeveloperPhase,
  runPlanningPipeline,
  runScmPhase,
  runValidationPhase
} from "@reddwarf/control-plane";
import {
  InMemoryPlanningRepository,
  createPipelineRun
} from "@reddwarf/evidence";
import {
  FixtureGitHubAdapter,
  FixtureSecretsAdapter
} from "@reddwarf/integrations";
import type { PlanningTaskInput } from "@reddwarf/contracts";

const eligibleInput: PlanningTaskInput = {
  source: {
    provider: "github",
    repo: "acme/platform",
    issueNumber: 99,
    issueUrl: "https://github.com/acme/platform/issues/99"
  },
  title: "Plan a docs-safe change",
  summary:
    "Plan a deterministic docs-safe change for the platform repository with durable evidence output.",
  priority: 1,
  labels: ["ai-eligible"],
  acceptanceCriteria: ["A planning spec exists", "Policy output is archived"],
  affectedPaths: ["docs/guide.md"],
  requestedCapabilities: ["can_plan", "can_archive_evidence"],
  metadata: {}
};

describe("control-plane", () => {
  it("rejects illegal lifecycle transitions", () => {
    expect(() => assertTaskLifecycleTransition("ready", "completed")).toThrow();
    expect(() => assertPhaseLifecycleTransition("passed", "running")).toThrow();
  });

  it("completes the planning pipeline and records structured observability output", async () => {
    const repository = new InMemoryPlanningRepository();
    const bufferedLogger = createBufferedPlanningLogger();
    const result = await runPlanningPipeline(eligibleInput, {
      repository,
      planner: new DeterministicPlanningAgent(),
      logger: bufferedLogger.logger,
      clock: () => new Date("2026-03-25T18:00:00.000Z"),
      idGenerator: () => "run-001"
    });

    expect(result.nextAction).toBe("complete");
    expect(result.manifest.lifecycleStatus).toBe("completed");
    expect(result.concurrencyDecision.action).toBe("start");
    expect(repository.phaseRecords.map((record) => record.phase)).toEqual([
      "intake",
      "eligibility",
      "planning",
      "policy_gate",
      "archive"
    ]);
    expect(
      repository.phaseRecords.some((record) => record.phase === "development")
    ).toBe(false);

    const bundle = createWorkspaceContextBundle({
      manifest: result.manifest,
      spec: result.spec!,
      policySnapshot: result.policySnapshot!
    });
    const runtimeInstructionLayer = createRuntimeInstructionLayer(bundle);
    const runtimeInstructionArtifacts = createRuntimeInstructionArtifacts(
      runtimeInstructionLayer
    );
    const runSummary = await repository.getRunSummary(
      result.manifest.taskId,
      result.runId
    );
    const taskMemory = await repository.listMemoryRecords({
      taskId: result.manifest.taskId,
      scope: "task"
    });
    const pipelineRuns = await repository.listPipelineRuns({
      taskId: result.manifest.taskId
    });

    expect(bundle.allowedPaths).toEqual(["docs/guide.md"]);
    expect(
      runtimeInstructionLayer.files.map((file) => file.relativePath)
    ).toContain("SOUL.md");
    expect(runtimeInstructionLayer.canonicalSources).toContain(
      "standards/engineering.md"
    );
    expect(runtimeInstructionArtifacts.soulMd).toContain(
      "RedDwarf Runtime Soul"
    );
    expect(runtimeInstructionArtifacts.toolsMd).toContain("can_plan");
    expect(runtimeInstructionArtifacts.taskSkillMd).toContain(
      ".context/task.json"
    );
    expect(runSummary?.status).toBe("completed");
    expect(runSummary?.phaseDurations.planning).toBe(0);
    expect(runSummary?.eventCounts.info).toBeGreaterThanOrEqual(6);
    expect(taskMemory).toHaveLength(1);
    expect(taskMemory[0]?.key).toBe("planning.brief");
    expect(pipelineRuns).toHaveLength(1);
    expect(pipelineRuns[0]?.status).toBe("completed");
    expect(
      bufferedLogger.records.some(
        (record) => record.bindings.runId === result.runId
      )
    ).toBe(true);
    expect(
      bufferedLogger.records.some(
        (record) =>
          record.bindings.code === "PIPELINE_COMPLETED" &&
          record.level === "info"
      )
    ).toBe(true);
  });

  it("provisions and destroys a managed workspace with manifest and evidence updates", async () => {
    const repository = new InMemoryPlanningRepository();
    const tempRoot = await mkdtemp(
      join(tmpdir(), "reddwarf-managed-workspace-")
    );
    const planningResult = await runPlanningPipeline(eligibleInput, {
      repository,
      planner: new DeterministicPlanningAgent(),
      clock: () => new Date("2026-03-25T18:00:00.000Z"),
      idGenerator: () => "run-workspace"
    });

    try {
      const snapshot = await repository.getTaskSnapshot(
        planningResult.manifest.taskId
      );
      const provisioned = await provisionTaskWorkspace({
        snapshot,
        repository,
        targetRoot: tempRoot,
        workspaceId: "workspace-001",
        clock: () => new Date("2026-03-25T18:05:00.000Z")
      });
      const descriptor = JSON.parse(
        await readFile(provisioned.workspace.stateFile, "utf8")
      );

      expect(provisioned.manifest.workspaceId).toBe("workspace-001");
      expect(descriptor.status).toBe("provisioned");
      expect(descriptor.toolPolicy.mode).toBe("planning_only");
      expect(descriptor.toolPolicy.codeWriteEnabled).toBe(false);
      expect(provisioned.workspace.descriptor.credentialPolicy.mode).toBe(
        "none"
      );
      expect(
        repository.evidenceRecords.some((record) =>
          record.recordId.endsWith(":provisioned")
        )
      ).toBe(true);

      const destroyed = await destroyTaskWorkspace({
        manifest: provisioned.manifest,
        repository,
        targetRoot: tempRoot,
        clock: () => new Date("2026-03-25T18:10:00.000Z")
      });

      expect(destroyed.manifest.workspaceId).toBeNull();
      expect(destroyed.workspace.removed).toBe(true);
      expect(destroyed.workspace.descriptor?.status).toBe("destroyed");
      expect(
        repository.evidenceRecords.some((record) =>
          record.recordId.endsWith(":destroyed")
        )
      ).toBe(true);
      await expect(
        access(provisioned.workspace.workspaceRoot)
      ).rejects.toThrow();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("blocks ineligible tasks before planning and persists a blocked run summary", async () => {
    const repository = new InMemoryPlanningRepository();
    const result = await runPlanningPipeline(
      {
        ...eligibleInput,
        labels: []
      },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-25T18:00:00.000Z"),
        idGenerator: () => "run-002"
      }
    );
    const runSummary = await repository.getRunSummary(
      result.manifest.taskId,
      result.runId
    );
    const pipelineRuns = await repository.listPipelineRuns({
      taskId: result.manifest.taskId
    });

    expect(result.nextAction).toBe("task_blocked");
    expect(result.manifest.currentPhase).toBe("eligibility");
    expect(repository.planningSpecs.size).toBe(0);
    expect(runSummary?.status).toBe("blocked");
    expect(runSummary?.failureClass).toBe("policy_violation");
    expect(pipelineRuns[0]?.status).toBe("blocked");
  });

  it("archives planning output but queues a human approval request for code-writing tasks", async () => {
    const repository = new InMemoryPlanningRepository();
    const result = await runPlanningPipeline(
      {
        ...eligibleInput,
        requestedCapabilities: ["can_write_code"],
        affectedPaths: ["src/app.ts"]
      },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-25T18:00:00.000Z"),
        idGenerator: () => "run-003"
      }
    );
    const runSummary = await repository.getRunSummary(
      result.manifest.taskId,
      result.runId
    );
    const pipelineRuns = await repository.listPipelineRuns({
      taskId: result.manifest.taskId
    });
    const approvalRequests = await repository.listApprovalRequests({
      taskId: result.manifest.taskId
    });

    expect(result.nextAction).toBe("await_human");
    expect(result.manifest.lifecycleStatus).toBe("blocked");
    expect(result.policySnapshot?.approvalMode).toBe("human_signoff_required");
    expect(result.approvalRequest?.status).toBe("pending");
    expect(
      repository.phaseRecords.find((record) => record.phase === "policy_gate")
        ?.status
    ).toBe("escalated");
    expect(approvalRequests).toHaveLength(1);
    expect(approvalRequests[0]?.requestedCapabilities).toEqual([
      "can_write_code"
    ]);
    expect(pipelineRuns[0]?.status).toBe("blocked");
    expect(runSummary?.status).toBe("blocked");
    expect(runSummary?.failureClass).toBeNull();
    expect(runSummary?.eventCounts.warn).toBeGreaterThanOrEqual(2);
  });

  it("approves a pending approval request and marks the task ready", async () => {
    const repository = new InMemoryPlanningRepository();
    const result = await runPlanningPipeline(
      {
        ...eligibleInput,
        requestedCapabilities: ["can_write_code"],
        affectedPaths: ["src/app.ts"]
      },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-25T18:00:00.000Z"),
        idGenerator: () => "run-approve"
      }
    );

    const decision = await resolveApprovalRequest(
      {
        requestId: result.approvalRequest!.requestId,
        decision: "approve",
        decidedBy: "operator",
        decisionSummary: "Approved for developer orchestration.",
        comment: "Proceed under supervision."
      },
      {
        repository,
        clock: () => new Date("2026-03-25T18:05:00.000Z")
      }
    );
    const persistedRequest = await repository.getApprovalRequest(
      result.approvalRequest!.requestId
    );

    expect(decision.manifest.lifecycleStatus).toBe("ready");
    expect(persistedRequest?.status).toBe("approved");
    expect(persistedRequest?.decision).toBe("approve");
    expect(
      repository.phaseRecords.some((record) =>
        record.recordId.includes(":approval:")
      )
    ).toBe(true);
    expect(
      repository.runEvents.some((event) => event.code === "APPROVAL_APPROVED")
    ).toBe(true);
  });

  it("runs the developer phase in a managed workspace with code writing disabled", async () => {
    const repository = new InMemoryPlanningRepository();
    const tempRoot = await mkdtemp(
      join(tmpdir(), "reddwarf-development-workspace-")
    );
    const planningResult = await runPlanningPipeline(
      {
        ...eligibleInput,
        requestedCapabilities: ["can_write_code"],
        affectedPaths: ["src/app.ts"]
      },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-25T18:00:00.000Z"),
        idGenerator: () => "run-dev-plan"
      }
    );

    await resolveApprovalRequest(
      {
        requestId: planningResult.approvalRequest!.requestId,
        decision: "approve",
        decidedBy: "operator",
        decisionSummary: "Approved for developer orchestration.",
        comment: "Code writing stays disabled."
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
          workspaceId: "workspace-dev"
        },
        {
          repository,
          developer: new DeterministicDeveloperAgent(),
          clock: () => new Date("2026-03-25T18:10:00.000Z"),
          idGenerator: () => "run-dev-phase"
        }
      );
      const persistedManifest = await repository.getManifest(
        planningResult.manifest.taskId
      );
      const runSummary = await repository.getRunSummary(
        planningResult.manifest.taskId,
        development.runId
      );
      const handoffMarkdown = await readFile(development.handoffPath!, "utf8");

      expect(development.nextAction).toBe("await_validation");
      expect(development.manifest.currentPhase).toBe("development");
      expect(development.manifest.lifecycleStatus).toBe("blocked");
      expect(development.workspace?.descriptor.toolPolicy.mode).toBe(
        "development_readonly"
      );
      expect(
        development.workspace?.descriptor.toolPolicy.codeWriteEnabled
      ).toBe(false);
      expect(handoffMarkdown).toContain("Development Handoff");
      expect(
        repository.phaseRecords.some((record) => record.phase === "development")
      ).toBe(true);
      expect(
        repository.runEvents.some(
          (event) => event.code === "CODE_WRITE_DISABLED"
        )
      ).toBe(true);
      expect(persistedManifest?.assignedAgentType).toBe("developer");
      expect(runSummary?.status).toBe("blocked");
      expect(runSummary?.latestPhase).toBe("development");

      await destroyTaskWorkspace({
        manifest: development.manifest,
        repository,
        targetRoot: tempRoot,
        clock: () => new Date("2026-03-25T18:15:00.000Z")
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });


  it("injects scoped credentials into the developer workspace when policy and adapter both allow them", async () => {
    const repository = new InMemoryPlanningRepository();
    const tempRoot = await mkdtemp(
      join(tmpdir(), "reddwarf-secret-development-")
    );
    const planningResult = await runPlanningPipeline(
      {
        ...eligibleInput,
        summary:
          "Plan a deterministic implementation task that requires scoped credentials for read-only integration access during development.",
        requestedCapabilities: ["can_write_code", "can_use_secrets"],
        affectedPaths: ["src/integrations/github.ts"],
        metadata: {
          secretScopes: ["github_readonly"]
        }
      },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-25T18:00:00.000Z"),
        idGenerator: () => "run-secret-dev-plan"
      }
    );

    await resolveApprovalRequest(
      {
        requestId: planningResult.approvalRequest!.requestId,
        decision: "approve",
        decidedBy: "operator",
        decisionSummary: "Approved for scoped developer credentials.",
        comment: "Inject the least-privilege lease only."
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
          workspaceId: "workspace-secret-dev"
        },
        {
          repository,
          developer: new DeterministicDeveloperAgent(),
          secrets: new FixtureSecretsAdapter([
            {
              scope: "github_readonly",
              environmentVariables: {
                GITHUB_TOKEN: "ghs_dev_fixture"
              },
              allowedAgents: ["developer", "validation"],
              allowedEnvironments: ["staging"]
            }
          ]),
          environment: "staging",
          clock: () => new Date("2026-03-25T18:10:00.000Z"),
          idGenerator: () => "run-secret-dev-phase"
        }
      );
      const secretEnv = JSON.parse(
        await readFile(
          development.workspace!.descriptor.credentialPolicy.secretEnvFile!,
          "utf8"
        )
      );
      const toolsMd = await readFile(
        development.workspace!.instructions.files.toolsMd,
        "utf8"
      );

      expect(development.workspace?.descriptor.credentialPolicy.mode).toBe(
        "scoped_env"
      );
      expect(
        development.workspace?.descriptor.toolPolicy.allowedCapabilities
      ).toContain("can_use_secrets");
      expect(
        development.workspace?.descriptor.credentialPolicy.allowedSecretScopes
      ).toEqual(["github_readonly"]);
      expect(
        development.workspace?.descriptor.credentialPolicy.injectedSecretKeys
      ).toEqual(["GITHUB_TOKEN"]);
      expect(secretEnv.environmentVariables.GITHUB_TOKEN).toBe(
        "ghs_dev_fixture"
      );
      expect(toolsMd).toContain("github_readonly");
      expect(
        repository.runEvents.some(
          (event) => event.code === "SECRET_LEASE_ISSUED"
        )
      ).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when scoped secrets are approved but no secrets adapter is configured", async () => {
    const repository = new InMemoryPlanningRepository();
    const tempRoot = await mkdtemp(
      join(tmpdir(), "reddwarf-secret-missing-")
    );
    const planningResult = await runPlanningPipeline(
      {
        ...eligibleInput,
        summary:
          "Plan a deterministic implementation task that requires scoped credentials for read-only integration access during development.",
        requestedCapabilities: ["can_write_code", "can_use_secrets"],
        affectedPaths: ["src/integrations/github.ts"],
        metadata: {
          secretScopes: ["github_readonly"]
        }
      },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-25T18:00:00.000Z"),
        idGenerator: () => "run-secret-missing-plan"
      }
    );

    await resolveApprovalRequest(
      {
        requestId: planningResult.approvalRequest!.requestId,
        decision: "approve",
        decidedBy: "operator",
        decisionSummary: "Approved for scoped developer credentials.",
        comment: "Fail if the adapter is unavailable."
      },
      {
        repository,
        clock: () => new Date("2026-03-25T18:05:00.000Z")
      }
    );

    try {
      await expect(
        runDeveloperPhase(
          {
            taskId: planningResult.manifest.taskId,
            targetRoot: tempRoot,
            workspaceId: "workspace-secret-missing"
          },
          {
            repository,
            developer: new DeterministicDeveloperAgent(),
            clock: () => new Date("2026-03-25T18:10:00.000Z"),
            idGenerator: () => "run-secret-missing-phase"
          }
        )
      ).rejects.toMatchObject({
        code: "SECRETS_ADAPTER_REQUIRED"
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("runs validation commands in the managed workspace and blocks pending review", async () => {
    const repository = new InMemoryPlanningRepository();
    const tempRoot = await mkdtemp(
      join(tmpdir(), "reddwarf-validation-workspace-")
    );
    const planningResult = await runPlanningPipeline(
      {
        ...eligibleInput,
        requestedCapabilities: ["can_write_code"],
        affectedPaths: ["src/app.ts"]
      },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-25T18:00:00.000Z"),
        idGenerator: () => "run-validation-plan"
      }
    );

    await resolveApprovalRequest(
      {
        requestId: planningResult.approvalRequest!.requestId,
        decision: "approve",
        decidedBy: "operator",
        decisionSummary: "Approved for validation orchestration.",
        comment: "Proceed through validation."
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
          workspaceId: "workspace-validation"
        },
        {
          repository,
          developer: new DeterministicDeveloperAgent(),
          clock: () => new Date("2026-03-25T18:10:00.000Z"),
          idGenerator: () => "run-validation-dev"
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
          idGenerator: () => "run-validation-phase"
        }
      );
      const persistedManifest = await repository.getManifest(
        planningResult.manifest.taskId
      );
      const runSummary = await repository.getRunSummary(
        planningResult.manifest.taskId,
        validation.runId
      );
      const reportMarkdown = await readFile(validation.reportPath!, "utf8");
      const taskMemory = await repository.listMemoryRecords({
        taskId: planningResult.manifest.taskId,
        scope: "task"
      });

      expect(development.nextAction).toBe("await_validation");
      expect(validation.nextAction).toBe("await_review");
      expect(validation.manifest.currentPhase).toBe("validation");
      expect(validation.manifest.lifecycleStatus).toBe("blocked");
      expect(validation.workspace?.descriptor.toolPolicy.mode).toBe(
        "validation_only"
      );
      expect(
        validation.workspace?.descriptor.toolPolicy.allowedCapabilities
      ).toContain("can_run_tests");
      expect(reportMarkdown).toContain("Validation Report");
      expect(
        repository.phaseRecords.some((record) => record.phase === "validation")
      ).toBe(true);
      expect(
        repository.runEvents.some(
          (event) => event.code === "VALIDATION_COMMAND_PASSED"
        )
      ).toBe(true);
      expect(persistedManifest?.assignedAgentType).toBe("validation");
      expect(runSummary?.status).toBe("blocked");
      expect(runSummary?.latestPhase).toBe("validation");
      expect(
        taskMemory.some((record) => record.key === "validation.summary")
      ).toBe(true);

      await destroyTaskWorkspace({
        manifest: validation.manifest,
        repository,
        targetRoot: tempRoot,
        clock: () => new Date("2026-03-25T18:20:00.000Z")
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("routes approved PR tasks from validation into SCM and completes the task", async () => {
    const repository = new InMemoryPlanningRepository();
    const tempRoot = await mkdtemp(join(tmpdir(), "reddwarf-scm-workspace-"));
    const evidenceRoot = await mkdtemp(join(tmpdir(), "reddwarf-scm-evidence-"));
    const planningResult = await runPlanningPipeline(
      {
        ...eligibleInput,
        summary:
          "Plan a deterministic change that requires validation before an approved branch and pull request are opened.",
        requestedCapabilities: ["can_write_code", "can_open_pr"],
        affectedPaths: ["src/app.ts"]
      },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-25T18:00:00.000Z"),
        idGenerator: () => "run-scm-plan"
      }
    );

    await resolveApprovalRequest(
      {
        requestId: planningResult.approvalRequest!.requestId,
        decision: "approve",
        decidedBy: "operator",
        decisionSummary: "Approved for SCM orchestration.",
        comment: "Open the branch and pull request after validation."
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
          workspaceId: "workspace-scm",
          evidenceRoot
        },
        {
          repository,
          developer: new DeterministicDeveloperAgent(),
          clock: () => new Date("2026-03-25T18:10:00.000Z"),
          idGenerator: () => "run-scm-dev"
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
          idGenerator: () => "run-scm-validation"
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
                repo: planningResult.manifest.source.repo,
                issueNumber: 99,
                title: planningResult.manifest.title,
                body: planningResult.manifest.summary,
                labels: ["ai-eligible"],
                url: "https://github.com/acme/platform/issues/99",
                state: "open"
              }
            ],
            mutations: {
              allowBranchCreation: true,
              allowPullRequestCreation: true,
              pullRequestNumberStart: 71
            }
          }),
          clock: () => new Date("2026-03-25T18:20:00.000Z"),
          idGenerator: () => "run-scm-phase"
        }
      );
      const persistedManifest = await repository.getManifest(
        planningResult.manifest.taskId
      );
      const runSummary = await repository.getRunSummary(
        planningResult.manifest.taskId,
        scm.runId
      );
      const reportMarkdown = await readFile(scm.reportPath!, "utf8");
      const archivedArtifacts = repository.evidenceRecords.filter(
        (record) =>
          record.taskId === planningResult.manifest.taskId &&
          typeof record.metadata.archivePath === "string"
      );

      expect(validation.nextAction).toBe("await_scm");
      expect(scm.nextAction).toBe("complete");
      expect(scm.workspace?.descriptor.toolPolicy.mode).toBe("scm_only");
      expect(scm.branch?.branchName).toContain(planningResult.manifest.taskId);
      expect(scm.pullRequest?.number).toBe(71);
      expect(persistedManifest?.currentPhase).toBe("scm");
      expect(persistedManifest?.lifecycleStatus).toBe("completed");
      expect(persistedManifest?.branchName).toBe(scm.branch?.branchName ?? null);
      expect(persistedManifest?.prNumber).toBe(71);
      expect(runSummary?.status).toBe("completed");
      expect(runSummary?.latestPhase).toBe("scm");
      expect(reportMarkdown).toContain("SCM Report");
      expect(
        repository.memoryRecords.some((record) => record.key === "scm.summary")
      ).toBe(true);
      expect(
        repository.runEvents.some((event) => event.code === "PULL_REQUEST_CREATED")
      ).toBe(true);
      expect(
        archivedArtifacts.map((record) => record.metadata.artifactClass)
      ).toEqual(
        expect.arrayContaining(["handoff", "log", "report", "test_result", "diff"])
      );

      await destroyTaskWorkspace({
        manifest: scm.manifest,
        repository,
        targetRoot: tempRoot,
        evidenceRoot,
        clock: () => new Date("2026-03-25T18:25:00.000Z")
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

  it("fails the validation phase when a validation command exits non-zero", async () => {
    const repository = new InMemoryPlanningRepository();
    const tempRoot = await mkdtemp(
      join(tmpdir(), "reddwarf-validation-failure-")
    );
    const planningResult = await runPlanningPipeline(
      {
        ...eligibleInput,
        requestedCapabilities: ["can_write_code"],
        affectedPaths: ["src/app.ts"]
      },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-25T18:00:00.000Z"),
        idGenerator: () => "run-validation-failure-plan"
      }
    );

    await resolveApprovalRequest(
      {
        requestId: planningResult.approvalRequest!.requestId,
        decision: "approve",
        decidedBy: "operator",
        decisionSummary: "Approved for validation failure test.",
        comment: "Exercise the failure path."
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
          workspaceId: "workspace-validation-failure"
        },
        {
          repository,
          developer: new DeterministicDeveloperAgent(),
          clock: () => new Date("2026-03-25T18:10:00.000Z"),
          idGenerator: () => "run-validation-failure-dev"
        }
      );

      await expect(
        runValidationPhase(
          {
            taskId: planningResult.manifest.taskId,
            targetRoot: tempRoot
          },
          {
            repository,
            validator: {
              async createPlan() {
                return {
                  summary: "Force a failing validation command.",
                  commands: [
                    {
                      id: "failing-test",
                      name: "Failing validation command",
                      executable: process.execPath,
                      args: ["-e", "process.exit(7)"]
                    }
                  ]
                };
              }
            },
            clock: () => new Date("2026-03-25T18:15:00.000Z"),
            idGenerator: () => "run-validation-failure-phase"
          }
        )
      ).rejects.toBeInstanceOf(PlanningPipelineFailure);

      const persistedManifest = await repository.getManifest(
        planningResult.manifest.taskId
      );
      const runSummary = await repository.getRunSummary(
        planningResult.manifest.taskId,
        "run-validation-failure-phase"
      );

      expect(persistedManifest?.lifecycleStatus).toBe("failed");
      expect(persistedManifest?.currentPhase).toBe("validation");
      expect(runSummary?.status).toBe("failed");
      expect(runSummary?.failureClass).toBe("validation_failure");
      expect(
        repository.runEvents.some(
          (event) => event.code === "VALIDATION_COMMAND_FAILED"
        )
      ).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects a pending approval request and cancels the task", async () => {
    const repository = new InMemoryPlanningRepository();
    const result = await runPlanningPipeline(
      {
        ...eligibleInput,
        requestedCapabilities: ["can_open_pr"],
        affectedPaths: ["docs/release-notes.md"]
      },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-25T18:00:00.000Z"),
        idGenerator: () => "run-reject"
      }
    );

    const decision = await resolveApprovalRequest(
      {
        requestId: result.approvalRequest!.requestId,
        decision: "reject",
        decidedBy: "operator",
        decisionSummary: "Rejected pending operator signoff.",
        comment: "Do not proceed with SCM automation for this task."
      },
      {
        repository,
        clock: () => new Date("2026-03-25T18:07:00.000Z")
      }
    );
    const persistedRequest = await repository.getApprovalRequest(
      result.approvalRequest!.requestId
    );

    expect(decision.manifest.lifecycleStatus).toBe("cancelled");
    expect(persistedRequest?.status).toBe("rejected");
    expect(persistedRequest?.decision).toBe("reject");
    expect(
      repository.runEvents.some((event) => event.code === "APPROVAL_REJECTED")
    ).toBe(true);
  });

  it("blocks a fresh overlapping run for the same task source", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.savePipelineRun(
      createPipelineRun({
        runId: "run-active",
        taskId: "acme-platform-99",
        concurrencyKey: "github:acme/platform:99",
        strategy: "serialize",
        status: "active",
        startedAt: "2026-03-25T17:59:00.000Z",
        lastHeartbeatAt: "2026-03-25T18:00:00.000Z",
        metadata: {}
      })
    );

    const result = await runPlanningPipeline(eligibleInput, {
      repository,
      planner: new DeterministicPlanningAgent(),
      clock: () => new Date("2026-03-25T18:00:05.000Z"),
      idGenerator: () => "run-blocked"
    });
    const runSummary = await repository.getRunSummary(
      result.manifest.taskId,
      result.runId
    );
    const pipelineRuns = await repository.listPipelineRuns({
      concurrencyKey: "github:acme/platform:99"
    });

    expect(result.nextAction).toBe("task_blocked");
    expect(result.concurrencyDecision.action).toBe("block");
    expect(result.concurrencyDecision.blockedByRunId).toBe("run-active");
    expect(runSummary?.status).toBe("blocked");
    expect(runSummary?.failureClass).toBe("execution_loop");
    expect(pipelineRuns.map((run) => run.status)).toContain("blocked");
    expect(repository.planningSpecs.size).toBe(0);
  });

  it("marks stale overlapping runs and proceeds with a new planning run", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.savePipelineRun(
      createPipelineRun({
        runId: "run-stale",
        taskId: "acme-platform-99",
        concurrencyKey: "github:acme/platform:99",
        strategy: "serialize",
        status: "active",
        startedAt: "2026-03-25T17:45:00.000Z",
        lastHeartbeatAt: "2026-03-25T17:45:00.000Z",
        metadata: {}
      })
    );

    const result = await runPlanningPipeline(eligibleInput, {
      repository,
      planner: new DeterministicPlanningAgent(),
      clock: () => new Date("2026-03-25T18:00:00.000Z"),
      idGenerator: () => "run-005",
      concurrency: {
        staleAfterMs: 60_000
      }
    });
    const runSummary = await repository.getRunSummary(
      result.manifest.taskId,
      result.runId
    );
    const pipelineRuns = await repository.listPipelineRuns({
      concurrencyKey: "github:acme/platform:99"
    });
    const staleRun = pipelineRuns.find((run) => run.runId === "run-stale");
    const activeRun = pipelineRuns.find((run) => run.runId === "run-005");

    expect(result.nextAction).toBe("complete");
    expect(result.concurrencyDecision.action).toBe("start");
    expect(result.concurrencyDecision.staleRunIds).toEqual(["run-stale"]);
    expect(staleRun?.status).toBe("stale");
    expect(staleRun?.staleAt).toBe("2026-03-25T18:00:00.000Z");
    expect(activeRun?.status).toBe("completed");
    expect(runSummary?.status).toBe("completed");
  });

  it("persists a failed run with planning failure metadata", async () => {
    const repository = new InMemoryPlanningRepository();
    const bufferedLogger = createBufferedPlanningLogger();

    await expect(
      runPlanningPipeline(eligibleInput, {
        repository,
        planner: {
          async createSpec() {
            throw new Error("Planner exploded.");
          }
        },
        logger: bufferedLogger.logger,
        clock: () => new Date("2026-03-25T18:00:00.000Z"),
        idGenerator: () => "run-004"
      })
    ).rejects.toBeInstanceOf(PlanningPipelineFailure);

    const manifest = await repository.getManifest("acme-platform-99");
    const runSummary = await repository.getRunSummary(
      "acme-platform-99",
      "run-004"
    );
    const pipelineRuns = await repository.listPipelineRuns({
      taskId: "acme-platform-99"
    });

    expect(manifest?.lifecycleStatus).toBe("failed");
    expect(runSummary?.status).toBe("failed");
    expect(runSummary?.failureClass).toBe("planning_failure");
    expect(pipelineRuns.find((run) => run.runId === "run-004")?.status).toBe(
      "failed"
    );
    expect(
      bufferedLogger.records.some((record) => record.level === "error")
    ).toBe(true);
  });
});
