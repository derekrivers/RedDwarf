import { randomUUID } from "node:crypto";
import {
  asIsoTimestamp
} from "@reddwarf/contracts";
import {
  createApprovalRequest,
  createPipelineRun,
  createRunEvent,
  type PlanningRepository
} from "@reddwarf/evidence";
import { buildOpenClawIssueSessionKeyFromManifest } from "../openclaw-session-key.js";
import { createDiscordNotifier } from "../notifications/discord-notifier.js";
import {
  findApprovedPolicyGateRequest,
  isPipelineRunStale,
  isRecoverablePhase,
  patchManifest,
  readFailureRecoveryMemory,
  resolvePipelineRunStaleAfterMs
} from "./shared.js";
import {
  EventCodes,
  failureAutomationRequestedBy,
  type RecoverablePhase,
  type SweepOrphanedStateOptions,
  type SweepOrphanedStateRepair,
  type SweepOrphanedStateResult,
  type SweepStaleRunsOptions,
  type SweepStaleRunsResult
} from "./types.js";

export async function sweepStaleRuns(
  repository: PlanningRepository,
  options?: SweepStaleRunsOptions
): Promise<SweepStaleRunsResult> {
  const clock = options?.clock ?? (() => new Date());
  const now = clock();
  const nowIso = asIsoTimestamp(now);

  const activeRuns = await repository.listPipelineRuns({
    statuses: ["active"],
    limit: 100
  });

  const sweptRunIds: string[] = [];
  const cancelledSessionKeys: string[] = [];

  for (const run of activeRuns) {
    const staleAfterMs = resolvePipelineRunStaleAfterMs(run, options?.staleAfterMs);
    if (isPipelineRunStale(run, now, staleAfterMs)) {
      await repository.savePipelineRun(
        createPipelineRun({
          ...run,
          status: "stale",
          lastHeartbeatAt: nowIso,
          completedAt: nowIso,
          staleAt: nowIso,
          overlapReason: "Marked stale during startup sweep",
          metadata: {
            ...run.metadata,
            staleDetectedBy: "startup-sweep"
          }
        })
      );
      sweptRunIds.push(run.runId);

      // R-12: Best-effort OpenClaw session cancellation for orphaned sessions
      if (options?.cancelOpenClawSession) {
        try {
          const manifest = await repository.getManifest(run.taskId);
          if (manifest) {
            const sessionKey = buildOpenClawIssueSessionKeyFromManifest(manifest);
            await options.cancelOpenClawSession(sessionKey);
            cancelledSessionKeys.push(sessionKey);
            options.logger?.info(
              `Cancelled orphaned OpenClaw session for stale run.`,
              { runId: run.runId, taskId: run.taskId, sessionKey }
            );
          }
        } catch (cancelErr) {
          options.logger?.warn(
            `Failed to cancel OpenClaw session for stale run (non-fatal).`,
            { runId: run.runId, taskId: run.taskId, error: String(cancelErr) }
          );
        }
      }
    }
  }

  // Cancel any blocked runs whose blocker was just swept — they will never
  // unblock on their own because the blocking run is now stale.
  const cancelledBlockedRunIds: string[] = [];

  if (sweptRunIds.length > 0) {
    const sweptSet = new Set(sweptRunIds);
    const blockedRuns = await repository.listPipelineRuns({
      statuses: ["blocked"],
      limit: 100
    });
    for (const blockedRun of blockedRuns) {
      if (blockedRun.blockedByRunId && sweptSet.has(blockedRun.blockedByRunId)) {
        await repository.savePipelineRun(
          createPipelineRun({
            ...blockedRun,
            status: "cancelled",
            completedAt: nowIso,
            metadata: {
              ...blockedRun.metadata,
              cancelledBy: "sweep-blocked-by-stale",
              originalBlockedByRunId: blockedRun.blockedByRunId
            }
          })
        );
        cancelledBlockedRunIds.push(blockedRun.runId);
      }
    }
  }

  if (sweptRunIds.length > 0) {
    options?.logger?.info(
      `Startup sweep marked ${sweptRunIds.length} stale run(s) and cancelled ${cancelledBlockedRunIds.length} blocked run(s).`,
      { sweptRunIds, cancelledBlockedRunIds, cancelledSessionKeys }
    );
  }

  return { sweptRunIds, cancelledBlockedRunIds, cancelledSessionKeys, sweptAt: nowIso };
}

