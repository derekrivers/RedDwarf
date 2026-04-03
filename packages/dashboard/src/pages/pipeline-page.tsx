import { Fragment, useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { PipelineRun } from "@reddwarf/contracts";
import type { DashboardApiClient, TaskDetailResponse } from "../types/dashboard";

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
          {detail.tokenUsage.inputTokens} in / {detail.tokenUsage.outputTokens} out
        </div>
      </div>
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
  const [selectedStatus, setSelectedStatus] = useState<PipelineRun["status"] | "all">("all");
  const [sortDirection, setSortDirection] = useState<"desc" | "asc">("desc");
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  useEffect(() => {
    setCurrentPage(1);
  }, [selectedStatus, sortDirection]);

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
                    <td>
                      <button
                        className="btn btn-sm btn-outline-secondary"
                        onClick={() =>
                          setExpandedRunId((current) => (current === run.runId ? null : run.runId))
                        }
                        type="button"
                      >
                        {isExpanded ? "Hide" : "Details"}
                      </button>
                    </td>
                  </tr>
                  {isExpanded ? (
                    <tr>
                      <td colSpan={7}>
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
