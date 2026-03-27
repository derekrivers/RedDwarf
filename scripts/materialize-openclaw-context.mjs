import { resolve } from "node:path";
import { createWorkspaceContextBundleFromSnapshot, provisionTaskWorkspace } from "../packages/control-plane/dist/index.js";
import { PostgresPlanningRepository } from "../packages/evidence/dist/index.js";
import { connectionString } from "./lib/config.mjs";

const positionalArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const taskId = positionalArgs[0];
const requestedTargetRoot = positionalArgs[1];
const requestedWorkspaceId = positionalArgs[2];
const targetRoot = resolve(
  requestedTargetRoot ?? process.env.REDDWARF_HOST_WORKSPACE_ROOT ?? "runtime-data/workspaces"
);

if (!taskId) {
  throw new Error("Usage: node scripts/materialize-openclaw-context.mjs <taskId> [targetRoot] [workspaceId]");
}

const repository = new PostgresPlanningRepository({ connectionString });

try {
  const snapshot = await repository.getTaskSnapshot(taskId);
  createWorkspaceContextBundleFromSnapshot(snapshot);
  const provisioned = await provisionTaskWorkspace({
    snapshot,
    repository,
    targetRoot,
    workspaceId: requestedWorkspaceId
  });

  console.log(JSON.stringify(provisioned.workspace, null, 2));
} finally {
  await repository.close();
}
