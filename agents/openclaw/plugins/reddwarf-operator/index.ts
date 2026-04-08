type OperatorCommandContext = {
  channel?: string;
  args?: string;
  senderId?: string;
};

type OperatorPluginConfig = {
  operatorApiBaseUrl?: unknown;
};

type ToolCallHookContext = {
  toolName: string;
  args: Record<string, unknown>;
  sessionKey: string;
};

type ToolCallHookResult =
  | { allow: true }
  | { deny: true; reason: string };

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
  /** Register a hook that fires before every tool call in this session. Available from OpenClaw v2026.3.28+. */
  registerHook?: (
    event: "before_tool_call",
    handler: (ctx: ToolCallHookContext) => Promise<ToolCallHookResult>
  ) => void;
};

const PLUGIN_ID = "reddwarf-operator";

// ── File write tool names and argument key resolution ─────────────────────────

const FILE_WRITE_TOOLS = new Set(["write", "edit", "create", "patch", "replace"]);
const SENSITIVE_TOOLS = new Set(["bash", "shell", "run", "exec"]);

/**
 * Heuristically extract the file path from a tool call's args.
 * Returns null if the tool does not appear to touch a specific file.
 */
function extractTargetPath(toolName: string, args: Record<string, unknown>): string | null {
  const lower = toolName.toLowerCase();
  if (FILE_WRITE_TOOLS.has(lower)) {
    const path = args["path"] ?? args["file_path"] ?? args["filename"] ?? args["target"];
    return typeof path === "string" ? path : null;
  }
  if (SENSITIVE_TOOLS.has(lower)) {
    // Check for shell redirections that suggest file writes
    const command = args["command"] ?? args["cmd"] ?? args["input"];
    if (typeof command === "string" && /[>|]/.test(command)) {
      return null; // Flag as sensitive but no specific path
    }
    return null;
  }
  return null;
}

/**
 * Returns true if the candidate path matches any of the glob-style denied paths.
 * Supports simple prefix matching and exact matching. The deny check uses the
 * resolved list of denied paths from the policy snapshot.
 */
