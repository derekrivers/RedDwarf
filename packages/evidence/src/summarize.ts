import {
  memoryContextSchema,
  runSummarySchema,
  type FailureClass,
  type MemoryContext,
  type MemoryQuery,
  type MemoryRecord,
  type RunEvent,
  type RunSummary
} from "@reddwarf/contracts";
import { compareMemoryRecords, dedupeMemoryRecords, type PlanningRepository } from "./repository.js";
export function summarizeRunEvents(
  taskId: string,
  runId: string,
  events: RunEvent[]
): RunSummary | null {
  const scoped = [...events]
    .filter((event) => event.taskId === taskId && event.runId === runId)
    .sort((left, right) => {
      const byTime = left.createdAt.localeCompare(right.createdAt);
      return byTime !== 0 ? byTime : left.eventId.localeCompare(right.eventId);
    });

  if (scoped.length === 0) {
    return null;
  }

  const eventCounts: RunSummary["eventCounts"] = {
    info: 0,
    warn: 0,
    error: 0
  };
  const phaseDurations: Record<string, number> = {};
  const failureCodes = new Set<string>();
  let failureClass: FailureClass | null = null;
  let status: RunSummary["status"] = "completed";
  let latestPhase = scoped[scoped.length - 1]!.phase;

  for (const event of scoped) {
    eventCounts[event.level] += 1;
    latestPhase = event.phase;

    if (
      event.durationMs !== undefined &&
      (event.code === "PHASE_PASSED" ||
        event.code === "PHASE_ESCALATED" ||
        event.code === "PHASE_BLOCKED" ||
        event.code === "PHASE_FAILED")
    ) {
      phaseDurations[event.phase] = Math.max(
        phaseDurations[event.phase] ?? 0,
        event.durationMs
      );
    }

    if (event.failureClass !== undefined && failureClass === null) {
      failureClass = event.failureClass;
    }

    if (
      event.failureClass !== undefined ||
      event.level === "error" ||
      event.level === "warn"
    ) {
      failureCodes.add(event.code);
    }

    if (event.code === "PIPELINE_BLOCKED") {
      status = "blocked";
    }

    if (event.code === "PIPELINE_FAILED") {
      status = "failed";
    }
  }

  const terminalEvent = [...scoped]
    .reverse()
    .find(
      (event) =>
        event.code === "PIPELINE_COMPLETED" ||
        event.code === "PIPELINE_BLOCKED" ||
        event.code === "PIPELINE_FAILED"
    );
  const totalDurationMs =
    terminalEvent?.durationMs ??
    Object.values(phaseDurations).reduce((sum, value) => sum + value, 0);

  return runSummarySchema.parse({
    taskId,
    runId,
    status,
    totalDurationMs,
    phaseDurations,
    eventCounts,
    latestPhase,
    failureClass,
    failureCodes: [...failureCodes],
    firstEventAt: scoped[0]?.createdAt ?? null,
    lastEventAt: scoped[scoped.length - 1]?.createdAt ?? null
  });
}

export async function buildMemoryContextForRepository(
  repository: {
    listMemoryRecords(query?: Partial<MemoryQuery>): Promise<MemoryRecord[]>;
  },
  input: {
    taskId: string;
    repo: string;
    organizationId?: string | null;
    limitPerScope?: number;
  }
): Promise<MemoryContext> {
  const limit = input.limitPerScope ?? 10;
  const externalCandidates = await Promise.all([
    repository.listMemoryRecords({
      scope: "external",
      repo: input.repo,
      limit
    }),
    input.organizationId
      ? repository.listMemoryRecords({
          scope: "external",
          organizationId: input.organizationId,
          limit
        })
      : Promise.resolve([])
  ]);

  return memoryContextSchema.parse({
    taskId: input.taskId,
    repo: input.repo,
    organizationId: input.organizationId ?? null,
    taskMemory: await repository.listMemoryRecords({
      scope: "task",
      taskId: input.taskId,
      limit
    }),
    projectMemory: await repository.listMemoryRecords({
      scope: "project",
      repo: input.repo,
      limit
    }),
    organizationMemory: input.organizationId
      ? await repository.listMemoryRecords({
          scope: "organization",
          organizationId: input.organizationId,
          limit
        })
      : [],
    externalMemory: dedupeMemoryRecords(externalCandidates.flat())
  });
}

export function deriveOrganizationId(repo: string): string | null {
  const owner = repo.split("/")[0]?.trim();
  return owner && owner.length > 0 ? owner : null;
}


