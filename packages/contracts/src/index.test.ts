import { describe, expect, it } from "vitest";
import {
  asIsoTimestamp,
  concurrencyDecisionSchema,
  memoryContextSchema,
  memoryRecordSchema,
  pipelineRunSchema,
  planningTaskInputSchema,
  policyPackManifestSchema,
  runEventSchema,
  runSummarySchema,
  runtimeInstructionLayerSchema,
  workspaceContextBundleSchema,
  workspaceDescriptorSchema,
  approvalRequestSchema,
  approvalRequestQuerySchema
} from "@reddwarf/contracts";

const timestamp = asIsoTimestamp(new Date("2026-03-25T18:00:00.000Z"));

describe("contracts", () => {
  it("parses a valid planning input", () => {
    const parsed = planningTaskInputSchema.parse({
      source: {
        provider: "github",
        repo: "acme/platform",
        issueNumber: 42,
        issueUrl: "https://github.com/acme/platform/issues/42"
      },
      title: "Plan the docs-only backlog",
      summary:
        "Create a deterministic planning package for the docs-only backlog in the platform repo.",
      priority: 1,
      labels: ["ai-eligible"],
      acceptanceCriteria: ["Spec is produced"],
      affectedPaths: ["docs/architecture.md"],
      requestedCapabilities: ["can_plan", "can_archive_evidence"]
    });

    expect(parsed.source.repo).toBe("acme/platform");
  });

  it("parses a workspace context bundle", () => {
    const bundle = workspaceContextBundleSchema.parse({
      manifest: {
        taskId: "acme-platform-42",
        source: {
          provider: "github",
          repo: "acme/platform",
          issueNumber: 42,
          issueUrl: "https://github.com/acme/platform/issues/42"
        },
        title: "Plan the docs-only backlog",
        summary:
          "Create a deterministic planning package for the docs-only backlog in the platform repo.",
        priority: 1,
        riskClass: "low",
        approvalMode: "auto",
        currentPhase: "archive",
        lifecycleStatus: "completed",
        assignedAgentType: "architect",
        requestedCapabilities: ["can_plan", "can_archive_evidence"],
        retryCount: 0,
        evidenceLinks: ["db://manifest/acme-platform-42"],
        workspaceId: null,
        branchName: null,
        prNumber: null,
        policyVersion: "reddwarf-v1",
        createdAt: timestamp,
        updatedAt: timestamp
      },
      spec: {
        specId: "spec-1",
        taskId: "acme-platform-42",
        summary: "Plan the work.",
        assumptions: ["Issue is ready."],
        affectedAreas: ["docs/architecture.md"],
        constraints: ["No code writing."],
        acceptanceCriteria: ["Spec is produced"],
        testExpectations: ["Schemas validate."],
        recommendedAgentType: "architect",
        riskClass: "low",
        createdAt: timestamp
      },
      policySnapshot: {
        policyVersion: "reddwarf-v1",
        approvalMode: "auto",
        allowedCapabilities: ["can_plan", "can_archive_evidence"],
        allowedPaths: ["docs/**"],
        allowedSecretScopes: [],
        blockedPhases: ["review"],
        reasons: ["Planning phase is approved for autonomous execution in v1."]
      },
      acceptanceCriteria: ["Spec is produced"],
      allowedPaths: ["docs/**"]
    });

    expect(bundle.policySnapshot.blockedPhases).toEqual(["review"]);
  });

  it("parses a runtime instruction layer", () => {
    const layer = runtimeInstructionLayerSchema.parse({
      taskId: "acme-platform-42",
      assignedAgentType: "architect",
      recommendedAgentType: "architect",
      approvalMode: "auto",
      allowedCapabilities: ["can_plan", "can_archive_evidence"],
      blockedPhases: ["review"],
      canonicalSources: [
        "standards/engineering.md",
        "prompts/planning-system.md"
      ],
      contextFiles: [".context/task.json", ".context/spec.md"],
      files: [
        {
          relativePath: "SOUL.md",
          description: "Workspace operating posture and source hierarchy.",
          content: "# RedDwarf Runtime Soul"
        },
        {
          relativePath: "skills/reddwarf-task/SKILL.md",
          description: "Task skill",
          content: "# RedDwarf Task Runtime Skill"
        }
      ]
    });

    expect(layer.files.map((file) => file.relativePath)).toContain("SOUL.md");
  });

  it("parses a workspace descriptor", () => {
    const descriptor = workspaceDescriptorSchema.parse({
      workspaceId: "workspace-42",
      taskId: "acme-platform-42",
      workspaceRoot: "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42",
      contextDir:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42/.context",
      stateFile:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42/.workspace/workspace.json",
      scratchDir:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42/scratch",
      artifactsDir:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42/artifacts",
      status: "provisioned",
      assignedAgentType: "architect",
      recommendedAgentType: "architect",
      allowedCapabilities: ["can_plan", "can_archive_evidence"],
      allowedPaths: ["docs/**"],
      blockedPhases: ["review"],
      canonicalSources: ["standards/engineering.md"],
      taskContractFiles: [
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42/.context/task.json"
      ],
      instructionFiles: {
        soulMd: "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42/SOUL.md",
        agentsMd:
          "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42/AGENTS.md",
        toolsMd:
          "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42/TOOLS.md",
        taskSkillMd:
          "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42/skills/reddwarf-task/SKILL.md"
      },
      toolPolicy: {
        mode: "planning_only",
        codeWriteEnabled: false,
        allowedCapabilities: ["can_plan", "can_archive_evidence"],
        blockedPhases: ["review"],
        notes: ["Planning-only workspace."]
      },
      credentialPolicy: {
        mode: "none",
        allowedSecretScopes: [],
        injectedSecretKeys: [],
        secretEnvFile: null,
        leaseIssuedAt: null,
        leaseExpiresAt: null,
        notes: ["Secrets adapter is not implemented in v1."]
      },
      createdAt: timestamp,
      updatedAt: timestamp,
      destroyedAt: null
    });

    expect(descriptor.status).toBe("provisioned");
    expect(descriptor.toolPolicy.mode).toBe("planning_only");
    expect(descriptor.toolPolicy.codeWriteEnabled).toBe(false);
  });

  it("parses a validation workspace descriptor", () => {
    const descriptor = workspaceDescriptorSchema.parse({
      workspaceId: "workspace-42-validation",
      taskId: "acme-platform-42",
      workspaceRoot:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-validation",
      contextDir:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-validation/.context",
      stateFile:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-validation/.workspace/workspace.json",
      scratchDir:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-validation/scratch",
      artifactsDir:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-validation/artifacts",
      status: "provisioned",
      assignedAgentType: "validation",
      recommendedAgentType: "developer",
      allowedCapabilities: ["can_run_tests", "can_archive_evidence"],
      allowedPaths: ["src/**"],
      blockedPhases: ["review"],
      canonicalSources: ["agents/validation.md"],
      taskContractFiles: [
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-validation/.context/task.json"
      ],
      instructionFiles: {
        soulMd:
          "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-validation/SOUL.md",
        agentsMd:
          "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-validation/AGENTS.md",
        toolsMd:
          "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-validation/TOOLS.md",
        taskSkillMd:
          "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-validation/skills/reddwarf-task/SKILL.md"
      },
      toolPolicy: {
        mode: "validation_only",
        codeWriteEnabled: false,
        allowedCapabilities: ["can_run_tests", "can_archive_evidence"],
        blockedPhases: ["review"],
        notes: ["Validation-only workspace."]
      },
      credentialPolicy: {
        mode: "none",
        allowedSecretScopes: [],
        injectedSecretKeys: [],
        secretEnvFile: null,
        leaseIssuedAt: null,
        leaseExpiresAt: null,
        notes: ["Secrets adapter is not implemented in v1."]
      },
      createdAt: timestamp,
      updatedAt: timestamp,
      destroyedAt: null
    });

    expect(descriptor.assignedAgentType).toBe("validation");
    expect(descriptor.toolPolicy.mode).toBe("validation_only");
    expect(descriptor.toolPolicy.allowedCapabilities).toContain(
      "can_run_tests"
    );
  });

  it("parses an scm workspace descriptor", () => {
    const descriptor = workspaceDescriptorSchema.parse({
      workspaceId: "workspace-42-scm",
      taskId: "acme-platform-42",
      workspaceRoot:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-scm",
      contextDir:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-scm/.context",
      stateFile:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-scm/.workspace/workspace.json",
      scratchDir:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-scm/scratch",
      artifactsDir:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-scm/artifacts",
      status: "provisioned",
      assignedAgentType: "scm",
      recommendedAgentType: "developer",
      allowedCapabilities: ["can_open_pr", "can_archive_evidence"],
      allowedPaths: ["src/**"],
      blockedPhases: ["review"],
      canonicalSources: ["docs/implementation-map.md"],
      taskContractFiles: [
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-scm/.context/task.json"
      ],
      instructionFiles: {
        soulMd:
          "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-scm/SOUL.md",
        agentsMd:
          "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-scm/AGENTS.md",
        toolsMd:
          "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-scm/TOOLS.md",
        taskSkillMd:
          "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-scm/skills/reddwarf-task/SKILL.md"
      },
      toolPolicy: {
        mode: "scm_only",
        codeWriteEnabled: false,
        allowedCapabilities: ["can_open_pr", "can_archive_evidence"],
        blockedPhases: ["review"],
        notes: ["SCM-only workspace."]
      },
      credentialPolicy: {
        mode: "none",
        allowedSecretScopes: [],
        injectedSecretKeys: [],
        secretEnvFile: null,
        leaseIssuedAt: null,
        leaseExpiresAt: null,
        notes: ["Secrets are not injected during SCM."]
      },
      createdAt: timestamp,
      updatedAt: timestamp,
      destroyedAt: null
    });

    expect(descriptor.assignedAgentType).toBe("scm");
    expect(descriptor.toolPolicy.mode).toBe("scm_only");
    expect(descriptor.toolPolicy.allowedCapabilities).toContain("can_open_pr");
  });

  it("parses a policy snapshot with allowed secret scopes", () => {
    const bundle = workspaceContextBundleSchema.parse({
      manifest: {
        taskId: "acme-platform-42",
        source: {
          provider: "github",
          repo: "acme/platform",
          issueNumber: 42,
          issueUrl: "https://github.com/acme/platform/issues/42"
        },
        title: "Plan the docs-only backlog",
        summary:
          "Create a deterministic planning package for the docs-only backlog in the platform repo.",
        priority: 1,
        riskClass: "medium",
        approvalMode: "human_signoff_required",
        currentPhase: "development",
        lifecycleStatus: "blocked",
        assignedAgentType: "developer",
        requestedCapabilities: ["can_write_code", "can_use_secrets"],
        retryCount: 0,
        evidenceLinks: ["db://manifest/acme-platform-42"],
        workspaceId: "workspace-42",
        branchName: null,
        prNumber: null,
        policyVersion: "reddwarf-v1",
        createdAt: timestamp,
        updatedAt: timestamp
      },
      spec: {
        specId: "spec-2",
        taskId: "acme-platform-42",
        summary: "Plan the work.",
        assumptions: ["Issue is ready."],
        affectedAreas: ["src/credential-flow.ts"],
        constraints: ["No uncontrolled secret access."],
        acceptanceCriteria: ["Secret scopes are explicit"],
        testExpectations: ["Schemas validate."],
        recommendedAgentType: "developer",
        riskClass: "medium",
        createdAt: timestamp
      },
      policySnapshot: {
        policyVersion: "reddwarf-v1",
        approvalMode: "human_signoff_required",
        allowedCapabilities: ["can_plan", "can_archive_evidence", "can_use_secrets"],
        allowedPaths: ["src/**"],
        allowedSecretScopes: ["github_readonly"],
        blockedPhases: ["review"],
        reasons: ["Scoped secrets are allowed after approval."]
      },
      acceptanceCriteria: ["Secret scopes are explicit"],
      allowedPaths: ["src/**"]
    });

    expect(bundle.policySnapshot.allowedSecretScopes).toEqual([
      "github_readonly"
    ]);
  });

  it("parses approval requests and queue queries", () => {
    const request = approvalRequestSchema.parse({
      requestId: "approval-1",
      taskId: "acme-platform-42",
      runId: "run-1",
      phase: "policy_gate",
      approvalMode: "human_signoff_required",
      status: "pending",
      riskClass: "high",
      summary: "Human approval is required before downstream execution.",
      requestedCapabilities: ["can_write_code"],
      allowedPaths: ["src/**"],
      blockedPhases: ["review"],
      policyReasons: [
        "Developer orchestration may continue after human intervention, but code writing remains disabled by default in v1."
      ],
      requestedBy: "policy",
      decidedBy: null,
      decision: null,
      decisionSummary: null,
      comment: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      resolvedAt: null
    });
    const query = approvalRequestQuerySchema.parse({
      taskId: "acme-platform-42",
      statuses: ["pending"],
      limit: 10
    });

    expect(request.status).toBe("pending");
    expect(query.statuses).toEqual(["pending"]);
  });

  it("parses run events and summaries with failure metadata", () => {
    const event = runEventSchema.parse({
      eventId: "run-1:event-1",
      taskId: "acme-platform-42",
      runId: "run-1",
      phase: "planning",
      level: "error",
      code: "PHASE_FAILED",
      message: "Planning failed.",
      failureClass: "planning_failure",
      durationMs: 12,
      data: {
        causeCode: "PLANNING_FAILED"
      },
      createdAt: timestamp
    });
    const summary = runSummarySchema.parse({
      taskId: "acme-platform-42",
      runId: "run-1",
      status: "failed",
      totalDurationMs: 12,
      phaseDurations: {
        planning: 12
      },
      eventCounts: {
        info: 0,
        warn: 0,
        error: 1
      },
      latestPhase: "planning",
      failureClass: "planning_failure",
      failureCodes: ["PHASE_FAILED"],
      firstEventAt: timestamp,
      lastEventAt: timestamp
    });

    expect(event.failureClass).toBe("planning_failure");
    expect(summary.phaseDurations.planning).toBe(12);
  });

  it("parses partitioned memory records and memory contexts", () => {
    const taskMemory = memoryRecordSchema.parse({
      memoryId: "memory-1",
      taskId: "acme-platform-42",
      scope: "task",
      provenance: "pipeline_derived",
      key: "planning.brief",
      title: "Planning brief",
      value: {
        summary: "Plan the docs-only backlog."
      },
      repo: "acme/platform",
      organizationId: "acme",
      sourceUri: null,
      tags: ["planning", "task"],
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const context = memoryContextSchema.parse({
      taskId: "acme-platform-42",
      repo: "acme/platform",
      organizationId: "acme",
      taskMemory: [taskMemory],
      projectMemory: [],
      organizationMemory: [],
      externalMemory: []
    });

    expect(taskMemory.scope).toBe("task");
    expect(context.taskMemory).toHaveLength(1);
  });

  it("parses policy-pack package manifests", () => {
    const manifest = policyPackManifestSchema.parse({
      policyPackId: "reddwarf-policy-pack",
      policyPackVersion: "0.1.0+20260325t210000z",
      rootPackageVersion: "0.1.0",
      createdAt: timestamp,
      sourceRoot: "C:/Dev/RedDwarf",
      packageRoot:
        "C:/Dev/RedDwarf/artifacts/policy-packs/reddwarf-policy-pack-0.1.0+20260325t210000z/policy-root",
      composePolicySourceRoot:
        "C:/Dev/RedDwarf/artifacts/policy-packs/reddwarf-policy-pack-0.1.0+20260325t210000z/policy-root",
      contentHash:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      runtimeDependenciesBundled: true,
      includedEntries: [
        {
          path: "agents",
          kind: "directory",
          requiredAtRuntime: true
        },
        {
          path: "packages/control-plane/dist/index.js",
          kind: "file",
          requiredAtRuntime: true
        }
      ],
      notes: ["Packaged for immutable Docker mounts."]
    });

    expect(manifest.runtimeDependenciesBundled).toBe(true);
    expect(manifest.includedEntries).toHaveLength(2);
  });

  it("parses pipeline runs and overlap decisions", () => {
    const run = pipelineRunSchema.parse({
      runId: "run-1",
      taskId: "acme-platform-42",
      concurrencyKey: "github:acme/platform:42",
      strategy: "serialize",
      status: "active",
      blockedByRunId: null,
      overlapReason: null,
      startedAt: timestamp,
      lastHeartbeatAt: timestamp,
      completedAt: null,
      staleAt: null,
      metadata: {
        sourceRepo: "acme/platform"
      }
    });
    const decision = concurrencyDecisionSchema.parse({
      action: "block",
      strategy: "serialize",
      blockedByRunId: "run-0",
      staleRunIds: ["run-stale"],
      reason:
        "Active overlapping run run-0 already owns github:acme/platform:42."
    });

    expect(run.status).toBe("active");
    expect(decision.action).toBe("block");
  });
});
