import { randomUUID } from "node:crypto";
import {
  asIsoTimestamp,
  concurrencyDecisionSchema,
  phaseRecordSchema,
  taskManifestSchema,
  workspaceContextBundleSchema,
  type ApprovalRequest,
  type Capability,
  type ConcurrencyDecision,
  type FailureClass,
  type MemoryContext,
  type PhaseLifecycleStatus,
  type PhaseRecord,
  type PipelineRun,
  type PlanningTaskInput,
  type PolicySnapshot,
  type RunEvent,
  type TaskManifest,
  type TaskPhase,
  type WorkspaceContextBundle
} from "@reddwarf/contracts";
import {
  createPipelineRun,
  createRunEvent,
  deriveOrganizationId,
  type PersistedTaskSnapshot,
  type PlanningRepository
} from "@reddwarf/evidence";
import {
  scrubManagedWorkspaceSecrets
} from "../workspace.js";
import {
  sanitizeSecretBearingText
} from "../live-workflow.js";
import type { MaterializedManagedWorkspace } from "@reddwarf/contracts";
import { bindPlanningLogger, defaultLogger, type PlanningPipelineLogger } from "../logger.js";
import {
  DEFAULT_PHASE_STALE_AFTER_MS,
  EventCodes,
  PHASE_HEARTBEAT_INTERVAL_MS,
  phaseTimeoutBudgetsMs,
  PlanningPipelineFailure,
  phaseRegistry,
  type PlanningConcurrencyOptions,
  type ResolvedPhaseDependencies,
  type ValidatedPhaseSnapshot,
  type RecoverablePhase
} from "./types.js";

// ── Error serialization ───────────────────────────────────────────────────────

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof PlanningPipelineFailure) {
    return {
      name: error.name,
      message: sanitizeSecretBearingText(error.message),
      code: error.code,
      phase: error.phase,
      failureClass: error.failureClass,
      taskId: error.taskId,
      runId: error.runId,
      details: sanitizeSerializedErrorDetails(error.details)
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: sanitizeSecretBearingText(error.message),
      stack: error.stack ? sanitizeSecretBearingText(error.stack) : null
    };
  }

  return {
    message: sanitizeSecretBearingText(String(error))
  };
}

export function sanitizeSerializedErrorDetails(
  details: Record<string, unknown>
): Record<string, unknown> {
  return sanitizeSerializedErrorValue(details) as Record<string, unknown>;
}

export function sanitizeSerializedErrorValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>()
): unknown {
  if (typeof value === "string") {
    return sanitizeSecretBearingText(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeSerializedErrorValue(entry, seen));
  }

  if (value && typeof value === "object") {
    if (seen.has(value as object)) {
      return "[Circular]";
    }

    seen.add(value as object);
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        sanitizeSerializedErrorValue(entry, seen)
      ])
    );
  }

  return value;
}

export function getDurationMs(start: Date, end: Date): number {
  return Math.max(0, end.getTime() - start.getTime());
}

// ── Phase record / event helpers ─────────────────────────────────────────────

export function createPhaseRecord(input: {
  id: string;
  taskId: string;
  phase: TaskPhase;
  status: PhaseLifecycleStatus;
  actor: string;
  summary: string;
  details?: Record<string, unknown>;
  createdAt: string;
}): PhaseRecord {
  return phaseRecordSchema.parse({
    recordId: input.id,
    taskId: input.taskId,
    phase: input.phase,
    status: input.status,
    actor: input.actor,
    summary: input.summary,
    details: input.details ?? {},
    createdAt: input.createdAt
  });
}

export function createConcurrencyDecision(
  input: ConcurrencyDecision
): ConcurrencyDecision {
  return concurrencyDecisionSchema.parse(input);
}

