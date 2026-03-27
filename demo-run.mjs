// demo-run.mjs
import { runPlanningPipeline } from "./packages/control-plane/dist/index.js";
import { createPostgresPlanningRepository } from "./packages/evidence/dist/index.js";
import {
  intakeGitHubIssue,
  createRestGitHubAdapter
} from "./packages/integrations/dist/index.js";
import { createAnthropicPlanningAgent } from "./packages/execution-plane/dist/index.js";

const repo = "owner/repo";   // TODO: replace with your GitHub repo in owner/repo format
const issueNumber = 0;       // TODO: replace with your issue number

const github = createRestGitHubAdapter();          // reads GITHUB_TOKEN from env
const planner = createAnthropicPlanningAgent();    // reads ANTHROPIC_API_KEY from env
const repository = createPostgresPlanningRepository(
  process.env.HOST_DATABASE_URL ?? "postgresql://reddwarf:reddwarf@127.0.0.1:55432/reddwarf"
);

try {
  // Step 1: Intake the GitHub issue
  console.log(`Intaking ${repo}#${issueNumber}...`);
  const intake = await intakeGitHubIssue({ github, repo, issueNumber });
  console.log("Issue title:", intake.candidate.title);
  console.log("Acceptance criteria:", intake.planningInput.acceptanceCriteria);

  // Step 2: Run the planning pipeline
  console.log("\nRunning planning pipeline...");
  const result = await runPlanningPipeline(intake.planningInput, {
    repository,
    planner
  });

  console.log("\nPipeline result:");
  console.log("  Task ID:", result.manifest.taskId);
  console.log("  Run ID:", result.runId);
  console.log("  Next action:", result.nextAction);
  console.log("  Risk class:", result.manifest.riskClass);

  // Step 3: Inspect the evidence
  const snapshot = await repository.getTaskSnapshot(result.manifest.taskId);
  console.log("\nEvidence snapshot:");
  console.log("  Phase records:", snapshot.phaseRecords.map((p) => `${p.phase}:${p.status}`));
  console.log("  Planning spec summary:", snapshot.spec?.summary ?? "(none)");

  console.log("\nDemo complete. Task ID:", result.manifest.taskId);
} finally {
  await repository.close();
}