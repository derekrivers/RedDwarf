import { join, relative } from "node:path";
import { type MaterializedManagedWorkspace, type WorkspaceRuntimeConfig } from "@reddwarf/contracts";

export function resolveWorkspaceRootConfig(runtimeConfig?: WorkspaceRuntimeConfig): {
  runtimeWorkspaceRoot: string;
  hostWorkspaceRoot: string | undefined;
} {
  return {
    runtimeWorkspaceRoot: (
      runtimeConfig?.workspaceRoot ??
      process.env.REDDWARF_WORKSPACE_ROOT ??
      "/var/lib/reddwarf/workspaces"
    ).replace(/\\/g, "/"),
    hostWorkspaceRoot:
      runtimeConfig?.hostWorkspaceRoot ?? process.env.REDDWARF_HOST_WORKSPACE_ROOT
  };
}

export function buildRuntimeWorkspacePath(
  workspace: MaterializedManagedWorkspace,
  runtimeConfig?: WorkspaceRuntimeConfig
): string {
  const { runtimeWorkspaceRoot, hostWorkspaceRoot } = resolveWorkspaceRootConfig(runtimeConfig);

  if (hostWorkspaceRoot) {
    const normalizedHost = hostWorkspaceRoot.replace(/\\/g, "/");
    const normalizedWorkspace = workspace.workspaceRoot.replace(/\\/g, "/");
    const relativeWorkspacePath = relative(normalizedHost, normalizedWorkspace).replace(
      /\\/g,
      "/"
    );

    if (
      relativeWorkspacePath.length > 0 &&
      relativeWorkspacePath !== "." &&
      !relativeWorkspacePath.startsWith("../") &&
      relativeWorkspacePath !== ".." &&
      !relativeWorkspacePath.includes(":")
    ) {
      return join(runtimeWorkspaceRoot, relativeWorkspacePath).replace(/\\/g, "/");
    }
  }

  return join(runtimeWorkspaceRoot, workspace.workspaceId).replace(/\\/g, "/");
}