export async function recordRunEvent(input: {
  repository: { saveRunEvent(event: RunEvent): Promise<void> };
  logger: PlanningPipelineLogger;
  eventId: string;
  taskId: string;
  runId: string;
  phase: TaskPhase;
  level: RunEvent["level"];
  code: string;
  message: string;
  failureClass?: FailureClass;
  durationMs?: number;
  data?: Record<string, unknown>;
  createdAt: string;
}): Promise<RunEvent> {
  const event = createRunEvent({
    eventId: input.eventId,
    taskId: input.taskId,
    runId: input.runId,
    phase: input.phase,
    level: input.level,
    code: input.code,
    message: input.message,
    ...(input.failureClass === undefined
      ? {}
      : { failureClass: input.failureClass }),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    data: input.data ?? {},
    createdAt: input.createdAt
  });
  await input.repository.saveRunEvent(event);

  const context: Record<string, unknown> = {
    eventId: event.eventId,
    taskId: event.taskId,
    runId: event.runId,
    phase: event.phase,
    code: event.code,
    ...(event.failureClass === undefined
      ? {}
      : { failureClass: event.failureClass }),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    ...event.data
  };

  if (event.level === "info") {
    input.logger.info(event.message, context);
  } else if (event.level === "warn") {
    input.logger.warn(event.message, context);
  } else {
    input.logger.error(event.message, context);
  }

  return event;
}

export function patchManifest(
  manifest: TaskManifest,
  updates: Partial<TaskManifest>
): TaskManifest {
  return { ...manifest, ...updates };
}

// ── Phase pre-flight helpers ──────────────────────────────────────────────────

export function requirePhaseSnapshot(
  snapshot: PersistedTaskSnapshot,
  taskId: string
): ValidatedPhaseSnapshot {
  if (!snapshot.manifest) {
    throw new Error(`Task manifest ${taskId} was not found.`);
  }
  if (!snapshot.spec) {
    throw new Error(`Planning spec for ${taskId} was not found.`);
  }
  if (!snapshot.policySnapshot) {
    throw new Error(`Policy snapshot for ${taskId} was not found.`);
  }
  return {
    snapshot,
    manifest: snapshot.manifest,
    spec: snapshot.spec,
    policySnapshot: snapshot.policySnapshot
  };
}

export function requireApprovedRequest(
  snapshot: PersistedTaskSnapshot,
  manifest: TaskManifest,
  phase: TaskPhase
): ApprovalRequest | null {
  if (manifest.approvalMode === "auto") {
    return null;
  }
  const approvedRequest = findApprovedPolicyGateRequest(snapshot);

  if (!approvedRequest) {
    throw new Error(
      `Task ${manifest.taskId} requires an approved request before the ${phase} phase can start.`
    );
  }
  return approvedRequest;
}

export function findApprovedRequestByPhase(
  snapshot: PersistedTaskSnapshot,
  phase: ApprovalRequest["phase"]
): ApprovalRequest | null {
  return (
    snapshot.approvalRequests.find(
      (request) => request.phase === phase && request.status === "approved"
    ) ?? null
  );
}

export function findApprovedPolicyGateRequest(
  snapshot: PersistedTaskSnapshot
): ApprovalRequest | null {
  return findApprovedRequestByPhase(snapshot, "policy_gate");
}

export function findApprovedArchitectureReviewOverride(
  snapshot: PersistedTaskSnapshot
): ApprovalRequest | null {
  return findApprovedRequestByPhase(snapshot, "architecture_review");
}

export function requireNoFailureEscalation(
  snapshot: PersistedTaskSnapshot,
  taskId: string,
  phase: RecoverablePhase
): void {
  const pendingFailureEscalation = findPendingFailureEscalationRequest(
    snapshot,
    phase
  );
  if (pendingFailureEscalation) {
    throw new Error(
      `Task ${taskId} has a pending failure escalation request ${pendingFailureEscalation.requestId} before the ${phase} phase can restart.`
    );
  }
}

export function defaultStaleAfterMsForPhase(phase: TaskPhase): number {
  const phaseBudgetMs = phaseTimeoutBudgetsMs[phase];
  return phaseBudgetMs === undefined
    ? DEFAULT_PHASE_STALE_AFTER_MS
    : phaseBudgetMs + (PHASE_HEARTBEAT_INTERVAL_MS * 3);
}

export function resolvePhaseDependencies(
  phase: TaskPhase,
  dependencies: {
    logger?: PlanningPipelineLogger;
    clock?: () => Date;
    idGenerator?: () => string;
    concurrency?: PlanningConcurrencyOptions;
  }
): ResolvedPhaseDependencies {
  return {
    logger: dependencies.logger ?? defaultLogger,
    clock: dependencies.clock ?? (() => new Date()),
    idGenerator: dependencies.idGenerator ?? (() => randomUUID()),
    concurrency: {
      strategy: dependencies.concurrency?.strategy ?? "serialize",
      staleAfterMs:
        dependencies.concurrency?.staleAfterMs ?? defaultStaleAfterMsForPhase(phase)
    }
  };
}

