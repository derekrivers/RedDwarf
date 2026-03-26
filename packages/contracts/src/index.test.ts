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
  workspaceContextBundleSchema
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
      summary: "Create a deterministic planning package for the docs-only backlog in the platform repo.",
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
        summary: "Create a deterministic planning package for the docs-only backlog in the platform repo.",
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
        blockedPhases: ["development", "validation", "review", "scm"],
        reasons: ["Planning phase is approved for autonomous execution in v1."]
      },
      acceptanceCriteria: ["Spec is produced"],
      allowedPaths: ["docs/**"]
    });

    expect(bundle.policySnapshot.blockedPhases).toContain("development");
  });

  it("parses a runtime instruction layer", () => {
    const layer = runtimeInstructionLayerSchema.parse({
      taskId: "acme-platform-42",
      assignedAgentType: "architect",
      recommendedAgentType: "architect",
      approvalMode: "auto",
      allowedCapabilities: ["can_plan", "can_archive_evidence"],
      blockedPhases: ["development", "validation", "review", "scm"],
      canonicalSources: ["standards/engineering.md", "prompts/planning-system.md"],
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
      packageRoot: "C:/Dev/RedDwarf/artifacts/policy-packs/reddwarf-policy-pack-0.1.0+20260325t210000z/policy-root",
      composePolicySourceRoot: "C:/Dev/RedDwarf/artifacts/policy-packs/reddwarf-policy-pack-0.1.0+20260325t210000z/policy-root",
      contentHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
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
      reason: "Active overlapping run run-0 already owns github:acme/platform:42."
    });

    expect(run.status).toBe("active");
    expect(decision.action).toBe("block");
  });
});
