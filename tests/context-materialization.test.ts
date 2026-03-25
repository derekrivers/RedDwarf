import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorkspaceContextArtifacts,
  createWorkspaceContextBundle,
  createWorkspaceContextBundleFromSnapshot,
  materializeWorkspaceContext
} from "@reddwarf/control-plane";
import { asIsoTimestamp, type PersistedTaskSnapshot, type PolicySnapshot, type TaskManifest, type PlanningSpec } from "@reddwarf/contracts";

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
  blockedPhases: ["development", "validation", "review", "scm"],
  reasons: ["Planning phase is approved for autonomous execution in v1."]
};

describe("workspace context materialization", () => {
  it("creates the expected OpenClaw context artifacts", () => {
    const bundle = createWorkspaceContextBundle({ manifest, spec, policySnapshot });
    const artifacts = createWorkspaceContextArtifacts(bundle);

    expect(JSON.parse(artifacts.taskJson).taskId).toBe(manifest.taskId);
    expect(JSON.parse(artifacts.policySnapshotJson).approvalMode).toBe("auto");
    expect(JSON.parse(artifacts.allowedPathsJson)).toEqual(["docs/**"]);
    expect(JSON.parse(artifacts.acceptanceCriteriaJson)).toEqual(["Spec is produced"]);
    expect(artifacts.specMarkdown).toContain("# Planning Spec");
    expect(artifacts.specMarkdown).toContain("## Acceptance Criteria");
  });

  it("materializes the .context directory to disk", async () => {
    const bundle = createWorkspaceContextBundle({ manifest, spec, policySnapshot });
    const tempRoot = await mkdtemp(join(tmpdir(), "reddwarf-context-"));

    try {
      const materialized = await materializeWorkspaceContext({
        bundle,
        targetRoot: tempRoot,
        workspaceId: "workspace-42"
      });

      const taskJson = JSON.parse(await readFile(materialized.files.taskJson, "utf8"));
      const specMarkdown = await readFile(materialized.files.specMarkdown, "utf8");

      expect(taskJson.taskId).toBe(manifest.taskId);
      expect(taskJson.workspaceId).toBe("workspace-42");
      expect(specMarkdown).toContain("Plan the work.");
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
      runEvents: []
    };

    const bundle = createWorkspaceContextBundleFromSnapshot(snapshot);
    expect(bundle.policySnapshot.allowedPaths).toEqual(["docs/**"]);
  });
});