// ── Concurrency key helpers ───────────────────────────────────────────────────

export function createSourceConcurrencyKey(
  source: PlanningTaskInput["source"]
): string {
  const sourceIssue = source.issueNumber ?? source.issueId ?? "adhoc";
  return `${source.provider}:${source.repo}:${sourceIssue}`;
}

export function createTaskConcurrencyKey(input: PlanningTaskInput): string {
  return createSourceConcurrencyKey(input.source);
}

// ── Pipeline run staleness ────────────────────────────────────────────────────

export function resolvePipelineRunStaleAfterMs(
  run: PipelineRun,
  overrideStaleAfterMs?: number
): number {
  if (overrideStaleAfterMs !== undefined) {
    return overrideStaleAfterMs;
  }

  const metadataPhase =
    typeof run.metadata?.currentPhase === "string"
      ? run.metadata.currentPhase
      : typeof run.metadata?.phase === "string"
        ? run.metadata.phase
        : null;

  return metadataPhase && metadataPhase in phaseTimeoutBudgetsMs
    ? defaultStaleAfterMsForPhase(metadataPhase as TaskPhase)
    : DEFAULT_PHASE_STALE_AFTER_MS;
}

export function isPipelineRunStale(
  run: PipelineRun,
  now: Date,
  staleAfterMs: number
): boolean {
  return now.getTime() - new Date(run.lastHeartbeatAt).getTime() > staleAfterMs;
}

// ── Task id / branch helpers ─────────────────────────────────────────────────

export function createTaskId(input: PlanningTaskInput, runId: string): string {
  const sourceIssue = input.source.issueNumber ?? input.source.issueId ?? runId;
  const repo = input.source.repo.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  return `${repo}-${sourceIssue}`;
}

export function readConfiguredBaseBranch(input: PlanningTaskInput): string {
  const githubMetadata = input.metadata["github"];

  if (githubMetadata && typeof githubMetadata === "object") {
    const baseBranch = (githubMetadata as Record<string, unknown>)["baseBranch"];

    if (typeof baseBranch === "string" && baseBranch.trim().length > 0) {
      return baseBranch.trim();
    }
  }

  return "main";
}

export function readTaskMemoryValue(
  snapshot: PersistedTaskSnapshot,
  key: string
): unknown {
  return (
    snapshot.memoryRecords.find(
      (record) => record.scope === "task" && record.key === key
    )?.value ?? null
  );
}

export function readPlanningDefaultBranchFromSnapshot(
  snapshot: PersistedTaskSnapshot
): string {
  const planningBrief = readTaskMemoryValue(snapshot, "planning.brief");

  if (planningBrief && typeof planningBrief === "object") {
    const defaultBranch = (planningBrief as Record<string, unknown>)[
      "defaultBranch"
    ];

    if (typeof defaultBranch === "string" && defaultBranch.trim().length > 0) {
      return defaultBranch.trim();
    }
  }

  return "main";
}

export async function resolveTaskMemoryContext(input: {
  repository: PlanningRepository;
  manifest: TaskManifest;
  providedMemoryContext?: MemoryContext | null;
  limitPerScope?: number;
}): Promise<MemoryContext> {
  if (input.providedMemoryContext) {
    return input.providedMemoryContext;
  }

  return input.repository.getMemoryContext({
    taskId: input.manifest.taskId,
    repo: input.manifest.source.repo,
    organizationId: deriveOrganizationId(input.manifest.source.repo),
    ...(input.limitPerScope !== undefined
      ? { limitPerScope: input.limitPerScope }
      : {})
  });
}

export function readValidationSummaryFromSnapshot(
  snapshot: PersistedTaskSnapshot
): string {
  const validationSummary = readTaskMemoryValue(snapshot, "validation.summary");

  if (validationSummary && typeof validationSummary === "object") {
    const summary = (validationSummary as Record<string, unknown>)["summary"];

    if (typeof summary === "string" && summary.trim().length > 0) {
      return summary.trim();
    }
  }

  throw new Error(
    `Task ${snapshot.manifest?.taskId ?? "unknown"} requires a validation.summary memory record before SCM can start.`
  );
}

