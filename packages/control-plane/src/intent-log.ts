/**
 * R-18: Write-ahead intent log for external side effects.
 *
 * Before performing an external mutation (OpenClaw dispatch, GitHub PR creation),
 * write an intent record to Postgres. After the operation completes (or fails),
 * update the intent status. On crash recovery, pending intents are reconciled.
 */

import {
  asIsoTimestamp,
  intentRecordSchema,
  type IntentRecord,
  type IntentType
} from "@reddwarf/contracts";
import { type PlanningRepository } from "@reddwarf/evidence";
import { type PlanningPipelineLogger } from "./logger.js";

export interface IntentContext {
  intentId: string;
  taskId: string;
  runId: string;
  phase: string;
  intentType: IntentType;
  payload: Record<string, unknown>;
}

/**
 * Execute an external side effect with write-ahead intent logging.
 *
 * 1. Writes a `pending` intent record before execution
 * 2. On success: marks the intent `completed` with the result
 * 3. On failure: marks the intent `failed` with the error
 *
 * The intent record survives crashes — on startup, pending intents
 * can be reconciled (replayed or abandoned) by `sweepPendingIntents`.
 */
export async function withIntent<T>(
  repository: PlanningRepository,
  context: IntentContext,
  fn: () => Promise<T>,
  options?: { logger?: PlanningPipelineLogger }
): Promise<T> {
  const now = asIsoTimestamp(new Date());
  const intent = intentRecordSchema.parse({
    intentId: context.intentId,
    taskId: context.taskId,
    runId: context.runId,
    phase: context.phase,
    intentType: context.intentType,
    status: "pending",
    payload: context.payload,
    result: null,
    error: null,
    createdAt: now,
    completedAt: null,
    updatedAt: now
  });

  // Step 1: Write the intent before performing the side effect
  await repository.saveIntent(intent);

  try {
    // Step 2: Perform the external side effect
    const result = await fn();

    // Step 3a: Mark as completed
    const completedAt = asIsoTimestamp(new Date());
    await repository.updateIntentStatus(context.intentId, "completed", {
      result: result !== null && typeof result === "object"
        ? JSON.parse(JSON.stringify(result)) as Record<string, unknown>
        : null,
      completedAt
    });

    return result;
  } catch (err) {
    // Step 3b: Mark as failed
    const completedAt = asIsoTimestamp(new Date());
    await repository.updateIntentStatus(context.intentId, "failed", {
      error: err instanceof Error ? err.message : String(err),
      completedAt
    }).catch((updateErr) => {
      // If we can't even update the intent status (e.g. DB is also down),
      // log it but don't mask the original error
      options?.logger?.warn(
        `Failed to update intent status to failed for ${context.intentId}: ${updateErr}`,
        { intentId: context.intentId }
      );
    });

    throw err;
  }
}

/**
 * Reconcile pending intents left behind by a crash.
 *
 * Marks all pending intents older than `staleAfterMs` as `abandoned`.
 * Returns the list of abandoned intents for logging.
 *
 * In future, specific intent types could be replayed (e.g. check if
 * a GitHub PR was actually created despite the crash), but the safe
 * default is to abandon and let the pipeline retry the entire phase.
 */
export async function sweepPendingIntents(
  repository: PlanningRepository,
  options?: {
    staleAfterMs?: number;
    clock?: () => Date;
    logger?: PlanningPipelineLogger;
  }
): Promise<{ abandonedCount: number; abandonedIntentIds: string[] }> {
  const clock = options?.clock ?? (() => new Date());
  const now = clock();
  const staleAfterMs = options?.staleAfterMs ?? 5 * 60_000;
  const staleThreshold = new Date(now.getTime() - staleAfterMs);

  const pendingIntents = await repository.listPendingIntents(100);
  const abandonedIntentIds: string[] = [];

  for (const intent of pendingIntents) {
    const createdAt = new Date(intent.createdAt);
    if (createdAt < staleThreshold) {
      await repository.updateIntentStatus(intent.intentId, "abandoned", {
        error: "Abandoned during startup intent sweep — process likely crashed before completion",
        completedAt: asIsoTimestamp(now)
      });
      abandonedIntentIds.push(intent.intentId);
    }
  }

  if (abandonedIntentIds.length > 0) {
    options?.logger?.info(
      `Intent sweep abandoned ${abandonedIntentIds.length} pending intent(s).`,
      { abandonedIntentIds }
    );
  }

  return { abandonedCount: abandonedIntentIds.length, abandonedIntentIds };
}
