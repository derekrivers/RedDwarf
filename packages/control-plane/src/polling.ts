import {
  asIsoTimestamp,
  type ArchitectureReviewAgent,
  type DevelopmentAgent,
  type PlanningAgent,
  type ScmAgent,
  type TaskManifest,
  type ValidationAgent
} from "@reddwarf/contracts";
import { type PersistedTaskSnapshot } from "@reddwarf/evidence";
import {
  createGitHubIssuePollingCursor,
  type PlanningRepository
} from "@reddwarf/evidence";
import type {
  GitHubAdapter,
  GitHubIssueCandidate,
  GitHubIssueQuery,
  GitHubIssueState,
  OpenClawDispatchAdapter,
  SecretsAdapter
} from "@reddwarf/integrations";
import { bindPlanningLogger, type PlanningPipelineLogger } from "./logger.js";
import type {
  ArchitectureReviewCompletionAwaiter,
  OpenClawCompletionAwaiter,
  WorkspaceCommitPublisher,
  WorkspaceRepoBootstrapper
} from "./live-workflow.js";
import {
  dispatchReadyTask,
  runPlanningPipeline,
  type DispatchReadyTaskResult,
  type PlanningConcurrencyOptions
} from "./pipeline.js";
import { resolveUnmetTaskGroupDependencies } from "./task-groups.js";

export interface GitHubPollingRepoConfig {
  repo: string;
  labels?: string[];
  limit?: number;
  states?: GitHubIssueState[];
  maxBatchSize?: number;
  /**
   * Per-repository author allowlist.  When present, overrides the daemon-level
   * `authorAllowlist` for this repository.  An empty array means default-deny
   * (all authors rejected).  Omit the field entirely to inherit the daemon
   * setting.
   */
  authorAllowlist?: string[];
}

export interface GitHubIssuePollingDaemonConfig {
  intervalMs: number;
  repositories: GitHubPollingRepoConfig[];
  dryRun?: boolean;
  runOnStart?: boolean;
  cycleTimeoutMs?: number;
  /**
   * Global author allowlist applied to every polled repository unless
   * overridden by a per-repository `authorAllowlist`.
   *
   * When set to a non-empty array only issues authored by a listed GitHub
   * username are accepted; all others are silently skipped.  When set to an
   * empty array every issue is rejected (full default-deny).  When omitted
   * (or `undefined`) no author filtering is performed and all authors pass
   * through (backward-compatible default).
   *
   * May also be sourced from the `GITHUB_ISSUE_AUTHOR_ALLOWLIST` environment
   * variable (comma-separated usernames) via `parseAuthorAllowlistFromEnv`.
   */
  authorAllowlist?: string[];
}

export interface GitHubIssuePollingDecision {
  repo: string;
  issueNumber: number;
  action: "planned" | "skipped" | "rejected";
  reason?: "existing_planning_spec" | "author_not_allowlisted";
  taskId?: string;
  runId?: string;
}

export interface GitHubIssuePollingCycleResult {
  startedAt: string;
  completedAt: string;
  polledIssueCount: number;
  plannedIssueCount: number;
  skippedIssueCount: number;
  rejectedIssueCount: number;
  decisions: GitHubIssuePollingDecision[];
}