export function readValidationReportPathFromSnapshot(
  snapshot: PersistedTaskSnapshot
): string {
  const validationSummary = readTaskMemoryValue(snapshot, "validation.summary");

  if (validationSummary && typeof validationSummary === "object") {
    const reportPath = (validationSummary as Record<string, unknown>)["reportPath"];

    if (typeof reportPath === "string" && reportPath.trim().length > 0) {
      return reportPath;
    }
  }

  throw new Error(
    `Task ${snapshot.manifest?.taskId ?? "unknown"} requires a validation report path before SCM can start.`
  );
}

export function readDevelopmentCodeWriteEnabledFromSnapshot(
  snapshot: PersistedTaskSnapshot
): boolean {
  const developmentHandoff = readTaskMemoryValue(snapshot, "development.handoff");

  if (developmentHandoff && typeof developmentHandoff === "object") {
    const codeWriteEnabled = (developmentHandoff as Record<string, unknown>)[
      "codeWriteEnabled"
    ];

    if (typeof codeWriteEnabled === "boolean") {
      return codeWriteEnabled;
    }
  }

  return false;
}

export function taskRequestsPullRequest(manifest: TaskManifest): boolean {
  return manifest.requestedCapabilities.includes("can_open_pr");
}

export function createScmBranchName(taskId: string, _runId: string): string {
  return `reddwarf/${sanitizeBranchSegment(taskId)}/scm`;
}

export function sanitizeBranchSegment(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-/.]+|[-/.]+$/g, "");

  return sanitized.length > 0 ? sanitized : "task";
}

// ── Heartbeat helpers ─────────────────────────────────────────────────────────

export async function waitWithHeartbeat<T>(input: {
  work: Promise<T>;
  heartbeatIntervalMs?: number;
  onHeartbeat?: () => Promise<void>;
  onHeartbeatError?: (error: unknown) => void;
}): Promise<T> {
  if (!input.onHeartbeat) {
    return await input.work;
  }

  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? PHASE_HEARTBEAT_INTERVAL_MS;
  const taggedWork = input.work.then(
    (value) => ({ kind: "result" as const, value }),
    (error) => ({ kind: "error" as const, error })
  );

  while (true) {
    const outcome = await Promise.race([
      taggedWork,
      new Promise<{ kind: "heartbeat" }>((resolve) => {
        setTimeout(() => resolve({ kind: "heartbeat" }), heartbeatIntervalMs);
      })
    ]);

    if (outcome.kind === "result") {
      return outcome.value;
    }

    if (outcome.kind === "error") {
      throw outcome.error;
    }

    try {
      await input.onHeartbeat();
    } catch (heartbeatError) {
      input.onHeartbeatError?.(heartbeatError);
    }
  }
}

