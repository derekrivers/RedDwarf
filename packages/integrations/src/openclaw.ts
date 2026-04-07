import { asIsoTimestamp } from "@reddwarf/contracts";
import { EnvVarSecretsAdapter } from "./secrets.js";

const DEFAULT_OPENCLAW_DISPATCH_TIMEOUT_MS = 15_000;

// ── OpenClaw hook-token scope name ───────────────────────────────────────────

/**
 * Well-known scope name for the OpenClaw webhook hook token.
 * Used by RedDwarf dispatch adapters to retrieve the bearer token
 * needed for `POST /hooks/agent` calls.
 */
export const OPENCLAW_HOOK_TOKEN_SCOPE = "openclaw" as const;

/**
 * Well-known environment variable name for the OpenClaw hook token.
 */
export const OPENCLAW_HOOK_TOKEN_ENV = "OPENCLAW_HOOK_TOKEN" as const;

/**
 * Well-known environment variable name for the OpenClaw gateway base URL.
 */
export const OPENCLAW_BASE_URL_ENV = "OPENCLAW_BASE_URL" as const;

/**
 * Request payload for dispatching work to an OpenClaw agent.
 * Maps to the `POST /hooks/agent` webhook endpoint, where the prompt is
 * sent as the webhook `message` field.
 */
export interface OpenClawDispatchRequest {
  /** Deterministic session key for continuity — e.g. `github:issue:acme/repo:42`. */
  sessionKey: string;
  /** The OpenClaw agent ID to dispatch to — e.g. `reddwarf-analyst`. */
  agentId: string;
  /** The task prompt or instruction to execute. */
  prompt: string;
  /** Optional metadata attached to the dispatch for evidence/tracing. */
  metadata?: Record<string, unknown>;
}

/**
 * Response from an OpenClaw dispatch operation.
 */
export interface OpenClawDispatchResult {
  /** Whether the dispatch was accepted by the gateway. */
  accepted: boolean;
  /** Session key echoed back for correlation. */
  sessionKey: string;
  /** Agent that handled the dispatch. */
  agentId: string;
  /** Gateway-assigned session or request ID. */
  sessionId: string | null;
  /** Timestamp of the dispatch response. */
  respondedAt: string;
  /** Optional status message from the gateway. */
  statusMessage: string | null;
}

/**
 * Adapter contract for dispatching bounded work to OpenClaw agents.
 *
 * RedDwarf owns intake, policy, risk, and approvals. This adapter is
 * the handoff point where approved work enters the OpenClaw execution
 * runtime. Implementers must authenticate with the gateway hook token
 * and return a dispatch result for evidence capture.
 */
export interface OpenClawDispatchAdapter {
  /**
   * Dispatch a task prompt to the specified OpenClaw agent.
   * Throws on network or auth failures.
   */
  dispatch(request: OpenClawDispatchRequest): Promise<OpenClawDispatchResult>;
}

export interface FixtureOpenClawDispatchAdapterOptions {
  /** When true, all dispatches are rejected. Defaults to false. */
  rejectAll?: boolean;
  /** Fixed session ID returned for all dispatches. */
  fixedSessionId?: string;
  /** Custom status message to include in the result. */
  statusMessage?: string;
}

/**
 * A fixture-backed OpenClawDispatchAdapter for tests and deterministic
 * pipeline runs. Records all dispatches for later inspection.
 */
export class FixtureOpenClawDispatchAdapter implements OpenClawDispatchAdapter {
  private readonly rejectAll: boolean;
  private readonly fixedSessionId: string;
  private readonly statusMessage: string | null;
  public readonly dispatches: OpenClawDispatchRequest[] = [];

  constructor(options: FixtureOpenClawDispatchAdapterOptions = {}) {
    this.rejectAll = options.rejectAll ?? false;
    this.fixedSessionId = options.fixedSessionId ?? "fixture-session-001";
    this.statusMessage = options.statusMessage ?? null;
  }

  async dispatch(request: OpenClawDispatchRequest): Promise<OpenClawDispatchResult> {
    this.dispatches.push(request);

    return {
      accepted: !this.rejectAll,
      sessionKey: request.sessionKey,
      agentId: request.agentId,
      sessionId: this.rejectAll ? null : this.fixedSessionId,
      respondedAt: asIsoTimestamp(),
      statusMessage: this.rejectAll
        ? "Fixture: dispatch rejected (rejectAll=true)"
        : this.statusMessage
    };
  }
}

