import {
  asIsoTimestamp
} from "@reddwarf/contracts";
import {
  createPipelineRun,
  type PlanningRepository
} from "@reddwarf/evidence";
import {
  isPipelineRunStale,
  resolvePipelineRunStaleAfterMs
} from "./shared.js";
import {
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
    }
  }

  if (sweptRunIds.length > 0) {
    options?.logger?.info(
      `Startup sweep marked ${sweptRunIds.length} stale run(s).`,
      { sweptRunIds }
    );
  }

  return { sweptRunIds, sweptAt: nowIso };
}
