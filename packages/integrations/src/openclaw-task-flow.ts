import { asIsoTimestamp } from "@reddwarf/contracts";
import { OPENCLAW_BASE_URL_ENV, OPENCLAW_HOOK_TOKEN_ENV } from "./openclaw.js";

// ── OpenClaw Task Flow adapter (Feature 150) ─────────────────────────────────

/**
 * A single child task within an OpenClaw Task Flow.
 * Each ticket in a project maps to one child task.
 */
export interface TaskFlowChildTask {
  /** External identifier for this child — typically the RedDwarf ticketId. */
  externalId: string;
  /** Human-readable label for dashboard visibility. */
  label: string;
  /** Dependencies expressed as externalIds of other children in this flow. */
  dependsOn: string[];
}

export interface CreateTaskFlowRequest {
  /** Stable external identifier for this flow — typically the projectId. */
  externalId: string;
  /** Human-readable label shown in the OpenClaw Task Flow dashboard. */
  label: string;
  /**
   * Sync mode. "mirrored" means RedDwarf stays the source of truth for state
   * while OpenClaw provides durable lifecycle management and cancellation.
   */
  mode: "mirrored";
  /** Ordered child tasks — one per project ticket in dependency order. */
  children: TaskFlowChildTask[];
}

export interface CreateTaskFlowResult {
  /** The OpenClaw-assigned flow ID for subsequent state transitions. */
  flowId: string;
  externalId: string;
  createdAt: string;
}

/**
 * Adapter contract for managing project-ticket pipelines through OpenClaw Task Flows.
 * Requires OpenClaw >= v2026.4.2.
 *
 * In mirrored mode, RedDwarf remains the authoritative state machine. OpenClaw
 * provides durable flow lifecycle, heartbeats, and cancellation intent propagation.
 */
export interface OpenClawTaskFlowAdapter {
  /**
   * Create a new Task Flow for the project with one child per ticket.
   * Returns the gateway-assigned flowId for subsequent state transitions.
   */
  createFlow(request: CreateTaskFlowRequest): Promise<CreateTaskFlowResult>;

  /**
   * Signal that a child task has completed (PR merged, ticket advancing).
   * OpenClaw advances the flow to the next eligible child task.
   */
  advanceFlow(flowId: string, completedExternalId: string): Promise<void>;

  /**
   * Cancel the flow — used when a project enters "failed" state.
   * OpenClaw stops scheduling new child tasks and waits for active ones to settle.
   */
  cancelFlow(flowId: string, reason: string): Promise<void>;
}

export interface HttpOpenClawTaskFlowAdapterOptions {
  baseUrl?: string;
  hookToken?: string;
  requestTimeoutMs?: number;
}

const DEFAULT_TASK_FLOW_TIMEOUT_MS = 10_000;

/**
 * HTTP-backed OpenClawTaskFlowAdapter that calls the OpenClaw runtime Task Flow
 * API. Uses the same bearer token as the dispatch adapter.
 *
 * Endpoints (OpenClaw >= v2026.4.2):
 *   POST /runtime/task-flows            — create a new flow
 *   POST /runtime/task-flows/:id/advance — advance flow to next child
 *   POST /runtime/task-flows/:id/cancel  — cancel flow
 */
export class HttpOpenClawTaskFlowAdapter implements OpenClawTaskFlowAdapter {
  private readonly baseUrl: string;
  private readonly hookToken: string;
  private readonly requestTimeoutMs: number;

  constructor(options: HttpOpenClawTaskFlowAdapterOptions = {}) {
    const baseUrl = options.baseUrl ?? process.env[OPENCLAW_BASE_URL_ENV];
    if (!baseUrl) {
      throw new Error(
        "HttpOpenClawTaskFlowAdapter requires a base URL. " +
          `Set the ${OPENCLAW_BASE_URL_ENV} environment variable or pass baseUrl explicitly.`
      );
    }
    const hookToken = options.hookToken ?? process.env[OPENCLAW_HOOK_TOKEN_ENV];
    if (!hookToken) {
      throw new Error(
        "HttpOpenClawTaskFlowAdapter requires a hook token. " +
          `Set the ${OPENCLAW_HOOK_TOKEN_ENV} environment variable or pass hookToken explicitly.`
      );
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.hookToken = hookToken;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TASK_FLOW_TIMEOUT_MS;
  }

  private async request(path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.hookToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `OpenClaw Task Flow API ${path} returned ${response.status}${text ? `: ${text}` : ""}`
        );
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async createFlow(request: CreateTaskFlowRequest): Promise<CreateTaskFlowResult> {
    const result = await this.request("/runtime/task-flows", {
      externalId: request.externalId,
      label: request.label,
      mode: request.mode,
      children: request.children.map((c) => ({
        externalId: c.externalId,
        label: c.label,
        dependsOn: c.dependsOn
      }))
    }) as Record<string, unknown>;

    return {
      flowId: String(result["flowId"] ?? result["id"] ?? ""),
      externalId: request.externalId,
      createdAt: typeof result["createdAt"] === "string" ? result["createdAt"] : asIsoTimestamp()
    };
  }

  async advanceFlow(flowId: string, completedExternalId: string): Promise<void> {
    await this.request(`/runtime/task-flows/${encodeURIComponent(flowId)}/advance`, {
      completedExternalId
    });
  }

  async cancelFlow(flowId: string, reason: string): Promise<void> {
    await this.request(`/runtime/task-flows/${encodeURIComponent(flowId)}/cancel`, {
      reason
    });
  }
}

/**
 * Fixture Task Flow adapter for tests — records calls without hitting OpenClaw.
 */
export class FixtureOpenClawTaskFlowAdapter implements OpenClawTaskFlowAdapter {
  readonly createdFlows: CreateTaskFlowRequest[] = [];
  readonly advancedFlows: Array<{ flowId: string; completedExternalId: string }> = [];
  readonly cancelledFlows: Array<{ flowId: string; reason: string }> = [];
  private nextFlowId = 1;

  async createFlow(request: CreateTaskFlowRequest): Promise<CreateTaskFlowResult> {
    this.createdFlows.push(request);
    return {
      flowId: `fixture-flow-${this.nextFlowId++}`,
      externalId: request.externalId,
      createdAt: asIsoTimestamp()
    };
  }

  async advanceFlow(flowId: string, completedExternalId: string): Promise<void> {
    this.advancedFlows.push({ flowId, completedExternalId });
  }

  async cancelFlow(flowId: string, reason: string): Promise<void> {
    this.cancelledFlows.push({ flowId, reason });
  }
}
