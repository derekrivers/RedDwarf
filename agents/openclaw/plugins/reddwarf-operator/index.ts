type OperatorCommandContext = {
  channel?: string;
  args?: string;
  senderId?: string;
};

type OperatorPluginConfig = {
  operatorApiBaseUrl?: unknown;
};

type OpenClawPluginApi = {
  config?: {
    plugins?: {
      entries?: Record<string, { config?: OperatorPluginConfig }>;
    };
  };
  logger: {
    warn?: (message: string) => void;
    info?: (message: string) => void;
  };
  registerCommand: (definition: {
    name: string;
    nativeNames?: Record<string, string>;
    description: string;
    acceptsArgs?: boolean;
    handler: (ctx: OperatorCommandContext) => Promise<{ text: string }>;
  }) => void;
};

const PLUGIN_ID = "reddwarf-operator";
const DEFAULT_OPERATOR_API_BASE_URL = "http://host.docker.internal:8080";
const DEFAULT_SUBMIT_ACCEPTANCE =
  "The delivered change satisfies the operator-provided description and is verified before handoff.";

function definePluginEntry<T extends { id: string; register: (api: OpenClawPluginApi) => void }>(
  plugin: T
): T {
  return plugin;
}

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveOperatorApiBaseUrl(api: OpenClawPluginApi): string {
  const configured = trimString(
    api.config?.plugins?.entries?.[PLUGIN_ID]?.config?.operatorApiBaseUrl
  );
  return (configured || DEFAULT_OPERATOR_API_BASE_URL).replace(/\/+$/, "");
}

function resolveOperatorToken(): string {
  return trimString(process.env.REDDWARF_OPERATOR_TOKEN);
}

async function operatorRequest(
  api: OpenClawPluginApi,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const token = resolveOperatorToken();
  if (!token) {
    throw new Error("REDDWARF_OPERATOR_TOKEN is not configured inside the OpenClaw gateway.");
  }

  const response = await fetch(`${resolveOperatorApiBaseUrl(api)}${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Operator API ${path} returned ${response.status}${body ? `: ${body}` : ""}`
    );
  }

  return response;
}

async function operatorJson<T>(
  api: OpenClawPluginApi,
  path: string,
  init?: RequestInit
): Promise<T> {
  const response = await operatorRequest(api, path, init);
  return (await response.json()) as T;
}

function formatList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function formatRecentRuns(runs: Array<Record<string, unknown>>): string {
  if (runs.length === 0) {
    return "No pipeline runs found.";
  }

  return formatList(
    runs.map((run) => {
      const runId = trimString(run.runId) || "unknown";
      const taskId = trimString(run.taskId) || "unknown-task";
      const status = trimString(run.status) || "unknown";
      return `${runId} (${status}) task=${taskId}`;
    })
  );
}

function formatPendingApprovals(
  approvals: Array<Record<string, unknown>>
): string {
  if (approvals.length === 0) {
    return "No pending approvals.";
  }

  return formatList(
    approvals.map((approval) => {
      const taskId = trimString(approval.taskId) || "unknown-task";
      const requestId = trimString(approval.requestId) || "unknown-request";
      const summary = trimString(approval.summary) || "Pending operator review.";
      return `${taskId} (${requestId}) ${summary}`;
    })
  );
}

function deriveSubmitTitle(description: string): string {
  const collapsed = description.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 72) {
    return collapsed;
  }
  return `${collapsed.slice(0, 69).trimEnd()}...`;
}

function parseSubmitInput(rawArgs: string): {
  repo: string | null;
  description: string;
} {
  const args = rawArgs.trim();
  if (!args) {
    return { repo: null, description: "" };
  }

  const pipeParts = args.split("|").map((part) => part.trim()).filter(Boolean);
  if (pipeParts.length >= 2) {
    return {
      repo: pipeParts[0] ?? null,
      description: pipeParts.slice(1).join(" | ")
    };
  }

  const repoPrefixMatch = /^(?<repo>[\w.-]+\/[\w.-]+)\s*:\s*(?<description>.+)$/u.exec(args);
  if (repoPrefixMatch?.groups) {
    return {
      repo: repoPrefixMatch.groups.repo ?? null,
      description: repoPrefixMatch.groups.description ?? ""
    };
  }

  return { repo: null, description: args };
}

