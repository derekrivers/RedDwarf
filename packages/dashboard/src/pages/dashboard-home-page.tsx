import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { PipelineRun } from "@reddwarf/contracts";
import { getApprovalUiCopy } from "../lib/approval-presenters";
import { CrewFeedPanel } from "../components/crew-feed";
import type {
  DailyBudgetStatusResponse,
  DashboardApiClient,
  TaskDetailResponse
} from "../types/dashboard";

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined).format(Math.round(value));
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4
  }).format(value);
}

function progressBarTone(rate: number, exhausted: boolean): string {
  if (exhausted) return "bg-danger";
  if (rate >= 0.8) return "bg-warning";
  return "bg-success";
}

function DailyBudgetCard({ status }: { status: DailyBudgetStatusResponse }) {
  const tokenRate =
    status.tokenBudget && status.tokenBudget > 0
      ? Math.min(1, status.tokensUsed / status.tokenBudget)
      : 0;
  const costRate =
    status.costBudgetUsd && status.costBudgetUsd > 0
      ? Math.min(1, status.costUsdUsed / status.costBudgetUsd)
      : 0;
  return (
    <div className="card">
      <div className="card-header d-flex align-items-center justify-content-between">
        <div>
          <h3 className="card-title mb-0">Daily autonomy budget</h3>
          <div className="text-secondary small">
            Today's burn-down (window opens at 00:00 UTC). Dispatcher pauses new
            tasks once either cap is hit.
          </div>
        </div>
        {status.exhausted ? (
          <span className="badge bg-red-lt text-red">Exhausted</span>
        ) : (
          <span className="badge bg-green-lt text-green">Within budget</span>
        )}
      </div>
      <div className="card-body">
        <div className="row g-4">
          {status.tokenBudget !== null ? (
            <div className="col-md-6">
              <div className="d-flex justify-content-between mb-1">
                <strong>Tokens</strong>
                <span className="text-secondary">
                  {formatNumber(status.tokensUsed)} / {formatNumber(status.tokenBudget)}
                </span>
              </div>
              <div className="progress progress-thin">
                <div
                  className={`progress-bar ${progressBarTone(tokenRate, status.tokenBudgetExhausted)}`}
                  style={{ width: `${Math.round(tokenRate * 100)}%` }}
                />
              </div>
              <div className="text-secondary small mt-1">
                {status.tokensRemaining !== null
                  ? `${formatNumber(status.tokensRemaining)} remaining`
                  : null}
              </div>
            </div>
          ) : null}
          {status.costBudgetUsd !== null ? (
            <div className="col-md-6">
              <div className="d-flex justify-content-between mb-1">
                <strong>Cost</strong>
                <span className="text-secondary">
                  {formatUsd(status.costUsdUsed)} / {formatUsd(status.costBudgetUsd)}
                </span>
              </div>
              <div className="progress progress-thin">
                <div
                  className={`progress-bar ${progressBarTone(costRate, status.costBudgetExhausted)}`}
                  style={{ width: `${Math.round(costRate * 100)}%` }}
                />
              </div>
              <div className="text-secondary small mt-1">
                {status.costUsdRemaining !== null
                  ? `${formatUsd(status.costUsdRemaining)} remaining`
                  : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatTaskSource(task: TaskDetailResponse | undefined, taskId: string): string {
  if (!task) {
    return taskId;
  }

  const issueNumber = task.manifest.source.issueNumber ?? task.manifest.source.issueId;
  return issueNumber
    ? `${task.manifest.source.repo}#${issueNumber}`
    : task.manifest.source.repo;
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

export function DashboardHomePage(props: { apiClient: DashboardApiClient }) {
  const { apiClient } = props;

  const runsQuery = useQuery({
    queryKey: ["dashboard-home-runs"],
    queryFn: () => apiClient.getPipelineRuns({ limit: 50 }),
    refetchInterval: 15000
  });

  const blockedQuery = useQuery({
    queryKey: ["dashboard-home-blocked"],
    queryFn: () => apiClient.getBlockedApprovals(),
    refetchInterval: 10000
  });

  const budgetQuery = useQuery({
    queryKey: ["dashboard-home-budget"],
    queryFn: () => apiClient.getDailyBudgetStatus(),
    refetchInterval: 30000
  });

  const recentRuns = useMemo(
    () => (runsQuery.data?.runs ?? []).slice(0, 10),
    [runsQuery.data?.runs]
  );

  const taskQueries = useQueries({
    queries: recentRuns.map((run) => ({
      queryKey: ["dashboard-home-task", run.taskId],
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

  if (runsQuery.isLoading || blockedQuery.isLoading) {
    return (
      <div className="empty">
        <div className="spinner-border text-red" role="status" />
        <p className="empty-title mt-3">Loading dashboard</p>
      </div>
    );
  }

  if (runsQuery.isError || blockedQuery.isError) {
    return (
      <div className="alert alert-danger" role="alert">
        {(runsQuery.error instanceof Error && runsQuery.error.message) ||
          (blockedQuery.error instanceof Error && blockedQuery.error.message) ||
          "Unable to load dashboard data."}
      </div>
    );
  }

  const runs = runsQuery.data?.runs ?? [];
  const pendingApprovals = blockedQuery.data?.pendingApprovals ?? [];
  const now = Date.now();
  const failedLastDay = runs.filter((run) => {
    if (run.status !== "failed") {
      return false;
    }

    return now - new Date(run.startedAt).getTime() <= 24 * 60 * 60 * 1000;
  }).length;

  return (
    <div className="row g-4">
      <div className="col-12">
        <div className="row row-deck row-cards">
          <div className="col-sm-6 col-lg-3">
            <div className="card">
              <div className="card-body">
                <div className="text-secondary">Total pipeline runs</div>
                <div className="display-6 fw-bold">{runs.length}</div>
              </div>
            </div>
          </div>
          <div className="col-sm-6 col-lg-3">
            <div className="card">
              <div className="card-body">
                <div className="text-secondary">Active runs</div>
                <div className="display-6 fw-bold">
                  {runs.filter((run) => run.status === "active").length}
                </div>
              </div>
            </div>
          </div>
          <div className="col-sm-6 col-lg-3">
            <div className="card">
              <div className="card-body">
                <div className="text-secondary">Pending approvals</div>
                <div className="display-6 fw-bold">
                  <Link to="/approvals">{pendingApprovals.length}</Link>
                </div>
              </div>
            </div>
          </div>
          <div className="col-sm-6 col-lg-3">
            <div className="card">
              <div className="card-body">
                <div className="text-secondary">Failed runs last 24 h</div>
                <div className="display-6 fw-bold">{failedLastDay}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {budgetQuery.data &&
      (budgetQuery.data.tokenBudget !== null || budgetQuery.data.costBudgetUsd !== null) ? (
        <div className="col-12">
          <DailyBudgetCard status={budgetQuery.data} />
        </div>
      ) : null}

      <div className="col-xl-5 col-lg-12 order-xl-last">
        <CrewFeedPanel apiClient={apiClient} />
      </div>

      <div className="col-xl-7 col-lg-12">
        <div className="row g-4">
          <div className="col-12">
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">Recent Pipeline Runs</h3>
              </div>
              <div className="list-group list-group-flush">
                {recentRuns.length === 0 ? (
                  <div className="empty py-5">
                    <p className="empty-title">No pipeline runs yet.</p>
                  </div>
                ) : (
                  recentRuns.map((run) => (
                    <div className="list-group-item" key={run.runId}>
                      <div className="d-flex align-items-center justify-content-between gap-3 flex-wrap">
                        <div>
                          <div className="fw-medium">{formatTaskSource(taskMap.get(run.taskId), run.taskId)}</div>
                          <div className="text-secondary">
                            {run.runId} • {formatDateTime(run.startedAt)}
                          </div>
                        </div>
                        <span className={`badge ${statusBadgeClass(run.status)} text-capitalize`}>
                          {run.status}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="col-12">
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">Pending Approvals</h3>
              </div>
              <div className="list-group list-group-flush">
                {pendingApprovals.length === 0 ? (
                  <div className="empty py-5">
                    <p className="empty-title">Nothing is waiting for approval.</p>
                  </div>
                ) : (
                  pendingApprovals.map((approval) => {
                    const uiCopy = getApprovalUiCopy(approval);

                    return (
                      <div className="list-group-item" key={approval.requestId}>
                        <div className="d-flex align-items-center justify-content-between gap-3 flex-wrap">
                          <div>
                            <div className="d-flex align-items-center gap-2 flex-wrap mb-1">
                              <div className="fw-medium">{approval.summary}</div>
                              {uiCopy.reviewBadgeLabel ? (
                                <span className="badge badge-outline text-uppercase">
                                  {uiCopy.reviewBadgeLabel}
                                </span>
                              ) : null}
                            </div>
                            <div className="text-secondary">
                              {approval.taskId} • {uiCopy.phaseLabel}
                            </div>
                          </div>
                          <Link
                            className="btn btn-sm btn-primary"
                            state={{ runId: approval.runId, taskId: approval.taskId }}
                            to={`/approvals/${approval.requestId}`}
                          >
                            {uiCopy.reviewCtaLabel}
                          </Link>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
