import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GitHubAdapter, GitHubIssueCandidate } from "@reddwarf/integrations";
import type { GitHubIssuesAdapter, OpenClawTaskFlowAdapter } from "@reddwarf/integrations";
import type { PlanningAgent, PlanningTaskInput } from "@reddwarf/contracts";
import type { PlanningRepository } from "@reddwarf/evidence";
import { runPlanningPipeline } from "./pipeline.js";
import { advanceProjectTicket } from "./pipeline/project-approval.js";
import { classifyComplexity } from "./rimmer/index.js";
import type { PlanningPipelineLogger } from "./logger.js";
import { bindPlanningLogger } from "./logger.js";
import type { OpenClawDispatchAdapter } from "@reddwarf/integrations";

// ============================================================
// Poll mode configuration
// ============================================================

export type PollMode = "auto" | "always" | "never";

export function resolvePollMode(): PollMode {
  const raw = (process.env.REDDWARF_POLL_MODE ?? "auto").trim().toLowerCase();
  if (raw === "always" || raw === "never") {
    return raw;
  }
  return "auto";
}

/**
 * Returns `true` when the polling daemon should be started, based on the
 * resolved poll mode and whether a webhook secret is configured.
 */
export function shouldStartPolling(pollMode: PollMode, webhookSecretSet: boolean): boolean {
  if (pollMode === "never") {
    return false;
  }
  if (pollMode === "always") {
    return true;
  }
  // auto: poll when webhooks are not configured
  return !webhookSecretSet;
}

/**
 * Human-readable description of the active intake mode for log messages and
 * health endpoint reporting.
 */
export function describeIntakeMode(pollMode: PollMode, webhookSecretSet: boolean): string {
  if (pollMode === "always") {
    return webhookSecretSet ? "webhook+polling" : "polling";
  }
  if (pollMode === "never") {
    return webhookSecretSet ? "webhook" : "disabled";
  }
  // auto
  return webhookSecretSet ? "webhook" : "polling";
}

// ============================================================
// HMAC verification
// ============================================================

/**
 * Read the raw request body as a Buffer. Must be called before any JSON
 * parsing so the HMAC can be computed over the exact bytes GitHub sent.
 */
export function readRawBody(
  req: IncomingMessage,
  maxBytes: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let tooLarge = false;

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (tooLarge) {
        reject(new Error(`Request body exceeds ${maxBytes} bytes.`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    req.on("error", reject);
  });
}

/**
 * Verify GitHub's HMAC-SHA256 signature over the raw body.
 *
 * Returns `true` when the signature is valid; `false` otherwise. Uses
 * `crypto.timingSafeEqual` to prevent timing-based attacks.
 */
export function verifyGitHubSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const expectedHex = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  const expected = `sha256=${expectedHex}`;

  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.from(signatureHeader);

  if (expectedBuf.length !== receivedBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, receivedBuf);
}

// ============================================================
// GitHub webhook issue payload → GitHubIssueCandidate
// ============================================================

interface GitHubWebhookIssuePayload {
  action: string;
  issue: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    state: string;
    user?: { login: string } | null;
    labels?: Array<{ name: string }>;
    updated_at?: string;
  };
  repository: {
    full_name: string;
    default_branch?: string;
  };
}

function isIssuePayload(body: unknown): body is GitHubWebhookIssuePayload {
  if (typeof body !== "object" || body === null) {
    return false;
  }
  const obj = body as Record<string, unknown>;
  return (
    typeof obj.action === "string" &&
    typeof obj.issue === "object" &&
    obj.issue !== null &&
    typeof obj.repository === "object" &&
    obj.repository !== null
  );
}

