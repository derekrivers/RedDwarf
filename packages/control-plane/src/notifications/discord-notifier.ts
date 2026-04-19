import type { ApprovalRequest } from "@reddwarf/contracts";
import type { PlanningPipelineLogger } from "../logger.js";

// Feature 177: Outbound Discord webhook notifications for approvals and PR creation.
// The notifier is best-effort — webhook failures must not fail the pipeline — and
// reads its env flags on every call so operator-config reloads take effect without
// a process restart.

export const DISCORD_EMBED_COLOR_FALLBACK = 0xd7263d;
export const DISCORD_WEBHOOK_TIMEOUT_MS = 5_000;

export interface ToolApprovalLike {
  id: string;
  sessionKey: string;
  taskId: string | null;
  toolName: string;
  targetPath: string | null;
  reason: string;
}

export interface ProjectApprovalLike {
  projectId: string;
  title: string;
  summary: string;
  sourceRepo: string;
  projectSize: "small" | "medium" | "large";
  ticketCount: number;
  createdAt: string;
}

export type ApprovalNotificationInput =
  | { kind: "phase"; approval: ApprovalRequest; repo?: string | null }
  | { kind: "tool"; approval: ToolApprovalLike }
  | { kind: "project"; project: ProjectApprovalLike };

export interface PullRequestNotificationInput {
  taskId: string;
  runId: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  branchName: string;
}

export interface DiscordNotifier {
  notifyApprovalCreated(input: ApprovalNotificationInput): Promise<void>;
  notifyPullRequestCreated(input: PullRequestNotificationInput): Promise<void>;
}

export interface DiscordNotifierOptions {
  fetchImpl?: typeof fetch;
  logger?: PlanningPipelineLogger;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

interface ResolvedConfig {
  enabled: boolean;
  approvalsEnabled: boolean;
  prCreatedEnabled: boolean;
  webhookUrl: string | null;
  dashboardOrigin: string | null;
  embedColor: number;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  return /^(true|1|yes)$/i.test(trimmed);
}

function parseHexColor(value: string | undefined): number {
  if (!value) return DISCORD_EMBED_COLOR_FALLBACK;
  const match = /^#([0-9a-fA-F]{6})$/.exec(value.trim());
  if (!match) return DISCORD_EMBED_COLOR_FALLBACK;
  return Number.parseInt(match[1]!, 16);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function resolveDiscordNotifyConfig(
  env: NodeJS.ProcessEnv = process.env
): ResolvedConfig {
  const enabled = parseBoolean(env["REDDWARF_DISCORD_NOTIFY_ENABLED"], false);
  const webhookRaw = (env["REDDWARF_DISCORD_NOTIFY_WEBHOOK_URL"] ?? "").trim();
  const webhookUrl = webhookRaw.length > 0 ? webhookRaw : null;
  const approvalsEnabled = parseBoolean(
    env["REDDWARF_DISCORD_NOTIFY_APPROVALS"],
    true
  );
  const prCreatedEnabled = parseBoolean(
    env["REDDWARF_DISCORD_NOTIFY_PR_CREATED"],
    true
  );
  const dashboardRaw = (env["REDDWARF_DASHBOARD_ORIGIN"] ?? "").trim();
  const dashboardOrigin =
    dashboardRaw.length > 0 ? trimTrailingSlash(dashboardRaw) : null;
  const embedColor = parseHexColor(
    env["REDDWARF_OPENCLAW_DISCORD_ACCENT_COLOR"]
  );
  return {
    enabled,
    approvalsEnabled,
    prCreatedEnabled,
    webhookUrl,
    dashboardOrigin,
    embedColor
  };
}

export function buildApprovalDeepLink(
  approvalRequestId: string,
  dashboardOrigin: string | null
): string | null {
  if (!dashboardOrigin) return null;
  return `${dashboardOrigin}/approvals/${encodeURIComponent(approvalRequestId)}`;
}

function titleForPhaseApproval(approval: ApprovalRequest): string {
  const phase = approval.phase.replace(/_/g, " ");
  return `New ${phase} approval — ${approval.taskId}`;
}

function descriptionForPhaseApproval(approval: ApprovalRequest): string {
  const lines = [approval.summary];
  if (approval.requestedCapabilities.length > 0) {
    lines.push(
      `**Requested capabilities:** ${approval.requestedCapabilities.join(", ")}`
    );
  }
  if (approval.riskClass) {
    lines.push(`**Risk class:** ${approval.riskClass}`);
  }
  return lines.join("\n\n");
}

export function buildPhaseApprovalEmbed(
  approval: ApprovalRequest,
  config: ResolvedConfig,
  repo: string | null | undefined
): Record<string, unknown> {
  const link = buildApprovalDeepLink(approval.requestId, config.dashboardOrigin);
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: "Task", value: approval.taskId, inline: true },
    { name: "Phase", value: approval.phase, inline: true }
  ];
  if (repo) {
    fields.push({ name: "Repo", value: repo, inline: true });
  }
  if (approval.approvalMode) {
    fields.push({
      name: "Mode",
      value: approval.approvalMode,
      inline: true
    });
  }
  const embed: Record<string, unknown> = {
    title: titleForPhaseApproval(approval),
    description: descriptionForPhaseApproval(approval),
    color: config.embedColor,
    fields,
    timestamp: approval.createdAt
  };
  if (link) {
    embed["url"] = link;
  }
  return embed;
}

