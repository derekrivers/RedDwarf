import assert from "node:assert/strict";
import { access, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DeterministicPlanningAgent,
  createWorkspaceContextBundleFromSnapshot,
  materializeWorkspaceContext,
  runPlanningPipeline
} from "../packages/control-plane/dist/index.js";
import { createPostgresPlanningRepository } from "../packages/evidence/dist/index.js";
import { connectionString, postgresPoolConfig } from "./lib/config.mjs";

const targetRoot = resolve(process.env.REDDWARF_HOST_WORKSPACE_ROOT ?? "runtime-data/workspaces");
const repository = createPostgresPlanningRepository(connectionString, postgresPoolConfig);
const unique = Date.now();

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

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
  const baseBundle = createWorkspaceContextBundleFromSnapshot(snapshot);
  const expectationsByRole = {
    architect: {
      contextFiles: [
        ".context/task.json",
        ".context/spec.md",
        ".context/project_memory.json",
        ".context/policy_snapshot.json",
        ".context/allowed_paths.json",
        ".context/denied_paths.json",
        ".context/acceptance_criteria.json"
      ],
      absentFiles: []
    },
    developer: {
      contextFiles: [
        ".context/task.json",
        ".context/spec.md",
        ".context/project_memory.json",
        ".context/acceptance_criteria.json",
        ".context/denied_paths.json"
      ],
      absentFiles: [
        ".context/policy_snapshot.json",
        ".context/allowed_paths.json"
      ]
    },
    validation: {
      contextFiles: [
        ".context/task.json",
        ".context/spec.md",
        ".context/acceptance_criteria.json",
        ".context/denied_paths.json"
      ],
      absentFiles: [
        ".context/policy_snapshot.json",
        ".context/allowed_paths.json"
      ]
    }
  };

  const verification = {};

  for (const [role, expectations] of Object.entries(expectationsByRole)) {
    const bundle = {
      ...baseBundle,
      manifest: {
        ...baseBundle.manifest,
        assignedAgentType: role
      }
    };
    const materialized = await materializeWorkspaceContext({
      bundle,
      targetRoot,
      workspaceId: `${bundle.manifest.taskId}-${role}-verify`
    });

    const specMarkdown = await readFile(materialized.files.specMarkdown, "utf8");
    const soulMd = await readFile(materialized.instructions.files.soulMd, "utf8");
    const agentsMd = await readFile(materialized.instructions.files.agentsMd, "utf8");
    const toolsMd = await readFile(materialized.instructions.files.toolsMd, "utf8");
    const taskSkillMd = await readFile(materialized.instructions.files.taskSkillMd, "utf8");

    assert.deepEqual(
      materialized.instructions.taskContractFiles.map((file) =>
        file.slice(materialized.workspaceRoot.length + 1).replace(/\\/g, "/")
      ),
      expectations.contextFiles
    );
    assert.match(specMarkdown, /# Planning Spec/);
    assert.match(soulMd, /RedDwarf Runtime Soul/);
    assert.match(soulMd, new RegExp(result.manifest.taskId));
    assert.match(agentsMd, /Architect Agent/);
    assert.match(toolsMd, /can_archive_evidence/);
    assert.equal(
      materialized.instructions.canonicalSources.includes("standards/engineering.md"),
      true
    );

    for (const relativePath of expectations.contextFiles) {
      assert.equal(
        await pathExists(resolve(materialized.workspaceRoot, relativePath)),
        true
      );
      assert.match(taskSkillMd, new RegExp(relativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }

    for (const relativePath of expectations.absentFiles) {
      assert.equal(
        await pathExists(resolve(materialized.workspaceRoot, relativePath)),
        false
      );
    }

    verification[role] = {
      workspaceId: materialized.workspaceId,
      contextDir: materialized.contextDir,
      contextFiles: expectations.contextFiles,
      canonicalSources: materialized.instructions.canonicalSources
    };

    await rm(materialized.workspaceRoot, { recursive: true, force: true });
  }

  console.log(
    JSON.stringify(
      {
        taskId: result.manifest.taskId,
        verification
      },
      null,
      2
    )
  );
} finally {
  await repository.close();
}