export interface PollingScheduler {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface PollingLoopHealthSnapshot {
  status: "idle" | "running" | "healthy" | "degraded";
  startupStatus: "idle" | "healthy" | "degraded";
  lastCycleStartedAt: string | null;
  lastCycleCompletedAt: string | null;
  lastCycleDurationMs: number | null;
  lastError: string | null;
}

export interface GitHubIssuePollingDependencies {
  repository: PlanningRepository;
  github: GitHubAdapter;
  planner: PlanningAgent;
  logger?: PlanningPipelineLogger;
  clock?: () => Date;
  idGenerator?: () => string;
  concurrency?: PlanningConcurrencyOptions;
  scheduler?: PollingScheduler;
}

export interface GitHubIssuePollingDaemon {
  readonly intervalMs: number;
  readonly isRunning: boolean;
  readonly consecutiveFailures: number;
  readonly health: PollingLoopHealthSnapshot;
  start(): Promise<void>;
  stop(): Promise<void>;
  pollOnce(): Promise<GitHubIssuePollingCycleResult>;
}

const defaultGitHubIssueStates: GitHubIssueState[] = ["open"];
const defaultPollingLabels = ["ai-eligible"];
const DEFAULT_MAX_BATCH_SIZE = 50;
const DEFAULT_POLLING_CYCLE_TIMEOUT_MS = 120_000;
const DEFAULT_DISPATCH_CYCLE_TIMEOUT_MS = 5 * 60_000;

interface MutableLoopHealthState {
  startupStatus: PollingLoopHealthSnapshot["startupStatus"];
  lastCycleStartedAt: string | null;
  lastCycleCompletedAt: string | null;
  lastCycleDurationMs: number | null;
  lastError: string | null;
}

function createMutableLoopHealthState(): MutableLoopHealthState {
  return {
    startupStatus: "idle",
    lastCycleStartedAt: null,
    lastCycleCompletedAt: null,
    lastCycleDurationMs: null,
    lastError: null
  };
}

function snapshotLoopHealth(input: {
  intervalHandle: unknown;
  cycleRunning: boolean;
  consecutiveFailures: number;
  healthState: MutableLoopHealthState;
}): PollingLoopHealthSnapshot {
  const status =
    input.intervalHandle === null
      ? "idle"
      : input.cycleRunning
        ? "running"
        : input.consecutiveFailures > 0 || input.healthState.startupStatus === "degraded"
          ? "degraded"
          : "healthy";

  return {
    status,
    startupStatus: input.healthState.startupStatus,
    lastCycleStartedAt: input.healthState.lastCycleStartedAt,
    lastCycleCompletedAt: input.healthState.lastCycleCompletedAt,
    lastCycleDurationMs: input.healthState.lastCycleDurationMs,
    lastError: input.healthState.lastError
  };
}

export function createGitHubIssuePollingDaemon(
  config: GitHubIssuePollingDaemonConfig,
  deps: GitHubIssuePollingDependencies
): GitHubIssuePollingDaemon {
  if (config.intervalMs < 1_000) {
    throw new Error("GitHub issue polling interval must be at least 1000ms.");
  }

  if (config.repositories.length === 0) {
    throw new Error("GitHub issue polling requires at least one repository.");
  }

  if ((config.cycleTimeoutMs ?? DEFAULT_POLLING_CYCLE_TIMEOUT_MS) < 1_000) {
    throw new Error("GitHub issue polling cycle timeout must be at least 1000ms.");
  }

  const clock = deps.clock ?? (() => new Date());
  const cycleTimeoutMs = config.cycleTimeoutMs ?? DEFAULT_POLLING_CYCLE_TIMEOUT_MS;
  const scheduler =
    deps.scheduler ??
    {
      setInterval: (callback: () => void, delayMs: number) =>
        globalThis.setInterval(callback, delayMs),
      clearInterval: (handle: unknown) =>
        globalThis.clearInterval(handle as NodeJS.Timeout)
    };
  const logger = deps.logger
    ? bindPlanningLogger(deps.logger, { component: "github-poller" })
    : undefined;

  let intervalHandle: unknown = null;
  let polling = false;
  let consecutiveFailures = 0;
  let nextAllowedPollAt = 0;
  const healthState = createMutableLoopHealthState();

  const MAX_BACKOFF_MS = 5 * 60_000;

  function computeBackoffMs(failures: number): number {
    if (failures <= 0) {
      return 0;
    }

    return Math.min(config.intervalMs * Math.pow(2, failures - 1), MAX_BACKOFF_MS);
  }

  async function pollRepository(
    repoConfig: GitHubPollingRepoConfig,
    decisions: GitHubIssuePollingDecision[]
  ): Promise<void> {
    let existingCursor: Awaited<
      ReturnType<PlanningRepository["getGitHubIssuePollingCursor"]>
    > = null;
    const pollStartedAt = clock();
    const pollStartedAtIso = asIsoTimestamp(pollStartedAt);
    const cycleLabel = `GitHub issue polling cycle for ${repoConfig.repo}`;
    const repoLogger = logger
      ? bindPlanningLogger(logger, { sourceRepo: repoConfig.repo })
      : undefined;

    try {
      await runWithTimeout(cycleLabel, cycleTimeoutMs, async () => {
        existingCursor = await deps.repository.getGitHubIssuePollingCursor(repoConfig.repo);

        const query: GitHubIssueQuery = {
          repo: repoConfig.repo,
          ...(repoConfig.labels !== undefined
            ? { labels: repoConfig.labels }
            : { labels: defaultPollingLabels }),
          ...(repoConfig.limit !== undefined ? { limit: repoConfig.limit } : {}),
          ...(repoConfig.states !== undefined
            ? { states: repoConfig.states }
            : { states: defaultGitHubIssueStates })
        };
        const candidates = await deps.github.listIssueCandidates(query);
        const batchSize = repoConfig.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
        const unseenCandidates = selectUnseenCandidates(
          candidates,
          existingCursor?.lastSeenIssueNumber ?? null
        ).slice(0, batchSize);

        repoLogger?.info("GitHub polling repository batch loaded.", {
          code: "POLLING_REPO_BATCH",
          candidateCount: candidates.length,
          unseenCandidateCount: unseenCandidates.length,
          batchSize
        });

        const effectiveAllowlist = resolveEffectiveAllowlist(repoConfig, config);

        for (const candidate of unseenCandidates) {
          if (!isAuthorAllowed(candidate, effectiveAllowlist)) {
            repoLogger?.info("GitHub issue rejected: author not in allowlist.", {
              code: "INTAKE_AUTHOR_REJECTED",
              repo: candidate.repo,
              issueNumber: candidate.issueNumber,
              author: candidate.author ?? null
            });
            decisions.push({
              repo: candidate.repo,
              issueNumber: candidate.issueNumber,
              action: "rejected",
              reason: "author_not_allowlisted"
            });
            continue;
          }

          const source: TaskManifest["source"] = {
            provider: "github",
            repo: candidate.repo,
            issueNumber: candidate.issueNumber,
            issueUrl: candidate.url
          };
          const existingSpec = await deps.repository.hasPlanningSpecForSource(source);

          if (existingSpec) {
            decisions.push({
              repo: candidate.repo,
              issueNumber: candidate.issueNumber,
              action: "skipped",
              reason: "existing_planning_spec"
            });
            continue;
          }

          const planningInput = await deps.github.convertToPlanningInput(candidate);
          const result = await runPlanningPipeline(
            {
              ...planningInput,
              dryRun: config.dryRun ?? planningInput.dryRun
            },
            {
            repository: deps.repository,
            planner: deps.planner,
            ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
            clock,
            ...(deps.idGenerator !== undefined ? { idGenerator: deps.idGenerator } : {}),
            ...(deps.concurrency !== undefined ? { concurrency: deps.concurrency } : {})
            }
          );

          decisions.push({
            repo: candidate.repo,
            issueNumber: candidate.issueNumber,
            action: "planned",
            taskId: result.manifest.taskId,
            runId: result.runId
          });
        }

        const lastSeenCandidate = unseenCandidates.at(-1) ?? null;
        const pollCompletedAtIso = asIsoTimestamp(clock());
        await deps.repository.saveGitHubIssuePollingCursor(
          createGitHubIssuePollingCursor({
            repo: repoConfig.repo,
            lastSeenIssueNumber:
              lastSeenCandidate?.issueNumber ??
              existingCursor?.lastSeenIssueNumber ??
              null,
            lastSeenUpdatedAt:
              lastSeenCandidate?.updatedAt ??
              existingCursor?.lastSeenUpdatedAt ??
              null,
            lastPollStartedAt: pollStartedAtIso,
            lastPollCompletedAt: pollCompletedAtIso,
            lastPollStatus: "succeeded",
            lastPollError: null,
            updatedAt: pollCompletedAtIso
          })
        );
      });
    } catch (error) {
      const failedAtIso = asIsoTimestamp(clock());

      try {
        await runWithTimeout(
          `GitHub issue polling cursor persistence for ${repoConfig.repo}`,
          cycleTimeoutMs,
          async () =>
            deps.repository.saveGitHubIssuePollingCursor(
              createGitHubIssuePollingCursor({
                repo: repoConfig.repo,
                lastSeenIssueNumber: existingCursor?.lastSeenIssueNumber ?? null,
                lastSeenUpdatedAt: existingCursor?.lastSeenUpdatedAt ?? null,
                lastPollStartedAt: pollStartedAtIso,
                lastPollCompletedAt: failedAtIso,
                lastPollStatus: "failed",
                lastPollError: serializePollingError(error),
                updatedAt: failedAtIso
              })
            )
        );
      } catch (cursorError) {
        repoLogger?.error(
          "Failed to persist GitHub issue polling cursor after poll failure.",
          {
            code: "POLLING_CURSOR_PERSIST_FAILED",
            originalError: serializePollingError(error),
            persistenceError: serializePollingError(cursorError)
          }
        );
      }

      throw error;
    }
  }

  async function pollOnce(): Promise<GitHubIssuePollingCycleResult> {
    if (polling) {
      throw new Error("GitHub issue polling cycle is already running.");
    }

    polling = true;
    const startedAt = clock();
    const startedAtIso = asIsoTimestamp(startedAt);
    const decisions: GitHubIssuePollingDecision[] = [];
    healthState.lastCycleStartedAt = startedAtIso;

    logger?.info("GitHub issue polling cycle started.", {
      code: "POLLING_CYCLE_STARTED",
      startedAt: startedAtIso,
      repositoryCount: config.repositories.length
    });

    try {
      for (const repoConfig of config.repositories) {
        await pollRepository(repoConfig, decisions);
      }

      consecutiveFailures = 0;
      nextAllowedPollAt = 0;
      healthState.startupStatus = intervalHandle === null && config.runOnStart === false
        ? "idle"
        : "healthy";
      healthState.lastError = null;

      const completedAt = clock();
      const completedAtIso = asIsoTimestamp(completedAt);
      const durationMs = completedAt.getTime() - startedAt.getTime();
      healthState.lastCycleCompletedAt = completedAtIso;
      healthState.lastCycleDurationMs = durationMs;

      const result = {
        startedAt: startedAtIso,
        completedAt: completedAtIso,
        polledIssueCount: decisions.length,
        plannedIssueCount: decisions.filter((decision) => decision.action === "planned").length,
        skippedIssueCount: decisions.filter((decision) => decision.action === "skipped").length,
        rejectedIssueCount: decisions.filter((decision) => decision.action === "rejected").length,
        decisions
      } satisfies GitHubIssuePollingCycleResult;

      logger?.info("GitHub issue polling cycle completed.", {
        code: "POLLING_CYCLE_COMPLETED",
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        durationMs,
        polledIssueCount: result.polledIssueCount,
        plannedIssueCount: result.plannedIssueCount,
        skippedIssueCount: result.skippedIssueCount,
        rejectedIssueCount: result.rejectedIssueCount
      });

      return result;
    } catch (error) {
      consecutiveFailures += 1;
      const backoffMs = computeBackoffMs(consecutiveFailures);
      const completedAt = clock();
      nextAllowedPollAt = completedAt.getTime() + backoffMs;
      const completedAtIso = asIsoTimestamp(completedAt);
      const durationMs = completedAt.getTime() - startedAt.getTime();
      const serializedError = serializePollingError(error);
      healthState.startupStatus = "degraded";
      healthState.lastCycleCompletedAt = completedAtIso;
      healthState.lastCycleDurationMs = durationMs;
      healthState.lastError = serializedError;

      logger?.error("GitHub issue polling cycle failed.", {
        code: "POLLING_CYCLE_FAILED",
        startedAt: startedAtIso,
        completedAt: completedAtIso,
        durationMs,
        error: serializedError,
        consecutiveFailures,
        backoffMs
      });
      throw error;
    } finally {
      polling = false;
    }
  }

  return {
    get intervalMs() {
      return config.intervalMs;
    },
    get isRunning() {
      return intervalHandle !== null;
    },
    get consecutiveFailures() {
      return consecutiveFailures;
    },
    get health() {
      return snapshotLoopHealth({
        intervalHandle,
        cycleRunning: polling,
        consecutiveFailures,
        healthState
      });
    },
    async start(): Promise<void> {
      if (intervalHandle !== null) {
        return;
      }

      intervalHandle = scheduler.setInterval(() => {
        const now = clock().getTime();
        if (now < nextAllowedPollAt) {
          logger?.warn("GitHub issue polling cycle skipped due to backoff.", {
            code: "POLLING_CYCLE_BACKOFF",
            consecutiveFailures,
            resumesInMs: nextAllowedPollAt - now
          });
          return;
        }

        void pollOnce().catch(() => {
          // Error already logged and backoff applied inside pollOnce
        });
      }, config.intervalMs);

      if (config.runOnStart === false) {
        return;
      }

      try {
        await pollOnce();
        logger?.info("GitHub issue polling daemon startup cycle completed.", {
          code: "POLLING_STARTUP_COMPLETED",
          consecutiveFailures
        });
      } catch (error) {
        logger?.warn(
          "GitHub issue polling daemon started in degraded mode after startup cycle failure.",
          {
            code: "POLLING_STARTUP_DEGRADED",
            error: serializePollingError(error),
            consecutiveFailures,
            resumesInMs: Math.max(0, nextAllowedPollAt - clock().getTime())
          }
        );
      }
    },
    async stop(): Promise<void> {
      if (intervalHandle === null) {
        return;
      }

      scheduler.clearInterval(intervalHandle);
      intervalHandle = null;
      consecutiveFailures = 0;
      nextAllowedPollAt = 0;
      healthState.startupStatus = "idle";
      healthState.lastError = null;
    },
    pollOnce
  };
}

function selectUnseenCandidates(
  candidates: GitHubIssueCandidate[],
  lastSeenIssueNumber: number | null
): GitHubIssueCandidate[] {
  return candidates
    .filter((candidate) =>
      lastSeenIssueNumber === null
        ? true
        : candidate.issueNumber > lastSeenIssueNumber
    )
    .sort((left, right) => left.issueNumber - right.issueNumber);
}

/**
 * Returns `true` when the candidate's author is permitted given the configured
 * allowlist, `false` when it should be rejected.
 *
 * - `undefined` allowlist  â†’ no filtering; all authors pass.
 * - empty array            â†’ full default-deny; all authors rejected.
 * - non-empty array        â†’ only listed usernames pass (case-insensitive).
 */
function isAuthorAllowed(
  candidate: GitHubIssueCandidate,
  allowlist: string[] | undefined
): boolean {
  if (allowlist === undefined) {
    return true;
  }

  if (allowlist.length === 0) {
    return false;
  }

  const author = candidate.author;
  if (!author) {
    // No author metadata available; treat as disallowed when a list is set.
    return false;
  }

  const lowerAuthor = author.toLowerCase();
  return allowlist.some((entry) => entry.toLowerCase() === lowerAuthor);
}

/**
 * Resolves the effective author allowlist for a repository by merging the
 * per-repo override (if present) with the daemon-level default.
 *
 * Per-repo `authorAllowlist` always wins over the daemon-level setting,
 * including when the per-repo value is an empty array.
 */
function resolveEffectiveAllowlist(
  repoConfig: GitHubPollingRepoConfig,
  daemonConfig: GitHubIssuePollingDaemonConfig
): string[] | undefined {
  if (repoConfig.authorAllowlist !== undefined) {
    return repoConfig.authorAllowlist;
  }

  return daemonConfig.authorAllowlist;
}

/**
 * Parse the `GITHUB_ISSUE_AUTHOR_ALLOWLIST` environment variable into an
 * author allowlist array suitable for `GitHubIssuePollingDaemonConfig.authorAllowlist`.
 *
 * The variable is expected to be a comma-separated list of GitHub usernames.
 * Leading/trailing whitespace around each entry is stripped.  Empty entries
 * after stripping are discarded.
 *
 * Returns `undefined` when the variable is absent or blank so callers can
 * distinguish "not configured" from "configured as empty".
 *
 * @param envValue - Optionally provide the raw env string directly (useful for
 *   testing without mutating `process.env`).  Defaults to
 *   `process.env.GITHUB_ISSUE_AUTHOR_ALLOWLIST`.
 */
export function parseAuthorAllowlistFromEnv(envValue?: string): string[] | undefined {
  const raw = envValue ?? process.env.GITHUB_ISSUE_AUTHOR_ALLOWLIST;

  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }

  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return entries;
}

