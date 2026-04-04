import { useEffect, useMemo, useRef } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { ApprovalRequestStatus } from "@reddwarf/contracts";
import { getPendingApprovalCount } from "../api/client";
import { useToast } from "../components/toast-provider";
import { getApprovalUiCopy } from "../lib/approval-presenters";
import type { DashboardApiClient, TaskDetailResponse } from "../types/dashboard";

function statusBadgeClass(status: ApprovalRequestStatus): string {
  switch (status) {
    case "pending":
      return "bg-orange-lt text-orange";
    case "approved":
      return "bg-green-lt text-green";
    case "rejected":
      return "bg-red-lt text-red";
    case "cancelled":
      return "bg-secondary-lt text-secondary";
  }
}

function formatTaskSource(
  manifest: TaskDetailResponse["manifest"] | undefined,
  fallbackTaskId: string
): string {
  if (!manifest) {
    return fallbackTaskId;
  }

  const source = manifest.source;
  const issueNumber = source.issueNumber ?? source.issueId;
  return issueNumber ? `${source.repo}#${issueNumber}` : source.repo;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export function ApprovalsPage(props: { apiClient: DashboardApiClient }) {
  const { apiClient } = props;
  const { pushToast } = useToast();
  const seenPendingIdsRef = useRef<Set<string> | null>(null);

  const approvalsQuery = useQuery({
    queryKey: ["approvals-list"],
    queryFn: () => apiClient.listApprovals({ statuses: ["pending", "approved", "rejected"] }),
    refetchInterval: 10000
  });

  const taskQueries = useQueries({
    queries: (approvalsQuery.data?.approvals ?? []).map((approval) => ({
      queryKey: ["task-detail", approval.taskId],
      queryFn: () => apiClient.getTask(approval.taskId),
      staleTime: 30000
    }))
  });

  useEffect(() => {
    const pendingApprovals = approvalsQuery.data?.approvals.filter(
      (approval) => approval.status === "pending"
    );

    if (!pendingApprovals) {
      return;
    }

    const pendingIds = new Set(pendingApprovals.map((approval) => approval.requestId));

    if (seenPendingIdsRef.current !== null) {
      const hasNewPendingApproval = pendingApprovals.some(
        (approval) => !seenPendingIdsRef.current?.has(approval.requestId)
      );

      if (hasNewPendingApproval) {
        pushToast("New approval request received.", "info");
      }
    }

    seenPendingIdsRef.current = pendingIds;
  }, [approvalsQuery.data?.approvals, pushToast]);

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

  if (approvalsQuery.isLoading) {
    return (
      <div className="empty">
        <div className="spinner-border text-red" role="status" />
        <p className="empty-title mt-3">Loading approval requests</p>
      </div>
    );
  }

  if (approvalsQuery.isError) {
    return (
      <div className="alert alert-danger" role="alert">
        <div className="d-flex">
          <div>
            <h3 className="alert-title">Unable to load approvals</h3>
            <div className="text-secondary">
              {approvalsQuery.error instanceof Error
                ? approvalsQuery.error.message
                : "Unexpected error"}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const approvals = approvalsQuery.data?.approvals ?? [];
  const pendingCount = getPendingApprovalCount(approvals);

  if (approvals.length === 0) {
    return (
      <div className="empty">
        <p className="empty-title">No approval requests</p>
        <p className="empty-subtitle text-secondary">
          New human-signoff requests will appear here automatically.
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title mb-1">Approval Requests</h3>
          <p className="text-secondary mb-0">
            {pendingCount} pending request{pendingCount === 1 ? "" : "s"} in the queue
          </p>
        </div>
      </div>
      <div className="table-responsive">
        <table className="table table-vcenter card-table">
          <thead>
            <tr>
              <th>Request ID</th>
              <th>Task Source</th>
              <th>Risk Level</th>
              <th>Phase</th>
              <th>Created At</th>
              <th>Status</th>
              <th className="w-1">Actions</th>
            </tr>
          </thead>
          <tbody>
            {approvals.map((approval) => {
              const task = taskMap.get(approval.taskId);
              const uiCopy = getApprovalUiCopy(approval);

              return (
                <tr key={approval.requestId}>
                  <td className="text-secondary">{approval.requestId}</td>
                  <td>
                    <div className="fw-medium">
                      {formatTaskSource(task?.manifest, approval.taskId)}
                    </div>
                    <div className="text-secondary text-truncate dashboard-table-subtext">
                      {task?.manifest.title ?? approval.summary}
                    </div>
                  </td>
                  <td>
                    <span className="badge badge-outline text-uppercase">
                      {approval.riskClass}
                    </span>
                  </td>
                  <td>
                    <div className="fw-medium">{uiCopy.phaseLabel}</div>
                    {uiCopy.reviewBadgeLabel ? (
                      <div className="text-secondary dashboard-table-subtext">
                        {uiCopy.reviewBadgeLabel}
                      </div>
                    ) : null}
                  </td>
                  <td className="text-secondary">{formatDateTime(approval.createdAt)}</td>
                  <td>
                    <span className={`badge ${statusBadgeClass(approval.status)} text-capitalize`}>
                      {approval.status}
                    </span>
                  </td>
                  <td>
                    {approval.status === "pending" ? (
                      <Link
                        className="btn btn-sm btn-primary"
                        state={{ runId: approval.runId, taskId: approval.taskId }}
                        to={`/approvals/${approval.requestId}`}
                      >
                        {uiCopy.reviewCtaLabel}
                      </Link>
                    ) : (
                      <span className="text-secondary">Resolved</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
