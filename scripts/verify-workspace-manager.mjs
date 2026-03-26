import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DeterministicPlanningAgent,
  destroyTaskWorkspace,
  provisionTaskWorkspace,
  runPlanningPipeline
} from "../packages/control-plane/dist/index.js";
import { PostgresPlanningRepository } from "../packages/evidence/dist/index.js";

const connectionString =
  process.env.HOST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://reddwarf:reddwarf@127.0.0.1:55432/reddwarf";
const targetRoot = resolve(
  process.env.REDDWARF_HOST_WORKSPACE_ROOT ?? "runtime-data/workspaces"
);
const repository = new PostgresPlanningRepository({ connectionString });
const unique = Date.now();

try {
  const result = await runPlanningPipeline(
    {
      source: {
        provider: "github",
        repo: "acme/platform",
        issueNumber: unique,
        issueUrl: `https://github.com/acme/platform/issues/${unique}`
      },
      title: "Verify managed workspace lifecycle",
      summary:
        "Run the planning pipeline against live Postgres, provision a managed workspace, validate its isolation metadata, and destroy it cleanly.",
      priority: 1,
      labels: ["ai-eligible"],
      acceptanceCriteria: [
        "Workspace is provisioned",
        "Workspace is destroyed cleanly"
      ],
      affectedPaths: ["docs/workspace-manager-verification.md"],
      requestedCapabilities: ["can_plan", "can_archive_evidence"],
      metadata: {}
    },
    {
      repository,
      planner: new DeterministicPlanningAgent()
    }
  );

  const snapshot = await repository.getTaskSnapshot(result.manifest.taskId);
  const provisioned = await provisionTaskWorkspace({
    snapshot,
    repository,
    targetRoot,
    workspaceId: `${result.manifest.taskId}-managed-verify`
  });
  const descriptor = JSON.parse(
    await readFile(provisioned.workspace.stateFile, "utf8")
  );
  const soulMd = await readFile(
    provisioned.workspace.instructions.files.soulMd,
    "utf8"
  );

  assert.equal(
    provisioned.manifest.workspaceId,
    provisioned.workspace.workspaceId
  );
  assert.equal(descriptor.status, "provisioned");
  assert.equal(descriptor.toolPolicy.mode, "planning_only");
  assert.equal(descriptor.toolPolicy.codeWriteEnabled, false);
  assert.equal(descriptor.credentialPolicy.mode, "none");
  assert.match(soulMd, /RedDwarf Runtime Soul/);

  const destroyed = await destroyTaskWorkspace({
    manifest: provisioned.manifest,
    repository,
    targetRoot
  });
  const persistedManifest = await repository.getManifest(
    result.manifest.taskId
  );
  const evidenceRecords = await repository.listEvidenceRecords(
    result.manifest.taskId
  );

  assert.equal(destroyed.manifest.workspaceId, null);
  assert.equal(destroyed.workspace.removed, true);
  assert.equal(destroyed.workspace.descriptor?.status, "destroyed");
  assert.equal(persistedManifest?.workspaceId, null);
  assert.equal(
    evidenceRecords.some((record) => record.recordId.endsWith(":provisioned")),
    true
  );
  assert.equal(
    evidenceRecords.some((record) => record.recordId.endsWith(":destroyed")),
    true
  );
  await assert.rejects(access(provisioned.workspace.workspaceRoot));

  console.log(
    JSON.stringify(
      {
        taskId: result.manifest.taskId,
        workspaceId: provisioned.workspace.workspaceId,
        provisioned: {
          workspaceRoot: provisioned.workspace.workspaceRoot,
          stateFile: provisioned.workspace.stateFile,
          descriptor: provisioned.workspace.descriptor
        },
        destroyed: destroyed.workspace
      },
      null,
      2
    )
  );
} finally {
  await repository.close();
}