function serializePollingError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ReadyTaskDispatcherConfig {
  intervalMs: number;
  targetRoot: string;
  evidenceRoot?: string;
  runOnStart?: boolean;
  cycleTimeoutMs?: number;
}

export interface ReadyTaskDispatcherDependencies {
  repository: PlanningRepository;
  developer: DevelopmentAgent;
  reviewer: ArchitectureReviewAgent;
  validator: ValidationAgent;
  scm: ScmAgent;
  github: GitHubAdapter;
  openClawDispatch: OpenClawDispatchAdapter;
  secrets?: SecretsAdapter;
  workspaceRepoBootstrapper?: WorkspaceRepoBootstrapper;
  openClawCompletionAwaiter?: OpenClawCompletionAwaiter;
  architectureReviewAwaiter?: ArchitectureReviewCompletionAwaiter;
  openClawReviewAgentId?: string;
  workspaceCommitPublisher?: WorkspaceCommitPublisher;
  logger?: PlanningPipelineLogger;
  clock?: () => Date;
  concurrency?: PlanningConcurrencyOptions;
  scheduler?: PollingScheduler;
}

export interface ReadyTaskDispatchCycleResult {
  startedAt: string;
  completedAt: string;
  dispatchedCount: number;
  results: DispatchReadyTaskResult[];
}

