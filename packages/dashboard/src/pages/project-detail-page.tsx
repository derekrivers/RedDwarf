import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  IconArrowLeft,
  IconCheck,
  IconClock,
  IconEdit,
  IconExternalLink,
  IconGitPullRequest,
  IconMessageQuestion,
  IconTicket
} from "@tabler/icons-react";
import type { ProjectSpec, TicketSpec } from "@reddwarf/contracts";
import type { DashboardApiClient } from "../types/dashboard";
import { useToast } from "../components/toast-provider";

function ticketStatusBadge(status: string): string {
  switch (status) {
    case "pending":
      return "bg-secondary-lt text-secondary";
    case "dispatched":
      return "bg-blue-lt text-blue";
    case "in_progress":
      return "bg-azure-lt text-azure";
    case "pr_open":
      return "bg-purple-lt text-purple";
    case "merged":
      return "bg-green-lt text-green";
    case "failed":
      return "bg-red-lt text-red";
    default:
      return "bg-secondary-lt text-secondary";
  }
}

function projectStatusBadge(status: string): string {
  switch (status) {
    case "pending_approval":
      return "bg-orange-lt text-orange";
    case "clarification_pending":
      return "bg-purple-lt text-purple";
    case "executing":
      return "bg-blue-lt text-blue";
    case "complete":
      return "bg-green-lt text-green";
    case "failed":
      return "bg-red-lt text-red";
    case "draft":
      return "bg-secondary-lt text-secondary";
    case "approved":
      return "bg-teal-lt text-teal";
    default:
      return "bg-secondary-lt text-secondary";
  }
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

/**
 * M25 F-196 — Auto-merge card on the project detail sidebar.
 *
 * Read-only summary of the project's auto-merge state plus a single
 * toggle button. The toggle calls PATCH /projects/:id which refuses to
 * enable when the deployment-level REDDWARF_PROJECT_AUTOMERGE_ENABLED is
 * false; the 409 case is surfaced through the toast provider.
 */
function AutoMergeCard(props: {
  project: ProjectSpec;
  projectId: string;
  apiClient: DashboardApiClient;
}) {
  const { project, projectId, apiClient } = props;
  const queryClient = useQueryClient();
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);

  const contract = project.requiredCheckContract;
  const enabled = project.autoMergeEnabled;

  const handleToggle = async (): Promise<void> => {
    setSubmitting(true);
    try {
      await apiClient.patchProjectAutoMerge(projectId, !enabled);
      await queryClient.invalidateQueries({
        queryKey: ["project-detail", projectId]
      });
      toast.pushToast(
        !enabled
          ? "Auto-merge enabled for this project."
          : "Auto-merge disabled for this project. Open PRs will fall back to human review.",
        "success"
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.pushToast(
        /409/.test(msg)
          ? "Auto-merge is globally disabled on this deployment. Operator must set REDDWARF_PROJECT_AUTOMERGE_ENABLED=true first."
          : `Could not update auto-merge: ${msg}`,
        "error"
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">Auto-merge</h3>
      </div>
      <div className="card-body">
        <div className="mb-2">
          <strong>Status:</strong>{" "}
          <span
            className={`badge ${enabled ? "bg-green-lt text-green" : "bg-secondary-lt"}`}
          >
            {enabled ? "enabled" : "disabled"}
          </span>
        </div>
        {contract && contract.requiredCheckNames.length > 0 ? (
          <div className="mb-2">
            <div>
              <strong>Required checks:</strong>
            </div>
            <div className="d-flex flex-wrap gap-1 mt-1">
              {contract.requiredCheckNames.map((name) => (
                <span key={name} className="badge bg-blue-lt text-blue">
                  {name}
                </span>
              ))}
            </div>
            <div className="text-secondary mt-1" style={{ fontSize: "0.85em" }}>
              minimumCheckCount: {contract.minimumCheckCount}
              {contract.forbidSkipCi ? " · forbids [skip ci]" : ""}
              {contract.forbidEmptyTestDiff ? " · forbids empty test diff" : ""}
            </div>
          </div>
        ) : (
          <div className="text-secondary mb-2">
            No RequiredCheckContract — auto-merge is ineligible. Holly's
            workflow surveyor (F-191) populates this at planning time.
          </div>
        )}
        <button
          type="button"
          className={`btn btn-sm ${enabled ? "btn-outline-secondary" : "btn-success"}`}
          onClick={handleToggle}
          disabled={submitting}
        >
          {submitting
            ? "Updating…"
            : enabled
              ? "Disable auto-merge"
              : "Enable auto-merge"}
        </button>
      </div>
    </div>
  );
}

function TicketRow(props: { ticket: TicketSpec; allTickets: TicketSpec[] }) {
  const { ticket, allTickets } = props;
  const deps = ticket.dependsOn
    .map((depId) => allTickets.find((t) => t.ticketId === depId))
    .filter(Boolean);

  return (
    <tr>
      <td>
        <strong>{ticket.title}</strong>
        <div className="text-secondary dashboard-table-subtext">
          {ticket.description}
        </div>
      </td>
      <td>
        <span className={`badge ${ticketStatusBadge(ticket.status)}`}>
          {statusLabel(ticket.status)}
        </span>
      </td>
      <td>
        <span className="badge bg-secondary-lt">{ticket.complexityClass}</span>
      </td>
      <td>
        <span className="badge bg-secondary-lt">{ticket.riskClass}</span>
      </td>
      <td>
        {deps.length > 0 ? (
          <div className="d-flex flex-column gap-1">
            {deps.map((dep) => (
              <small key={dep!.ticketId} className="text-secondary">
                {dep!.title}
              </small>
            ))}
          </div>
        ) : (
          <span className="text-secondary">None</span>
        )}
      </td>
      <td className="text-nowrap">
        {ticket.githubSubIssueNumber !== null && (
          <span className="badge bg-secondary-lt me-1">
            <IconExternalLink size={12} className="me-1" />
            #{ticket.githubSubIssueNumber}
          </span>
        )}
        {ticket.githubPrNumber !== null && (
          <span className="badge bg-purple-lt">
            <IconGitPullRequest size={12} className="me-1" />
            #{ticket.githubPrNumber}
          </span>
        )}
      </td>
    </tr>
  );
}

function ApprovalPanel(props: {
  projectId: string;
  apiClient: DashboardApiClient;
}) {
  const { projectId, apiClient } = props;
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [decisionSummary, setDecisionSummary] = useState("");
  const [amendments, setAmendments] = useState("");
  // M25 — auto-merge opt-in at approval time. Server refuses with 409 when the
  // global REDDWARF_PROJECT_AUTOMERGE_ENABLED flag is off; the toast surfaces it.
  const [autoMergeOptIn, setAutoMergeOptIn] = useState(false);
  const [activeModal, setActiveModal] = useState<"approve" | "amend" | null>(
    null
  );

  async function handleApprove() {
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await apiClient.approveProject(
        projectId,
        "approve",
        "operator",
        decisionSummary || undefined,
        undefined,
        { autoMerge: autoMergeOptIn }
      );
      await queryClient.invalidateQueries({
        queryKey: ["project-detail", projectId]
      });
      await queryClient.invalidateQueries({ queryKey: ["projects-list"] });
      pushToast(
        autoMergeOptIn
          ? "Project approved with auto-merge enabled."
          : "Project approved and executing.",
        "success"
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to approve project.";
      setSubmitError(
        /409/.test(msg) && /auto_merge/.test(msg)
          ? "Auto-merge is globally disabled on this deployment. Set REDDWARF_PROJECT_AUTOMERGE_ENABLED=true and retry, or untick the auto-merge checkbox."
          : msg
      );
    } finally {
      setIsSubmitting(false);
      setActiveModal(null);
    }
  }

  async function handleAmend() {
    if (!amendments.trim()) {
      setSubmitError("Amendments text is required.");
      return;
    }
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await apiClient.approveProject(
        projectId,
        "amend",
        "operator",
        decisionSummary || undefined,
        amendments
      );
      await queryClient.invalidateQueries({
        queryKey: ["project-detail", projectId]
      });
      await queryClient.invalidateQueries({ queryKey: ["projects-list"] });
      pushToast("Project returned to draft with amendments.", "info");
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Failed to amend project."
      );
    } finally {
      setIsSubmitting(false);
      setActiveModal(null);
    }
  }

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">
          <IconCheck size={18} className="me-2" />
          Approval Decision
        </h3>
      </div>
      <div className="card-body">
        {submitError && (
          <div className="alert alert-danger mb-3">{submitError}</div>
        )}
        <div className="mb-3">
          <label className="form-label">Decision note (optional)</label>
          <textarea
            className="form-control"
            rows={2}
            value={decisionSummary}
            onChange={(e) => setDecisionSummary(e.target.value)}
            placeholder="Optional note about the decision..."
          />
        </div>
        <div className="mb-3">
          <label className="form-label">Amendments (required for amend)</label>
          <textarea
            className="form-control"
            rows={3}
            value={amendments}
            onChange={(e) => setAmendments(e.target.value)}
            placeholder="Describe what should be changed in the plan..."
          />
        </div>
        {/* M25 — auto-merge opt-in (only meaningful for the approve path). */}
        <div className="mb-3 form-check">
          <input
            type="checkbox"
            className="form-check-input"
            id="auto-merge-opt-in"
            checked={autoMergeOptIn}
            onChange={(e) => setAutoMergeOptIn(e.target.checked)}
          />
          <label className="form-check-label" htmlFor="auto-merge-opt-in">
            <strong>Enable auto-merge</strong> for sub-ticket PRs
          </label>
          <div className="text-secondary" style={{ fontSize: "0.85em" }}>
            When checked, RedDwarf merges each sub-ticket PR automatically once
            its required CI checks are green. Requires{" "}
            <code>REDDWARF_PROJECT_AUTOMERGE_ENABLED=true</code> on the
            deployment; the request is refused with 409 otherwise. You can
            still toggle this from the Auto-merge card after approval.
          </div>
        </div>
        <div className="d-flex gap-2">
          <button
            className="btn btn-success"
            disabled={isSubmitting}
            onClick={() => setActiveModal("approve")}
          >
            <IconCheck size={16} className="me-1" />
            Approve
          </button>
          <button
            className="btn btn-outline-warning"
            disabled={isSubmitting}
            onClick={() => setActiveModal("amend")}
          >
            <IconEdit size={16} className="me-1" />
            Request Amendments
          </button>
        </div>
      </div>

      {activeModal && (
        <div
          className="modal modal-blur d-block"
          tabIndex={-1}
          onClick={() => setActiveModal(null)}
        >
          <div
            className="modal-dialog modal-sm modal-dialog-centered"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-content">
              <div className="modal-body text-center py-4">
                <h3>
                  {activeModal === "approve"
                    ? "Approve this project?"
                    : "Return project for amendments?"}
                </h3>
                <div className="text-secondary">
                  {activeModal === "approve"
                    ? "This will create GitHub sub-issues and begin execution."
                    : "The project will return to draft status for re-planning."}
                </div>
              </div>
              <div className="modal-footer">
                <button
                  className="btn btn-link link-secondary"
                  onClick={() => setActiveModal(null)}
                  disabled={isSubmitting}
                >
                  Cancel
                </button>
                <button
                  className={`btn ${activeModal === "approve" ? "btn-success" : "btn-warning"}`}
                  onClick={
                    activeModal === "approve" ? handleApprove : handleAmend
                  }
                  disabled={isSubmitting}
                >
                  {isSubmitting
                    ? "Submitting..."
                    : activeModal === "approve"
                      ? "Confirm Approve"
                      : "Confirm Amend"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ClarificationPanel(props: {
  projectId: string;
  apiClient: DashboardApiClient;
}) {
  const { projectId, apiClient } = props;
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const clarificationsQuery = useQuery({
    queryKey: ["project-clarifications", projectId],
    queryFn: () => apiClient.getClarifications(projectId),
    refetchInterval: 5000
  });

  const data = clarificationsQuery.data;

  if (clarificationsQuery.isLoading) {
    return (
      <div className="card">
        <div className="card-body text-center">
          <div className="spinner-border spinner-border-sm text-purple" />
        </div>
      </div>
    );
  }

  if (!data || data.questions.length === 0) {
    return null;
  }

  async function handleSubmit() {
    const unanswered = data!.questions.filter((q) => !answers[q]?.trim());
    if (unanswered.length > 0) {
      setSubmitError(`Please answer all ${unanswered.length} question(s).`);
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await apiClient.submitClarifications(projectId, answers);
      await queryClient.invalidateQueries({
        queryKey: ["project-detail", projectId]
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-clarifications", projectId]
      });
      await queryClient.invalidateQueries({ queryKey: ["projects-list"] });
      pushToast("Clarification answers submitted. Project will re-plan.", "success");
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Failed to submit clarifications."
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">
          <IconMessageQuestion size={18} className="me-2" />
          Clarification Questions
        </h3>
        {data.timedOut && (
          <span className="badge bg-red-lt text-red ms-auto">Timed Out</span>
        )}
      </div>
      <div className="card-body">
        {submitError && (
          <div className="alert alert-danger mb-3">{submitError}</div>
        )}
        {data.timedOut && (
          <div className="alert alert-warning mb-3">
            The clarification window has expired. Submitting answers will still
            return the project to draft for re-planning.
          </div>
        )}
        <div className="d-flex flex-column gap-3">
          {data.questions.map((question, idx) => (
            <div key={idx}>
              <label className="form-label fw-bold">
                Q{idx + 1}: {question}
              </label>
              <textarea
                className="form-control"
                rows={2}
                value={answers[question] ?? ""}
                onChange={(e) =>
                  setAnswers((prev) => ({
                    ...prev,
                    [question]: e.target.value
                  }))
                }
                placeholder="Your answer..."
              />
            </div>
          ))}
        </div>
      </div>
      <div className="card-footer">
        <button
          className="btn btn-primary"
          disabled={isSubmitting}
          onClick={handleSubmit}
        >
          {isSubmitting ? "Submitting..." : "Submit Answers"}
        </button>
      </div>
    </div>
  );
}

export function ProjectDetailPage(props: { apiClient: DashboardApiClient }) {
  const { apiClient } = props;
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const projectQuery = useQuery({
    queryKey: ["project-detail", projectId],
    enabled: projectId !== undefined,
    queryFn: () => apiClient.getProject(projectId!),
    refetchInterval: 10000
  });

  if (projectQuery.isLoading) {
    return (
      <div className="empty">
        <div className="spinner-border text-red" />
        <p className="empty-title">Loading project</p>
      </div>
    );
  }

  if (projectQuery.isError) {
    return (
      <div className="alert alert-danger">
        <h3 className="alert-title">Unable to load project</h3>
        <div>
          {projectQuery.error instanceof Error
            ? projectQuery.error.message
            : "Unknown error"}
        </div>
      </div>
    );
  }

  const data = projectQuery.data;
  if (!data) return null;

  const { project, tickets, ticketCounts } = data;
  const merged = ticketCounts.merged;
  const total = ticketCounts.total;
  const progressPct = total > 0 ? Math.round((merged / total) * 100) : 0;

  return (
    <div className="row g-4">
      {/* Back link */}
      <div className="col-12">
        <button
          className="btn btn-link text-secondary p-0"
          onClick={() => navigate("/projects")}
        >
          <IconArrowLeft size={16} className="me-1" />
          Back to Projects
        </button>
      </div>

      {/* Main content */}
      <div className="col-lg-8">
        {/* Project header card */}
        <div className="card mb-4">
          <div className="card-body">
            <div className="d-flex align-items-start justify-content-between mb-2">
              <div>
                <h2 className="mb-1">{project.title}</h2>
                <div className="text-secondary">{project.summary}</div>
              </div>
              <span
                className={`badge ${projectStatusBadge(project.status)} fs-6`}
              >
                {statusLabel(project.status)}
              </span>
            </div>
            <div className="d-flex gap-3 mt-3 text-secondary">
              <span>
                <code>{project.sourceRepo}</code>
              </span>
              {project.sourceIssueId && (
                <span>Issue #{project.sourceIssueId}</span>
              )}
              <span>Size: {project.projectSize}</span>
              {project.decidedBy && <span>Decided by: {project.decidedBy}</span>}
            </div>
            {project.decisionSummary && (
              <div className="alert alert-info mt-3 mb-0">
                <strong>Decision note:</strong> {project.decisionSummary}
              </div>
            )}
            {project.amendments && (
              <div className="alert alert-warning mt-3 mb-0">
                <strong>Amendments:</strong>
                <pre className="mb-0 mt-1" style={{ whiteSpace: "pre-wrap" }}>
                  {project.amendments}
                </pre>
              </div>
            )}
          </div>
        </div>

        {/* Tickets table */}
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">
              <IconTicket size={18} className="me-2" />
              Tickets ({total})
            </h3>
            {total > 0 && (
              <div className="ms-auto d-flex align-items-center gap-2">
                <div
                  className="progress"
                  style={{ width: "8rem", height: "6px" }}
                >
                  {merged > 0 && (
                    <div
                      className="progress-bar bg-green"
                      style={{ width: `${(merged / total) * 100}%` }}
                    />
                  )}
                  {ticketCounts.dispatched > 0 && (
                    <div
                      className="progress-bar bg-blue"
                      style={{
                        width: `${(ticketCounts.dispatched / total) * 100}%`
                      }}
                    />
                  )}
                  {ticketCounts.in_progress > 0 && (
                    <div
                      className="progress-bar bg-azure"
                      style={{
                        width: `${(ticketCounts.in_progress / total) * 100}%`
                      }}
                    />
                  )}
                </div>
                <small className="text-secondary">
                  {merged}/{total} merged ({progressPct}%)
                </small>
              </div>
            )}
          </div>
          {tickets.length === 0 ? (
            <div className="card-body">
              <div className="empty py-4">
                <p className="empty-title">No tickets yet</p>
                <p className="empty-subtitle text-secondary">
                  Tickets will appear after project planning completes.
                </p>
              </div>
            </div>
          ) : (
            <div className="table-responsive">
              <table className="table table-vcenter card-table">
                <thead>
                  <tr>
                    <th>Ticket</th>
                    <th>Status</th>
                    <th>Complexity</th>
                    <th>Risk</th>
                    <th>Dependencies</th>
                    <th>Links</th>
                  </tr>
                </thead>
                <tbody>
                  {tickets.map((ticket) => (
                    <TicketRow
                      key={ticket.ticketId}
                      ticket={ticket}
                      allTickets={tickets}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Sidebar */}
      <div className="col-lg-4">
        <div className="dashboard-sticky-stack d-flex flex-column gap-4">
          {/* M25 F-196 — Auto-merge card. Read-only summary + a single
              toggle. Server-side gate refuses enabling when the global
              REDDWARF_PROJECT_AUTOMERGE_ENABLED flag is off (returns 409). */}
          {projectId && (
            <AutoMergeCard
              project={project}
              projectId={projectId}
              apiClient={apiClient}
            />
          )}

          {/* Complexity classification */}
          {project.complexityClassification && (
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">Complexity</h3>
              </div>
              <div className="card-body">
                <div className="mb-2">
                  <strong>Size:</strong>{" "}
                  <span className="badge bg-secondary-lt">
                    {project.complexityClassification.size}
                  </span>
                </div>
                <div className="mb-2">
                  <strong>Reasoning:</strong>{" "}
                  {project.complexityClassification.reasoning}
                </div>
                {project.complexityClassification.signals.length > 0 && (
                  <div>
                    <strong>Signals:</strong>
                    <div className="d-flex flex-wrap gap-1 mt-1">
                      {project.complexityClassification.signals.map(
                        (signal) => (
                          <span
                            key={signal}
                            className="badge bg-secondary-lt"
                          >
                            {signal}
                          </span>
                        )
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Ticket counts summary */}
          {total > 0 && (
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">Ticket Summary</h3>
              </div>
              <div className="card-body p-0">
                <div className="list-group list-group-flush">
                  {ticketCounts.merged > 0 && (
                    <div className="list-group-item d-flex justify-content-between">
                      <span className={ticketStatusBadge("merged").replace("bg-", "text-").split(" ")[1]}>Merged</span>
                      <strong>{ticketCounts.merged}</strong>
                    </div>
                  )}
                  {ticketCounts.dispatched > 0 && (
                    <div className="list-group-item d-flex justify-content-between">
                      <span className="text-blue">Dispatched</span>
                      <strong>{ticketCounts.dispatched}</strong>
                    </div>
                  )}
                  {ticketCounts.in_progress > 0 && (
                    <div className="list-group-item d-flex justify-content-between">
                      <span className="text-azure">In Progress</span>
                      <strong>{ticketCounts.in_progress}</strong>
                    </div>
                  )}
                  {ticketCounts.pr_open > 0 && (
                    <div className="list-group-item d-flex justify-content-between">
                      <span className="text-purple">PR Open</span>
                      <strong>{ticketCounts.pr_open}</strong>
                    </div>
                  )}
                  {ticketCounts.pending > 0 && (
                    <div className="list-group-item d-flex justify-content-between">
                      <span className="text-secondary">Pending</span>
                      <strong>{ticketCounts.pending}</strong>
                    </div>
                  )}
                  {ticketCounts.failed > 0 && (
                    <div className="list-group-item d-flex justify-content-between">
                      <span className="text-red">Failed</span>
                      <strong>{ticketCounts.failed}</strong>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Timestamps */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">
                <IconClock size={18} className="me-2" />
                Timeline
              </h3>
            </div>
            <div className="card-body">
              <div className="mb-2">
                <strong>Created:</strong>{" "}
                <span className="text-secondary">
                  {new Date(project.createdAt).toLocaleString()}
                </span>
              </div>
              <div>
                <strong>Updated:</strong>{" "}
                <span className="text-secondary">
                  {new Date(project.updatedAt).toLocaleString()}
                </span>
              </div>
            </div>
          </div>

          {/* Clarification panel (only for clarification_pending) */}
          {project.status === "clarification_pending" && (
            <ClarificationPanel
              projectId={project.projectId}
              apiClient={apiClient}
            />
          )}

          {/* Approval panel (only for pending_approval) */}
          {project.status === "pending_approval" && (
            <ApprovalPanel
              projectId={project.projectId}
              apiClient={apiClient}
            />
          )}
        </div>
      </div>
    </div>
  );
}
