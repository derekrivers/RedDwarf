import { describe, expect, it } from "vitest";
import { buildRuntimeWorkspacePath } from "./pipeline.js";
import type { MaterializedManagedWorkspace } from "@reddwarf/contracts";

function makeWorkspace(partial: { workspaceId: string; workspaceRoot: string }): MaterializedManagedWorkspace {
  return {
    workspaceId: partial.workspaceId,
    workspaceRoot: partial.workspaceRoot,
    contextDir: "",
    files: {
      taskJson: "",
      specMarkdown: "",
      policySnapshotJson: "",
      allowedPathsJson: "",
      deniedPathsJson: "",
      acceptanceCriteriaJson: ""
    },
    instructions: { canonicalSources: [], taskContractFiles: [], files: { soulMd: "", agentsMd: "", toolsMd: "", taskSkillMd: "" } },
    stateDir: "",
    stateFile: "",
    scratchDir: "",
    artifactsDir: "",
    repoRoot: null,
    descriptor: {} as MaterializedManagedWorkspace["descriptor"]
  };
}

describe("buildRuntimeWorkspacePath with injected runtimeConfig", () => {
  it("uses injected workspaceRoot instead of process.env", () => {
    const workspace = makeWorkspace({
      workspaceId: "task-123",
      workspaceRoot: "/host/workspaces/task-123"
    });

    const path = buildRuntimeWorkspacePath(workspace, {
      workspaceRoot: "/container/workspaces"
    });

    expect(path).toBe("/container/workspaces/task-123");
  });

  it("uses hostWorkspaceRoot to derive relative path into the container mount", () => {
    const workspace = makeWorkspace({
      workspaceId: "task-abc",
      workspaceRoot: "/host/ws/nested/task-abc"
    });

    const path = buildRuntimeWorkspacePath(workspace, {
      workspaceRoot: "/var/lib/reddwarf/workspaces",
      hostWorkspaceRoot: "/host/ws"
    });

    expect(path).toBe("/var/lib/reddwarf/workspaces/nested/task-abc");
  });

  it("falls back to workspaceId when relative path escapes host root", () => {
    const workspace = makeWorkspace({
      workspaceId: "task-xyz",
      workspaceRoot: "/completely/different/path/task-xyz"
    });

    const path = buildRuntimeWorkspacePath(workspace, {
      workspaceRoot: "/var/lib/reddwarf/workspaces",
      hostWorkspaceRoot: "/host/ws"
    });

    expect(path).toBe("/var/lib/reddwarf/workspaces/task-xyz");
  });

  it("returns default workspaceRoot when no runtimeConfig provided and env is unset", () => {
    // Temporarily clear the env var if it's set
    const saved = process.env.REDDWARF_WORKSPACE_ROOT;
    delete process.env.REDDWARF_WORKSPACE_ROOT;
    delete process.env.REDDWARF_HOST_WORKSPACE_ROOT;

    try {
      const workspace = makeWorkspace({
        workspaceId: "task-def",
        workspaceRoot: "/host/ws/task-def"
      });

      const path = buildRuntimeWorkspacePath(workspace);
      expect(path).toBe("/var/lib/reddwarf/workspaces/task-def");
    } finally {
      if (saved !== undefined) process.env.REDDWARF_WORKSPACE_ROOT = saved;
    }
  });
});