function webhookIssueToCandidate(payload: GitHubWebhookIssuePayload): GitHubIssueCandidate {
  const issue = payload.issue;
  const author = issue.user?.login;
  const updatedAt = issue.updated_at;
  const baseBranch = payload.repository.default_branch;
  return {
    repo: payload.repository.full_name,
    issueNumber: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    labels: (issue.labels ?? []).map((l) => l.name),
    url: issue.html_url,
    state: issue.state === "open" ? "open" : "closed",
    ...(author !== undefined ? { author } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(baseBranch !== undefined ? { baseBranch } : {})
  };
}

// ============================================================
// GitHub webhook pull_request payload → ticket advance
// ============================================================

interface GitHubWebhookPullRequestPayload {
  action: string;
  pull_request: {
    number: number;
    merged: boolean;
    head: { ref: string };
    body: string | null;
    html_url: string;
  };
  repository: {
    full_name: string;
  };
}

function isPullRequestPayload(body: unknown): body is GitHubWebhookPullRequestPayload {
  if (typeof body !== "object" || body === null) {
    return false;
  }
  const obj = body as Record<string, unknown>;
  return (
    typeof obj.action === "string" &&
    typeof obj.pull_request === "object" &&
    obj.pull_request !== null &&
    typeof obj.repository === "object" &&
    obj.repository !== null
  );
}

const BRANCH_TICKET_RE = /^reddwarf\/ticket\/(.+)$/;
const BODY_TICKET_RE = /<!-- reddwarf:ticket_id:(\S+) -->/;

/**
 * Extract ticket_id from a PR branch name (`reddwarf/ticket/{id}`) or PR body
 * (`<!-- reddwarf:ticket_id:VALUE -->`). Returns `null` if no ticket reference
 * is found.
 */
export function extractTicketId(branchName: string, prBody: string | null): string | null {
  const branchMatch = BRANCH_TICKET_RE.exec(branchName);
  const branchId = branchMatch?.[1];
  if (branchId && /^[a-zA-Z0-9._:/-]+$/.test(branchId)) {
    return branchId;
  }
  if (prBody) {
    const bodyMatch = BODY_TICKET_RE.exec(prBody);
    const bodyId = bodyMatch?.[1];
    if (bodyId && /^[a-zA-Z0-9._:/-]+$/.test(bodyId)) {
      return bodyId;
    }
  }
  return null;
}

// ============================================================
// Webhook handler
// ============================================================

export interface WebhookHandlerDependencies {
  repository: PlanningRepository;
  github: GitHubAdapter;
  planner: PlanningAgent;
  logger?: PlanningPipelineLogger;
  clock?: () => Date;
  openClawDispatch?: OpenClawDispatchAdapter;
  architectTargetRoot?: string;
  dryRun?: boolean;
  /** When provided, enables sub-issue close on ticket advance via webhook. */
  githubIssuesAdapter?: GitHubIssuesAdapter | null;
  /** When provided, enables Task Flow advance on ticket advance via webhook. */
  taskFlowAdapter?: OpenClawTaskFlowAdapter | null;
  /**
   * M25 F-193: invoked when a check_run / check_suite / status delivery
   * for a known RedDwarf-authored PR has been persisted. Implementations
   * (typically the F-194 evaluator) debounce by `(ticketId, headSha)` and
   * decide whether to merge, wait, or block. Failures are logged but not
   * re-raised — the webhook still 202s so GitHub doesn't retry forever.
   */
  autoMergeEvaluator?: AutoMergeEvaluatorTrigger | null;
}

/**
 * M25 F-193 — narrow trigger interface that F-194's evaluator implements.
 * Decoupling the webhook receiver from the evaluator lets each be tested
 * in isolation and avoids a circular module dependency.
 */
export interface AutoMergeEvaluatorTrigger {
  enqueueEvaluation(input: { ticketId: string; headSha: string; prNumber: number }): void;
}

export interface WebhookHandlerResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Handle a single GitHub webhook delivery. This is the core logic extracted
 * from the HTTP layer so it can be tested independently.
 *
 * The function reads the raw body, verifies the HMAC signature, parses the
 * event, and — for `issues` / `opened` events — feeds the issue into the
 * same intake pipeline the poller uses.
 */
export async function handleGitHubWebhook(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  eventType: string | undefined,
  secret: string,
  deps: WebhookHandlerDependencies
): Promise<WebhookHandlerResult> {
  const logger = deps.logger
    ? bindPlanningLogger(deps.logger, { component: "github-webhook" })
    : undefined;

  // Step 1: HMAC verification
  if (!verifyGitHubSignature(rawBody, signatureHeader, secret)) {
    logger?.warn("Webhook signature verification failed.", {
      code: "WEBHOOK_SIGNATURE_INVALID",
      eventType: eventType ?? "unknown"
    });
    return {
      status: 401,
      body: { error: "unauthorized", message: "Invalid webhook signature." }
    };
  }

  // Step 2: Handle ping
  if (eventType === "ping") {
    logger?.info("GitHub webhook ping received.", {
      code: "WEBHOOK_PING"
    });
    return { status: 200, body: { event: "ping", message: "pong" } };
  }

  // Step 3: Route by event type. M25 F-193 adds check_run, check_suite, status.
  const handledEventTypes = new Set([
    "issues",
    "pull_request",
    "check_run",
    "check_suite",
    "status"
  ]);
  if (!eventType || !handledEventTypes.has(eventType)) {
    logger?.info("Ignoring unhandled webhook event.", {
      code: "WEBHOOK_EVENT_IGNORED",
      eventType: eventType ?? "unknown"
    });
    return {
      status: 200,
      body: { event: eventType ?? "unknown", message: "Event type ignored." }
    };
  }

  // Step 4: Parse payload
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf-8"));
  } catch {
    return {
      status: 400,
      body: { error: "bad_request", message: "Invalid JSON body." }
    };
  }

  // Step 5: Route to event-specific handler
  if (eventType === "pull_request") {
    return handlePullRequestEvent(payload, deps, logger);
  }
  if (eventType === "check_run") {
    return handleCheckRunEvent(payload, deps, logger);
  }
  if (eventType === "check_suite") {
    return handleCheckSuiteEvent(payload, deps, logger);
  }
  if (eventType === "status") {
    return handleStatusEvent(payload, deps, logger);
  }

  return handleIssuesEvent(payload, deps, logger);
}