async function resolveSubmitRepo(
  api: OpenClawPluginApi,
  explicitRepo: string | null
): Promise<string> {
  if (explicitRepo) {
    return explicitRepo;
  }

  const repoResponse = await operatorJson<{
    repos?: Array<Record<string, unknown>>;
  }>(api, "/repos");
  const repos = Array.isArray(repoResponse.repos) ? repoResponse.repos : [];
  if (repos.length === 1) {
    return trimString(repos[0]?.repo);
  }

  throw new Error(
    repos.length === 0
      ? "No managed repos are configured yet. Add a repo first or use `/submit owner/repo | description`."
      : "Multiple managed repos are configured. Use `/submit owner/repo | description`."
  );
}

async function resolvePendingApproval(
  api: OpenClawPluginApi,
  taskOrRequestId: string
): Promise<Record<string, unknown>> {
  const byTask = await operatorJson<{
    approvals?: Array<Record<string, unknown>>;
  }>(
    api,
    `/approvals?taskId=${encodeURIComponent(taskOrRequestId)}&statuses=pending&limit=5`
  );
  const byTaskItems = Array.isArray(byTask.approvals) ? byTask.approvals : [];
  if (byTaskItems.length === 1) {
    return byTaskItems[0]!;
  }
  if (byTaskItems.length > 1) {
    throw new Error(
      `Multiple pending approvals were found for ${taskOrRequestId}. Resolve the specific approval request from the operator panel.`
    );
  }

  const direct = await operatorJson<{ approval?: Record<string, unknown> }>(
    api,
    `/approvals/${encodeURIComponent(taskOrRequestId)}`
  ).catch(() => ({ approval: undefined }));
  if (direct.approval && trimString(direct.approval.status) === "pending") {
    return direct.approval;
  }

  throw new Error(`No pending approval was found for ${taskOrRequestId}.`);
}

function resolveDecidedBy(ctx: OperatorCommandContext): string {
  const sender = trimString(ctx.senderId);
  const channel = trimString(ctx.channel) || "webchat";
  return sender ? `openclaw:${channel}:${sender}` : `openclaw:${channel}`;
}

async function handleStatusCommand(
  api: OpenClawPluginApi
): Promise<{ text: string }> {
  const [health, approvals, runs] = await Promise.all([
    operatorJson<Record<string, unknown>>(api, "/health"),
    operatorJson<{ approvals?: Array<Record<string, unknown>> }>(
      api,
      "/approvals?statuses=pending&limit=5"
    ),
    operatorJson<{ runs?: Array<Record<string, unknown>> }>(
      api,
      "/runs?statuses=active&statuses=blocked&limit=5"
    )
  ]);

  const repository = (health.repository as Record<string, unknown> | undefined) ?? {};
  const polling = (health.polling as Record<string, unknown> | undefined) ?? {};
  const dispatcher = (health.dispatcher as Record<string, unknown> | undefined) ?? {};
  const approvalItems = Array.isArray(approvals.approvals) ? approvals.approvals : [];
  const runItems = Array.isArray(runs.runs) ? runs.runs : [];

  return {
    text:
      "RedDwarf status\n" +
      `- repository: ${trimString(repository.status) || "unknown"}\n` +
      `- polling: ${trimString(polling.status) || "unknown"} (${trimString(polling.totalRepositories) || "0"} repos)\n` +
      `- dispatcher: ${trimString(dispatcher.status) || "not-configured"}\n` +
      `- pending approvals: ${approvalItems.length}\n` +
      `- active/blocked runs: ${runItems.length}\n\n` +
      "Pending approvals:\n" +
      formatPendingApprovals(approvalItems) +
      "\n\nRecent active or blocked runs:\n" +
      formatRecentRuns(runItems)
    };
}

async function handleRunsCommand(
  api: OpenClawPluginApi
): Promise<{ text: string }> {
  const runs = await operatorJson<{ runs?: Array<Record<string, unknown>> }>(
    api,
    "/runs?limit=8"
  );
  const items = Array.isArray(runs.runs) ? runs.runs : [];
  return {
    text: "Recent RedDwarf runs\n" + formatRecentRuns(items)
  };
}

async function handleApproveCommand(
  api: OpenClawPluginApi,
  ctx: OperatorCommandContext
): Promise<{ text: string }> {
  const taskId = trimString(ctx.args);
  if (!taskId) {
    return { text: "Usage: /rdapprove <task-id-or-approval-id>" };
  }

  const approval = await resolvePendingApproval(api, taskId);
  const requestId = trimString(approval.requestId);
  const resolved = await operatorJson<{
    approval?: Record<string, unknown>;
  }>(api, `/approvals/${encodeURIComponent(requestId)}/resolve`, {
    method: "POST",
    body: JSON.stringify({
      decision: "approve",
      decidedBy: resolveDecidedBy(ctx),
      decisionSummary: "Approved via OpenClaw operator command."
    })
  });

  return {
    text:
      `Approved ${trimString(resolved.approval?.taskId) || taskId}.\n` +
      `Approval request: ${requestId}`
  };
}

