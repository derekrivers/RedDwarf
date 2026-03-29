import assert from "node:assert/strict";
import { DeterministicPlanningAgent, runPlanningPipeline } from "../packages/control-plane/dist/index.js";
import { createPostgresPlanningRepository } from "../packages/evidence/dist/index.js";
import {
  DenyAllSecretsAdapter,
  FixtureCiAdapter,
  FixtureGitHubAdapter,
  FixtureSecretsAdapter,
  NullNotificationAdapter,
  V1MutationDisabledError,
  intakeGitHubIssue,
  redactSecretValues
} from "../packages/integrations/dist/index.js";
import { connectionString, postgresPoolConfig } from "./lib/config.mjs";

const repository = createPostgresPlanningRepository(connectionString, postgresPoolConfig);
const unique = Date.now();
const repo = "acme/platform";
const candidate = {
  repo,
  issueNumber: unique,
  title: "Verify read-only GitHub and CI adapter flow",
  body: [
    "This issue validates the RedDwarf integration plane for read-only GitHub and CI operations.",
    "",
    "Acceptance Criteria:",
    "- GitHub issue intake produces a planning input",
    "- Mutation-oriented adapter methods remain disabled",
    "",
    "Affected Paths:",
    "- docs/integrations.md",
    "- docs/implementation-map.md",
    "",
    "Requested Capabilities:",
    "- can_plan",
    "- can_archive_evidence"
  ].join("\n"),
  labels: ["ai-eligible", "priority:9", "integration"],
  url: `https://github.com/${repo}/issues/${unique}`,
  state: "open",
  author: "fixture-bot",
  updatedAt: "2026-03-25T20:10:00.000Z",
  baseBranch: "main"
};

const github = new FixtureGitHubAdapter({ candidates: [candidate] });
const ci = new FixtureCiAdapter([
  {
    repo,
    ref: "main",
    overallStatus: "success",
    checks: [
      {
        name: "ci / typecheck",
        status: "success",
        conclusion: "success",
        url: "https://ci.example/typecheck",
        completedAt: "2026-03-25T20:11:00.000Z"
      },
      {
        name: "ci / test",
        status: "success",
        conclusion: "success",
        url: "https://ci.example/test",
        completedAt: "2026-03-25T20:11:30.000Z"
      }
    ],
    observedAt: "2026-03-25T20:12:00.000Z"
  }
]);
const notifications = new NullNotificationAdapter();
const denyAllSecrets = new DenyAllSecretsAdapter();
const fixtureSecrets = new FixtureSecretsAdapter([
  {
    scope: "github_readonly",
    environmentVariables: {
      GITHUB_TOKEN: "ghs_fixture_verify_token"
    },
    allowedAgents: ["validation"],
    allowedEnvironments: ["staging"]
  }
]);

try {
  const intake = await intakeGitHubIssue({
    github,
    ci,
    repo,
    issueNumber: unique
  });

  assert.equal(intake.issueStatus.defaultBranch, "main");
  assert.equal(intake.ciSnapshot?.overallStatus, "success");
  assert.deepEqual(intake.planningInput.acceptanceCriteria, [
    "GitHub issue intake produces a planning input",
    "Mutation-oriented adapter methods remain disabled"
  ]);

  await notifications.sendStatusUpdate("Integration intake verified.", {
    repo,
    issueNumber: unique
  });

  const result = await runPlanningPipeline(intake.planningInput, {
    repository,
    planner: new DeterministicPlanningAgent()
  });
  const snapshot = await repository.getTaskSnapshot(result.manifest.taskId);
  const runSummary = await repository.getRunSummary(result.manifest.taskId, result.runId);

  assert.equal(result.nextAction, "complete");
  assert.ok(snapshot.spec, "Expected a persisted planning spec.");
  assert.equal(runSummary?.status, "completed");

  const lease = await fixtureSecrets.issueTaskSecrets({
    taskId: result.manifest.taskId,
    repo,
    agentType: "validation",
    phase: "validation",
    environment: "staging",
    riskClass: "medium",
    approvalMode: "human_signoff_required",
    requestedCapabilities: ["can_use_secrets"],
    allowedSecretScopes: ["github_readonly"]
  });

  assert.equal(lease?.mode, "scoped_env");
  assert.deepEqual(lease?.secretScopes, ["github_readonly"]);
  assert.equal(
    redactSecretValues("token=ghs_fixture_verify_token", lease),
    "token=***REDACTED***"
  );

  await assert.rejects(
    github.createPullRequest({
      repo,
      baseBranch: "main",
      headBranch: "feature/red-dwarf-test",
      title: "Disabled mutation verification",
      body: "This should stay disabled in v1."
    }),
    V1MutationDisabledError
  );
  await assert.rejects(github.addLabels(repo, unique, ["triaged"]), V1MutationDisabledError);
  await assert.rejects(ci.triggerWorkflow(repo, "ci.yml", "main"), V1MutationDisabledError);
  await assert.rejects(denyAllSecrets.requestSecret("GITHUB_TOKEN"), V1MutationDisabledError);
  await assert.rejects(
    denyAllSecrets.issueTaskSecrets({
      taskId: result.manifest.taskId,
      repo,
      agentType: "validation",
      phase: "validation",
      environment: "staging",
      riskClass: "medium",
      approvalMode: "human_signoff_required",
      requestedCapabilities: ["can_use_secrets"],
      allowedSecretScopes: ["github_readonly"]
    }),
    V1MutationDisabledError
  );

  console.log(
    JSON.stringify(
      {
        taskId: result.manifest.taskId,
        runId: result.runId,
        intakeRepo: intake.candidate.repo,
        ciOverallStatus: intake.ciSnapshot?.overallStatus ?? null,
        phaseRecordCount: snapshot.phaseRecords.length,
        runEventCount: snapshot.runEvents.length,
        runStatus: runSummary?.status ?? null,
        scopedSecretLease: lease
          ? {
              mode: lease.mode,
              secretScopes: lease.secretScopes,
              injectedSecretKeys: lease.injectedSecretKeys
            }
          : null,
        mutationGuardsVerified: true
      },
      null,
      2
    )
  );
} finally {
  await repository.close();
}