export interface ReadyTaskDispatcher {
  readonly intervalMs: number;
  readonly isRunning: boolean;
  readonly consecutiveFailures: number;
  readonly lastDispatchResult: DispatchReadyTaskResult | null;
  readonly health: PollingLoopHealthSnapshot;
  start(): Promise<void>;
  stop(): Promise<void>;
  dispatchOnce(): Promise<ReadyTaskDispatchCycleResult>;
}

function isRecoverableDispatchPhase(
  phase: TaskManifest["currentPhase"]
): phase is "development" | "validation" | "scm" {
  return phase === "development" || phase === "validation" || phase === "scm";
}

function hasPendingFailureEscalationRequest(
  snapshot: PersistedTaskSnapshot,
  phase: "development" | "validation" | "scm"
): boolean {
  return snapshot.approvalRequests.some(
    (request) =>
      request.phase === phase &&
      request.status === "pending" &&
      request.requestedBy === "failure-automation"
  );
}

function hasAutomatedRetryRecovery(
  snapshot: PersistedTaskSnapshot,
  phase: "development" | "validation" | "scm"
): boolean {
  const recoveryRecord = snapshot.memoryRecords.find(
    (record) => record.key === "failure.recovery"
  );
  const value = recoveryRecord?.value;

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const objectValue = value as Record<string, unknown>;
  return (
    objectValue["action"] === "retry" &&
    objectValue["phase"] === phase &&
    !hasPendingFailureEscalationRequest(snapshot, phase)
  );
}

