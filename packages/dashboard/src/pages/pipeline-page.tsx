import { Fragment, useEffect, useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PipelineRun, RunEvent } from "@reddwarf/contracts";
import type { DashboardApiClient, TaskDetailResponse } from "../types/dashboard";

const CANCELLABLE_STATUSES: ReadonlySet<PipelineRun["status"]> = new Set([
  "blocked",
  "failed",
  "stale"
]);

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatDuration(run: PipelineRun): string {
  const end = run.completedAt ? new Date(run.completedAt).getTime() : Date.now();
  const durationMs = Math.max(end - new Date(run.startedAt).getTime(), 0);
  const minutes = Math.floor(durationMs / 60000);
  const seconds = Math.floor((durationMs % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatTaskSource(task: TaskDetailResponse | undefined, taskId: string): string {
  if (!task) {
    return taskId;
  }

  const issueNumber = task.manifest.source.issueNumber ?? task.manifest.source.issueId;
  return issueNumber ? `${task.manifest.source.repo}#${issueNumber}` : task.manifest.source.repo;
}

function statusBadgeClass(status: PipelineRun["status"]): string {
  switch (status) {
    case "active":
      return "bg-blue-lt text-blue";
    case "completed":
      return "bg-green-lt text-green";
    case "blocked":
      return "bg-orange-lt text-orange";
    case "failed":
      return "bg-red-lt text-red";
    case "stale":
      return "bg-yellow-lt text-yellow";
    case "cancelled":
      return "bg-secondary-lt text-secondary";
  }
}

// Feature 197 — render token counts with thousands separators and cost in
// USD. Cost is small per-phase but accumulates across long runs; show four
// decimal places so sub-cent figures are still legible.
function formatTokenCount(value: number | undefined): string {
  if (value === undefined || value === null) return "0";
  return new Intl.NumberFormat(undefined).format(Math.round(value));
}

function formatCostUsd(value: number | undefined): string {
  if (value === undefined || value === null) return "$0.0000";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 4,
    maximumFractionDigits: 4
  }).format(value);
}

function progressItemStatusBadge(status: string): string {
  switch (status) {
    case "done":
      return "bg-green-lt text-green";
    case "active":
      return "bg-blue-lt text-blue";
    case "failed":
      return "bg-red-lt text-red";
    case "skipped":
      return "bg-secondary-lt text-secondary";
    default:
      return "bg-secondary-lt text-muted";
  }
}

function formatItemDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = (ms / 1000).toFixed(1);
  return `${seconds}s`;
}