// ============================================================
// M25 F-193 — CI check ingestion (check_run / check_suite / status)
// ============================================================

interface CheckRunPayload {
  action: string;
  check_run: {
    name: string;
    status: string;
    conclusion: string | null;
    completed_at: string | null;
    head_sha: string;
    pull_requests?: Array<{ number: number }>;
  };
  repository: { full_name: string };
}

interface CheckSuitePayload {
  action: string;
  check_suite: {
    head_sha: string;
    status: string;
    conclusion: string | null;
    updated_at: string | null;
    pull_requests?: Array<{ number: number }>;
    app?: { name?: string } | null;
  };
  repository: { full_name: string };
}

interface StatusPayload {
  state: string;
  sha: string;
  context: string;
  updated_at: string | null;
  branches?: Array<{ name: string }>;
  repository: { full_name: string };
}

function isCheckRunPayload(value: unknown): value is CheckRunPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.action === "string" &&
    typeof v.check_run === "object" &&
    v.check_run !== null &&
    typeof v.repository === "object" &&
    v.repository !== null
  );
}

function isCheckSuitePayload(value: unknown): value is CheckSuitePayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.action === "string" &&
    typeof v.check_suite === "object" &&
    v.check_suite !== null &&
    typeof v.repository === "object" &&
    v.repository !== null
  );
}

function isStatusPayload(value: unknown): value is StatusPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.state === "string" &&
    typeof v.sha === "string" &&
    typeof v.context === "string" &&
    typeof v.repository === "object" &&
    v.repository !== null
  );
}

/**
 * Resolve a webhook event's PR + ticket. Returns null when the event has
 * no associated open RedDwarf-authored PR (which is the common case — most
 * checks fire on PRs we did not create).
 */
async function resolveTicketForCheck(input: {
  repo: string;
  headSha: string;
  prNumberCandidates: number[];
  github: GitHubAdapter;
  repository: PlanningRepository;
}): Promise<{ ticketId: string; prNumber: number } | null> {
  // GitHub frequently includes pull_requests on the payload; try those
  // first to avoid a roundtrip. The fallback path needs an adapter that
  // can resolve PR by SHA, which the current GitHubAdapter does not
  // expose — so when no candidates are present we give up cleanly.
  const candidates = input.prNumberCandidates;
  if (candidates.length === 0) {
    return null;
  }

  for (const prNumber of candidates) {
    // Fetch every ticket whose github_pr_number matches. We don't have a
    // reverse-lookup index, so list tickets across all known projects and
    // filter. In practice the table is small (one entry per PR) and the
    // evaluator runs at webhook cadence, not request cadence.
    const projects = await input.repository.listProjectSpecs();
    for (const project of projects) {
      const tickets = await input.repository.listTicketSpecs(project.projectId);
      const match = tickets.find((t) => t.githubPrNumber === prNumber);
      if (match) {
        return { ticketId: match.ticketId, prNumber };
      }
    }
  }
  return null;
}