export interface HttpOpenClawDispatchAdapterOptions {
  /** OpenClaw gateway base URL — e.g. `http://localhost:3578`. */
  baseUrl?: string;
  /** Bearer token for webhook authentication. */
  hookToken?: string;
  /** Maximum retry attempts for transient failures. Defaults to 3. */
  maxAttempts?: number;
  /** Base delay in milliseconds between retries. Defaults to 2000. */
  baseDelayMs?: number;
  /** HTTP status codes that trigger a retry. Defaults to 429 and 529. */
  retryableStatuses?: Set<number>;
  /** Per-request timeout in milliseconds. Defaults to 15000. */
  requestTimeoutMs?: number;
}

/**
 * HTTP-backed OpenClawDispatchAdapter that posts to `/hooks/agent` on the
 * OpenClaw gateway. Uses bearer auth with the hook token, disables chat
 * delivery for RedDwarf orchestration runs, and retries on transient 429/529
 * responses.
 */
export class HttpOpenClawDispatchAdapter implements OpenClawDispatchAdapter {
  private readonly baseUrl: string;
  private readonly hookToken: string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly retryableStatuses: Set<number>;
  private readonly requestTimeoutMs: number;

  constructor(options: HttpOpenClawDispatchAdapterOptions = {}) {
    const baseUrl = options.baseUrl ?? process.env[OPENCLAW_BASE_URL_ENV];
    if (!baseUrl) {
      throw new Error(
        "HttpOpenClawDispatchAdapter requires a base URL. " +
          `Set the ${OPENCLAW_BASE_URL_ENV} environment variable or pass baseUrl explicitly.`
      );
    }
    const hookToken = options.hookToken ?? process.env[OPENCLAW_HOOK_TOKEN_ENV];
    if (!hookToken) {
      throw new Error(
        "HttpOpenClawDispatchAdapter requires a hook token. " +
          `Set the ${OPENCLAW_HOOK_TOKEN_ENV} environment variable or pass hookToken explicitly.`
      );
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.hookToken = hookToken;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 2000;
    this.retryableStatuses = options.retryableStatuses ?? new Set([429, 529]);
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_OPENCLAW_DISPATCH_TIMEOUT_MS;
  }

  async dispatch(request: OpenClawDispatchRequest): Promise<OpenClawDispatchResult> {
    const url = `${this.baseUrl}/hooks/agent`;
    const body = JSON.stringify({
      message: request.prompt,
      name: "RedDwarf",
      sessionKey: request.sessionKey,
      agentId: request.agentId,
      deliver: false,
      wakeMode: "now",
      ...(request.metadata !== undefined ? { metadata: request.metadata } : {})
    });

    let attempt = 0;
    while (true) {
      attempt++;
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.hookToken}`,
            "Content-Type": "application/json"
          },
          body,
          signal: AbortSignal.timeout(this.requestTimeoutMs)
        });
      } catch (error) {
        throw normalizeFetchTimeoutError(
          error,
          `OpenClaw dispatch to ${url}`,
          this.requestTimeoutMs
        );
      }

      if (!response.ok) {
        if (this.retryableStatuses.has(response.status) && attempt < this.maxAttempts) {
          const delay = attempt * this.baseDelayMs;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        const responseBody = await response.text().catch(() => "");
        throw new Error(
          `OpenClaw dispatch to ${url} returned ${response.status}: ${responseBody}`
        );
      }

      const responseBody = await response.text();
      let result: Record<string, unknown> = {};
      if (responseBody.length > 0) {
        try {
          result = JSON.parse(responseBody) as Record<string, unknown>;
        } catch {
          throw new Error(
            `OpenClaw dispatch to ${url} returned non-JSON response (status ${response.status}): ${responseBody.slice(0, 200)}`
          );
        }
      }

      return {
        accepted: true,
        sessionKey: request.sessionKey,
        agentId: request.agentId,
        sessionId: typeof result["sessionId"] === "string" ? result["sessionId"] : null,
        respondedAt: asIsoTimestamp(),
        statusMessage: typeof result["message"] === "string" ? result["message"] : null
      };
    }
  }
}

/**
 * Create an HttpOpenClawDispatchAdapter from environment variables or
 * explicit options. Reads OPENCLAW_BASE_URL and OPENCLAW_HOOK_TOKEN from
 * the environment when not passed explicitly.
 */
export function createHttpOpenClawDispatchAdapter(
  options: HttpOpenClawDispatchAdapterOptions = {}
): HttpOpenClawDispatchAdapter {
  return new HttpOpenClawDispatchAdapter(options);
}

/**
 * Create an EnvVarSecretsAdapter pre-configured with the `openclaw` scope
 * mapping so that `requestSecret("openclaw_hook_token")` reads from
 * `OPENCLAW_HOOK_TOKEN` and the `openclaw` scope is available for
 * task-scoped lease issuance.
 *
 * Additional scopes can be passed and will be merged with the openclaw scope.
 */
export function createOpenClawSecretsAdapter(
  options: { extraScopes?: Record<string, Record<string, string>> } = {}
): EnvVarSecretsAdapter {
  const hookToken = process.env[OPENCLAW_HOOK_TOKEN_ENV] ?? "";
  const openclawScope: Record<string, string> = {};
  if (hookToken.length > 0) {
    openclawScope["HOOK_TOKEN"] = hookToken;
  }
  return new EnvVarSecretsAdapter({
    scopes: {
      [OPENCLAW_HOOK_TOKEN_SCOPE]: openclawScope,
      ...options.extraScopes
    }
  });
}

// ── ACPX embedded dispatch adapter (Feature 154) ────────────────────────────

export interface AcpxOpenClawDispatchAdapterOptions {
  baseUrl?: string;
  hookToken?: string;
  requestTimeoutMs?: number;
}

/**
 * ACPX-backed OpenClawDispatchAdapter that creates bound sessions via the
 * OpenClaw ACPX session endpoint instead of firing a fire-and-forget webhook.
 *
 * Benefits over HTTP hook dispatch:
 * - Returns a real sessionId immediately for heartbeat and transcript lookup
 * - Supports streaming progress events (used by Feature 151 in real-time)
 * - Enables graceful cancellation via session signals
 *
 * The OpenClawDispatchAdapter interface is unchanged — only the implementation
 * changes. Coexists with HttpOpenClawDispatchAdapter via REDDWARF_ACPX_DISPATCH_ENABLED.
 *
 * Requires OpenClaw >= v2026.4.5.
 */
export class AcpxOpenClawDispatchAdapter implements OpenClawDispatchAdapter {
  private readonly baseUrl: string;
  private readonly hookToken: string;
  private readonly requestTimeoutMs: number;

  constructor(options: AcpxOpenClawDispatchAdapterOptions = {}) {
    const baseUrl = options.baseUrl ?? process.env[OPENCLAW_BASE_URL_ENV];
    if (!baseUrl) {
      throw new Error(
        "AcpxOpenClawDispatchAdapter requires a base URL. " +
          `Set the ${OPENCLAW_BASE_URL_ENV} environment variable or pass baseUrl explicitly.`
      );
    }
    const hookToken = options.hookToken ?? process.env[OPENCLAW_HOOK_TOKEN_ENV];
    if (!hookToken) {
      throw new Error(
        "AcpxOpenClawDispatchAdapter requires a hook token. " +
          `Set the ${OPENCLAW_HOOK_TOKEN_ENV} environment variable or pass hookToken explicitly.`
      );
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.hookToken = hookToken;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_OPENCLAW_DISPATCH_TIMEOUT_MS;
  }

  async dispatch(request: OpenClawDispatchRequest): Promise<OpenClawDispatchResult> {
    const url = `${this.baseUrl}/acpx/sessions`;
    const body = JSON.stringify({
      prompt: request.prompt,
      sessionKey: request.sessionKey,
      agentId: request.agentId,
      ...(request.metadata !== undefined ? { metadata: request.metadata } : {})
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.hookToken}`,
          "Content-Type": "application/json"
        },
        body,
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      });
    } catch (err) {
      throw normalizeFetchTimeoutError(err, "ACPX session creation", this.requestTimeoutMs);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `OpenClaw ACPX session creation returned ${response.status}${text ? `: ${text}` : ""}`
      );
    }

    const result = (await response.json()) as Record<string, unknown>;
    return {
      accepted: true,
      sessionKey: request.sessionKey,
      agentId: request.agentId,
      sessionId: typeof result["sessionId"] === "string" ? result["sessionId"] : null,
      respondedAt: asIsoTimestamp(),
      statusMessage: typeof result["message"] === "string" ? result["message"] : null
    };
  }
}

/**
 * Create an ACPX dispatch adapter from environment variables or explicit options.
 * Reads OPENCLAW_BASE_URL and OPENCLAW_HOOK_TOKEN from the environment.
 */
export function createAcpxOpenClawDispatchAdapter(
  options: AcpxOpenClawDispatchAdapterOptions = {}
): AcpxOpenClawDispatchAdapter {
  return new AcpxOpenClawDispatchAdapter(options);
}

function normalizeFetchTimeoutError(
  error: unknown,
  context: string,
  timeoutMs: number
): Error {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new Error(`${context} timed out after ${timeoutMs}ms.`);
  }

  return error instanceof Error ? error : new Error(String(error));
}
