import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DenyAllSecretsAdapter,
  FixtureCiAdapter,
  FixtureGitHubAdapter,
  FixtureOpenClawDispatchAdapter,
  FixtureSecretsAdapter,
  HttpOpenClawDispatchAdapter,
  OPENCLAW_BASE_URL_ENV,
  OPENCLAW_HOOK_TOKEN_ENV,
  OPENCLAW_HOOK_TOKEN_SCOPE,
  V1MutationDisabledError,
  createOpenClawSecretsAdapter,
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

  it("creates fixture-backed follow-up issues only when issue automation is explicitly enabled", async () => {
    const github = new FixtureGitHubAdapter({
      candidates: [candidate],
      mutations: {
        allowIssueCreation: true,
        issueNumberStart: 301
      }
    });

    const followUp = await github.createIssue({
      repo: candidate.repo,
      title: "Follow-up: validation failure",
      body: "Body",
      labels: ["reddwarf", "follow-up"]
    });

    expect(followUp.issueNumber).toBe(301);
    expect(followUp.url).toBe("https://github.com/acme/platform/issues/301");
    expect(followUp.state).toBe("open");
    expect(followUp.title).toBe("Follow-up: validation failure");
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

  it("exports well-known OpenClaw secret constants", () => {
    expect(OPENCLAW_HOOK_TOKEN_SCOPE).toBe("openclaw");
    expect(OPENCLAW_HOOK_TOKEN_ENV).toBe("OPENCLAW_HOOK_TOKEN");
    expect(OPENCLAW_BASE_URL_ENV).toBe("OPENCLAW_BASE_URL");
  });

  it("creates an OpenClaw secrets adapter that reads hook token from env", async () => {
    const saved = process.env[OPENCLAW_HOOK_TOKEN_ENV];
    try {
      process.env[OPENCLAW_HOOK_TOKEN_ENV] = "test-hook-token-abc";
      const adapter = createOpenClawSecretsAdapter();

      const lease = await adapter.issueTaskSecrets({
        taskId: "test-task",
        repo: "acme/demo",
        agentType: "developer",
        phase: "development",
        environment: "local",
        riskClass: "low",
        approvalMode: "auto",
        requestedCapabilities: ["can_use_secrets"],
        allowedSecretScopes: ["openclaw"]
      });

      expect(lease).not.toBeNull();
      expect(lease?.secretScopes).toEqual(["openclaw"]);
      expect(lease?.environmentVariables["HOOK_TOKEN"]).toBe("test-hook-token-abc");
    } finally {
      if (saved !== undefined) {
        process.env[OPENCLAW_HOOK_TOKEN_ENV] = saved;
      } else {
        delete process.env[OPENCLAW_HOOK_TOKEN_ENV];
      }
    }
  });

  it("denies mutation-oriented GitHub, CI, and secret operations in v1", async () => {
    const github = new FixtureGitHubAdapter({ candidates: [candidate] });
    const ci = new FixtureCiAdapter([]);
    const secrets = new DenyAllSecretsAdapter();

    await expect(
      github.createIssue({
        repo: candidate.repo,
        title: "Follow-up",
        body: "Body"
      })
    ).rejects.toBeInstanceOf(V1MutationDisabledError);
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

describe("FixtureOpenClawDispatchAdapter", () => {
  it("accepts dispatches and records them for inspection", async () => {
    const adapter = new FixtureOpenClawDispatchAdapter();
    const result = await adapter.dispatch({
      sessionKey: "github:issue:acme/repo:42",
      agentId: "reddwarf-analyst",
      prompt: "Analyze the codebase for issue #42"
    });

    expect(result.accepted).toBe(true);
    expect(result.sessionKey).toBe("github:issue:acme/repo:42");
    expect(result.agentId).toBe("reddwarf-analyst");
    expect(result.sessionId).toBe("fixture-session-001");
    expect(adapter.dispatches).toHaveLength(1);
    expect(adapter.dispatches[0]?.prompt).toBe("Analyze the codebase for issue #42");
  });

  it("rejects all dispatches when rejectAll is true", async () => {
    const adapter = new FixtureOpenClawDispatchAdapter({ rejectAll: true });
    const result = await adapter.dispatch({
      sessionKey: "test:session",
      agentId: "reddwarf-coordinator",
      prompt: "Test dispatch"
    });

    expect(result.accepted).toBe(false);
    expect(result.sessionId).toBeNull();
    expect(result.statusMessage).toContain("rejected");
    expect(adapter.dispatches).toHaveLength(1);
  });

  it("uses custom session ID and status message when provided", async () => {
    const adapter = new FixtureOpenClawDispatchAdapter({
      fixedSessionId: "custom-session-xyz",
      statusMessage: "Dispatch queued"
    });
    const result = await adapter.dispatch({
      sessionKey: "test:key",
      agentId: "reddwarf-validator",
      prompt: "Validate workspace"
    });

    expect(result.sessionId).toBe("custom-session-xyz");
    expect(result.statusMessage).toBe("Dispatch queued");
  });
});

describe("HttpOpenClawDispatchAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when no base URL is available", () => {
    const saved = process.env[OPENCLAW_BASE_URL_ENV];
    delete process.env[OPENCLAW_BASE_URL_ENV];
    try {
      expect(() => new HttpOpenClawDispatchAdapter({ hookToken: "tok" })).toThrow(
        "requires a base URL"
      );
    } finally {
      if (saved !== undefined) process.env[OPENCLAW_BASE_URL_ENV] = saved;
    }
  });

  it("throws when no hook token is available", () => {
    const saved = process.env[OPENCLAW_HOOK_TOKEN_ENV];
    delete process.env[OPENCLAW_HOOK_TOKEN_ENV];
    try {
      expect(
        () => new HttpOpenClawDispatchAdapter({ baseUrl: "http://localhost:3578" })
      ).toThrow("requires a hook token");
    } finally {
      if (saved !== undefined) process.env[OPENCLAW_HOOK_TOKEN_ENV] = saved;
    }
  });

  it("constructs successfully when both base URL and hook token are provided", () => {
    const adapter = new HttpOpenClawDispatchAdapter({
      baseUrl: "http://localhost:3578",
      hookToken: "test-token"
    });
    expect(adapter).toBeInstanceOf(HttpOpenClawDispatchAdapter);
  });

  it("posts webhook-compatible payloads to /hooks/agent", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ sessionId: "hook-session-123", message: "Dispatch queued" })
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new HttpOpenClawDispatchAdapter({
      baseUrl: "http://localhost:3578/",
      hookToken: "test-token"
    });

    const result = await adapter.dispatch({
      sessionKey: "github:issue:acme/repo:42",
      agentId: "reddwarf-developer",
      prompt: "Implement the requested change",
      metadata: { source: "e2e" }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3578/hooks/agent",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        }),
        body: JSON.stringify({
          message: "Implement the requested change",
          name: "RedDwarf",
          sessionKey: "github:issue:acme/repo:42",
          agentId: "reddwarf-developer",
          deliver: false,
          wakeMode: "now",
          metadata: { source: "e2e" }
        })
      })
    );
    expect(result.sessionId).toBe("hook-session-123");
    expect(result.statusMessage).toBe("Dispatch queued");
  });
});