async function handleCheckRunEvent(
  payload: unknown,
  deps: WebhookHandlerDependencies,
  logger?: ReturnType<typeof bindPlanningLogger>
): Promise<WebhookHandlerResult> {
  if (!isCheckRunPayload(payload)) {
    return {
      status: 400,
      body: { error: "bad_request", message: "Malformed check_run webhook payload." }
    };
  }
  if (payload.action !== "completed") {
    return {
      status: 200,
      body: { event: "check_run", action: payload.action, message: "Only completed actions are processed." }
    };
  }
  const conclusion = payload.check_run.conclusion;
  if (!conclusion) {
    return {
      status: 200,
      body: { event: "check_run", message: "check_run has no conclusion yet." }
    };
  }
  const repo = payload.repository.full_name;
  const headSha = payload.check_run.head_sha;
  const prCandidates = (payload.check_run.pull_requests ?? []).map((p) => p.number);
  const resolved = await resolveTicketForCheck({
    repo,
    headSha,
    prNumberCandidates: prCandidates,
    github: deps.github,
    repository: deps.repository
  });
  if (!resolved) {
    logger?.info("check_run does not match a RedDwarf-authored ticket; ignoring.", {
      code: "WEBHOOK_CHECK_RUN_NO_TICKET",
      repo,
      headSha
    });
    return {
      status: 200,
      body: { event: "check_run", message: "No matching RedDwarf ticket; ignored." }
    };
  }

  await deps.repository.saveCiCheckObservation({
    ticketId: resolved.ticketId,
    prNumber: resolved.prNumber,
    headSha,
    source: "check_run",
    checkName: payload.check_run.name,
    conclusion,
    completedAt:
      payload.check_run.completed_at ?? new Date().toISOString()
  });

  deps.autoMergeEvaluator?.enqueueEvaluation({
    ticketId: resolved.ticketId,
    headSha,
    prNumber: resolved.prNumber
  });

  return {
    status: 202,
    body: {
      event: "check_run",
      ticketId: resolved.ticketId,
      checkName: payload.check_run.name,
      conclusion,
      message: "Observation persisted; evaluator notified."
    }
  };
}

async function handleCheckSuiteEvent(
  payload: unknown,
  deps: WebhookHandlerDependencies,
  logger?: ReturnType<typeof bindPlanningLogger>
): Promise<WebhookHandlerResult> {
  if (!isCheckSuitePayload(payload)) {
    return {
      status: 400,
      body: { error: "bad_request", message: "Malformed check_suite webhook payload." }
    };
  }
  if (payload.action !== "completed") {
    return {
      status: 200,
      body: { event: "check_suite", action: payload.action, message: "Only completed actions are processed." }
    };
  }
  const conclusion = payload.check_suite.conclusion;
  if (!conclusion) {
    return {
      status: 200,
      body: { event: "check_suite", message: "check_suite has no conclusion yet." }
    };
  }
  const repo = payload.repository.full_name;
  const headSha = payload.check_suite.head_sha;
  const prCandidates = (payload.check_suite.pull_requests ?? []).map((p) => p.number);
  const resolved = await resolveTicketForCheck({
    repo,
    headSha,
    prNumberCandidates: prCandidates,
    github: deps.github,
    repository: deps.repository
  });
  if (!resolved) {
    logger?.info("check_suite does not match a RedDwarf-authored ticket; ignoring.", {
      code: "WEBHOOK_CHECK_SUITE_NO_TICKET",
      repo,
      headSha
    });
    return {
      status: 200,
      body: { event: "check_suite", message: "No matching RedDwarf ticket; ignored." }
    };
  }

  // Use the app/integration name as the synthetic check name when no
  // per-run name is available. The evaluator dedupes by source.
  const checkName = payload.check_suite.app?.name ?? "check_suite";
  await deps.repository.saveCiCheckObservation({
    ticketId: resolved.ticketId,
    prNumber: resolved.prNumber,
    headSha,
    source: "check_suite",
    checkName,
    conclusion,
    completedAt: payload.check_suite.updated_at ?? new Date().toISOString()
  });

  deps.autoMergeEvaluator?.enqueueEvaluation({
    ticketId: resolved.ticketId,
    headSha,
    prNumber: resolved.prNumber
  });

  return {
    status: 202,
    body: {
      event: "check_suite",
      ticketId: resolved.ticketId,
      conclusion,
      message: "Observation persisted; evaluator notified."
    }
  };
}

