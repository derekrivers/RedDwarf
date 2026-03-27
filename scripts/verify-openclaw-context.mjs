import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DeterministicPlanningAgent,
  createWorkspaceContextBundleFromSnapshot,
  materializeWorkspaceContext,
  runPlanningPipeline
} from "../packages/control-plane/dist/index.js";
import { PostgresPlanningRepository } from "../packages/evidence/dist/index.js";
import { connectionString } from "./lib/config.mjs";

const targetRoot = resolve(process.env.REDDWARF_HOST_WORKSPACE_ROOT ?? "runtime-data/workspaces");
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
      title: "Verify OpenClaw context materialization",
      summary:
        "Run the planning pipeline against live Postgres, reconstruct the workspace context bundle, and materialize the .context files plus runtime instructions for OpenClaw.",
      priority: 1,
      labels: ["ai-eligible"],
      acceptanceCriteria: ["Context files are generated", "Context payload is readable"],
      affectedPaths: ["docs/context-verification.md"],
      requestedCapabilities: ["can_plan", "can_archive_evidence"],
      metadata: {}
    },
    {
      repository,
      planner: new DeterministicPlanningAgent()
    }
  );

  const snapshot = await repository.getTaskSnapshot(result.manifest.taskId);
  const bundle = createWorkspaceContextBundleFromSnapshot(snapshot);
  const materialized = await materializeWorkspaceContext({
    bundle,
    targetRoot,
    workspaceId: `${bundle.manifest.taskId}-verify`
  });

  const taskJson = JSON.parse(await readFile(materialized.files.taskJson, "utf8"));
  const policySnapshotJson = JSON.parse(await readFile(materialized.files.policySnapshotJson, "utf8"));
  const allowedPathsJson = JSON.parse(await readFile(materialized.files.allowedPathsJson, "utf8"));
  const acceptanceCriteriaJson = JSON.parse(await readFile(materialized.files.acceptanceCriteriaJson, "utf8"));
  const specMarkdown = await readFile(materialized.files.specMarkdown, "utf8");
  const soulMd = await readFile(materialized.instructions.files.soulMd, "utf8");
  const agentsMd = await readFile(materialized.instructions.files.agentsMd, "utf8");
  const toolsMd = await readFile(materialized.instructions.files.toolsMd, "utf8");
  const taskSkillMd = await readFile(materialized.instructions.files.taskSkillMd, "utf8");

  assert.equal(taskJson.taskId, result.manifest.taskId);
  assert.equal(policySnapshotJson.approvalMode, "auto");
  assert.equal(allowedPathsJson.length, 1);
  assert.equal(acceptanceCriteriaJson.length, 2);
  assert.match(specMarkdown, /# Planning Spec/);
  assert.match(soulMd, /RedDwarf Runtime Soul/);
  assert.match(soulMd, new RegExp(result.manifest.taskId));
  assert.match(agentsMd, /Architect Agent/);
  assert.match(toolsMd, /can_archive_evidence/);
  assert.match(taskSkillMd, /\.context\/task\.json/);
  assert.equal(materialized.instructions.canonicalSources.includes("standards/engineering.md"), true);

  console.log(
    JSON.stringify(
      {
        taskId: result.manifest.taskId,
        workspaceId: materialized.workspaceId,
        contextDir: materialized.contextDir,
        files: materialized.files,
        instructions: materialized.instructions
      },
      null,
      2
    )
  );
} finally {
  await repository.close();
}