const DEFAULT_ORPHAN_SCAN_LIMIT = 50;

/**
 * Reconcile orphaned dispatcher state after approval row deletions.
 *
 * Two orphan types are repaired:
 *
 * 1. Ready manifests whose approved policy-gate approval row was deleted.
 *    The dispatcher would pick these up, hit `requireApprovedRequest`, fail, and
 *    loop forever because the manifest lifecycle never advances.  These are
 *    transitioned to `failed` with an ORPHAN_MISSING_APPROVAL event.
 *
 * 2. Blocked manifests whose pending failure-escalation approval was deleted.
 *    With no approval row the operator cannot make a decision, and the task is
 *    stuck.  A new pending failure-escalation approval is re-queued from the
 *    existing failure.recovery memory record so the operator can resolve it.
 */
export async function sweepOrphanedDispatcherState(
  repository: PlanningRepository,
  options?: SweepOrphanedStateOptions
): Promise<SweepOrphanedStateResult> {
  const clock = options?.clock ?? (() => new Date());
  const idGenerator = options?.idGenerator ?? (() => randomUUID());
  const scanLimit = options?.scanLimit ?? DEFAULT_ORPHAN_SCAN_LIMIT;
  const logger = options?.logger;

  const now = clock();
  const nowIso = asIsoTimestamp(now);
  const repairs: SweepOrphanedStateRepair[] = [];

  // ── Scan ready manifests for missing policy-gate approval ────────────────

  const readyManifests = await repository.listManifestsByLifecycleStatus(
    "ready",
    scanLimit
  );

  for (const manifest of readyManifests) {
    if (manifest.approvalMode === "auto") {
      continue;
    }

    const snapshot = await repository.getTaskSnapshot(manifest.taskId);
    const hasApprovedRequest =
      findApprovedPolicyGateRequest(snapshot) !== null;

    if (hasApprovedRequest) {
      continue;
    }

    // Orphaned ready manifest: no approved policy-gate approval row exists.
    // Transition to failed so the dispatcher stops picking it up.
    logger?.warn(
      "Orphaned ready manifest detected: no approved policy-gate approval row found. Marking as failed.",
      {
        code: EventCodes.ORPHAN_MISSING_APPROVAL,
        taskId: manifest.taskId,
        lifecycleStatus: manifest.lifecycleStatus,
        approvalMode: manifest.approvalMode
      }
    );

    const failedManifest = patchManifest(manifest, {
      lifecycleStatus: "failed",
      updatedAt: nowIso
    });

    await repository.runInTransaction(async (tx) => {
      await tx.updateManifest(failedManifest);
      await tx.saveRunEvent(
        createRunEvent({
          eventId: `${manifest.taskId}:orphan:missing_approval:${idGenerator()}`,
          taskId: manifest.taskId,
          runId: `orphan-sweep:${nowIso}`,
          phase: "policy_gate",
          level: "error",
          code: EventCodes.ORPHAN_MISSING_APPROVAL,
          message:
            "Ready manifest had no approved policy-gate approval row. Task marked failed by orphan sweep.",
          data: {
            detectedAt: nowIso,
            lifecycleStatus: manifest.lifecycleStatus,
            approvalMode: manifest.approvalMode
          },
          createdAt: nowIso
        })
      );
    });

    repairs.push({
      taskId: manifest.taskId,
      lifecycleStatus: "ready",
      orphanType: "missing_planning_approval",
      action: "marked_failed"
    });
  }

  // ── Scan blocked manifests for missing escalation approval ────────────────

  const blockedManifests = await repository.listManifestsByLifecycleStatus(
    "blocked",
    scanLimit
  );

  for (const manifest of blockedManifests) {
    if (!isRecoverablePhase(manifest.currentPhase)) {
      continue;
    }

    const phase = manifest.currentPhase as RecoverablePhase;
    const snapshot = await repository.getTaskSnapshot(manifest.taskId);
    const recovery = readFailureRecoveryMemory(snapshot);

    if (!recovery || recovery.action !== "escalate" || recovery.phase !== phase) {
      continue;
    }

    const hasPendingEscalation = snapshot.approvalRequests.some(
      (r) =>
        r.phase === phase &&
        r.status === "pending" &&
        r.requestedBy === failureAutomationRequestedBy
    );

    if (hasPendingEscalation) {
      continue;
    }

    // Orphaned blocked escalation: failure.recovery says escalate but the
    // pending approval row no longer exists.  Re-queue a new pending approval.
    const sourceIssue =
      manifest.source.issueNumber ?? manifest.source.issueId;
    const sourceLabel =
      sourceIssue === undefined
        ? manifest.source.repo
        : `${manifest.source.repo}#${sourceIssue}`;

    const summary =
      `${capitalize(phase)} failure escalation approval was deleted for ${sourceLabel}. ` +
      `Original failure: ${recovery.failureCode} (${recovery.failureClass}). ` +
      `Re-queued by orphan sweep for operator review.`;

    const newApproval = createApprovalRequest({
      requestId: `${manifest.taskId}:approval:${phase}:orphan:${idGenerator()}`,
      taskId: manifest.taskId,
      runId: recovery.runId,
      phase,
      dryRun: manifest.dryRun,
      approvalMode: "human_signoff_required",
      status: "pending",
      riskClass: manifest.riskClass,
      summary,
      requestedCapabilities: manifest.requestedCapabilities,
      allowedPaths: snapshot.policySnapshot?.allowedPaths ?? [],
      blockedPhases: [phase],
      policyReasons: [
        `${capitalize(phase)} phase previously failed with ${recovery.failureClass}.`,
        "The original escalation approval was deleted. This is a re-queued replacement.",
        "Human review is required before retrying the phase."
      ],
      requestedBy: failureAutomationRequestedBy,
      createdAt: nowIso,
      updatedAt: nowIso
    });

    logger?.warn(
      "Orphaned blocked escalation detected: no pending failure-escalation approval. Re-queuing approval.",
      {
        code: EventCodes.ORPHAN_ESCALATION_REQUEUED,
        taskId: manifest.taskId,
        phase,
        newApprovalRequestId: newApproval.requestId,
        originalRunId: recovery.runId
      }
    );

    await repository.runInTransaction(async (tx) => {
      await tx.saveApprovalRequest(newApproval);
      await tx.saveRunEvent(
        createRunEvent({
          eventId: `${manifest.taskId}:orphan:escalation_requeued:${idGenerator()}`,
          taskId: manifest.taskId,
          runId: recovery.runId,
          phase,
          level: "warn",
          code: EventCodes.ORPHAN_ESCALATION_REQUEUED,
          message:
            "Blocked manifest had no pending failure-escalation approval. A replacement approval was re-queued by orphan sweep.",
          data: {
            detectedAt: nowIso,
            newApprovalRequestId: newApproval.requestId,
            originalFailureCode: recovery.failureCode,
            originalFailureClass: recovery.failureClass,
            retryCount: recovery.retryCount,
            retryLimit: recovery.retryLimit
          },
          createdAt: nowIso
        })
      );
    });
    await createDiscordNotifier(
      logger ? { logger } : {}
    ).notifyApprovalCreated({
      kind: "phase",
      approval: newApproval,
      repo: manifest.source.repo
    });

    repairs.push({
      taskId: manifest.taskId,
      lifecycleStatus: "blocked",
      orphanType: "missing_escalation_approval",
      action: "escalation_requeued"
    });
  }

  if (repairs.length > 0) {
    logger?.info(`Orphan sweep completed with ${repairs.length} repair(s).`, {
      repairCount: repairs.length,
      repairs: repairs.map((r) => ({
        taskId: r.taskId,
        orphanType: r.orphanType,
        action: r.action
      }))
    });
  }

  return {
    scannedReadyCount: readyManifests.length,
    scannedBlockedCount: blockedManifests.length,
    repairs,
    sweptAt: nowIso
  };
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}
