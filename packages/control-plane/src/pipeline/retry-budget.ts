import {
  phaseRetryBudgetStateSchema,
  type PhaseRetryBudgetState,
  type RetryBudgetConfig
} from "@reddwarf/contracts";
import type { PersistedTaskSnapshot } from "@reddwarf/evidence";
import type { RecoverablePhase } from "./types.js";

const phaseRetryBudgetEnvNames: Record<RecoverablePhase, readonly string[]> = {
  development: ["REDDWARF_MAX_RETRIES_DEVELOPMENT", "REDDWARF_MAX_RETRIES_DEVELOPER"],
  architecture_review: [
    "REDDWARF_MAX_RETRIES_ARCHITECTURE_REVIEW",
    "REDDWARF_MAX_RETRIES_ARCHITECT",
    "REDDWARF_MAX_RETRIES_REVIEWER"
  ],
  validation: ["REDDWARF_MAX_RETRIES_VALIDATION", "REDDWARF_MAX_RETRIES_VALIDATOR"],
  scm: ["REDDWARF_MAX_RETRIES_SCM"]
};

const defaultRetryLimits: Record<RecoverablePhase, number> = {
  development: 1,
  architecture_review: 1,
  validation: 1,
  scm: 0
};

export const phaseRetryBudgetMemoryPrefix = "failure.retry_budget";

function parseRetryLimit(
  phase: RecoverablePhase,
  env: NodeJS.ProcessEnv
): number | undefined {
  for (const envName of phaseRetryBudgetEnvNames[phase]) {
    const raw = env[envName]?.trim();
    if (!raw) {
      continue;
    }

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return undefined;
}

export function resolveRetryBudgetConfig(
  env: NodeJS.ProcessEnv = process.env
): RetryBudgetConfig {
  const development = parseRetryLimit("development", env);
  const architectureReview = parseRetryLimit("architecture_review", env);
  const validation = parseRetryLimit("validation", env);
  const scm = parseRetryLimit("scm", env);

  return {
    maxRetries: {
      ...(development !== undefined ? { development } : {}),
      ...(architectureReview !== undefined
        ? { architecture_review: architectureReview }
        : {}),
      ...(validation !== undefined ? { validation } : {}),
      ...(scm !== undefined ? { scm } : {})
    }
  };
}

export function getPhaseRetryBudgetMemoryKey(phase: RecoverablePhase): string {
  return `${phaseRetryBudgetMemoryPrefix}.${phase}`;
}

export function resolvePhaseRetryLimit(
  phase: RecoverablePhase,
  config: RetryBudgetConfig = resolveRetryBudgetConfig()
): number {
  return config.maxRetries[phase] ?? defaultRetryLimits[phase];
}

export function readPhaseRetryBudgetState(
  snapshot: PersistedTaskSnapshot,
  phase: RecoverablePhase
): PhaseRetryBudgetState | null {
  const value =
    snapshot.memoryRecords.find(
      (record) => record.key === getPhaseRetryBudgetMemoryKey(phase)
    )?.value ?? null;
  const parsed = phaseRetryBudgetStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