export function buildProjectApprovalEmbed(
  project: ProjectApprovalLike,
  config: ResolvedConfig
): Record<string, unknown> {
  const link = config.dashboardOrigin
    ? `${config.dashboardOrigin}/projects/${encodeURIComponent(project.projectId)}`
    : null;
  const embed: Record<string, unknown> = {
    title: `New project approval — ${project.title}`,
    description: project.summary,
    color: config.embedColor,
    fields: [
      { name: "Project", value: project.projectId, inline: true },
      { name: "Repo", value: project.sourceRepo, inline: true },
      { name: "Size", value: project.projectSize, inline: true },
      { name: "Tickets", value: String(project.ticketCount), inline: true }
    ],
    timestamp: project.createdAt
  };
  if (link) {
    embed["url"] = link;
  }
  return embed;
}

export function buildToolApprovalEmbed(
  approval: ToolApprovalLike,
  config: ResolvedConfig
): Record<string, unknown> {
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: "Tool", value: approval.toolName, inline: true },
    { name: "Session", value: approval.sessionKey, inline: true }
  ];
  if (approval.taskId) {
    fields.push({ name: "Task", value: approval.taskId, inline: true });
  }
  if (approval.targetPath) {
    fields.push({ name: "Target path", value: approval.targetPath });
  }
  return {
    title: `Tool approval requested — ${approval.toolName}`,
    description: approval.reason,
    color: config.embedColor,
    fields
  };
}

export function buildPullRequestEmbed(
  input: PullRequestNotificationInput,
  config: ResolvedConfig
): Record<string, unknown> {
  return {
    title: `Pull request #${input.prNumber} opened — ${input.repo}`,
    description: `Branch \`${input.branchName}\` is ready for review.`,
    url: input.prUrl,
    color: config.embedColor,
    fields: [
      { name: "Task", value: input.taskId, inline: true },
      { name: "Repo", value: input.repo, inline: true },
      { name: "Branch", value: input.branchName, inline: true }
    ]
  };
}

function canDeliver(config: ResolvedConfig): boolean {
  return config.enabled && config.webhookUrl !== null;
}

async function postWebhook(
  url: string,
  embed: Record<string, unknown>,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<void> {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
    signal
  });
  if (!response.ok) {
    throw new Error(
      `Discord webhook responded ${response.status} ${response.statusText}`
    );
  }
}

export function createDiscordNotifier(
  options: DiscordNotifierOptions = {}
): DiscordNotifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const logger = options.logger;
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DISCORD_WEBHOOK_TIMEOUT_MS;

  async function deliver(
    embed: Record<string, unknown>,
    context: Record<string, unknown>
  ): Promise<void> {
    const config = resolveDiscordNotifyConfig(env);
    if (!canDeliver(config)) return;
    try {
      await postWebhook(config.webhookUrl!, embed, fetchImpl, timeoutMs);
      logger?.info?.("discord.notify.sent", context);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      logger?.warn?.("discord.notify.failed", { ...context, error: message });
    }
  }

  return {
    async notifyApprovalCreated(input) {
      const config = resolveDiscordNotifyConfig(env);
      if (!config.enabled || !config.approvalsEnabled) return;
      if (input.kind === "phase") {
        const embed = buildPhaseApprovalEmbed(
          input.approval,
          config,
          input.repo ?? null
        );
        await deliver(embed, {
          event: "approval.created",
          kind: "phase",
          requestId: input.approval.requestId,
          taskId: input.approval.taskId,
          phase: input.approval.phase
        });
      } else if (input.kind === "project") {
        const embed = buildProjectApprovalEmbed(input.project, config);
        await deliver(embed, {
          event: "approval.created",
          kind: "project",
          projectId: input.project.projectId,
          repo: input.project.sourceRepo
        });
      } else {
        const embed = buildToolApprovalEmbed(input.approval, config);
        await deliver(embed, {
          event: "approval.created",
          kind: "tool",
          approvalId: input.approval.id,
          toolName: input.approval.toolName,
          taskId: input.approval.taskId ?? null
        });
      }
    },

    async notifyPullRequestCreated(input) {
      const config = resolveDiscordNotifyConfig(env);
      if (!config.enabled || !config.prCreatedEnabled) return;
      const embed = buildPullRequestEmbed(input, config);
      await deliver(embed, {
        event: "pull_request.created",
        taskId: input.taskId,
        runId: input.runId,
        repo: input.repo,
        prNumber: input.prNumber
      });
    }
  };
}

