import assert from "node:assert/strict";
import { DeterministicPlanningAgent, runPlanningPipeline } from "../packages/control-plane/dist/index.js";
import { PostgresPlanningRepository } from "../packages/evidence/dist/index.js";
import {
  DenyAllSecretsAdapter,
  FixtureCiAdapter,
  FixtureGitHubAdapter,
  NullNotificationAdapter,
  V1MutationDisabledError,
  intakeGitHubIssue
} from "../packages/integrations/dist/index.js";

const connectionString =
  process.env.HOST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://reddwarf:reddwarf@127.0.0.1:55432/reddwarf";

const repository = new PostgresPlanningRepository({ connectionString });
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
const secrets = new DenyAllSecretsAdapter();

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
  await assert.rejects(secrets.requestSecret("GITHUB_TOKEN"), V1MutationDisabledError);

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
        mutationGuardsVerified: true
      },
      null,
      2
    )
  );
} finally {
  await repository.close();
}