async function findNextDispatchableManifest(
  repository: PlanningRepository,
  logger: import("./logger.js").PlanningPipelineLogger | undefined,
  blockedScanLimit = 25
): Promise<{ manifest: TaskManifest; selection: "ready" | "blocked_retry" } | null> {
  const blockedManifests = await repository.listManifestsByLifecycleStatus(
    "blocked",
    blockedScanLimit
  );

  for (const manifest of blockedManifests) {
    if (!isRecoverableDispatchPhase(manifest.currentPhase)) {
      continue;
    }

    const snapshot = await repository.getTaskSnapshot(manifest.taskId);
    if (hasAutomatedRetryRecovery(snapshot, manifest.currentPhase)) {
      return {
        manifest,
        selection: "blocked_retry"
      };
    }
  }

  const readyManifests = await repository.listManifestsByLifecycleStatus(
    "ready",
    blockedScanLimit
  );

  for (const manifest of readyManifests) {

    // Guard against orphaned ready manifests whose approved planning approval
    // row was deleted.  If we dispatched these they would fail inside
    // requireApprovedRequest and the manifest would stay ready, causing the
    // dispatcher to loop on it indefinitely.  Skip and log; the operator
    // should run the orphan sweep to mark these as failed.
    if (manifest.approvalMode !== "auto") {
      const snapshot = await repository.getTaskSnapshot(manifest.taskId);
      const hasApprovedRequest = snapshot.approvalRequests.some(
        (r) => r.status === "approved"
      );

      if (!hasApprovedRequest) {
        logger?.warn(
          "Skipping orphaned ready manifest: no approved planning approval row found. " +
          "Run POST /maintenance/reconcile-orphaned-state to repair.",
          {
            code: "DISPATCH_ORPHAN_SKIPPED",
            taskId: manifest.taskId,
            approvalMode: manifest.approvalMode
          }
        );
        continue;
      }
    }

    const dependencyState = await resolveUnmetTaskGroupDependencies(
      repository,
      manifest
    );
    if (dependencyState.unmetDependencies.length > 0) {
      logger?.info("Skipping ready grouped task until dependencies complete.", {
        code: "DISPATCH_GROUP_WAITING",
        taskId: manifest.taskId,
        groupId: dependencyState.membership?.groupId ?? null,
        unmetDependencies: dependencyState.unmetDependencies
      });
      continue;
    }

    return {
      manifest,
      selection: "ready"
    };
  }

  return null;
}

