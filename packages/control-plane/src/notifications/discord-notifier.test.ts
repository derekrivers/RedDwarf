import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@reddwarf/contracts";
import {
  buildApprovalDeepLink,
  buildPhaseApprovalEmbed,
  buildProjectApprovalEmbed,
  buildPullRequestEmbed,
  buildToolApprovalEmbed,
  createDiscordNotifier,
  resolveDiscordNotifyConfig
} from "./discord-notifier.js";

function makeApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: "task-1:approval:1",
    taskId: "task-1",
    runId: "run-1",
    phase: "policy_gate",
    dryRun: false,
    confidenceLevel: null,
    confidenceReason: null,
    approvalMode: "review_required",
    status: "pending",
    riskClass: "medium",
    summary: "Approve before developer phase can run.",
    requestedCapabilities: ["can_write_code"],
    allowedPaths: ["src/**"],
    blockedPhases: [],
    policyReasons: [],
    requestedBy: "rimmer",
    decidedBy: null,
    decision: null,
    decisionSummary: null,
    comment: null,
    createdAt: "2026-04-19T10:00:00.000Z",
    updatedAt: "2026-04-19T10:00:00.000Z",
    resolvedAt: null,
    ...overrides
  };
}

const ENABLED_ENV = {
  REDDWARF_DISCORD_NOTIFY_ENABLED: "true",
  REDDWARF_DISCORD_NOTIFY_WEBHOOK_URL: "https://discord.test/webhook/abc",
  REDDWARF_DASHBOARD_ORIGIN: "https://dash.example.com",
  REDDWARF_OPENCLAW_DISCORD_ACCENT_COLOR: "#00ff00"
} as NodeJS.ProcessEnv;

