import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { IconAlertCircle } from "@tabler/icons-react";
import { HighlightedJson } from "../components/highlighted-json";
import { useToast } from "../components/toast-provider";
import { getApprovalUiCopy } from "../lib/approval-presenters";
import type { DashboardApiClient } from "../types/dashboard";

type ResolveIntent = "approve" | "reject" | "rework";

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "Not available";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatTaskSource(task: Awaited<ReturnType<DashboardApiClient["getTask"]>>["manifest"]) {
  const issueNumber = task.source.issueNumber ?? task.source.issueId;
  return issueNumber ? `${task.source.repo}#${issueNumber}` : task.source.repo;
}

function toPolicyLabel(
  task: Awaited<ReturnType<DashboardApiClient["getTask"]>> | undefined
): string {
  return task?.policySnapshot?.policyVersion ?? "Not available";
}

export function ApprovalDetailPage(props: { apiClient: DashboardApiClient }) {
  const { apiClient } = props;
  const { approvalId } = useParams<{ approvalId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const approveNoteRef = useRef<HTMLTextAreaElement | null>(null);
  const rejectReasonRef = useRef<HTMLTextAreaElement | null>(null);
  const [approveNote, setApproveNote] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [reworkFeedback, setReworkFeedback] = useState("");
  const reworkFeedbackRef = useRef<HTMLTextAreaElement | null>(null);
  const [activeModal, setActiveModal] = useState<ResolveIntent | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const routeState = location.state as { runId?: string; taskId?: string } | null;

  const approvalQuery = useQuery({
    queryKey: ["approval-detail", approvalId],
    enabled: approvalId !== undefined,
    queryFn: () => apiClient.getApproval(approvalId!)
  });

  const evidenceQuery = useQuery({
    queryKey: ["approval-evidence", approvalId, routeState?.runId ?? approvalQuery.data?.approval.runId],
    enabled: approvalId !== undefined && (routeState?.runId ?? approvalQuery.data?.approval.runId) !== undefined,
    queryFn: () => apiClient.getEvidenceForRun(routeState?.runId ?? approvalQuery.data!.approval.runId)
  });

  const taskQuery = useQuery({
    queryKey: ["approval-task", approvalId, routeState?.taskId ?? approvalQuery.data?.approval.taskId],
    enabled: approvalId !== undefined && (routeState?.taskId ?? approvalQuery.data?.approval.taskId) !== undefined,
    queryFn: () => apiClient.getTask(routeState?.taskId ?? approvalQuery.data!.approval.taskId)
  });

  useEffect(() => {
    function isEditableTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      return target.isContentEditable;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;

      if (event.key === "Escape") {
        navigate("/approvals");
        return;
      }

      if (event.key.toLowerCase() === "a") {
        approveNoteRef.current?.focus();
      }

      if (event.key.toLowerCase() === "r") {
        rejectReasonRef.current?.focus();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [navigate]);

  const isLoading = approvalQuery.isLoading || evidenceQuery.isLoading || taskQuery.isLoading;
  const hasError = approvalQuery.isError || evidenceQuery.isError || taskQuery.isError;
  const approval = approvalQuery.data?.approval;
  const task = taskQuery.data;
  const evidenceRecords = evidenceQuery.data?.evidenceRecords ?? [];
  const isResolved = approval?.status !== "pending";
  const rejectionValid = rejectReason.trim().length >= 10;
  const reworkValid = reworkFeedback.trim().length >= 10;
  const isFailureEscalation = approval?.requestedBy === "failure-automation";
  const uiCopy = approval ? getApprovalUiCopy(approval) : null;

  const taskDetails = useMemo(
    () => [
      { label: "Task Source", value: task ? formatTaskSource(task.manifest) : approval?.taskId ?? "Loading" },
      { label: "Approval Type", value: uiCopy?.phaseLabel ?? "Loading" },
      { label: "Created At", value: approval ? formatDateTime(approval.createdAt) : "Loading" },
      { label: "Policy Snapshot", value: toPolicyLabel(task) }
    ],
    [approval, task, uiCopy]
  );

  async function handleResolve(intent: ResolveIntent) {
    if (!approvalId) {
      return;
    }

    const decisionSummary =
      intent === "approve"
        ? approveNote.trim()
        : intent === "rework"
          ? reworkFeedback.trim()
          : rejectReason.trim();

    if (intent === "reject" && decisionSummary.length < 10) {
      return;
    }

    if (intent === "rework" && decisionSummary.length < 10) {
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const comment = intent === "rework" ? reworkFeedback.trim() : undefined;
      await apiClient.resolveApproval(approvalId, intent, decisionSummary, comment);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["approvals-list"] }),
        queryClient.invalidateQueries({ queryKey: ["shell-approvals"] })
      ]);
      pushToast(
        intent === "approve"
          ? "Approval request approved."
          : intent === "rework"
            ? "Rework requested. The agent will retry with your feedback."
            : "Approval request rejected.",
        "success"
      );
      navigate("/approvals");
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Unable to resolve approval.");
    } finally {
      setIsSubmitting(false);
      setActiveModal(null);
    }
  }

  if (isLoading) {
    return (
      <div className="empty">
        <div className="spinner-border text-red" role="status" />
        <p className="empty-title mt-3">Loading approval review</p>
      </div>
    );
  }

  if (hasError || !approval || !task) {
    return (
      <div className="alert alert-danger" role="alert">
        <div className="d-flex align-items-start gap-3">
          <IconAlertCircle size={20} className="mt-1" />
          <div>
            <h3 className="alert-title">Unable to load approval detail</h3>
            <div className="text-secondary mb-3">
              {(approvalQuery.error instanceof Error && approvalQuery.error.message) ||
                (taskQuery.error instanceof Error && taskQuery.error.message) ||
                (evidenceQuery.error instanceof Error && evidenceQuery.error.message) ||
                "Unexpected error"}
            </div>
            <button
              className="btn btn-danger"
              onClick={() => {
                approvalQuery.refetch();
                taskQuery.refetch();
                evidenceQuery.refetch();
              }}
              type="button"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="row g-4 align-items-start">
        <div className="col-lg-7">
          <div className="card mb-4">
            <div className="card-header">
              <h3 className="card-title">Planning Specification</h3>
            </div>
            <div className="card-body">
              <HighlightedJson value={task.spec ?? { message: "No planning spec available." }} />
            </div>
          </div>

          <div className="card mb-4">
            <div className="card-header">
              <h3 className="card-title">Task Details</h3>
            </div>
            <div className="card-body">
              <dl className="row mb-0">
                {taskDetails.map((item) => (
                  <div className="col-sm-6 mb-3" key={item.label}>
                    <dt className="text-secondary">{item.label}</dt>
                    <dd className="mb-0 text-capitalize">{item.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Evidence Trail</h3>
            </div>
            <div className="card-body">
              {evidenceRecords.length === 0 ? (
                <div className="empty">
                  <p className="empty-title">No evidence recorded yet.</p>
                </div>
              ) : (
                <div className="timeline">
                  {evidenceRecords.map((record) => (
                    <div className="timeline-item" key={record.recordId}>
                      <div className="timeline-point timeline-point-primary" />
                      <div className="card">
                        <div className="card-body">
                    <div className="d-flex justify-content-between gap-3 flex-wrap">
                      <div>
                        <h4 className="mb-1">{record.title}</h4>
                        <div className="text-secondary">
                          {typeof record.metadata.phase === "string"
                            ? `${record.metadata.phase} • `
                            : ""}
                          {record.kind} • {formatDateTime(record.createdAt)}
                        </div>
                      </div>
                            <details className="dashboard-evidence-details">
                              <summary className="btn btn-sm btn-outline-secondary">
                                Raw JSON
                              </summary>
                              <div className="mt-3">
                                <HighlightedJson value={record} />
                              </div>
                            </details>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="col-lg-5">
          <div className="dashboard-sticky-stack">
            {isResolved ? (
              <div className="alert alert-info" role="alert">
                This request has already been resolved.
              </div>
            ) : null}

            {submitError ? (
              <div className="alert alert-danger" role="alert">
                {submitError}
              </div>
            ) : null}

            {uiCopy ? (
              <div className="alert alert-warning" role="alert">
                <div className="fw-medium mb-1">{uiCopy.phaseLabel}</div>
                <div>{uiCopy.detailLead}</div>
              </div>
            ) : null}

            <div className="card border-success mb-4">
              <div className="card-body">
                <h3 className="card-title text-success">
                  {uiCopy?.approveHeading ?? "Approve"}
                </h3>
                <p className="text-secondary">
                  {uiCopy?.approveDescription ?? "Allow the developer phase to proceed in OpenClaw."}
                </p>
                <div className="mb-3">
                  <label className="form-label" htmlFor="approve-note">
                    Decision note
                  </label>
                  <textarea
                    className="form-control"
                    disabled={isSubmitting || isResolved}
                    id="approve-note"
                    onChange={(event) => setApproveNote(event.target.value)}
                    placeholder="Add a note..."
                    ref={approveNoteRef}
                    rows={4}
                    value={approveNote}
                  />
                </div>
                <button
                  className="btn btn-success w-100"
                  disabled={isSubmitting || isResolved}
                  onClick={() => setActiveModal("approve")}
                  type="button"
                >
                  {isSubmitting && activeModal === "approve"
                    ? "Processing..."
                    : (uiCopy?.approveButtonLabel ?? "Approve Run")}
                </button>
              </div>
            </div>

            {isFailureEscalation ? (
            <div className="card border-warning mb-4">
              <div className="card-body">
                <h3 className="card-title text-warning">
                  Rework
                </h3>
                <p className="text-secondary">
                  Send the task back for rework with feedback describing what the agent should fix.
                  The agent will retry the failed phase with your guidance.
                </p>
                <div className="mb-3">
                  <label className="form-label" htmlFor="rework-feedback">
                    Rework feedback
                  </label>
                  <textarea
                    className="form-control"
                    disabled={isSubmitting || isResolved}
                    id="rework-feedback"
                    onChange={(event) => setReworkFeedback(event.target.value)}
                    placeholder="Describe what the agent should fix or change..."
                    ref={reworkFeedbackRef}
                    rows={5}
                    value={reworkFeedback}
                  />
                  <small className="form-hint">At least 10 characters required.</small>
                </div>
                <button
                  className="btn btn-warning w-100"
                  disabled={isSubmitting || isResolved || !reworkValid}
                  onClick={() => setActiveModal("rework")}
                  type="button"
                >
                  {isSubmitting && activeModal === "rework"
                    ? "Processing..."
                    : "Request Rework"}
                </button>
              </div>
            </div>
            ) : null}

            <div className="card border-danger">
              <div className="card-body">
                <h3 className="card-title text-danger">
                  {uiCopy?.rejectHeading ?? "Reject"}
                </h3>
                <p className="text-secondary">
                  {uiCopy?.rejectDescription ??
                    "Provide a clear reason so the operator history stays auditable."}
                </p>
                <div className="mb-3">
                  <label className="form-label" htmlFor="reject-reason">
                    Rejection reason
                  </label>
                  <textarea
                    className="form-control"
                    disabled={isSubmitting || isResolved}
                    id="reject-reason"
                    onChange={(event) => setRejectReason(event.target.value)}
                    placeholder="Explain why this run should not proceed."
                    ref={rejectReasonRef}
                    rows={5}
                    value={rejectReason}
                  />
                  <small className="form-hint">At least 10 characters required.</small>
                </div>
                <button
                  className="btn btn-danger w-100"
                  disabled={isSubmitting || isResolved || !rejectionValid}
                  onClick={() => setActiveModal("reject")}
                  type="button"
                >
                  {isSubmitting && activeModal === "reject"
                    ? "Processing..."
                    : (uiCopy?.rejectButtonLabel ?? "Reject Run")}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {activeModal ? (
        <>
          <div className="modal modal-blur show d-block" role="dialog" tabIndex={-1}>
            <div className="modal-dialog modal-sm modal-dialog-centered" role="document">
              <div className="modal-content">
                <div
                  className={
                    activeModal === "approve"
                      ? "modal-status bg-success"
                      : activeModal === "rework"
                        ? "modal-status bg-warning"
                        : "modal-status bg-danger"
                  }
                />
                <div className="modal-header">
                  <h5 className="modal-title">
                    {activeModal === "approve"
                      ? (uiCopy?.approveModalTitle ?? "Approve this run?")
                      : activeModal === "rework"
                        ? "Request rework for this run?"
                        : "Reject this run?"}
                  </h5>
                  <button
                    aria-label="Close"
                    className="btn-close"
                    onClick={() => setActiveModal(null)}
                    type="button"
                  />
                </div>
                <div className="modal-body">
                  {activeModal === "approve" ? (
                    <p className="mb-0">{uiCopy?.approveModalBody ?? "Are you sure you want to approve this run? This will allow the developer phase to proceed in OpenClaw."}</p>
                  ) : activeModal === "rework" ? (
                    <p className="mb-0">
                      Are you sure you want to request rework? The agent will retry the
                      failed phase using your feedback.
                    </p>
                  ) : (
                    <p className="mb-0">
                      Are you sure you want to reject this run? The rejection reason
                      will be recorded with the approval history.
                    </p>
                  )}
                </div>
                <div className="modal-footer">
                  <button className="btn me-auto" onClick={() => setActiveModal(null)} type="button">
                    Cancel
                  </button>
                  <button
                    className={
                      activeModal === "approve"
                        ? "btn btn-success"
                        : activeModal === "rework"
                          ? "btn btn-warning"
                          : "btn btn-danger"
                    }
                    onClick={() => handleResolve(activeModal)}
                    type="button"
                  >
                    Confirm
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show" />
        </>
      ) : null}
    </>
  );
}
