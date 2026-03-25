import { describe, expect, it } from "vitest";
import { DeterministicPlanningAgent, runPlanningPipeline } from "@reddwarf/control-plane";
import { InMemoryPlanningRepository } from "@reddwarf/evidence";
import { FixtureGitHubAdapter, NullNotificationAdapter, intakeGitHubIssue } from "@reddwarf/integrations";

const candidate = {
  repo: "acme/platform",
  issueNumber: 188,
  title: "Run planning from GitHub issue intake",
  body: [
    "This issue validates the end-to-end read-only integration intake flow.",
    "",
    "Acceptance Criteria:",
    "- Issue intake creates a valid planning input",
    "- The planning pipeline completes from adapter-provided input",
    "",
    "Affected Paths:",
    "- docs/integration-intake.md",
    "",
    "Requested Capabilities:",
    "- can_plan",
    "- can_archive_evidence"
  ].join("\n"),
  labels: ["ai-eligible", "priority:6", "integration"],
  url: "https://github.com/acme/platform/issues/188",
  state: "open" as const,
  author: "octo",
  updatedAt: "2026-03-25T20:05:00.000Z",
  baseBranch: "main"
};

describe("integration intake", () => {
  it("runs an end-to-end planning flow from fixture issue intake", async () => {
    const github = new FixtureGitHubAdapter({ candidates: [candidate] });
    const repository = new InMemoryPlanningRepository();
    const intake = await intakeGitHubIssue({
      github,
      repo: candidate.repo,
      issueNumber: candidate.issueNumber
    });
    const notifications = new NullNotificationAdapter();

    await notifications.sendStatusUpdate("Issue intake complete.", { repo: candidate.repo });
    const result = await runPlanningPipeline(intake.planningInput, {
      repository,
      planner: new DeterministicPlanningAgent(),
      clock: () => new Date("2026-03-25T20:00:00.000Z"),
      idGenerator: () => "run-intake-001"
    });
    const runSummary = await repository.getRunSummary(result.manifest.taskId, result.runId);

    expect(result.manifest.source.issueNumber).toBe(candidate.issueNumber);
    expect(result.nextAction).toBe("complete");
    expect(runSummary?.status).toBe("completed");
    expect(result.manifest.title).toBe(candidate.title);
  });
});