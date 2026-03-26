import { describe, expect, it } from "vitest";
import {
  DenyAllSecretsAdapter,
  FixtureCiAdapter,
  FixtureGitHubAdapter,
  FixtureSecretsAdapter,
  V1MutationDisabledError,
  createPlanningInputFromGitHubIssue,
  intakeGitHubIssue,
  redactSecretValues
} from "@reddwarf/integrations";

const candidate = {
  repo: "acme/platform",
  issueNumber: 88,
  title: "Plan the docs and CI integration workflow",
  body: [
    "This issue needs a deterministic planning pass before any implementation work begins.",
    "",
    "Acceptance Criteria:",
    "- Feature intake is converted into a planning input",
    "- Mutation-capable GitHub actions remain disabled",
    "",
    "Affected Paths:",
    "- docs/implementation-map.md",
    "- .github/workflows/ci.yml",
    "",
    "Requested Capabilities:",
    "- can_plan",
    "- can_archive_evidence"
  ].join("\n"),
  labels: ["ai-eligible", "priority:7", "integration"],
  url: "https://github.com/acme/platform/issues/88",
  state: "open" as const,
  author: "octo",
  updatedAt: "2026-03-25T20:00:00.000Z",
  baseBranch: "main"
};

describe("integrations", () => {
  it("converts a GitHub issue candidate into a planning input", () => {
    const planningInput = createPlanningInputFromGitHubIssue(candidate);

    expect(planningInput.source.issueNumber).toBe(88);
    expect(planningInput.priority).toBe(7);
    expect(planningInput.acceptanceCriteria).toEqual([
      "Feature intake is converted into a planning input",
      "Mutation-capable GitHub actions remain disabled"
    ]);
    expect(planningInput.affectedPaths).toEqual([
      "docs/implementation-map.md",
      ".github/workflows/ci.yml"
    ]);
    expect(planningInput.requestedCapabilities).toEqual([
      "can_plan",
      "can_archive_evidence"
    ]);
  });

  it("supports fixture-based issue intake with read-only GitHub and CI adapters", async () => {
    const github = new FixtureGitHubAdapter({ candidates: [candidate] });
    const ci = new FixtureCiAdapter([
      {
        repo: candidate.repo,
        ref: "main",
        overallStatus: "success",
        checks: [
          {
            name: "ci / typecheck",
            status: "success",
            conclusion: "success",
            url: "https://ci.example/typecheck",
            completedAt: "2026-03-25T20:01:00.000Z"
          }
        ],
        observedAt: "2026-03-25T20:02:00.000Z"
      }
    ]);

    const intake = await intakeGitHubIssue({
      github,
      ci,
      repo: candidate.repo,
      issueNumber: candidate.issueNumber
    });

    expect(intake.issueStatus.defaultBranch).toBe("main");
    expect(intake.ciSnapshot?.overallStatus).toBe("success");
    expect(intake.planningInput.labels).toContain("ai-eligible");
  });

  it("issues scoped fixture secrets and redacts them from log output", async () => {
    const secrets = new FixtureSecretsAdapter([
      {
        scope: "github_readonly",
        environmentVariables: {
          GITHUB_TOKEN: "ghs_fixture_token"
        },
        allowedAgents: ["developer", "validation"],
        allowedEnvironments: ["staging"]
      }
    ]);

    const lease = await secrets.issueTaskSecrets({
      taskId: "acme-platform-88",
      repo: candidate.repo,
      agentType: "validation",
      phase: "validation",
      environment: "staging",
      riskClass: "medium",
      approvalMode: "human_signoff_required",
      requestedCapabilities: ["can_use_secrets"],
      allowedSecretScopes: ["github_readonly"]
    });

    expect(lease?.mode).toBe("scoped_env");
    expect(lease?.secretScopes).toEqual(["github_readonly"]);
    expect(lease?.injectedSecretKeys).toEqual(["GITHUB_TOKEN"]);
    expect(
      redactSecretValues("token=ghs_fixture_token", lease!)
    ).toBe("token=***REDACTED***");
  });

  it("creates fixture-backed branches and pull requests only when SCM mutations are explicitly enabled", async () => {
    const github = new FixtureGitHubAdapter({
      candidates: [candidate],
      mutations: {
        allowBranchCreation: true,
        allowPullRequestCreation: true,
        pullRequestNumberStart: 41
      }
    });

    const branch = await github.createBranch(
      candidate.repo,
      "main",
      "reddwarf/acme-platform-88/run-scm"
    );
    const pullRequest = await github.createPullRequest({
      repo: candidate.repo,
      baseBranch: "main",
      headBranch: branch.branchName,
      title: "[RedDwarf] Test PR",
      body: "Body",
      labels: ["reddwarf", "automation"],
      issueNumber: candidate.issueNumber
    });

    expect(branch.ref).toBe("refs/heads/reddwarf/acme-platform-88/run-scm");
    expect(branch.url).toContain("/tree/");
    expect(pullRequest.number).toBe(41);
    expect(pullRequest.baseBranch).toBe("main");
    expect(pullRequest.headBranch).toBe(branch.branchName);
  });

  it("denies mutation-oriented GitHub, CI, and secret operations in v1", async () => {
    const github = new FixtureGitHubAdapter({ candidates: [candidate] });
    const ci = new FixtureCiAdapter([]);
    const secrets = new DenyAllSecretsAdapter();

    await expect(
      github.createBranch(candidate.repo, "main", "feature/test")
    ).rejects.toBeInstanceOf(V1MutationDisabledError);
    await expect(
      github.createPullRequest({
        repo: candidate.repo,
        baseBranch: "main",
        headBranch: "feature/test",
        title: "Test PR",
        body: "Body"
      })
    ).rejects.toBeInstanceOf(V1MutationDisabledError);
    await expect(
      ci.triggerWorkflow(candidate.repo, "ci.yml", "main")
    ).rejects.toBeInstanceOf(V1MutationDisabledError);
    await expect(
      secrets.requestSecret("GITHUB_TOKEN")
    ).rejects.toBeInstanceOf(V1MutationDisabledError);
    await expect(
      secrets.issueTaskSecrets({
        taskId: "acme-platform-88",
        repo: candidate.repo,
        agentType: "validation",
        phase: "validation",
        environment: "staging",
        riskClass: "medium",
        approvalMode: "human_signoff_required",
        requestedCapabilities: ["can_use_secrets"],
        allowedSecretScopes: ["github_readonly"]
      })
    ).rejects.toBeInstanceOf(V1MutationDisabledError);
  });
});
