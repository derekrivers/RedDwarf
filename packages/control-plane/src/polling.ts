import {
  asIsoTimestamp,
  type DevelopmentAgent,
  type PlanningAgent,
  type ScmAgent,
  type TaskManifest,
  type ValidationAgent
} from "@reddwarf/contracts";
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

export interface GitHubPollingRepoConfig {
  repo: string;
  labels?: string[];
  limit?: number;
  states?: GitHubIssueState[];
  maxBatchSize?: number;
}

export interface GitHubIssuePollingDaemonConfig {
  intervalMs: number;
  repositories: GitHubPollingRepoConfig[];
  runOnStart?: boolean;
  cycleTimeoutMs?: number;
}

export interface GitHubIssuePollingDecision {
  repo: string;
  issueNumber: number;
  action: "planned" | "skipped";
  reason?: "existing_planning_spec";
  taskId?: string;
  runId?: string;
}

export interface GitHubIssuePollingCycleResult {
  startedAt: string;
  completedAt: string;
  polledIssueCount: number;
  plannedIssueCount: number;
  skippedIssueCount: number;
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

        for (const candidate of unseenCandidates) {
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
          const result = await runPlanningPipeline(planningInput, {
            repository: deps.repository,
            planner: deps.planner,
            ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
            clock,
            ...(deps.idGenerator !== undefined ? { idGenerator: deps.idGenerator } : {}),
            ...(deps.concurrency !== undefined ? { concurrency: deps.concurrency } : {})
          });

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
        decisions
      } satisfies GitHubIssuePollingCycleResult;

      logger?.info("GitHub issue polling cycle completed.", {
        code: "POLLING_CYCLE_COMPLETED",
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        durationMs,
        polledIssueCount: result.polledIssueCount,
        plannedIssueCount: result.plannedIssueCount,
        skippedIssueCount: result.skippedIssueCount
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
  validator: ValidationAgent;
  scm: ScmAgent;
  github: GitHubAdapter;
  openClawDispatch: OpenClawDispatchAdapter;
  secrets?: SecretsAdapter;
  workspaceRepoBootstrapper?: WorkspaceRepoBootstrapper;
  openClawCompletionAwaiter?: OpenClawCompletionAwaiter;
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
          const readyManifests = await deps.repository.listManifestsByLifecycleStatus("ready", 1);

          if (readyManifests.length > 0) {
            const manifest = readyManifests[0]!;
            const taskLogger = logger
              ? bindPlanningLogger(logger, {
                  taskId: manifest.taskId,
                  sourceRepo: manifest.source.repo
                })
              : undefined;

            taskLogger?.info("Found ready task for dispatch.", {
              code: "DISPATCH_READY_TASK_FOUND",
              currentPhase: manifest.currentPhase
            });

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
              pullRequestUrl: result.pullRequestUrl
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
