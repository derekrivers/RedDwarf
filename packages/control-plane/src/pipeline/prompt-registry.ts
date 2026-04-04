import { createHash, randomUUID } from "node:crypto";
import { createEvidenceRecord, createPromptSnapshot, type PlanningRepository } from "@reddwarf/evidence";
import type { TaskPhase } from "@reddwarf/contracts";
import type { PlanningPipelineLogger } from "../logger.js";
import { recordRunEvent } from "./shared.js";
import { EventCodes } from "./types.js";

export interface CapturePromptSnapshotInput {
  repository: PlanningRepository;
  logger: PlanningPipelineLogger;
  nextEventId: (phase: TaskPhase, code: string) => string;
  taskId: string;
  runId: string;
  phase: TaskPhase;
  promptPath: string;
  promptText: string;
  capturedAt: string;
  metadata?: Record<string, unknown>;
}

export function hashPromptText(promptText: string): string {
  return createHash("sha256").update(promptText).digest("hex").slice(0, 16);
}

export async function capturePromptSnapshot(
  input: CapturePromptSnapshotInput
) {
  const snapshot = await input.repository.savePromptSnapshot(
    createPromptSnapshot({
      snapshotId: randomUUID(),
      phase: input.phase,
      promptHash: hashPromptText(input.promptText),
      promptPath: input.promptPath,
      capturedAt: input.capturedAt
    })
  );

  await input.repository.saveEvidenceRecord(
    createEvidenceRecord({
      recordId: `${input.taskId}:prompt:${input.phase}:${input.runId}`,
      taskId: input.taskId,
      kind: "gate_decision",
      title: `${input.phase} prompt snapshot`,
      metadata: {
        phase: input.phase,
        prompt: snapshot,
        ...(input.metadata ?? {})
      },
      createdAt: input.capturedAt
    })
  );

  await recordRunEvent({
    repository: input.repository,
    logger: input.logger,
    eventId: input.nextEventId(input.phase, EventCodes.PROMPT_SNAPSHOT_RECORDED),
    taskId: input.taskId,
    runId: input.runId,
    phase: input.phase,
    level: "info",
    code: EventCodes.PROMPT_SNAPSHOT_RECORDED,
    message: `${input.phase} prompt snapshot recorded.`,
    data: {
      prompt: snapshot,
      ...(input.metadata ?? {})
    },
    createdAt: input.capturedAt
  });

  return snapshot;
}
