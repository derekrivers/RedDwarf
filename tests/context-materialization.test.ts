import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRuntimeInstructionArtifacts,
  createRuntimeInstructionLayer,
  createWorkspaceContextArtifacts,
  createWorkspaceContextBundle,
  createWorkspaceContextBundleFromSnapshot,
  destroyManagedWorkspace,
  materializeManagedWorkspace,
  materializeWorkspaceContext
} from "@reddwarf/control-plane";
import {
  asIsoTimestamp,
  type PersistedTaskSnapshot,
  type PlanningSpec,
  type PolicySnapshot,
  type TaskManifest
} from "@reddwarf/contracts";

const timestamp = asIsoTimestamp(new Date("2026-03-25T18:00:00.000Z"));
const manifest: TaskManifest = {
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
};

const spec: PlanningSpec = {
  specId: "spec-1",
  taskId: manifest.taskId,
  summary: "Plan the work.",
  assumptions: ["Issue is ready."],
  affectedAreas: ["docs/architecture.md"],
  constraints: ["No code writing."],
  acceptanceCriteria: ["Spec is produced"],
  testExpectations: ["Schemas validate."],
  recommendedAgentType: "architect",
  riskClass: "low",
  createdAt: timestamp
};

const policySnapshot: PolicySnapshot = {
  policyVersion: "reddwarf-v1",
  approvalMode: "auto",
  allowedCapabilities: ["can_plan", "can_archive_evidence"],
  allowedPaths: ["docs/**"],
  blockedPhases: ["review", "scm"],
  reasons: ["Planning phase is approved for autonomous execution in v1."]
};

