import { resolve } from "node:path";
import { destroyTaskWorkspace } from "../packages/control-plane/dist/index.js";
import { PostgresPlanningRepository } from "../packages/evidence/dist/index.js";

const connectionString =
  process.env.HOST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://reddwarf:reddwarf@127.0.0.1:55432/reddwarf";

const positionalArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const taskId = positionalArgs[0];
const requestedTargetRoot = positionalArgs[1];
const requestedWorkspaceId = positionalArgs[2];
const targetRoot = resolve(
  requestedTargetRoot ?? process.env.REDDWARF_HOST_WORKSPACE_ROOT ?? "runtime-data/workspaces"
);

if (!taskId) {
  throw new Error("Usage: node scripts/destroy-openclaw-workspace.mjs <taskId> [targetRoot] [workspaceId]");
}

const repository = new PostgresPlanningRepository({ connectionString });

try {
  const manifest = await repository.getManifest(taskId);

  if (!manifest) {
    throw new Error(`Task ${taskId} does not have a persisted manifest.`);
  }

  const destroyed = await destroyTaskWorkspace({
    manifest,
    repository,
    targetRoot,
    workspaceId: requestedWorkspaceId
  });

  console.log(JSON.stringify(destroyed.workspace, null, 2));
} finally {
  await repository.close();
}
