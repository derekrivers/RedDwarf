import {
  asIsoTimestamp,
  type PhaseLifecycleStatus
} from "@reddwarf/contracts";
import {
  createMemoryRecord,
  createApprovalRequest,
  createEvidenceRecord
} from "@reddwarf/evidence";
import {
  bindPlanningLogger,
  defaultLogger
} from "../logger.js";
import {
  assertTaskLifecycleTransition
} from "../lifecycle.js";
import {
  createPhaseRecord,
  patchManifest,
  recordRunEvent
} from "./shared.js";
import { getPhaseRetryBudgetMemoryKey, readPhaseRetryBudgetState } from "./retry-budget.js";
import { failureAutomationRequestedBy } from "./types.js";
import {
  type ResolveApprovalRequestDependencies,
  type ResolveApprovalRequestInput,
  type ResolveApprovalRequestResult
} from "./types.js";

export async function resolveApprovalRequest(
  input: ResolveApprovalRequestInput,
  dependencies: ResolveApprovalRequestDependencies
): Promise<ResolveApprovalRequestResult> {
  const requestId = input.requestId.trim();
  const decidedBy = input.decidedBy.trim();
  const decisionSummary = input.decisionSummary.trim();

  if (requestId.length === 0) {
    throw new Error("Approval request id is required.");
  }

  if (decidedBy.length === 0) {
    throw new Error("Approval decisions require a non-empty actor.");
  }

  if (decisionSummary.length === 0) {
    throw new Error("Approval decisions require a non-empty summary.");
  }

  const repository = dependencies.repository;
  const logger = dependencies.logger ?? defaultLogger;
  const clock = dependencies.clock ?? (() => new Date());
  const resolvedAt = clock();
  const resolvedAtIso = asIsoTimestamp(resolvedAt);
  const approvalRequest = await repository.getApprovalRequest(requestId);

  if (!approvalRequest) {
    throw new Error(`Approval request ${requestId} was not found.`);
  }

  if (approvalRequest.status !== "pending") {
    throw new Error(
      `Approval request ${requestId} is already ${approvalRequest.status}.`
    );
  }

  const manifest = await repository.getManifest(approvalRequest.taskId);

  if (!manifest) {
    throw new Error(
      `Task manifest ${approvalRequest.taskId} was not found for approval request ${requestId}.`
    );
  }

  const lifecycleStatus = input.decision === "approve" ? "ready" : "cancelled";
  assertTaskLifecycleTransition(manifest.lifecycleStatus, lifecycleStatus);

  const updatedApprovalRequest = createApprovalRequest({
    ...approvalRequest,
    status: input.decision === "approve" ? "approved" : "rejected",
    decidedBy,
    decision: input.decision,
    decisionSummary,
    comment: input.comment ?? null,
    updatedAt: resolvedAtIso,
    resolvedAt: resolvedAtIso
  });
  const updatedManifest = patchManifest(manifest, {
    lifecycleStatus,
    ...(input.decision === "approve" && approvalRequest.phase === "architecture_review"
      ? { currentPhase: "validation" as const }
      : {}),
    evidenceLinks: [
      ...manifest.evidenceLinks,
      `db://gate_decision/${approvalRequest.taskId}:approval-decision:${approvalRequest.requestId}`
    ],
    updatedAt: resolvedAtIso
  });
  const recoverableApprovalPhase =
    approvalRequest.phase === "development" ||
    approvalRequest.phase === "architecture_review" ||
    approvalRequest.phase === "validation" ||
    approvalRequest.phase === "scm"
      ? approvalRequest.phase
      : null;
  const snapshot = await repository.getTaskSnapshot(approvalRequest.taskId);
  const retryBudgetState =
    recoverableApprovalPhase !== null
      ? readPhaseRetryBudgetState(snapshot, recoverableApprovalPhase)
      : null;
  const resetRetryBudgetOnApproval =
    approvalRequest.requestedBy === failureAutomationRequestedBy &&
    input.decision === "approve" &&
    retryBudgetState !== null;
  const finalManifest = resetRetryBudgetOnApproval
    ? patchManifest(updatedManifest, {
        retryCount: 0,
        updatedAt: resolvedAtIso
      })
    : updatedManifest;
  const decisionCode =
    input.decision === "approve" ? "APPROVAL_APPROVED" : "APPROVAL_REJECTED";
  const decisionMessage =
    input.decision === "approve"
      ? approvalRequest.phase === "architecture_review"
        ? "Architecture review override approved; the task is ready to continue at validation."
        : "Approval granted for downstream execution."
      : "Approval rejected and the task was cancelled.";
  const phaseStatus: PhaseLifecycleStatus =
    input.decision === "approve" ? "passed" : "failed";
  const runLogger = bindPlanningLogger(logger, {
    runId: approvalRequest.runId,
    taskId: approvalRequest.taskId,
    sourceRepo: manifest.source.repo,
    approvalRequestId: approvalRequest.requestId
  });

  await repository.runInTransaction(async (transactionalRepository) => {
    await transactionalRepository.saveApprovalRequest(updatedApprovalRequest);
    await transactionalRepository.updateManifest(finalManifest);
    if (resetRetryBudgetOnApproval && retryBudgetState !== null) {
      const phase = recoverableApprovalPhase!;
      await transactionalRepository.saveMemoryRecord(
        createMemoryRecord({
          memoryId: `${approvalRequest.taskId}:memory:task:retry-budget:${phase}`,
          taskId: approvalRequest.taskId,
          scope: "task",
          provenance: "pipeline_derived",
          key: getPhaseRetryBudgetMemoryKey(phase),
          title: `${phase} retry budget state`,
          value: {
            ...retryBudgetState,
            attempts: 0,
            retryExhausted: false,
            lastError: null,
            lastFailureCode: null,
            lastFailureClass: null,
            lastRunId: null,
            updatedAt: resolvedAtIso
          },
          repo: manifest.source.repo,
          organizationId: null,
          tags: ["failure", "retry-budget", phase],
          createdAt: resolvedAtIso,
          updatedAt: resolvedAtIso
        })
      );
    }
    await transactionalRepository.savePhaseRecord(
      createPhaseRecord({
        id: `${approvalRequest.taskId}:phase:policy_gate:approval:${approvalRequest.requestId}`,
        taskId: approvalRequest.taskId,
        phase: "policy_gate",
        status: phaseStatus,
        actor: decidedBy,
        summary: decisionSummary,
        details: {
          requestId: approvalRequest.requestId,
          decision: input.decision,
          approvalMode: approvalRequest.approvalMode,
          comment: input.comment ?? null
        },
        createdAt: resolvedAtIso
      })
    );
    await transactionalRepository.saveEvidenceRecord(
      createEvidenceRecord({
        recordId: `${approvalRequest.taskId}:approval-decision:${approvalRequest.requestId}`,
        taskId: approvalRequest.taskId,
        kind: "gate_decision",
        title:
          input.decision === "approve" ? "Approval granted" : "Approval rejected",
        metadata: {
          requestId: approvalRequest.requestId,
          decision: input.decision,
          decidedBy,
          decisionSummary,
          comment: input.comment ?? null,
          lifecycleStatus
        },
        createdAt: resolvedAtIso
      })
    );
    await recordRunEvent({
      repository: transactionalRepository,
      logger: runLogger,
      eventId: `${approvalRequest.requestId}:${decisionCode}`,
      taskId: approvalRequest.taskId,
      runId: approvalRequest.runId,
      phase: "policy_gate",
      level: input.decision === "approve" ? "info" : "warn",
      code: decisionCode,
      message: decisionMessage,
      data: {
        requestId: approvalRequest.requestId,
        decision: input.decision,
        decidedBy,
        decisionSummary,
        lifecycleStatus,
        ...(input.comment ? { comment: input.comment } : {})
      },
      createdAt: resolvedAtIso
    });
  });

  return {
    approvalRequest: updatedApprovalRequest,
    manifest: finalManifest
  };
}