describe("resolveDiscordNotifyConfig", () => {
  it("defaults disabled with fallback accent color", () => {
    const config = resolveDiscordNotifyConfig({} as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(false);
    expect(config.approvalsEnabled).toBe(true);
    expect(config.prCreatedEnabled).toBe(true);
    expect(config.webhookUrl).toBeNull();
    expect(config.dashboardOrigin).toBeNull();
    expect(config.embedColor).toBe(0xd7263d);
  });

  it("parses enabled env, toggles, accent color, and trims dashboard origin", () => {
    const config = resolveDiscordNotifyConfig({
      ...ENABLED_ENV,
      REDDWARF_DISCORD_NOTIFY_APPROVALS: "false",
      REDDWARF_DISCORD_NOTIFY_PR_CREATED: "yes",
      REDDWARF_DASHBOARD_ORIGIN: "https://dash.example.com/"
    } as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(true);
    expect(config.approvalsEnabled).toBe(false);
    expect(config.prCreatedEnabled).toBe(true);
    expect(config.webhookUrl).toBe("https://discord.test/webhook/abc");
    expect(config.dashboardOrigin).toBe("https://dash.example.com");
    expect(config.embedColor).toBe(0x00ff00);
  });

  it("falls back to default color on malformed accent", () => {
    const config = resolveDiscordNotifyConfig({
      REDDWARF_OPENCLAW_DISCORD_ACCENT_COLOR: "nope"
    } as NodeJS.ProcessEnv);
    expect(config.embedColor).toBe(0xd7263d);
  });
});

describe("buildApprovalDeepLink", () => {
  it("returns null when dashboard origin is unset", () => {
    expect(buildApprovalDeepLink("task:approval:1", null)).toBeNull();
  });

  it("joins origin and encoded request id", () => {
    expect(
      buildApprovalDeepLink("task:approval:abc 1", "https://dash.example.com")
    ).toBe("https://dash.example.com/approvals/task%3Aapproval%3Aabc%201");
  });
});

describe("buildPhaseApprovalEmbed", () => {
  it("includes title, description, fields, and deep link", () => {
    const config = resolveDiscordNotifyConfig(ENABLED_ENV);
    const embed = buildPhaseApprovalEmbed(
      makeApproval({ phase: "architecture_review" }),
      config,
      "derekrivers/FirstVoyage"
    );
    expect(embed["title"]).toBe(
      "New architecture review approval — task-1"
    );
    expect(String(embed["description"])).toContain(
      "Approve before developer phase can run."
    );
    expect(String(embed["description"])).toContain("can_write_code");
    expect(embed["url"]).toBe(
      "https://dash.example.com/approvals/task-1%3Aapproval%3A1"
    );
    const fields = embed["fields"] as Array<{ name: string; value: string }>;
    expect(fields.find((f) => f.name === "Repo")?.value).toBe(
      "derekrivers/FirstVoyage"
    );
  });
});

describe("buildToolApprovalEmbed", () => {
  it("formats tool metadata", () => {
    const config = resolveDiscordNotifyConfig(ENABLED_ENV);
    const embed = buildToolApprovalEmbed(
      {
        id: "tool-1",
        sessionKey: "github:issue:acme/repo:42",
        taskId: "task-1",
        toolName: "write",
        targetPath: "/etc/passwd",
        reason: "Tool wants to touch a denied path."
      },
      config
    );
    expect(embed["title"]).toBe("Tool approval requested — write");
    const fields = embed["fields"] as Array<{ name: string; value: string }>;
    expect(fields.some((f) => f.name === "Target path")).toBe(true);
  });
});

describe("buildProjectApprovalEmbed", () => {
  it("formats project metadata and projects deep link", () => {
    const config = resolveDiscordNotifyConfig(ENABLED_ENV);
    const embed = buildProjectApprovalEmbed(
      {
        projectId: "proj-1",
        title: "Revamp billing",
        summary: "Break billing out into three tickets.",
        sourceRepo: "acme/repo",
        projectSize: "medium",
        ticketCount: 3,
        createdAt: "2026-04-19T10:00:00.000Z"
      },
      config
    );
    expect(embed["title"]).toBe("New project approval — Revamp billing");
    expect(embed["url"]).toBe("https://dash.example.com/projects/proj-1");
    const fields = embed["fields"] as Array<{ name: string; value: string }>;
    expect(fields.find((f) => f.name === "Tickets")?.value).toBe("3");
  });
});

describe("buildPullRequestEmbed", () => {
  it("formats PR title and URL", () => {
    const config = resolveDiscordNotifyConfig(ENABLED_ENV);
    const embed = buildPullRequestEmbed(
      {
        taskId: "task-1",
        runId: "run-1",
        repo: "acme/repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        branchName: "feature/thing"
      },
      config
    );
    expect(embed["title"]).toBe("Pull request #42 opened — acme/repo");
    expect(embed["url"]).toBe("https://github.com/acme/repo/pull/42");
  });
});

describe("createDiscordNotifier", () => {
  it("skips delivery when disabled", async () => {
    const fetchImpl = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const notifier = createDiscordNotifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger,
      env: {} as NodeJS.ProcessEnv
    });
    await notifier.notifyApprovalCreated({
      kind: "phase",
      approval: makeApproval()
    });
    await notifier.notifyPullRequestCreated({
      taskId: "t",
      runId: "r",
      repo: "a/b",
      prNumber: 1,
      prUrl: "https://example/pr/1",
      branchName: "b"
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips approval delivery when approvals toggle is off but notifier enabled", async () => {
    const fetchImpl = vi.fn();
    const notifier = createDiscordNotifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: {
        ...ENABLED_ENV,
        REDDWARF_DISCORD_NOTIFY_APPROVALS: "false"
      } as NodeJS.ProcessEnv
    });
    await notifier.notifyApprovalCreated({
      kind: "phase",
      approval: makeApproval()
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts an approval embed to the webhook when enabled", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 204 })
    );
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const notifier = createDiscordNotifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger,
      env: ENABLED_ENV
    });
    await notifier.notifyApprovalCreated({
      kind: "phase",
      approval: makeApproval(),
      repo: "acme/repo"
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0] as [string, RequestInit] | undefined;
    expect(call).toBeDefined();
    const [url, init] = call!;
    expect(url).toBe("https://discord.test/webhook/abc");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as {
      embeds: Array<{ title: string; fields: Array<{ name: string; value: string }> }>;
    };
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0]!.title).toContain("policy gate");
    expect(body.embeds[0]!.fields.find((f) => f.name === "Repo")?.value).toBe(
      "acme/repo"
    );
    expect(logger.info).toHaveBeenCalledWith(
      "discord.notify.sent",
      expect.objectContaining({ event: "approval.created", kind: "phase" })
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not throw when the webhook fails and logs a warning", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const notifier = createDiscordNotifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger,
      env: ENABLED_ENV
    });
    await expect(
      notifier.notifyPullRequestCreated({
        taskId: "task-1",
        runId: "run-1",
        repo: "acme/repo",
        prNumber: 7,
        prUrl: "https://github.com/acme/repo/pull/7",
        branchName: "feature/thing"
      })
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "discord.notify.failed",
      expect.objectContaining({
        event: "pull_request.created",
        error: "network down"
      })
    );
  });

  it("treats a non-2xx webhook response as a failure", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("rate limited", { status: 429, statusText: "Too Many Requests" })
    );
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const notifier = createDiscordNotifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger,
      env: ENABLED_ENV
    });
    await notifier.notifyApprovalCreated({
      kind: "tool",
      approval: {
        id: "tool-1",
        sessionKey: "s",
        taskId: null,
        toolName: "write",
        targetPath: null,
        reason: "needs approval"
      }
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "discord.notify.failed",
      expect.objectContaining({ error: expect.stringContaining("429") })
    );
  });

  it("skips approval delivery when webhook URL is missing even if enabled", async () => {
    const fetchImpl = vi.fn();
    const notifier = createDiscordNotifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: {
        REDDWARF_DISCORD_NOTIFY_ENABLED: "true"
      } as NodeJS.ProcessEnv
    });
    await notifier.notifyApprovalCreated({
      kind: "phase",
      approval: makeApproval()
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