describe("workspace context materialization", () => {
  it("creates the expected OpenClaw context artifacts and runtime instructions", () => {
    const bundle = createWorkspaceContextBundle({
      manifest,
      spec,
      policySnapshot
    });
    const artifacts = createWorkspaceContextArtifacts(bundle);
    const runtimeInstructionLayer = createRuntimeInstructionLayer(bundle);
    const runtimeInstructionArtifacts = createRuntimeInstructionArtifacts(
      runtimeInstructionLayer
    );

    expect(JSON.parse(artifacts.taskJson).taskId).toBe(manifest.taskId);
    expect(JSON.parse(artifacts.policySnapshotJson).approvalMode).toBe("auto");
    expect(JSON.parse(artifacts.allowedPathsJson)).toEqual(["docs/**"]);
    expect(JSON.parse(artifacts.acceptanceCriteriaJson)).toEqual([
      "Spec is produced"
    ]);
    expect(artifacts.specMarkdown).toContain("# Planning Spec");
    expect(artifacts.specMarkdown).toContain("## Acceptance Criteria");
    expect(
      runtimeInstructionLayer.files.map((file) => file.relativePath)
    ).toEqual([
      "SOUL.md",
      "AGENTS.md",
      "TOOLS.md",
      "skills/reddwarf-task/SKILL.md"
    ]);
    expect(runtimeInstructionArtifacts.soulMd).toContain(
      "RedDwarf Runtime Soul"
    );
    expect(runtimeInstructionArtifacts.agentsMd).toContain("Architect Agent");
    expect(runtimeInstructionArtifacts.toolsMd).toContain("can_plan");
    expect(runtimeInstructionArtifacts.taskSkillMd).toContain(
      ".context/task.json"
    );
  });

  it("materializes the .context directory and runtime instruction layer to disk", async () => {
    const bundle = createWorkspaceContextBundle({
      manifest,
      spec,
      policySnapshot
    });
    const tempRoot = await mkdtemp(join(tmpdir(), "reddwarf-context-"));

    try {
      const materialized = await materializeWorkspaceContext({
        bundle,
        targetRoot: tempRoot,
        workspaceId: "workspace-42"
      });

      const taskJson = JSON.parse(
        await readFile(materialized.files.taskJson, "utf8")
      );
      const specMarkdown = await readFile(
        materialized.files.specMarkdown,
        "utf8"
      );
      const soulMd = await readFile(
        materialized.instructions.files.soulMd,
        "utf8"
      );
      const agentsMd = await readFile(
        materialized.instructions.files.agentsMd,
        "utf8"
      );
      const toolsMd = await readFile(
        materialized.instructions.files.toolsMd,
        "utf8"
      );
      const taskSkillMd = await readFile(
        materialized.instructions.files.taskSkillMd,
        "utf8"
      );

      expect(taskJson.taskId).toBe(manifest.taskId);
      expect(taskJson.workspaceId).toBe("workspace-42");
      expect(specMarkdown).toContain("Plan the work.");
      expect(materialized.instructions.canonicalSources).toContain(
        "standards/engineering.md"
      );
      expect(soulMd).toContain("workspace-42");
      expect(agentsMd).toContain("Architect Agent");
      expect(toolsMd).toContain("docs/**");
      expect(taskSkillMd).toContain("prompts/planning-system.md");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("creates a development workspace descriptor with code writing disabled", async () => {
    const bundle = createWorkspaceContextBundle({
      manifest: {
        ...manifest,
        currentPhase: "development",
        lifecycleStatus: "active",
        assignedAgentType: "developer"
      },
      spec,
      policySnapshot
    });
    const tempRoot = await mkdtemp(
      join(tmpdir(), "reddwarf-development-context-")
    );

    try {
      const materialized = await materializeManagedWorkspace({
        bundle,
        targetRoot: tempRoot,
        workspaceId: "workspace-42-development",
        createdAt: timestamp
      });

      expect(materialized.descriptor.toolPolicy.mode).toBe(
        "development_readonly"
      );
      expect(materialized.descriptor.toolPolicy.codeWriteEnabled).toBe(false);
      expect(materialized.descriptor.taskContractFiles.length).toBeGreaterThan(
        0
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("creates a validation workspace descriptor with test execution enabled and code writing disabled", async () => {
    const bundle = createWorkspaceContextBundle({
      manifest: {
        ...manifest,
        currentPhase: "validation",
        lifecycleStatus: "active",
        assignedAgentType: "validation"
      },
      spec,
      policySnapshot: {
        ...policySnapshot,
        allowedCapabilities: ["can_run_tests", "can_archive_evidence"]
      }
    });
    const tempRoot = await mkdtemp(
      join(tmpdir(), "reddwarf-validation-context-")
    );

    try {
      const materialized = await materializeManagedWorkspace({
        bundle,
        targetRoot: tempRoot,
        workspaceId: "workspace-42-validation",
        createdAt: timestamp
      });
      const toolsMd = await readFile(
        materialized.instructions.files.toolsMd,
        "utf8"
      );

      expect(materialized.descriptor.toolPolicy.mode).toBe("validation_only");
      expect(materialized.descriptor.toolPolicy.codeWriteEnabled).toBe(false);
      expect(materialized.descriptor.toolPolicy.allowedCapabilities).toContain(
        "can_run_tests"
      );
      expect(toolsMd).toContain("can_run_tests");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("materializes and destroys a managed workspace lifecycle", async () => {
    const bundle = createWorkspaceContextBundle({
      manifest,
      spec,
      policySnapshot
    });
    const tempRoot = await mkdtemp(join(tmpdir(), "reddwarf-managed-context-"));

    try {
      const materialized = await materializeManagedWorkspace({
        bundle,
        targetRoot: tempRoot,
        workspaceId: "workspace-42-managed",
        createdAt: timestamp
      });
      const descriptor = JSON.parse(
        await readFile(materialized.stateFile, "utf8")
      );

      expect(materialized.descriptor.status).toBe("provisioned");
      expect(materialized.descriptor.toolPolicy.mode).toBe("planning_only");
      expect(materialized.descriptor.toolPolicy.codeWriteEnabled).toBe(false);
      expect(materialized.descriptor.credentialPolicy.mode).toBe("none");
      expect(descriptor.workspaceId).toBe("workspace-42-managed");
      expect(descriptor.stateFile).toBe(materialized.stateFile);

      const destroyed = await destroyManagedWorkspace({
        targetRoot: tempRoot,
        workspaceId: "workspace-42-managed",
        destroyedAt: asIsoTimestamp(new Date("2026-03-25T18:05:00.000Z"))
      });

      expect(destroyed.removed).toBe(true);
      expect(destroyed.descriptor?.status).toBe("destroyed");
      await expect(access(materialized.workspaceRoot)).rejects.toThrow();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rebuilds the bundle from a persisted snapshot", () => {
    const snapshot: PersistedTaskSnapshot = {
      manifest,
      spec,
      policySnapshot,
      phaseRecords: [],
      evidenceRecords: [],
      runEvents: [],
      memoryRecords: [],
      pipelineRuns: []
    };

    const bundle = createWorkspaceContextBundleFromSnapshot(snapshot);
    expect(bundle.policySnapshot.allowedPaths).toEqual(["docs/**"]);
  });
});