async function handleStatusEvent(
  payload: unknown,
  deps: WebhookHandlerDependencies,
  logger?: ReturnType<typeof bindPlanningLogger>
): Promise<WebhookHandlerResult> {
  if (!isStatusPayload(payload)) {
    return {
      status: 400,
      body: { error: "bad_request", message: "Malformed status webhook payload." }
    };
  }
  if (payload.state === "pending") {
    return {
      status: 200,
      body: { event: "status", message: "Pending status; waiting for terminal state." }
    };
  }
  // status payloads do not include pull_requests; the evaluator can resolve
  // by SHA via repository lookup. For now we only act when the head SHA
  // matches a ticket whose githubPrNumber is set; we don't know the PR
  // number without an extra API call, so we ignore here and rely on the
  // matching check_run/check_suite event for the same SHA. We still
  // persist an observation so the audit trail is complete.
  const repo = payload.repository.full_name;
  const projects = await deps.repository.listProjectSpecs(repo);
  for (const project of projects) {
    const tickets = await deps.repository.listTicketSpecs(project.projectId);
    for (const ticket of tickets) {
      if (ticket.githubPrNumber === null) continue;
      // Persist when the ticket has any PR open; the evaluator's gate-6
      // check (head_sha matches latest observation set) handles SHA drift.
      await deps.repository.saveCiCheckObservation({
        ticketId: ticket.ticketId,
        prNumber: ticket.githubPrNumber,
        headSha: payload.sha,
        source: "status",
        checkName: payload.context,
        conclusion: payload.state,
        completedAt: payload.updated_at ?? new Date().toISOString()
      });
      deps.autoMergeEvaluator?.enqueueEvaluation({
        ticketId: ticket.ticketId,
        headSha: payload.sha,
        prNumber: ticket.githubPrNumber
      });
    }
  }

  logger?.info("status event recorded.", {
    code: "WEBHOOK_STATUS_RECORDED",
    repo,
    sha: payload.sha,
    state: payload.state
  });
  return {
    status: 202,
    body: { event: "status", state: payload.state, message: "Status observations persisted." }
  };
}

// ============================================================
// M25 F-193 — debouncer used by the F-194 evaluator
// ============================================================

/**
 * In-process debouncer for auto-merge evaluations. Multiple webhook
 * deliveries on the same `(ticket, headSha)` collapse into one evaluation
 * after `windowMs` of quiet. Construction is decoupled from the webhook
 * handler so tests can drive the underlying timer manually.
 */
export class AutoMergeEvaluatorDebouncer implements AutoMergeEvaluatorTrigger {
  private readonly pending = new Map<
    string,
    { timeout: ReturnType<typeof setTimeout>; ticketId: string; headSha: string; prNumber: number }
  >();

  constructor(
    private readonly run: (input: {
      ticketId: string;
      headSha: string;
      prNumber: number;
    }) => Promise<void>,
    private readonly windowMs = 1000
  ) {}

  enqueueEvaluation(input: { ticketId: string; headSha: string; prNumber: number }): void {
    const key = `${input.ticketId}::${input.headSha}`;
    const existing = this.pending.get(key);
    if (existing) {
      clearTimeout(existing.timeout);
    }
    const timeout = setTimeout(() => {
      this.pending.delete(key);
      void this.run({ ...input }).catch(() => {
        // Swallow — the evaluator is responsible for its own logging.
        // We never want a failed evaluation to crash the webhook server.
      });
    }, this.windowMs);
    this.pending.set(key, {
      timeout,
      ticketId: input.ticketId,
      headSha: input.headSha,
      prNumber: input.prNumber
    });
  }

  /** Test helper: run all pending timers immediately and clear them. */
  async flushPending(): Promise<void> {
    const entries = Array.from(this.pending.values());
    for (const entry of entries) {
      clearTimeout(entry.timeout);
    }
    this.pending.clear();
    for (const entry of entries) {
      await this.run({
        ticketId: entry.ticketId,
        headSha: entry.headSha,
        prNumber: entry.prNumber
      });
    }
  }

