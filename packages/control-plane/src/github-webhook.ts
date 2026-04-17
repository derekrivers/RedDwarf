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

  // Step 3: Route by event type
  if (eventType !== "issues" && eventType !== "pull_request") {
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

  return handleIssuesEvent(payload, deps, logger);
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