async function handleRejectCommand(
  api: OpenClawPluginApi,
  ctx: OperatorCommandContext
): Promise<{ text: string }> {
  const args = trimString(ctx.args);
  const splitAt = args.indexOf(" ");
  const taskId = splitAt === -1 ? args : args.slice(0, splitAt).trim();
  const reason = splitAt === -1 ? "" : args.slice(splitAt + 1).trim();

  if (!taskId || !reason) {
    return { text: "Usage: /rdreject <task-id-or-approval-id> <reason>" };
  }

  const approval = await resolvePendingApproval(api, taskId);
  const requestId = trimString(approval.requestId);
  const resolved = await operatorJson<{
    approval?: Record<string, unknown>;
  }>(api, `/approvals/${encodeURIComponent(requestId)}/resolve`, {
    method: "POST",
    body: JSON.stringify({
      decision: "reject",
      decidedBy: resolveDecidedBy(ctx),
      decisionSummary: reason,
      comment: reason
    })
  });

  return {
    text:
      `Rejected ${trimString(resolved.approval?.taskId) || taskId}.\n` +
      `Approval request: ${requestId}\n` +
      `Reason: ${reason}`
  };
}

async function handleSubmitCommand(
  api: OpenClawPluginApi,
  ctx: OperatorCommandContext
): Promise<{ text: string }> {
  const parsed = parseSubmitInput(trimString(ctx.args));
  if (!parsed.description) {
    return {
      text:
        "Usage: /submit <description>\n" +
        "When multiple repos are managed, use `/submit owner/repo | description`."
    };
  }

  const repo = await resolveSubmitRepo(api, parsed.repo);
  const payload = {
    repo,
    title: deriveSubmitTitle(parsed.description),
    summary: parsed.description,
    acceptanceCriteria: [DEFAULT_SUBMIT_ACCEPTANCE]
  };
  const response = await operatorJson<{
    runId?: string;
    nextAction?: string;
    manifest?: Record<string, unknown>;
    approvalRequest?: Record<string, unknown>;
  }>(api, "/tasks/inject", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  return {
    text:
      "Submitted RedDwarf task\n" +
      `- repo: ${repo}\n` +
      `- task: ${trimString(response.manifest?.taskId) || "unknown"}\n` +
      `- run: ${trimString(response.runId) || "unknown"}\n` +
      `- next action: ${trimString(response.nextAction) || "unknown"}\n` +
      (response.approvalRequest?.requestId
        ? `- approval request: ${trimString(response.approvalRequest.requestId)}`
        : "- approval request: none")
    };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "RedDwarf Operator Commands",
  description: "WebChat helpers for RedDwarf operator status, approvals, intake, and runs.",
  register(api: OpenClawPluginApi) {
    api.registerCommand({
      name: "rdstatus",
      description:
        "Show RedDwarf pipeline health, pending approvals, and active runs. Alias used because /status is reserved by OpenClaw.",
      handler: async () => handleStatusCommand(api)
    });
    api.registerCommand({
      name: "rdapprove",
      description:
        "Approve a RedDwarf pending approval by task id or approval request id. Alias used because /approve is reserved by OpenClaw.",
      acceptsArgs: true,
      handler: async (ctx) => handleApproveCommand(api, ctx)
    });
    api.registerCommand({
      name: "rdreject",
      description:
        "Reject a RedDwarf pending approval with a reason. Alias used because /reject is reserved by OpenClaw.",
      acceptsArgs: true,
      handler: async (ctx) => handleRejectCommand(api, ctx)
    });
    api.registerCommand({
      name: "submit",
      description:
        "Submit a RedDwarf task from WebChat. Use `/submit description` when one repo is managed, or `/submit owner/repo | description`.",
      acceptsArgs: true,
      handler: async (ctx) => handleSubmitCommand(api, ctx)
    });
    api.registerCommand({
      name: "runs",
      description: "List recent RedDwarf pipeline runs with their status.",
      handler: async () => handleRunsCommand(api)
    });
    api.logger.info?.(
      "reddwarf-operator: registered /rdstatus, /rdapprove, /rdreject, /submit, and /runs"
    );
  }
});