  /** Test helper: how many distinct (ticket, sha) pairs are currently waiting. */
  pendingCount(): number {
    return this.pending.size;
  }
}

// ============================================================
// pull_request event handler — ticket advance on PR merge
// ============================================================

async function handlePullRequestEvent(
  payload: unknown,
  deps: WebhookHandlerDependencies,
  logger?: ReturnType<typeof bindPlanningLogger>
): Promise<WebhookHandlerResult> {
  if (!isPullRequestPayload(payload)) {
    return {
      status: 400,
      body: { error: "bad_request", message: "Malformed pull_request webhook payload." }
    };
  }

  const pr = payload.pull_request;
  const repo = payload.repository.full_name;

  // Only process closed + merged PRs
  if (payload.action !== "closed" || !pr.merged) {
    logger?.info("Ignoring non-merged pull_request event.", {
      code: "WEBHOOK_PR_ACTION_IGNORED",
      action: payload.action,
      merged: pr.merged,
      repo,
      prNumber: pr.number
    });
    return {
      status: 200,
      body: {
        event: "pull_request",
        action: payload.action,
        repo,
        prNumber: pr.number,
        message: "Only closed+merged pull requests are processed."
      }
    };
  }

  // Extract ticket_id from branch name or PR body
  const ticketId = extractTicketId(pr.head.ref, pr.body);

  if (!ticketId) {
    logger?.info("Merged PR has no ticket reference, ignoring.", {
      code: "WEBHOOK_PR_NO_TICKET",
      repo,
      prNumber: pr.number,
      branch: pr.head.ref
    });
    return {
      status: 200,
      body: {
        event: "pull_request",
        action: "closed",
        repo,
        prNumber: pr.number,
        message: "No ticket reference found in branch name or PR body. Ignored."
      }
    };
  }

  logger?.info("Processing merged PR for ticket advance.", {
    code: "WEBHOOK_PR_MERGED",
    repo,
    prNumber: pr.number,
    ticketId,
    branch: pr.head.ref
  });

  const clock = deps.clock ?? (() => new Date());

  // Fire and forget: advance the ticket but don't block the HTTP response
  const advancePromise = advanceProjectTicket(
    { ticketId, githubPrNumber: pr.number },
    {
      repository: deps.repository,
      githubIssuesAdapter: deps.githubIssuesAdapter ?? null,
      taskFlowAdapter: deps.taskFlowAdapter ?? null,
      clock
    }
  );

  advancePromise
    .then((result) => {
      logger?.info("Webhook-triggered ticket advance completed.", {
        code: "WEBHOOK_TICKET_ADVANCED",
        repo,
        prNumber: pr.number,
        ticketId,
        outcome: result.outcome,
        nextTicketId: result.nextDispatchedTicket?.ticketId ?? null
      });
    })
    .catch((error) => {
      logger?.error("Webhook-triggered ticket advance failed.", {
        code: "WEBHOOK_TICKET_ADVANCE_FAILED",
        repo,
        prNumber: pr.number,
        ticketId,
        error: error instanceof Error ? error.message : String(error)
      });
    });

  return {
    status: 202,
    body: {
      event: "pull_request",
      action: "closed",
      repo,
      prNumber: pr.number,
      ticketId,
      message: "Merged PR accepted for ticket advancement."
    }
  };
}

// ============================================================
// issues event handler — issue intake
// ============================================================

