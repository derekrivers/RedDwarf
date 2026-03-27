import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DeterministicDeveloperAgent,
  DeterministicPlanningAgent,
  destroyTaskWorkspace,
  resolveApprovalRequest,
  runDeveloperPhase,
  runPlanningPipeline,
  runValidationPhase
} from "../packages/control-plane/dist/index.js";
import { PostgresPlanningRepository } from "../packages/evidence/dist/index.js";
import { FixtureSecretsAdapter } from "../packages/integrations/dist/index.js";
import { connectionString } from "./lib/config.mjs";

const connectionString =
  process.env.HOST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://reddwarf:reddwarf@127.0.0.1:55432/reddwarf";
const baseTargetRoot = resolve(
  process.env.REDDWARF_HOST_WORKSPACE_ROOT ??
    join(tmpdir(), "reddwarf-secrets-verify")
);
const repository = new PostgresPlanningRepository({ connectionString });
const issueNumber = Date.now();
const targetRoot = resolve(baseTargetRoot, `verify-${issueNumber}`);
const repo = `secrets-${issueNumber}/platform-${issueNumber}`;
const secretValue = "ghs_fixture_secret_verify";
const environment = "staging";
const secrets = new FixtureSecretsAdapter([
  {
    scope: "github_readonly",
    environmentVariables: {
      GITHUB_TOKEN: secretValue
    },
    allowedAgents: ["developer", "validation"],
    allowedEnvironments: [environment],
    notes: ["Fixture read-only GitHub token"]
  }
]);

try {
  const planningResult = await runPlanningPipeline(
    {
      source: {
        provider: "github",
        repo,
        issueNumber,
        issueUrl: `https://github.com/${repo}/issues/${issueNumber}`
      },
      title: "Verify scoped secret orchestration",
      summary:
        "Run a planning task that requires scoped credentials, inject a least-privilege lease into the managed workspace, and verify validation logs redact any echoed secret values.",
      priority: 1,
      labels: ["ai-eligible"],
      acceptanceCriteria: [
        "Scoped credentials are injected into the workspace",
        "Validation logs redact secret values"
      ],
      affectedPaths: ["src/integrations/github.ts"],
      requestedCapabilities: ["can_write_code", "can_use_secrets"],
      metadata: {
        secretScopes: ["github_readonly"]
      }
    },
    {
      repository,
      planner: new DeterministicPlanningAgent(),
      clock: () => new Date("2026-03-25T18:00:00.000Z"),
      idGenerator: () => `secrets-plan-${issueNumber}`
    }
  );

  const resolved = await resolveApprovalRequest(
    {
      requestId: planningResult.approvalRequest.requestId,
      decision: "approve",
      decidedBy: "operator",
      decisionSummary: "Approved for scoped credential injection.",
      comment: "Use only the approved read-only secret scope."
    },
    {
      repository,
      clock: () => new Date("2026-03-25T18:05:00.000Z")
    }
  );
  const development = await runDeveloperPhase(
    {
      taskId: planningResult.manifest.taskId,
      targetRoot,
      workspaceId: `${planningResult.manifest.taskId}-secrets-verify`
    },
    {
      repository,
      developer: new DeterministicDeveloperAgent(),
      secrets,
      environment,
      clock: () => new Date("2026-03-25T18:10:00.000Z"),
      idGenerator: () => `secrets-dev-${issueNumber}`
    }
  );

  const validation = await runValidationPhase(
    {
      taskId: planningResult.manifest.taskId,
      targetRoot
    },
    {
      repository,
      validator: {
        async createPlan() {
          return {
            summary:
              "Verify that scoped validation credentials are injected and redacted in artifacts.",
            commands: [
              {
                id: "check-secret-env",
                name: "Check scoped secret environment injection",
                executable: process.execPath,
                args: [
                  "-e",
                  [
                    'const fs = require("node:fs");',
                    'const path = require("node:path");',
                    'const secretEnvFile = path.join(process.env.REDDWARF_WORKSPACE_ROOT, ".workspace", "credentials", "secret-env.json");',
                    'const payload = JSON.parse(fs.readFileSync(secretEnvFile, "utf8"));',
                    'if (process.env.GITHUB_TOKEN !== payload.environmentVariables.GITHUB_TOKEN) {',
                    '  throw new Error("Injected env var does not match the workspace lease file.");',
                    '}',
                    'console.log(`token=${process.env.GITHUB_TOKEN}`);',
                    'console.log(JSON.stringify(payload));'
                  ].join("\n")
                ]
              }
            ]
          };
        }
      },
      secrets,
      environment,
      clock: () => new Date("2026-03-25T18:15:00.000Z"),
      idGenerator: () => `secrets-validation-${issueNumber}`
    }
  );

  const secretEnvPayload = JSON.parse(
    await readFile(
      validation.workspace.descriptor.credentialPolicy.secretEnvFile,
      "utf8"
    )
  );
  const validationLog = await readFile(
    validation.report.commandResults[0].logPath,
    "utf8"
  );
  const runSummary = await repository.getRunSummary(
    planningResult.manifest.taskId,
    validation.runId
  );
  assert.equal(resolved.manifest.lifecycleStatus, "ready");
  assert.equal(
    development.workspace.descriptor.credentialPolicy.mode,
    "scoped_env"
  );
  assert.equal(
    validation.workspace.descriptor.credentialPolicy.mode,
    "scoped_env"
  );
  assert.deepEqual(
    validation.workspace.descriptor.credentialPolicy.allowedSecretScopes,
    ["github_readonly"]
  );
  assert.deepEqual(
    validation.workspace.descriptor.credentialPolicy.injectedSecretKeys,
    ["GITHUB_TOKEN"]
  );
  assert.equal(secretEnvPayload.environmentVariables.GITHUB_TOKEN, secretValue);
  assert.equal(validationLog.includes(secretValue), false);
  assert.equal(validationLog.includes("***REDACTED***"), true);
  assert.equal(runSummary?.status, "blocked");

  await destroyTaskWorkspace({
    manifest: validation.manifest,
    repository,
    targetRoot
  });

  console.log(
    JSON.stringify(
      {
        taskId: planningResult.manifest.taskId,
        planningRunId: planningResult.runId,
        developmentRunId: development.runId,
        validationRunId: validation.runId,
        workspaceId: validation.workspace.workspaceId,
        credentialPolicy: validation.workspace.descriptor.credentialPolicy,
        validationRunStatus: runSummary?.status ?? null,
        redactionVerified: true
      },
      null,
      2
    )
  );
} catch (error) {
  const logPath =
    error?.details?.logPath ??
    error?.cause?.details?.logPath ??
    error?.cause?.cause?.details?.logPath;

  if (typeof logPath === "string") {
    const log = await readFile(logPath, "utf8").catch(() => null);

    if (log) {
      console.error(log);
    }
  }

  throw error;
} finally {
  await rm(targetRoot, { recursive: true, force: true }).catch(() => {});
  await repository.close();
}