function AgentProgressTimeline(props: { events: RunEvent[] }) {
  const progressEvents = props.events.filter((e) => e.code === "AGENT_PROGRESS_ITEM");
  if (progressEvents.length === 0) {
    return null;
  }
  return (
    <div className="col-12">
      <div className="text-secondary mb-2">Agent progress</div>
      <div className="list-group list-group-flush">
        {progressEvents.map((event) => {
          const status = typeof event.data["status"] === "string" ? event.data["status"] : "pending";
          const durationMs = typeof event.data["durationMs"] === "number" ? event.data["durationMs"] : null;
          const detail = typeof event.data["detail"] === "string" ? event.data["detail"] : null;
          return (
            <div key={event.eventId} className="list-group-item list-group-item-action py-2 px-0">
              <div className="d-flex align-items-center gap-2">
                <span className={`badge badge-sm ${progressItemStatusBadge(status)}`}>
                  {status}
                </span>
                <span className="fw-medium flex-grow-1">{event.message}</span>
                {durationMs !== null && (
                  <small className="text-secondary text-nowrap">{formatItemDuration(durationMs)}</small>
                )}
              </div>
              {detail && (
                <div className="text-secondary" style={{ fontSize: "0.8125rem", paddingLeft: "0.25rem" }}>
                  {detail}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RunDetailPanel(props: {
  apiClient: DashboardApiClient;
  runId: string;
}) {
  const { apiClient, runId } = props;
  const detailQuery = useQuery({
    queryKey: ["pipeline-run-detail", runId],
    queryFn: () => apiClient.getRunDetail(runId)
  });

  if (detailQuery.isLoading) {
    return <div className="text-secondary">Loading run detail…</div>;
  }

  if (detailQuery.isError) {
    return (
      <div className="alert alert-danger mb-0" role="alert">
        {detailQuery.error instanceof Error ? detailQuery.error.message : "Unable to load run detail."}
      </div>
    );
  }

  const detail = detailQuery.data;

  if (!detail) {
    return null;
  }

  return (
    <div className="row g-3">
      <div className="col-md-4">
        <div className="text-secondary mb-1">Latest phase</div>
        <div className="fw-medium text-capitalize">
          {detail.summary?.latestPhase.replaceAll("_", " ") ?? "Unknown"}
        </div>
      </div>
      <div className="col-md-4">
        <div className="text-secondary mb-1">Events</div>
        <div className="fw-medium">{detail.totalEvents}</div>
      </div>
      <div className="col-md-4">
        <div className="text-secondary mb-1">Token usage</div>
        <div className="fw-medium">
          {formatTokenCount(detail.tokenUsage.totalActualInputTokens)} in /
          {" "}
          {formatTokenCount(detail.tokenUsage.totalActualOutputTokens)} out
        </div>
        <div className="text-secondary small mt-1">
          Cost: <strong>{formatCostUsd(detail.tokenUsage.totalCostUsd)}</strong>
          {detail.tokenUsage.anyCostBudgetExceeded ? (
            <span className="badge bg-red-lt text-red ms-2">budget exceeded</span>
          ) : null}
        </div>
      </div>
      <AgentProgressTimeline events={detail.events} />
      <div className="col-12">
        <div className="text-secondary mb-1">Run metadata</div>
        <pre className="dashboard-code-block mb-0">
          {JSON.stringify(detail.run.metadata, null, 2)}
        </pre>
      </div>
    </div>
  );
}

export function PipelinePage(props: { apiClient: DashboardApiClient }) {
  const { apiClient } = props;
  const queryClient = useQueryClient();
  const [selectedStatus, setSelectedStatus] = useState<PipelineRun["status"] | "all">("all");
  const [sortDirection, setSortDirection] = useState<"desc" | "asc">("desc");
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  useEffect(() => {
    setCurrentPage(1);
  }, [selectedStatus, sortDirection]);

  const cancelMutation = useMutation({
    mutationFn: (runId: string) => apiClient.cancelRun(runId),
    onSuccess: () => {
      setCancelError(null);
      void queryClient.invalidateQueries({ queryKey: ["pipeline-runs"] });
    },
    onError: (error: unknown) => {
      setCancelError(error instanceof Error ? error.message : "Failed to cancel run.");
    }
  });

  const handleCancelRun = (runId: string) => {
    if (cancelMutation.isPending) {
      return;
    }
    const confirmed = window.confirm(
      `Cancel pipeline run ${runId}? This marks the run as cancelled and cannot be undone.`
    );
    if (!confirmed) {
      return;
    }
    cancelMutation.mutate(runId);
  };

  const runsQuery = useQuery({
    queryKey: ["pipeline-runs", selectedStatus],
    queryFn: () =>
      apiClient.getPipelineRuns({
        limit: 100,
        ...(selectedStatus !== "all" ? { statuses: [selectedStatus] } : {})
      }),
    refetchInterval: 15000
  });

  const sortedRuns = useMemo(() => {
    const runs = [...(runsQuery.data?.runs ?? [])];

    runs.sort((left, right) => {
      const leftValue = new Date(left.startedAt).getTime();
      const rightValue = new Date(right.startedAt).getTime();
      return sortDirection === "desc" ? rightValue - leftValue : leftValue - rightValue;
    });

    return runs;
  }, [runsQuery.data?.runs, sortDirection]);

  const pageSize = 25;
  const totalPages = Math.max(1, Math.ceil(sortedRuns.length / pageSize));
  const pageRuns = sortedRuns.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const taskQueries = useQueries({
    queries: pageRuns.map((run) => ({
      queryKey: ["pipeline-task", run.taskId],
      queryFn: () => apiClient.getTask(run.taskId),
      staleTime: 30000
    }))
  });

  // Feature 197 — fetch run-detail per visible row so the Cost column has
  // its rollup. Same N+1 the page already pays for task details; bounded
  // by `pageSize` (25). Server-side aggregate is the right long-term fix.
  const runDetailQueries = useQueries({
    queries: pageRuns.map((run) => ({
      queryKey: ["pipeline-run-detail", run.runId],
      queryFn: () => apiClient.getRunDetail(run.runId),
      staleTime: 30000
    }))
  });

  const taskMap = useMemo(() => {
    const entries = new Map<string, TaskDetailResponse>();

    taskQueries.forEach((query) => {
      if (!query.data) {
        return;
      }

      entries.set(query.data.manifest.taskId, query.data);
    });

    return entries;
  }, [taskQueries]);

  const runCostMap = useMemo(() => {
    const entries = new Map<
      string,
      { totalCostUsd: number; anyCostBudgetExceeded: boolean }
    >();
    runDetailQueries.forEach((query) => {
      if (!query.data) return;
      entries.set(query.data.run.runId, {
        totalCostUsd: query.data.tokenUsage.totalCostUsd,
        anyCostBudgetExceeded: query.data.tokenUsage.anyCostBudgetExceeded
      });
    });
    return entries;
  }, [runDetailQueries]);

  if (runsQuery.isLoading) {
    return (
      <div className="empty">
        <div className="spinner-border text-red" role="status" />
        <p className="empty-title mt-3">Loading pipeline runs</p>
      </div>
    );
  }

  if (runsQuery.isError) {
    return (
      <div className="alert alert-danger" role="alert">
        {runsQuery.error instanceof Error ? runsQuery.error.message : "Unable to load pipeline runs."}
      </div>
    );
  }

  if (sortedRuns.length === 0) {
    return (
      <div className="empty">
        <p className="empty-title">No pipeline runs found.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-header flex-wrap gap-3">
        <h3 className="card-title">Pipeline Runs</h3>
        <div className="ms-auto d-flex gap-2">
          <select
            className="form-select"
            onChange={(event) =>
              setSelectedStatus(event.target.value as PipelineRun["status"] | "all")
            }
            value={selectedStatus}
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="completed">Completed</option>
            <option value="blocked">Blocked</option>
            <option value="failed">Failed</option>
            <option value="stale">Stale</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <button
            className="btn btn-outline-secondary"
            onClick={() =>
              setSortDirection((current) => (current === "desc" ? "asc" : "desc"))
            }
            type="button"
          >
            Sort {sortDirection === "desc" ? "Newest" : "Oldest"}
          </button>
        </div>
      </div>
      {cancelError ? (
        <div className="alert alert-danger m-3 mb-0" role="alert">
          {cancelError}
        </div>
      ) : null}
      <div className="table-responsive">
        <table className="table table-vcenter card-table">
          <thead>
            <tr>
              <th>Run ID</th>
              <th>Task Source</th>
              <th>Status</th>
              <th>Phase</th>
              <th>Started At</th>
              <th>Duration</th>
              <th className="text-end">Cost</th>
              <th className="w-1">Actions</th>
            </tr>
          </thead>
          <tbody>
            {pageRuns.map((run) => {
              const task = taskMap.get(run.taskId);
              const isExpanded = expandedRunId === run.runId;

              return (
                <Fragment key={run.runId}>
                  <tr>
                    <td className="text-secondary">{run.runId}</td>
                    <td>
                      <div className="fw-medium">{formatTaskSource(task, run.taskId)}</div>
                      <div className="text-secondary text-truncate dashboard-table-subtext">
                        {task?.manifest.title ?? run.taskId}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${statusBadgeClass(run.status)} text-capitalize`}>
                        {run.status}
                      </span>
                    </td>
                    <td className="text-secondary text-capitalize">
                      {(task?.manifest.currentPhase ?? "unknown").replaceAll("_", " ")}
                    </td>
                    <td className="text-secondary">{formatDateTime(run.startedAt)}</td>
                    <td className="text-secondary">{formatDuration(run)}</td>
                    <td className="text-end">
                      {(() => {
                        const cost = runCostMap.get(run.runId);
                        if (!cost) {
                          return <span className="text-secondary">—</span>;
                        }
                        return (
                          <span
                            className={
                              cost.anyCostBudgetExceeded
                                ? "text-red fw-medium"
                                : "text-secondary"
                            }
                            title={
                              cost.anyCostBudgetExceeded
                                ? "Run exceeded its per-task cost budget"
                                : undefined
                            }
                          >
                            {formatCostUsd(cost.totalCostUsd)}
                          </span>
                        );
                      })()}
                    </td>
                    <td>
                      <div className="btn-list flex-nowrap">
                        <button
                          className="btn btn-sm btn-outline-secondary"
                          onClick={() =>
                            setExpandedRunId((current) => (current === run.runId ? null : run.runId))
                          }
                          type="button"
                        >
                          {isExpanded ? "Hide" : "Details"}
                        </button>
                        {CANCELLABLE_STATUSES.has(run.status) ? (
                          <button
                            className="btn btn-sm btn-outline-danger"
                            disabled={
                              cancelMutation.isPending &&
                              cancelMutation.variables === run.runId
                            }
                            onClick={() => handleCancelRun(run.runId)}
                            type="button"
                          >
                            {cancelMutation.isPending &&
                            cancelMutation.variables === run.runId
                              ? "Cancelling…"
                              : "Cancel"}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                  {isExpanded ? (
                    <tr>
                      <td colSpan={8}>
                        <RunDetailPanel apiClient={apiClient} runId={run.runId} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="card-footer d-flex justify-content-between align-items-center">
        <div className="text-secondary">
          Page {currentPage} of {totalPages}
        </div>
        <div className="btn-list">
          <button
            className="btn btn-outline-secondary"
            disabled={currentPage === 1}
            onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
            type="button"
          >
            Previous
          </button>
          <button
            className="btn btn-outline-secondary"
            disabled={currentPage === totalPages}
            onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
            type="button"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
