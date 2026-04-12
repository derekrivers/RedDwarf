import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GitHubAdapter, GitHubIssueCandidate } from "@reddwarf/integrations";
import type { PlanningAgent, PlanningTaskInput } from "@reddwarf/contracts";
import type { PlanningRepository } from "@reddwarf/evidence";
import { runPlanningPipeline } from "./pipeline.js";
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

  // Step 3: Only process issues events
  if (eventType !== "issues") {
    logger?.info("Ignoring non-issues webhook event.", {
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

  if (!isIssuePayload(payload)) {
    return {
      status: 400,
      body: { error: "bad_request", message: "Malformed issues webhook payload." }
    };
  }

  // Step 5: Only process "opened" action
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

  // Step 6: Convert to candidate and check eligibility
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

  // Step 7: Check for existing planning spec (deduplication)
  // The planning pipeline's pre-screener also performs this check, but
  // checking here allows us to return a clear 200 response immediately
  // without starting the pipeline.
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

  // Step 8: Convert and run through intake pipeline (async, fire-and-forget)
  // We respond 202 Accepted immediately and let the pipeline run in the background.
  const planningInput: PlanningTaskInput = await deps.github.convertToPlanningInput(candidate);
  const classification = classifyComplexity(planningInput);
  const planningMetadata = {
    ...planningInput.metadata,
    complexityClassification: classification,
    intakeSource: "webhook" as const
  };

  // Fire and forget: start the pipeline but don't await it for the HTTP response
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

  // Log pipeline completion/failure asynchronously
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