async function handleIssuesEvent(
  payload: unknown,
  deps: WebhookHandlerDependencies,
  logger?: ReturnType<typeof bindPlanningLogger>
): Promise<WebhookHandlerResult> {
  if (!isIssuePayload(payload)) {
    return {
      status: 400,
      body: { error: "bad_request", message: "Malformed issues webhook payload." }
    };
  }

  // Only process "opened" action
  if (payload.action !== "opened") {
    logger?.info("Ignoring non-opened issues event.", {
      code: "WEBHOOK_ISSUE_ACTION_IGNORED",
      action: payload.action,
      repo: payload.repository.full_name,
      issueNumber: payload.issue.number
    });
    return {
      status: 200,
      body: {
        event: "issues",
        action: payload.action,
        message: "Only 'opened' actions are processed."
      }
    };
  }

  // Convert to candidate and check eligibility
  const candidate = webhookIssueToCandidate(payload);
  const clock = deps.clock ?? (() => new Date());

  logger?.info("Processing webhook issue.", {
    code: "WEBHOOK_ISSUE_RECEIVED",
    repo: candidate.repo,
    issueNumber: candidate.issueNumber,
    author: candidate.author ?? null
  });

  // Check if the repo is tracked for polling (registered in the system)
  const cursors = await deps.repository.listGitHubIssuePollingCursors();
  const isTrackedRepo = cursors.some((c) => c.repo === candidate.repo);

  if (!isTrackedRepo) {
    logger?.info("Webhook issue from untracked repo, skipping.", {
      code: "WEBHOOK_REPO_UNTRACKED",
      repo: candidate.repo,
      issueNumber: candidate.issueNumber
    });
    return {
      status: 200,
      body: {
        event: "issues",
        action: "opened",
        repo: candidate.repo,
        issueNumber: candidate.issueNumber,
        message: "Repository is not tracked. Issue ignored."
      }
    };
  }

  // Check for ai-eligible label
  const hasEligibleLabel = candidate.labels.some(
    (l) => l.toLowerCase() === "ai-eligible"
  );

  if (!hasEligibleLabel) {
    logger?.info("Webhook issue missing ai-eligible label, skipping.", {
      code: "WEBHOOK_LABEL_MISSING",
      repo: candidate.repo,
      issueNumber: candidate.issueNumber,
      labels: candidate.labels
    });
    return {
      status: 200,
      body: {
        event: "issues",
        action: "opened",
        repo: candidate.repo,
        issueNumber: candidate.issueNumber,
        message: "Issue does not have ai-eligible label. Ignored."
      }
    };
  }

  // Check for existing planning spec (deduplication)
  const source = {
    provider: "github" as const,
    repo: candidate.repo,
    issueNumber: candidate.issueNumber,
    issueUrl: candidate.url
  };
  const existingSpec = await deps.repository.hasPlanningSpecForSource(source);

  if (existingSpec) {
    logger?.info("Webhook issue already has a planning spec, skipping.", {
      code: "WEBHOOK_DUPLICATE_SKIPPED",
      repo: candidate.repo,
      issueNumber: candidate.issueNumber
    });
    return {
      status: 200,
      body: {
        event: "issues",
        action: "opened",
        repo: candidate.repo,
        issueNumber: candidate.issueNumber,
        message: "Issue already has a planning spec. Duplicate skipped."
      }
    };
  }

  // Convert and run through intake pipeline (async, fire-and-forget)
  const planningInput: PlanningTaskInput = await deps.github.convertToPlanningInput(candidate);
  const classification = classifyComplexity(planningInput);
  const planningMetadata = {
    ...planningInput.metadata,
    complexityClassification: classification,
    intakeSource: "webhook" as const
  };

  const pipelinePromise = runPlanningPipeline(
    {
      ...planningInput,
      metadata: planningMetadata,
      dryRun: deps.dryRun ?? planningInput.dryRun
    },
    {
      repository: deps.repository,
      planner: deps.planner,
      ...(deps.openClawDispatch ? { openClawDispatch: deps.openClawDispatch } : {}),
      ...(deps.architectTargetRoot ? { architectTargetRoot: deps.architectTargetRoot } : {}),
      ...(deps.logger ? { logger: deps.logger } : {}),
      clock
    }
  );

  pipelinePromise
    .then((result) => {
      logger?.info("Webhook-triggered pipeline completed.", {
        code: "WEBHOOK_PIPELINE_COMPLETED",
        repo: candidate.repo,
        issueNumber: candidate.issueNumber,
        taskId: result.manifest.taskId,
        runId: result.runId,
        nextAction: result.nextAction
      });
    })
    .catch((error) => {
      logger?.error("Webhook-triggered pipeline failed.", {
        code: "WEBHOOK_PIPELINE_FAILED",
        repo: candidate.repo,
        issueNumber: candidate.issueNumber,
        error: error instanceof Error ? error.message : String(error)
      });
    });

  return {
    status: 202,
    body: {
      event: "issues",
      action: "opened",
      repo: candidate.repo,
      issueNumber: candidate.issueNumber,
      message: "Issue accepted for processing."
    }
  };
}
