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
import type { PlanningPipelineLogger } from "./logger.js";
import type { OpenClawCompletionAwaiter, WorkspaceCommitPublisher, WorkspaceRepoBootstrapper } from "./live-workflow.js";
import { dispatchReadyTask, type DispatchReadyTaskResult, type PlanningConcurrencyOptions } from "./pipeline.js";
import { runPlanningPipeline } from "./pipeline.js";

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
  start(): Promise<void>;
  stop(): Promise<void>;
  pollOnce(): Promise<GitHubIssuePollingCycleResult>;
}

const defaultGitHubIssueStates: GitHubIssueState[] = ["open"];
const defaultPollingLabels = ["ai-eligible"];
const DEFAULT_MAX_BATCH_SIZE = 50;
const DEFAULT_POLLING_CYCLE_TIMEOUT_MS = 120_000;
const DEFAULT_DISPATCH_CYCLE_TIMEOUT_MS = 5 * 60_000;

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
  const cycleTimeoutMs =
    config.cycleTimeoutMs ?? DEFAULT_POLLING_CYCLE_TIMEOUT_MS;
  const scheduler = deps.scheduler ?? {
    setInterval: (callback: () => void, delayMs: number) =>
      globalThis.setInterval(callback, delayMs),
    clearInterval: (handle: unknown) =>
      globalThis.clearInterval(handle as NodeJS.Timeout)
  };
  let intervalHandle: unknown = null;
  let polling = false;
  let consecutiveFailures = 0;
  let nextAllowedPollAt = 0;

  const MAX_BACKOFF_MS = 5 * 60_000;

  function computeBackoffMs(failures: number): number {
    if (failures <= 0) return 0;
    const baseMs = Math.min(config.intervalMs * Math.pow(2, failures - 1), MAX_BACKOFF_MS);
    return baseMs;
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

    try {
      await runWithTimeout(cycleLabel, cycleTimeoutMs, async () => {
        existingCursor = await deps.repository.getGitHubIssuePollingCursor(
          repoConfig.repo
        );

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

        for (const candidate of unseenCandidates) {
          const source: TaskManifest["source"] = {
            provider: "github",
            repo: candidate.repo,
            issueNumber: candidate.issueNumber,
            issueUrl: candidate.url
          };
          const existingSpec = await deps.repository.hasPlanningSpecForSource(
            source
          );

          if (existingSpec) {
            decisions.push({
              repo: candidate.repo,
              issueNumber: candidate.issueNumber,
              action: "skipped",
              reason: "existing_planning_spec"
            });
            continue;
          }

          const planningInput = await deps.github.convertToPlanningInput(
            candidate
          );
          const result = await runPlanningPipeline(planningInput, {
            repository: deps.repository,
            planner: deps.planner,
            ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
            clock,
            ...(deps.idGenerator !== undefined
              ? { idGenerator: deps.idGenerator }
              : {}),
            ...(deps.concurrency !== undefined
              ? { concurrency: deps.concurrency }
              : {})
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
        deps.logger?.error(
          "Failed to persist GitHub issue polling cursor after poll failure.",
          {
            repo: repoConfig.repo,
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
    const decisions: GitHubIssuePollingDecision[] = [];

    try {
      for (const repoConfig of config.repositories) {
        await pollRepository(repoConfig, decisions);
      }
      consecutiveFailures = 0;
      nextAllowedPollAt = 0;
    } catch (error) {
      consecutiveFailures++;
      const backoffMs = computeBackoffMs(consecutiveFailures);
      nextAllowedPollAt = clock().getTime() + backoffMs;
      deps.logger?.error("GitHub issue polling cycle failed.", {
        error: serializePollingError(error),
        consecutiveFailures,
        backoffMs
      });
      throw error;
    } finally {
      polling = false;
    }

    const completedAt = clock();
    return {
      startedAt: asIsoTimestamp(startedAt),
      completedAt: asIsoTimestamp(completedAt),
      polledIssueCount: decisions.length,
      plannedIssueCount: decisions.filter((decision) => decision.action === "planned").length,
      skippedIssueCount: decisions.filter((decision) => decision.action === "skipped").length,
      decisions
    };
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
    async start(): Promise<void> {
      if (intervalHandle !== null) {
        return;
      }

      intervalHandle = scheduler.setInterval(() => {
        const now = clock().getTime();
        if (now < nextAllowedPollAt) {
          deps.logger?.info("GitHub issue polling cycle skipped due to backoff.", {
            consecutiveFailures,
            resumesInMs: nextAllowedPollAt - now
          });
          return;
        }
        void pollOnce().catch(() => {
          // Error already logged and backoff applied inside pollOnce
        });
      }, config.intervalMs);

      if (config.runOnStart !== false) {
        await pollOnce();
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

// ══════════════════════════════════════════════════════════════════════════════
// Ready-task dispatcher
// ══════════════════════════════════════════════════════════════════════════════

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
  const cycleTimeoutMs =
    config.cycleTimeoutMs ?? DEFAULT_DISPATCH_CYCLE_TIMEOUT_MS;
  const scheduler = deps.scheduler ?? {
    setInterval: (callback: () => void, delayMs: number) =>
      globalThis.setInterval(callback, delayMs),
    clearInterval: (handle: unknown) =>
      globalThis.clearInterval(handle as NodeJS.Timeout)
  };

  let intervalHandle: unknown = null;
  let dispatching = false;
  let consecutiveFailures = 0;
  let nextAllowedDispatchAt = 0;
  let lastResult: DispatchReadyTaskResult | null = null;

  const MAX_BACKOFF_MS = 5 * 60_000;

  function computeBackoffMs(failures: number): number {
    if (failures <= 0) return 0;
    return Math.min(config.intervalMs * Math.pow(2, failures - 1), MAX_BACKOFF_MS);
  }

  async function dispatchOnce(): Promise<ReadyTaskDispatchCycleResult> {
    if (dispatching) {
      throw new Error("Ready-task dispatch cycle is already running.");
    }

    dispatching = true;
    const startedAt = clock();

    try {
      const results = await runWithTimeout(
        "Ready-task dispatch cycle",
        cycleTimeoutMs,
        async () => {
          const cycleResults: DispatchReadyTaskResult[] = [];

          // Find the oldest ready manifest (one at a time)
          const readyManifests =
            await deps.repository.listManifestsByLifecycleStatus("ready", 1);

          if (readyManifests.length > 0) {
            const manifest = readyManifests[0]!;

            deps.logger?.info("Found ready task for dispatch.", {
              taskId: manifest.taskId,
              sourceRepo: manifest.source.repo,
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
                    ...(config.evidenceRoot
                      ? { evidenceRoot: config.evidenceRoot }
                      : {})
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
                      ? {
                          workspaceRepoBootstrapper:
                            deps.workspaceRepoBootstrapper
                        }
                      : {}),
                    ...(deps.openClawCompletionAwaiter
                      ? {
                          openClawCompletionAwaiter:
                            deps.openClawCompletionAwaiter
                        }
                      : {}),
                    ...(deps.workspaceCommitPublisher
                      ? {
                          workspaceCommitPublisher:
                            deps.workspaceCommitPublisher
                        }
                      : {}),
                    ...(deps.logger ? { logger: deps.logger } : {}),
                    ...(deps.clock ? { clock: deps.clock } : {}),
                    ...(deps.concurrency
                      ? { concurrency: deps.concurrency }
                      : {})
                  }
                )
            );

            cycleResults.push(result);
            lastResult = result;

            deps.logger?.info("Task dispatch completed.", {
              taskId: result.taskId,
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

      const completedAt = clock();
      return {
        startedAt: asIsoTimestamp(startedAt),
        completedAt: asIsoTimestamp(completedAt),
        dispatchedCount: results.length,
        results
      };
    } catch (error) {
      consecutiveFailures++;
      const backoffMs = computeBackoffMs(consecutiveFailures);
      nextAllowedDispatchAt = clock().getTime() + backoffMs;
      deps.logger?.error("Ready-task dispatch cycle failed.", {
        error: serializePollingError(error),
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
    async start(): Promise<void> {
      if (intervalHandle !== null) {
        return;
      }

      intervalHandle = scheduler.setInterval(() => {
        const now = clock().getTime();
        if (now < nextAllowedDispatchAt) {
          deps.logger?.info("Ready-task dispatch cycle skipped due to backoff.", {
            consecutiveFailures,
            resumesInMs: nextAllowedDispatchAt - now
          });
          return;
        }
        void dispatchOnce().catch(() => {
          // Error already logged and backoff applied inside dispatchOnce
        });
      }, config.intervalMs);

      if (config.runOnStart !== false) {
        await dispatchOnce();
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