function matchesDeniedPath(filePath: string, deniedPaths: string[]): boolean {
  for (const denied of deniedPaths) {
    const pattern = denied.replace(/\/\*\*$/, "").replace(/\/$/, "");
    if (filePath === denied || filePath.startsWith(`${pattern}/`) || filePath === pattern) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true if the candidate path is within the allowedPaths list.
 * Allowed paths are guidance, not strict blocklist — a match confirms it is safe.
 */
function matchesAllowedPath(filePath: string, allowedPaths: string[]): boolean {
  for (const allowed of allowedPaths) {
    const pattern = allowed.replace(/\/\*\*$/, "").replace(/\/$/, "");
    if (
      filePath === allowed ||
      filePath.startsWith(`${pattern}/`) ||
      filePath === pattern ||
      filePath.endsWith(`/${allowed}`)
    ) {
      return true;
    }
  }
  return false;
}

// ── Per-session policy snapshot cache ────────────────────────────────────────

interface CachedPolicy {
  taskId: string | null;
  allowedPaths: string[];
  deniedPaths: string[];
  fetchedAt: number;
}

const policyCache = new Map<string, CachedPolicy>();
const POLICY_CACHE_TTL_MS = 60_000;

const POLICY_FETCH_MAX_RETRIES = 3;
const POLICY_FETCH_RETRY_DELAY_MS = 500;

async function getOrFetchPolicy(
  api: OpenClawPluginApi,
  sessionKey: string
): Promise<CachedPolicy | null> {
  const cached = policyCache.get(sessionKey);
  if (cached && Date.now() - cached.fetchedAt < POLICY_CACHE_TTL_MS) {
    return cached;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < POLICY_FETCH_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, POLICY_FETCH_RETRY_DELAY_MS * attempt)
      );
    }
    try {
      const response = await operatorJson<{
        taskId?: string | null;
        policySnapshot?: {
          allowedPaths?: string[];
          deniedPaths?: string[];
        } | null;
      }>(api, `/sessions/policy?sessionKey=${encodeURIComponent(sessionKey)}`);

      const policy: CachedPolicy = {
        taskId: response.taskId ?? null,
        allowedPaths: response.policySnapshot?.allowedPaths ?? [],
        deniedPaths: response.policySnapshot?.deniedPaths ?? [],
        fetchedAt: Date.now()
      };
      policyCache.set(sessionKey, policy);
      return policy;
    } catch (err) {
      lastError = err;
    }
  }

  // Fail-closed: policy lookup failed after retries — return null so the caller
  // can deny the tool call rather than silently permitting everything.
  api.logger.warn?.(
    `reddwarf-operator: policy lookup failed for session ${sessionKey} after ${POLICY_FETCH_MAX_RETRIES} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
  return null;
}

async function requestToolApproval(
  api: OpenClawPluginApi,
  sessionKey: string,
  taskId: string | null,
  toolName: string,
  targetPath: string | null,
  reason: string,
  timeoutMs: number
): Promise<"approved" | "denied"> {
  let approvalId: string | null = null;
  try {
    const created = await operatorJson<{ toolApproval?: { id?: string } }>(
      api,
      "/tool-approvals",
      {
        method: "POST",
        body: JSON.stringify({ sessionKey, taskId, toolName, targetPath, reason })
      }
    );
    approvalId = created.toolApproval?.id ?? null;
  } catch {
    // If we can't create an approval request, default to deny for safety
    return "denied";
  }

  if (!approvalId) {
    return "denied";
  }

  // Poll for a decision using the single-item endpoint with exponential
  // backoff and jitter to avoid polling storms under concurrent approvals.
  const deadline = Date.now() + timeoutMs;
  const INITIAL_DELAY_MS = 1000;
  const MAX_DELAY_MS = 8000;
  let delay = INITIAL_DELAY_MS;

  while (Date.now() < deadline) {
    // Jitter: randomize up to ±25% of the current delay
    const jitter = delay * (0.75 + Math.random() * 0.5);
    await new Promise<void>((resolve) => setTimeout(resolve, jitter));
    try {
      const detail = await operatorJson<{
        toolApproval?: { id: string; status: string };
      }>(api, `/tool-approvals/${encodeURIComponent(approvalId)}`);
      const status = detail.toolApproval?.status;
      if (status === "approved") {
        return "approved";
      }
      if (status === "denied") {
        return "denied";
      }
      // status === "pending" → keep polling
    } catch {
      // polling error — continue
    }
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  }

  return "denied"; // timeout → deny
}

async function handleBeforeToolCall(
  api: OpenClawPluginApi,
  ctx: ToolCallHookContext
): Promise<ToolCallHookResult> {
  const { toolName, args, sessionKey } = ctx;
  const targetPath = extractTargetPath(toolName, args);

  // Non-file and non-sensitive ops pass through immediately
  if (!FILE_WRITE_TOOLS.has(toolName.toLowerCase()) && !SENSITIVE_TOOLS.has(toolName.toLowerCase())) {
    return { allow: true };
  }

  // Fetch cached policy snapshot (fast path — cache hit is < 1ms)
  const policy = await getOrFetchPolicy(api, sessionKey);

  // Fail-closed: if policy could not be fetched, deny the tool call
  if (policy === null) {
    return {
      deny: true,
      reason: "Policy lookup failed — tool call denied for safety. The RedDwarf operator API may be unreachable."
    };
  }

  // Hard deny if path matches a denied path
  if (targetPath && matchesDeniedPath(targetPath, policy.deniedPaths)) {
    api.logger.warn?.(
      `reddwarf-operator: blocked ${toolName} on denied path ${targetPath} for session ${sessionKey}`
    );
    return {
      deny: true,
      reason: `This path (${targetPath}) is blocked by the task policy. Consult the RedDwarf operator dashboard for allowed paths.`
    };
  }

  // Auto-approve if path is within allowed paths
  if (targetPath && matchesAllowedPath(targetPath, policy.allowedPaths)) {
    return { allow: true };
  }

  // Sensitive shell commands with redirections → route for approval
  if (SENSITIVE_TOOLS.has(toolName.toLowerCase())) {
    const command = args["command"] ?? args["cmd"];
    if (typeof command === "string" && /[>]/.test(command)) {
      const decision = await requestToolApproval(
        api,
        sessionKey,
        policy.taskId,
        toolName,
        null,
        `Shell command with file redirect: ${command.slice(0, 120)}`,
        120_000
      );
      return decision === "approved" ? { allow: true } : { deny: true, reason: "Operator denied this shell redirect." };
    }
    return { allow: true }; // non-redirect shell ops pass through
  }

  // File write to an unlisted path — route for explicit approval
  if (targetPath) {
    const decision = await requestToolApproval(
      api,
      sessionKey,
      policy.taskId,
      toolName,
      targetPath,
      `File write to path not in task allowed-path list: ${targetPath}`,
      120_000
    );
    return decision === "approved"
      ? { allow: true }
      : { deny: true, reason: `Operator denied write to ${targetPath}. Use an approved path or request a scope amendment.` };
  }

  return { allow: true };
}
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

// ── /rdhelp ─────────────────────────────────────────────────────────────────

const COMMAND_HELP: Array<{ name: string; usage: string; description: string }> = [
  {
    name: "rdhelp",
    usage: "/rdhelp",
    description: "Show this help message listing all available RedDwarf commands."
  },
  {
    name: "rdstatus",
    usage: "/rdstatus",
    description: "Show pipeline health, pending approvals, and active runs."
  },
  {
    name: "rdapprove",
    usage: "/rdapprove <task-id-or-approval-id>",
    description: "Approve a pending pipeline approval."
  },
  {
    name: "rdreject",
    usage: "/rdreject <task-id-or-approval-id> <reason>",
    description: "Reject a pending pipeline approval with a reason."
  },
  {
    name: "submit",
    usage: "/submit <description>  or  /submit owner/repo | description",
    description: "Submit a new RedDwarf task. If only one repo is managed the repo is inferred."
  },
  {
    name: "runs",
    usage: "/runs",
    description: "List recent pipeline runs with their status."
  },
  {
    name: "rdclarify",
    usage: "/rdclarify <project-id>  or  /rdclarify <project-id> | answer1 | answer2 | ...",
    description:
      "View pending clarification questions for a project, or submit answers. " +
      "When called without answers, shows Holly's questions. " +
      "When called with pipe-separated answers, submits them and triggers re-planning."
  }
];

function handleHelpCommand(): { text: string } {
  const lines = COMMAND_HELP.map(
    (cmd) => `**/${cmd.name}**\n  ${cmd.usage}\n  ${cmd.description}`
  );
  return {
    text: "RedDwarf commands\n\n" + lines.join("\n\n")
  };
}

// ── /rdclarify ──────────────────────────────────────────────────────────────

function parseClarifyInput(rawArgs: string): {
  projectId: string;
  answers: string[];
} {
  const args = rawArgs.trim();
  if (!args) {
    return { projectId: "", answers: [] };
  }

  const parts = args.split("|").map((part) => part.trim()).filter(Boolean);
  return {
    projectId: parts[0] ?? "",
    answers: parts.slice(1)
  };
}

function formatClarificationQuestions(
  projectId: string,
  status: string,
  questions: string[],
  answers: Record<string, string> | null,
  timedOut: boolean
): string {
  if (status !== "clarification_pending") {
    return `Project ${projectId} is in status '${status}' — no clarification pending.`;
  }

  if (timedOut) {
    return `Project ${projectId} clarification has timed out. Re-submit the task or extend the timeout.`;
  }

  if (questions.length === 0) {
    return `Project ${projectId} is pending clarification but has no questions listed.`;
  }

  const header = `Holly needs clarification on project ${projectId}:\n`;
  const numbered = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  const hint =
    "\n\nTo answer, use:\n" +
    `/rdclarify ${projectId} | <answer 1> | <answer 2> | ...`;

  if (answers && Object.keys(answers).length > 0) {
    const prev = Object.entries(answers)
      .map(([key, val]) => `- ${key}: ${val}`)
      .join("\n");
    return header + numbered + `\n\nPrevious answers:\n${prev}` + hint;
  }

  return header + numbered + hint;
}

async function handleClarifyCommand(
  api: OpenClawPluginApi,
  ctx: OperatorCommandContext
): Promise<{ text: string }> {
  const parsed = parseClarifyInput(trimString(ctx.args));
  if (!parsed.projectId) {
    return {
      text:
        "Usage:\n" +
        "  /rdclarify <project-id> — view pending questions\n" +
        "  /rdclarify <project-id> | answer1 | answer2 | ... — submit answers"
    };
  }

  // Normalise: the API expects the full project:<taskId> form, but operators
  // often copy just the task id from /rdstatus output.
  const projectId = parsed.projectId.startsWith("project:")
    ? parsed.projectId
    : `project:${parsed.projectId}`;

  // Fetch current clarification state
  const clarifications = await operatorJson<{
    projectId: string;
    status: string;
    questions: string[];
    answers: Record<string, string> | null;
    timedOut: boolean;
  }>(api, `/projects/${encodeURIComponent(projectId)}/clarifications`);

  // View mode — no answers provided
  if (parsed.answers.length === 0) {
    return {
      text: formatClarificationQuestions(
        projectId,
        clarifications.status,
        clarifications.questions,
        clarifications.answers,
        clarifications.timedOut
      )
    };
  }

  // Submit mode — answers provided
  if (clarifications.status !== "clarification_pending") {
    return {
      text: `Project ${projectId} is in status '${clarifications.status}' — cannot submit answers unless status is 'clarification_pending'.`
    };
  }

  const questions = clarifications.questions;
  if (parsed.answers.length !== questions.length) {
    return {
      text:
        `Expected ${questions.length} answer(s) but received ${parsed.answers.length}.\n\n` +
        "Questions:\n" +
        questions.map((q, i) => `${i + 1}. ${q}`).join("\n") +
        "\n\nProvide one answer per question separated by |."
    };
  }

  // Build answers keyed by question text (matches the operator API contract)
  const answersRecord: Record<string, string> = {};
  for (let i = 0; i < questions.length; i++) {
    answersRecord[questions[i]!] = parsed.answers[i]!;
  }

  const result = await operatorJson<{
    project?: Record<string, unknown>;
    replanRunId?: string;
    replanError?: string;
    message?: string;
  }>(api, `/projects/${encodeURIComponent(projectId)}/clarify`, {
    method: "POST",
    body: JSON.stringify({ answers: answersRecord })
  });

  const status = trimString(result.project?.status) || "unknown";
  let text =
    `Clarification answers submitted for ${projectId}.\n` +
    `- project status: ${status}\n`;

  if (result.replanRunId) {
    text += `- re-planning run: ${result.replanRunId}\n`;
  }
  if (result.replanError) {
    text += `- re-planning error: ${result.replanError}\n`;
  }
  if (result.message) {
    text += `\n${result.message}`;
  }
  return { text };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "RedDwarf Operator Commands",
  description: "WebChat helpers for RedDwarf operator status, approvals, intake, and runs.",
  register(api: OpenClawPluginApi) {
    api.registerCommand({
      name: "rdhelp",
      description: "List all available RedDwarf operator commands with usage and descriptions.",
      handler: async () => handleHelpCommand()
    });
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
    api.registerCommand({
      name: "rdclarify",
      description:
        "View or answer Holly's clarification questions for a project. " +
        "Use `/rdclarify <project-id>` to view, or `/rdclarify <project-id> | answer1 | answer2` to submit.",
      acceptsArgs: true,
      handler: async (ctx) => handleClarifyCommand(api, ctx)
    });
    // Feature 152: register before_tool_call hook for agent-side safety rails.
    // Gate behind REDDWARF_PLUGIN_APPROVAL_HOOK_ENABLED so existing deployments
    // are unaffected unless opted in.
    if (process.env["REDDWARF_PLUGIN_APPROVAL_HOOK_ENABLED"] === "true") {
      if (api.registerHook) {
        api.registerHook("before_tool_call", (ctx) => handleBeforeToolCall(api, ctx));
        api.logger.info?.(
          "reddwarf-operator: registered before_tool_call approval hook"
        );
      } else {
        api.logger.warn?.(
          "reddwarf-operator: REDDWARF_PLUGIN_APPROVAL_HOOK_ENABLED is set but this OpenClaw version does not support before_tool_call hooks (requires >= v2026.3.28)"
        );
      }
    }

    api.logger.info?.(
      "reddwarf-operator: registered /rdhelp, /rdstatus, /rdapprove, /rdreject, /submit, /runs, and /rdclarify"
    );
  }
});
