import { asIsoTimestamp, type PlanningAgent, type TaskManifest } from "@reddwarf/contracts";
import type {
  GitHubAdapter,
  GitHubIssueQuery,
  GitHubIssueState
} from "@reddwarf/integrations";
import type { PlanningRepository } from "@reddwarf/evidence";
import type { PlanningPipelineLogger } from "./logger.js";
import { runPlanningPipeline, type PlanningConcurrencyOptions } from "./pipeline.js";

export interface GitHubPollingRepoConfig {
  repo: string;
  labels?: string[];
  limit?: number;
  states?: GitHubIssueState[];
}

export interface GitHubIssuePollingDaemonConfig {
  intervalMs: number;
  repositories: GitHubPollingRepoConfig[];
  runOnStart?: boolean;
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
  start(): Promise<void>;
  stop(): Promise<void>;
  pollOnce(): Promise<GitHubIssuePollingCycleResult>;
}

const defaultGitHubIssueStates: GitHubIssueState[] = ["open"];
const defaultPollingLabels = ["ai-eligible"];

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

  const clock = deps.clock ?? (() => new Date());
  const scheduler = deps.scheduler ?? {
    setInterval: (callback: () => void, delayMs: number) =>
      globalThis.setInterval(callback, delayMs),
    clearInterval: (handle: unknown) =>
      globalThis.clearInterval(handle as NodeJS.Timeout)
  };
  let intervalHandle: unknown = null;
  let polling = false;

  async function pollOnce(): Promise<GitHubIssuePollingCycleResult> {
    if (polling) {
      throw new Error("GitHub issue polling cycle is already running.");
    }

    polling = true;
    const startedAt = clock();
    const decisions: GitHubIssuePollingDecision[] = [];

    try {
      for (const repoConfig of config.repositories) {
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

        for (const candidate of candidates.sort((left, right) => left.issueNumber - right.issueNumber)) {
          const source: TaskManifest["source"] = {
            provider: "github",
            repo: candidate.repo,
            issueNumber: candidate.issueNumber,
            issueUrl: candidate.url
          };
          const existing = await deps.repository.hasPlanningSpecForSource(source);

          if (existing) {
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
      }
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
    async start(): Promise<void> {
      if (intervalHandle !== null) {
        return;
      }

      intervalHandle = scheduler.setInterval(() => {
        void pollOnce().catch((error) =>
          deps.logger?.error("GitHub issue polling cycle failed.", {
            error: error instanceof Error ? error.message : String(error)
          })
        );
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
    },
    pollOnce
  };
}

