import { describe, expect, it } from "vitest";
import {
  createWorkspaceContextArtifacts,
  createRuntimeInstructionLayer,
  createWorkspaceContextBundle
} from "@reddwarf/control-plane";
import {
  taskManifestSchema,
  planningSpecSchema,
  policySnapshotSchema
} from "@reddwarf/contracts";

describe("workspace helpers", () => {
  it("normalizes defaulted policy snapshot arrays for raw runtime bundle callers", () => {
    const manifest = taskManifestSchema.parse({
      taskId: "packaged-verify-1",
      source: {
        provider: "github",
        repo: "acme/platform",
        issueNumber: 1,
        issueUrl: "https://github.com/acme/platform/issues/1"
      },
      title: "Verify packaged policy pack",
      summary:
        "Verify that the packaged policy pack can be mounted and its runtime helpers can still execute.",
      priority: 1,
      riskClass: "low",
      approvalMode: "auto",
      currentPhase: "archive",
      lifecycleStatus: "completed",
      assignedAgentType: "architect",
      requestedCapabilities: ["can_plan", "can_archive_evidence"],
      retryCount: 0,
      evidenceLinks: ["db://manifest/packaged-verify-1"],
      workspaceId: null,
      branchName: null,
      prNumber: null,
      policyVersion: "reddwarf-v1",
      createdAt: "2026-04-05T06:14:40.892Z",
      updatedAt: "2026-04-05T06:14:40.892Z"
    });
    const spec = planningSpecSchema.parse({
      specId: "packaged-spec-1",
      taskId: "packaged-verify-1",
      summary: "Verify packaged policy-pack helpers.",
      assumptions: ["Packaged mount is immutable."],
      affectedAreas: ["prompts/planning-system.md"],
      constraints: ["Do not rely on the live workspace."],
      acceptanceCriteria: ["Spec markdown renders", "Manifest validates"],
      testExpectations: ["Packaged dist imports resolve."],
      recommendedAgentType: "architect",
      riskClass: "low",
      confidenceLevel: "high",
      confidenceReason:
        "This verification fixture is fully specified and only exercises packaged runtime helpers.",
      createdAt: "2026-04-05T06:14:40.892Z"
    });
    const policySnapshot = policySnapshotSchema.parse({
      policyVersion: "reddwarf-v1",
      approvalMode: "auto",
      allowedCapabilities: ["can_plan", "can_archive_evidence"],
      allowedPaths: ["prompts/**"],
      blockedPhases: ["review", "scm"],
      reasons: ["Packaged policy pack verification run."]
    });
    const rawBundle = {
      manifest,
      spec,
      policySnapshot: {
        policyVersion: policySnapshot.policyVersion,
        approvalMode: policySnapshot.approvalMode,
        allowedCapabilities: policySnapshot.allowedCapabilities,
        allowedPaths: policySnapshot.allowedPaths,
        blockedPhases: policySnapshot.blockedPhases,
        reasons: policySnapshot.reasons
      },
      acceptanceCriteria: spec.acceptanceCriteria,
      allowedPaths: ["prompts/**"]
    } as unknown as ReturnType<typeof createWorkspaceContextBundle>;

    const artifacts = createWorkspaceContextArtifacts(rawBundle);
    const layer = createRuntimeInstructionLayer(rawBundle);

    expect(JSON.parse(artifacts.deniedPathsJson)).toEqual([]);
    expect(JSON.parse(artifacts.policySnapshotJson).deniedPaths).toEqual([]);
    expect(JSON.parse(artifacts.policySnapshotJson).allowedSecretScopes).toEqual(
      []
    );
    expect(
      layer.files.find((file) => file.relativePath === "SOUL.md")?.content
    ).toContain("- Blocked repo paths: none");
    expect(
      layer.files.find((file) => file.relativePath === "TOOLS.md")?.content
    ).toContain("- Allowed secret scopes: none");
  });
});