export function createReadyTaskDispatcher(
  config: ReadyTaskDispatcherConfig,
  deps: ReadyTaskDispatcherDependencies
): ReadyTaskDispatcher {
  if (config.intervalMs < 1_000) {
    throw new Error("Ready-task dispatch interval must be at least 1000ms.");
  }

  if ((config.cycleTimeoutMs ?? DEFAULT_DISPATCH_CYCLE_TIMEOUT_MS) < 1_000) {
    throw new Error("Ready-task dispatch cycle timeout must be at least 1000ms.");
  }

  const clock = deps.clock ?? (() => new Date());
  const cycleTimeoutMs = config.cycleTimeoutMs ?? DEFAULT_DISPATCH_CYCLE_TIMEOUT_MS;
  const scheduler =
    deps.scheduler ??
    {
      setInterval: (callback: () => void, delayMs: number) =>
        globalThis.setInterval(callback, delayMs),
      clearInterval: (handle: unknown) =>
        globalThis.clearInterval(handle as NodeJS.Timeout)
    };
  const logger = deps.logger
    ? bindPlanningLogger(deps.logger, { component: "ready-dispatcher" })
    : undefined;

  let intervalHandle: unknown = null;
  let dispatching = false;
  let consecutiveFailures = 0;
  let nextAllowedDispatchAt = 0;
  let lastResult: DispatchReadyTaskResult | null = null;
  const healthState = createMutableLoopHealthState();

  const MAX_BACKOFF_MS = 5 * 60_000;

  function computeBackoffMs(failures: number): number {
    if (failures <= 0) {
      return 0;
    }

    return Math.min(config.intervalMs * Math.pow(2, failures - 1), MAX_BACKOFF_MS);
  }

  async function dispatchOnce(): Promise<ReadyTaskDispatchCycleResult> {
    if (dispatching) {
      throw new Error("Ready-task dispatch cycle is already running.");
    }

    dispatching = true;
    const startedAt = clock();
    const startedAtIso = asIsoTimestamp(startedAt);
    healthState.lastCycleStartedAt = startedAtIso;

    logger?.info("Ready-task dispatch cycle started.", {
      code: "DISPATCH_CYCLE_STARTED",
      startedAt: startedAtIso
    });

    try {
      const results = await runWithTimeout(
        "Ready-task dispatch cycle",
        cycleTimeoutMs,
        async () => {
          const cycleResults: DispatchReadyTaskResult[] = [];
          const selectedManifest = await findNextDispatchableManifest(
            deps.repository,
            logger
          );

          if (selectedManifest) {
            const { manifest, selection } = selectedManifest;
            const taskLogger = logger
              ? bindPlanningLogger(logger, {
                  taskId: manifest.taskId,
                  sourceRepo: manifest.source.repo
                })
              : undefined;

            taskLogger?.info(
              selection === "ready"
                ? "Found ready task for dispatch."
                : "Found blocked retry task for dispatch.",
              {
                code:
                  selection === "ready"
                    ? "DISPATCH_READY_TASK_FOUND"
                    : "DISPATCH_BLOCKED_RETRY_TASK_FOUND",
                currentPhase: manifest.currentPhase,
                lifecycleStatus: manifest.lifecycleStatus
              }
            );

            const result = await runWithTimeout(
              `Ready-task dispatch cycle for ${manifest.taskId}`,
              cycleTimeoutMs,
              async () =>
                dispatchReadyTask(
                  {
                    taskId: manifest.taskId,
                    targetRoot: config.targetRoot,
                    ...(config.evidenceRoot ? { evidenceRoot: config.evidenceRoot } : {})
                  },
                  {
                    repository: deps.repository,
                    developer: deps.developer,
                    reviewer: deps.reviewer,
                    validator: deps.validator,
                    scm: deps.scm,
                    github: deps.github,
                    openClawDispatch: deps.openClawDispatch,
                    ...(deps.secrets ? { secrets: deps.secrets } : {}),
                    ...(deps.workspaceRepoBootstrapper
                      ? { workspaceRepoBootstrapper: deps.workspaceRepoBootstrapper }
                      : {}),
                    ...(deps.openClawCompletionAwaiter
                      ? { openClawCompletionAwaiter: deps.openClawCompletionAwaiter }
                      : {}),
                    ...(deps.architectureReviewAwaiter
                      ? { architectureReviewAwaiter: deps.architectureReviewAwaiter }
                      : {}),
                    ...(deps.openClawReviewAgentId
                      ? { openClawReviewAgentId: deps.openClawReviewAgentId }
                      : {}),
                    ...(deps.workspaceCommitPublisher
                      ? { workspaceCommitPublisher: deps.workspaceCommitPublisher }
                      : {}),
                    ...(deps.logger ? { logger: deps.logger } : {}),
                    ...(deps.clock ? { clock: deps.clock } : {}),
                    ...(deps.concurrency ? { concurrency: deps.concurrency } : {})
                  }
                )
            );

            cycleResults.push(result);
            lastResult = result;

            taskLogger?.info("Task dispatch completed.", {
              code: "DISPATCH_TASK_COMPLETED",
              outcome: result.outcome,
              phasesExecuted: result.phasesExecuted,
              finalPhase: result.finalPhase,
              pullRequestUrl: result.pullRequestUrl,
              lifecycleStatus: manifest.lifecycleStatus,
              selection
            });
          }

          return cycleResults;
        }
      );

      consecutiveFailures = 0;
      nextAllowedDispatchAt = 0;
      healthState.startupStatus = intervalHandle === null && config.runOnStart === false
        ? "idle"
        : "healthy";
      healthState.lastError = null;

      const completedAt = clock();
      const completedAtIso = asIsoTimestamp(completedAt);
      const durationMs = completedAt.getTime() - startedAt.getTime();
      healthState.lastCycleCompletedAt = completedAtIso;
      healthState.lastCycleDurationMs = durationMs;

      const result = {
        startedAt: startedAtIso,
        completedAt: completedAtIso,
        dispatchedCount: results.length,
        results
      } satisfies ReadyTaskDispatchCycleResult;

      logger?.info("Ready-task dispatch cycle completed.", {
        code: "DISPATCH_CYCLE_COMPLETED",
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        durationMs,
        dispatchedCount: result.dispatchedCount
      });

      return result;
    } catch (error) {
      consecutiveFailures += 1;
      const backoffMs = computeBackoffMs(consecutiveFailures);
      const completedAt = clock();
      nextAllowedDispatchAt = completedAt.getTime() + backoffMs;
      const completedAtIso = asIsoTimestamp(completedAt);
      const durationMs = completedAt.getTime() - startedAt.getTime();
      const serializedError = serializePollingError(error);
      healthState.startupStatus = "degraded";
      healthState.lastCycleCompletedAt = completedAtIso;
      healthState.lastCycleDurationMs = durationMs;
      healthState.lastError = serializedError;

      logger?.error("Ready-task dispatch cycle failed.", {
        code: "DISPATCH_CYCLE_FAILED",
        startedAt: startedAtIso,
        completedAt: completedAtIso,
        durationMs,
        error: serializedError,
        consecutiveFailures,
        backoffMs
      });
      throw error;
    } finally {
      dispatching = false;
    }
  }

  return {
    get intervalMs() {
      return config.intervalMs;
    },
    get isRunning() {
      return intervalHandle !== null;
    },
    get consecutiveFailures() {
      return consecutiveFailures;
    },
    get lastDispatchResult() {
      return lastResult;
    },
    get health() {
      return snapshotLoopHealth({
        intervalHandle,
        cycleRunning: dispatching,
        consecutiveFailures,
        healthState
      });
    },
    async start(): Promise<void> {
      if (intervalHandle !== null) {
        return;
      }

      intervalHandle = scheduler.setInterval(() => {
        const now = clock().getTime();
        if (now < nextAllowedDispatchAt) {
          logger?.warn("Ready-task dispatch cycle skipped due to backoff.", {
            code: "DISPATCH_CYCLE_BACKOFF",
            consecutiveFailures,
            resumesInMs: nextAllowedDispatchAt - now
          });
          return;
        }

        void dispatchOnce().catch(() => {
          // Error already logged and backoff applied inside dispatchOnce
        });
      }, config.intervalMs);

      if (config.runOnStart === false) {
        return;
      }

      try {
        await dispatchOnce();
        logger?.info("Ready-task dispatcher startup cycle completed.", {
          code: "DISPATCH_STARTUP_COMPLETED",
          consecutiveFailures
        });
      } catch (error) {
        logger?.warn(
          "Ready-task dispatcher started in degraded mode after startup cycle failure.",
          {
            code: "DISPATCH_STARTUP_DEGRADED",
            error: serializePollingError(error),
            consecutiveFailures,
            resumesInMs: Math.max(0, nextAllowedDispatchAt - clock().getTime())
          }
        );
      }
    },
    async stop(): Promise<void> {
      if (intervalHandle === null) {
        return;
      }

      scheduler.clearInterval(intervalHandle);
      intervalHandle = null;
      consecutiveFailures = 0;
      nextAllowedDispatchAt = 0;
      healthState.startupStatus = "idle";
      healthState.lastError = null;
    },
    dispatchOnce
  };
}

function runWithTimeout<T>(
  label: string,
  timeoutMs: number,
  operation: () => Promise<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    void operation()
      .then((result) => {
        if (settled) {
          return;
        }

        settled = true;
        globalThis.clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        if (settled) {
          return;
        }

        settled = true;
        globalThis.clearTimeout(timer);
        reject(error);
      });
  });
}
