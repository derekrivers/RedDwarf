import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DenyAllSecretsAdapter,
  FixtureCiAdapter,
  FixtureGitHubAdapter,
  FixtureOpenClawDispatchAdapter,
  FixtureSecretsAdapter,
  HttpOpenClawDispatchAdapter,
  RestGitHubAdapter,
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

  it("reuses fixture-backed follow-up issues for the same task marker", async () => {
    const github = new FixtureGitHubAdapter({
      candidates: [candidate],
      mutations: {
        allowIssueCreation: true,
        issueNumberStart: 301
      }
    });

    const firstFollowUp = await github.createIssue({
      repo: candidate.repo,
      title: "Follow-up: validation failure",
      body: [
        "Source task: Verify validation",
        "Task ID: acme-platform-88",
        "Run ID: validation-run-1"
      ].join("\n"),
      labels: ["reddwarf", "follow-up", "validation"]
    });
    const secondFollowUp = await github.createIssue({
      repo: candidate.repo,
      title: "Follow-up: validation failure",
      body: [
        "Source task: Verify validation",
        "Task ID: acme-platform-88",
        "Run ID: validation-run-2"
      ].join("\n"),
      labels: ["reddwarf", "follow-up", "validation"]
    });

    expect(secondFollowUp.issueNumber).toBe(firstFollowUp.issueNumber);
    expect(secondFollowUp.url).toBe(firstFollowUp.url);
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

  it("reuses fixture-backed branches and pull requests for the same SCM identity", async () => {
    const github = new FixtureGitHubAdapter({
      candidates: [candidate],
      mutations: {
        allowBranchCreation: true,
        allowPullRequestCreation: true,
        pullRequestNumberStart: 41
      }
    });

    const firstBranch = await github.createBranch(
      candidate.repo,
      "main",
      "reddwarf/acme-platform-88/scm"
    );
    const secondBranch = await github.createBranch(
      candidate.repo,
      "main",
      "reddwarf/acme-platform-88/scm"
    );
    const firstPullRequest = await github.createPullRequest({
      repo: candidate.repo,
      baseBranch: "main",
      headBranch: firstBranch.branchName,
      title: "[RedDwarf] Test PR",
      body: "Body",
      labels: ["reddwarf", "automation"],
      issueNumber: candidate.issueNumber
    });
    const secondPullRequest = await github.createPullRequest({
      repo: candidate.repo,
      baseBranch: "main",
      headBranch: secondBranch.branchName,
      title: "[RedDwarf] Test PR",
      body: "Body retry",
      labels: ["reddwarf", "automation"],
      issueNumber: candidate.issueNumber
    });

    expect(secondBranch).toEqual(firstBranch);
    expect(secondPullRequest.number).toBe(firstPullRequest.number);
    expect(secondPullRequest.url).toBe(firstPullRequest.url);
  });

  it("exports well-known OpenClaw secret constants", () => {
    expect(OPENCLAW_HOOK_TOKEN_SCOPE).toBe("openclaw");
    expect(OPENCLAW_HOOK_TOKEN_ENV).toBe("OPENCLAW_HOOK_TOKEN");
    expect(OPENCLAW_BASE_URL_ENV).toBe("OPENCLAW_BASE_URL");
  });

  it("creates an OpenClaw secrets adapter that does NOT expose the hook token", async () => {
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

      // The openclaw scope must NOT contain the hook token — it grants
      // full gateway write access and must not leak to agent workspaces.
      expect(lease).not.toBeNull();
      expect(lease?.secretScopes).toEqual(["openclaw"]);
      expect(lease?.environmentVariables["HOOK_TOKEN"]).toBeUndefined();
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

describe("RestGitHubAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("reuses an existing follow-up issue when the task marker already exists remotely", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          number: 77,
          title: "Follow-up: validation failure",
          body: [
            "Source task: Verify validation",
            "Task ID: acme-platform-88",
            "Run ID: validation-run-1"
          ].join("\n"),
          state: "open",
          html_url: "https://github.com/acme/platform/issues/77",
          labels: [{ name: "reddwarf" }, { name: "follow-up" }, { name: "validation" }],
          assignees: [],
          user: { login: "reddwarf" },
          updated_at: "2026-03-29T18:00:00.000Z",
          created_at: "2026-03-29T17:59:00.000Z",
          milestone: null
        }
      ]
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new RestGitHubAdapter({ token: "test-token" });
    const issue = await adapter.createIssue({
      repo: "acme/platform",
      title: "Follow-up: validation failure",
      body: [
        "Source task: Verify validation",
        "Task ID: acme-platform-88",
        "Run ID: validation-run-2"
      ].join("\n"),
      labels: ["reddwarf", "follow-up", "validation"]
    });

    expect(issue.issueNumber).toBe(77);
    expect(issue.createdAt).toBe("2026-03-29T17:59:00.000Z");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses an existing pull request for the same base and head branch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          number: 91,
          html_url: "https://github.com/acme/platform/pull/91",
          state: "open",
          base: { ref: "main" },
          head: { ref: "reddwarf/acme-platform-88/scm" },
          title: "[RedDwarf] Verify SCM"
        }
      ]
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new RestGitHubAdapter({ token: "test-token" });
    const pullRequest = await adapter.createPullRequest({
      repo: "acme/platform",
      baseBranch: "main",
      headBranch: "reddwarf/acme-platform-88/scm",
      title: "[RedDwarf] Verify SCM",
      body: "Body"
    });

    expect(pullRequest.number).toBe(91);
    expect(pullRequest.headBranch).toBe("reddwarf/acme-platform-88/scm");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails fast when the GitHub API request exceeds the timeout", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn().mockImplementation((_url, init) =>
      new Promise((_, reject) => {
        const signal = (init as RequestInit).signal;
        signal?.addEventListener("abort", () => reject(signal.reason));
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new RestGitHubAdapter({
      token: "test-token",
      requestTimeoutMs: 25
    });

    const pending = adapter.listIssueCandidates({
      repo: "acme/platform",
      labels: ["ai-eligible"],
      states: ["open"],
      limit: 10
    });
    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).rejects.toThrow(
      "GitHub API GET /repos/acme/platform/issues?state=open&labels=ai-eligible&per_page=10 timed out after 25ms."
    );
  });
});

describe("HttpOpenClawDispatchAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
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

  it("times out when the OpenClaw hook does not respond", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn().mockImplementation((_url, init) =>
      new Promise((_, reject) => {
        const signal = (init as RequestInit).signal;
        signal?.addEventListener("abort", () => reject(signal.reason));
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new HttpOpenClawDispatchAdapter({
      baseUrl: "http://localhost:3578/",
      hookToken: "test-token",
      requestTimeoutMs: 25
    });

    const pending = adapter.dispatch({
      sessionKey: "github:issue:acme/repo:42",
      agentId: "reddwarf-developer",
      prompt: "Implement the requested change"
    });
    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).rejects.toThrow(
      "OpenClaw dispatch to http://localhost:3578/hooks/agent timed out after 25ms."
    );
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