export async function heartbeatTrackedRun(input: {
  phase: TaskPhase;
  persistTrackedRun: (
    patch: Partial<PipelineRun> & { metadata?: Record<string, unknown> },
    runRepository?: { savePipelineRun(run: PipelineRun): Promise<void> }
  ) => Promise<void>;
  clock: () => Date;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await input.persistTrackedRun({
    lastHeartbeatAt: asIsoTimestamp(input.clock()),
    metadata: {
      currentPhase: input.phase,
      ...(input.metadata ?? {})
    }
  });
}

// ── Phase run context ─────────────────────────────────────────────────────────

export interface PhaseRunContext {
  runLogger: PlanningPipelineLogger;
  nextEventId: (phase: TaskPhase, code: string) => string;
  persistTrackedRun: (
    patch: Partial<PipelineRun> & { metadata?: Record<string, unknown> },
    runRepository?: { savePipelineRun(run: PipelineRun): Promise<void> }
  ) => Promise<void>;
}

export function createPhaseRunContext(input: {
  runId: string;
  taskId: string;
  sourceRepo: string;
  phase?: string;
  getTrackedRun: () => PipelineRun;
  setTrackedRun: (run: PipelineRun) => void;
  repository: { savePipelineRun(run: PipelineRun): Promise<void> };
  logger: PlanningPipelineLogger;
}): PhaseRunContext {
  const runLogger = bindPlanningLogger(input.logger, {
    runId: input.runId,
    taskId: input.taskId,
    sourceRepo: input.sourceRepo,
    ...(input.phase !== undefined ? { phase: input.phase } : {})
  });

  let eventSequence = 0;
  const nextEventId = (phase: TaskPhase, code: string): string => {
    const sequence = String(eventSequence).padStart(3, "0");
    eventSequence += 1;
    return `${input.runId}:${sequence}:${phase}:${code}`;
  };

  const persistTrackedRun = async (
    patch: Partial<PipelineRun> & { metadata?: Record<string, unknown> },
    runRepository: { savePipelineRun(run: PipelineRun): Promise<void> } = input.repository
  ): Promise<void> => {
    const updated = createPipelineRun({
      ...input.getTrackedRun(),
      ...patch,
      metadata: {
        ...input.getTrackedRun().metadata,
        ...(patch.metadata ?? {})
      }
    });
    input.setTrackedRun(updated);
    await runRepository.savePipelineRun(updated);
  };

  return { runLogger, nextEventId, persistTrackedRun };
}

// ── Failure-related helpers used by failure.ts ────────────────────────────────

export function findPendingFailureEscalationRequest(
  snapshot: PersistedTaskSnapshot,
  phase: RecoverablePhase
): ApprovalRequest | null {
  return (
    snapshot.approvalRequests.find(
      (request) =>
        request.phase === phase &&
        request.status === "pending" &&
        request.requestedBy === "failure-automation"
    ) ?? null
  );
}

export function findApprovedFailureEscalationRequest(
  snapshot: PersistedTaskSnapshot,
  phase: RecoverablePhase
): ApprovalRequest | null {
  return (
    snapshot.approvalRequests
      .slice()
      .reverse()
      .find(
        (request) =>
          request.phase === phase &&
          request.status === "approved" &&
          request.requestedBy === "failure-automation"
      ) ?? null
  );
}

export function isRecoverablePhase(phase: TaskPhase): phase is RecoverablePhase {
  return (
    phase === "development" ||
    phase === "architecture_review" ||
    phase === "validation" ||
    phase === "scm"
  );
}

export function findAutomatedRetryRecovery(
  snapshot: PersistedTaskSnapshot,
  phase: RecoverablePhase
): import("./types.js").FailureRecoveryMemoryValue | null {
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  const recoveryMemory = readFailureRecoveryMemory(snapshot);

  if (
    recoveryMemory?.action !== "retry" ||
    recoveryMemory.phase !== phase ||
    findPendingFailureEscalationRequest(snapshot, phase) !== null
  ) {
    return null;
  }

  return recoveryMemory;
}

export function readFailureRecoveryMemory(
  snapshot: PersistedTaskSnapshot
): import("./types.js").FailureRecoveryMemoryValue | null {
  const record = snapshot.memoryRecords.find(
    (entry) => entry.key === "failure.recovery"
  );
  const value = record?.value;

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const objectValue = value as Record<string, unknown>;
  const rawPhase = objectValue.phase;
  const rawAction = objectValue.action;
  const runId = objectValue.runId;
  const failureCode = objectValue.failureCode;
  const failureClass = objectValue.failureClass;
  const retryCount = objectValue.retryCount;
  const retryLimit = objectValue.retryLimit;
  const phaseCandidate = typeof rawPhase === "string" ? rawPhase : "";
  const isRecoverablePhaseCandidate =
    phaseCandidate === "development" ||
    phaseCandidate === "architecture_review" ||
    phaseCandidate === "validation" ||
    phaseCandidate === "scm";

  if (
    !isRecoverablePhaseCandidate ||
    (rawAction !== "retry" && rawAction !== "escalate") ||
    typeof runId !== "string" ||
    typeof failureCode !== "string" ||
    typeof failureClass !== "string" ||
    typeof retryCount !== "number" ||
    typeof retryLimit !== "number"
  ) {
    return null;
  }

  return {
    phase: phaseCandidate,
    action: rawAction,
    runId,
    failureCode,
    failureClass: failureClass as import("@reddwarf/contracts").FailureClass,
    retryCount,
    retryLimit
  };
}

// ── Approval request summary ──────────────────────────────────────────────────

export function createApprovalRequestSummary(input: {
  policySnapshot: PolicySnapshot;
  requestedCapabilities: Capability[];
}): string {
  if (!input.requestedCapabilities.includes("can_use_secrets")) {
    return "Human approval is required before downstream execution can continue.";
  }

  if (input.policySnapshot.allowedSecretScopes.length > 0) {
    return `Human approval is required before downstream execution can continue. Approved secret scopes: ${input.policySnapshot.allowedSecretScopes.join(", ")}.`;
  }

  return "Human approval is required before downstream execution can continue. No secret scopes are currently approved for injection.";
}

// ── Secret lease helpers ──────────────────────────────────────────────────────

export async function scrubWorkspaceSecretLeaseOnPhaseExit(input: {
  repository: PlanningRepository;
  logger: PlanningPipelineLogger;
  taskId: string;
  runId: string;
  phase: Extract<TaskPhase, "development" | "validation" | "scm">;
  workspace: MaterializedManagedWorkspace;
  clock: () => Date;
  nextEventId: (phase: TaskPhase, code: string) => string;
}): Promise<void> {
  const scrubbed = await scrubManagedWorkspaceSecrets({
    workspace: input.workspace,
    scrubbedAt: asIsoTimestamp(input.clock())
  });

  if (!scrubbed.scrubbed) {
    return;
  }

  await recordRunEvent({
    repository: input.repository,
    logger: input.logger,
    eventId: input.nextEventId(input.phase, EventCodes.SECRET_LEASE_SCRUBBED),
    taskId: input.taskId,
    runId: input.runId,
    phase: input.phase,
    level: "info",
    code: EventCodes.SECRET_LEASE_SCRUBBED,
    message: `Scoped ${input.phase} credentials were scrubbed from the managed workspace.`,
    data: {
      workspaceId: input.workspace.workspaceId,
      removedSecretEnvFile: scrubbed.removed,
      scrubbedAt: scrubbed.scrubbedAt,
      injectedSecretKeys: scrubbed.descriptor.credentialPolicy.injectedSecretKeys
    },
    createdAt: scrubbed.scrubbedAt
  });
}

export async function issueWorkspaceSecretLease(input: {
  bundle: WorkspaceContextBundle;
  phase: "development" | "validation";
  secrets?: import("@reddwarf/integrations").SecretsAdapter;
  environment?: string;
}): Promise<import("@reddwarf/integrations").SecretLease | null> {
  const bundle = workspaceContextBundleSchema.parse(input.bundle);
  const allowedSecretScopes = bundle.policySnapshot.allowedSecretScopes;
  const secretsRequested =
    bundle.manifest.requestedCapabilities.includes("can_use_secrets") &&
    bundle.policySnapshot.allowedCapabilities.includes("can_use_secrets") &&
    allowedSecretScopes.length > 0;

  if (!secretsRequested) {
    return null;
  }

  if (!input.secrets) {
    throw new PlanningPipelineFailure({
      message: `Task ${bundle.manifest.taskId} is approved for scoped secrets (${allowedSecretScopes.join(", ")}), but no secrets adapter is configured.`,
      failureClass: phaseRegistry[input.phase].failureClass,
      phase: input.phase,
      code: EventCodes.SECRETS_ADAPTER_REQUIRED,
      details: {
        allowedSecretScopes,
        requestedCapabilities: bundle.manifest.requestedCapabilities
      },
      taskId: bundle.manifest.taskId,
      runId: null
    });
  }

  let lease: import("@reddwarf/integrations").SecretLease | null = null;

  try {
    lease = await input.secrets.issueTaskSecrets({
      taskId: bundle.manifest.taskId,
      repo: bundle.manifest.source.repo,
      agentType: bundle.manifest.assignedAgentType,
      phase: input.phase,
      environment: input.environment ?? "default",
      riskClass: bundle.manifest.riskClass,
      approvalMode: bundle.manifest.approvalMode,
      requestedCapabilities: bundle.manifest.requestedCapabilities,
      allowedSecretScopes
    });
  } catch (error) {
    throw new PlanningPipelineFailure({
      message: `Failed to issue scoped secrets for ${bundle.manifest.taskId} during ${input.phase}.`,
      failureClass: phaseRegistry[input.phase].failureClass,
      phase: input.phase,
      code: EventCodes.SECRET_LEASE_FAILED,
      details: {
        allowedSecretScopes,
        environment: input.environment ?? "default",
        cause: serializeError(error)
      },
      cause: error,
      taskId: bundle.manifest.taskId,
      runId: null
    });
  }

  if (!lease) {
    throw new PlanningPipelineFailure({
      message: `Scoped secrets were approved for ${bundle.manifest.taskId}, but the secrets adapter returned no lease.`,
      failureClass: phaseRegistry[input.phase].failureClass,
      phase: input.phase,
      code: EventCodes.SECRET_LEASE_MISSING,
      details: {
        allowedSecretScopes,
        environment: input.environment ?? "default"
      },
      taskId: bundle.manifest.taskId,
      runId: null
    });
  }

  return lease;
}

// Re-export taskManifestSchema for use within pipeline modules
export { taskManifestSchema };
