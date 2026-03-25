import { resolve } from "node:path";
import { createWorkspaceContextBundleFromSnapshot } from "../packages/control-plane/dist/index.js";
import { PostgresPlanningRepository, createEvidenceRecord } from "../packages/evidence/dist/index.js";
import { materializeWorkspaceContext } from "../packages/control-plane/dist/index.js";

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
  throw new Error("Usage: node scripts/materialize-openclaw-context.mjs <taskId> [targetRoot] [workspaceId]");
}

const repository = new PostgresPlanningRepository({ connectionString });

try {
  const snapshot = await repository.getTaskSnapshot(taskId);
  const bundle = createWorkspaceContextBundleFromSnapshot(snapshot);
  const workspaceId = requestedWorkspaceId ?? bundle.manifest.workspaceId ?? bundle.manifest.taskId;
  const materialized = await materializeWorkspaceContext({
    bundle,
    targetRoot,
    workspaceId
  });

  const updatedManifest = {
    ...bundle.manifest,
    workspaceId,
    updatedAt: new Date().toISOString(),
    evidenceLinks: [...new Set([...bundle.manifest.evidenceLinks, materialized.contextDir])]
  };

  await repository.updateManifest(updatedManifest);
  await repository.saveEvidenceRecord(
    createEvidenceRecord({
      recordId: `${taskId}:context:${workspaceId}`,
      taskId,
      kind: "file_artifact",
      title: "OpenClaw context bundle",
      location: materialized.contextDir,
      metadata: {
        workspaceId,
        files: materialized.files
      }
    })
  );

  console.log(JSON.stringify(materialized, null, 2));
} finally {
  await repository.close();
}
