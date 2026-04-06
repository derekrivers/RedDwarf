import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { IconFolder, IconTicket } from "@tabler/icons-react";
import type { ProjectStatus } from "@reddwarf/contracts";
import type { DashboardApiClient, ProjectSummary } from "../types/dashboard";

const statusFilters: Array<{ label: string; value: ProjectStatus | "all" }> = [
  { label: "All", value: "all" },
  { label: "Pending Approval", value: "pending_approval" },
  { label: "Clarification", value: "clarification_pending" },
  { label: "Executing", value: "executing" },
  { label: "Complete", value: "complete" },
  { label: "Draft", value: "draft" },
  { label: "Failed", value: "failed" }
];

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

function TicketProgress(props: { project: ProjectSummary }) {
  const { ticketCounts } = props.project;
  if (ticketCounts.total === 0) return <span className="text-secondary">No tickets</span>;

  const merged = ticketCounts.merged;
  const total = ticketCounts.total;
  const pct = Math.round((merged / total) * 100);

  return (
    <div className="d-flex align-items-center gap-2" style={{ minWidth: "10rem" }}>
      <div className="progress flex-fill" style={{ height: "6px" }}>
        {ticketCounts.merged > 0 && (
          <div
            className="progress-bar bg-green"
            style={{ width: `${(ticketCounts.merged / total) * 100}%` }}
          />
        )}
        {ticketCounts.dispatched > 0 && (
          <div
            className="progress-bar bg-blue"
            style={{ width: `${(ticketCounts.dispatched / total) * 100}%` }}
          />
        )}
        {ticketCounts.in_progress > 0 && (
          <div
            className="progress-bar bg-azure"
            style={{ width: `${(ticketCounts.in_progress / total) * 100}%` }}
          />
        )}
        {ticketCounts.pr_open > 0 && (
          <div
            className="progress-bar bg-purple"
            style={{ width: `${(ticketCounts.pr_open / total) * 100}%` }}
          />
        )}
        {ticketCounts.failed > 0 && (
          <div
            className="progress-bar bg-red"
            style={{ width: `${(ticketCounts.failed / total) * 100}%` }}
          />
        )}
      </div>
      <small className="text-secondary text-nowrap">
        {merged}/{total} ({pct}%)
      </small>
    </div>
  );
}

export function ProjectsPage(props: { apiClient: DashboardApiClient }) {
  const { apiClient } = props;
  const [statusFilter, setStatusFilter] = useState<ProjectStatus | "all">("all");

  const projectsQuery = useQuery({
    queryKey: ["projects-list", statusFilter],
    queryFn: () =>
      apiClient.getProjects(
        statusFilter === "all" ? {} : { status: statusFilter }
      ),
    refetchInterval: 10000
  });

  if (projectsQuery.isLoading) {
    return (
      <div className="empty">
        <div className="spinner-border text-red" />
        <p className="empty-title">Loading projects</p>
      </div>
    );
  }

  if (projectsQuery.isError) {
    return (
      <div className="alert alert-danger">
        <h3 className="alert-title">Unable to load projects</h3>
        <div>
          {projectsQuery.error instanceof Error
            ? projectsQuery.error.message
            : "Unknown error"}
        </div>
      </div>
    );
  }

  const projects = projectsQuery.data?.projects ?? [];

  return (
    <div className="row g-4">
      <div className="col-12">
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">
              <IconFolder size={18} className="me-2" />
              Projects
            </h3>
            <div className="ms-auto d-flex gap-2 align-items-center">
              <select
                className="form-select form-select-sm"
                style={{ width: "auto" }}
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as ProjectStatus | "all")
                }
              >
                {statusFilters.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {projects.length === 0 ? (
            <div className="card-body">
              <div className="empty">
                <div className="empty-img">
                  <IconFolder size={72} stroke={1} className="text-secondary" />
                </div>
                <p className="empty-title">No projects found</p>
                <p className="empty-subtitle text-secondary">
                  {statusFilter !== "all"
                    ? "Try adjusting the status filter."
                    : "Projects will appear here when created by Holly."}
                </p>
              </div>
            </div>
          ) : (
            <div className="table-responsive">
              <table className="table table-vcenter card-table">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Repository</th>
                    <th>Status</th>
                    <th>Size</th>
                    <th>Tickets</th>
                    <th>Progress</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((project) => (
                    <tr key={project.projectId}>
                      <td>
                        <Link
                          to={`/projects/${encodeURIComponent(project.projectId)}`}
                          className="text-reset"
                        >
                          <strong>{project.title}</strong>
                        </Link>
                        <div className="text-secondary dashboard-table-subtext">
                          {project.summary}
                        </div>
                      </td>
                      <td>
                        <code className="text-secondary">
                          {project.sourceRepo}
                        </code>
                      </td>
                      <td>
                        <span
                          className={`badge ${projectStatusBadge(project.status)}`}
                        >
                          {statusLabel(project.status)}
                        </span>
                      </td>
                      <td>
                        <span className="badge bg-secondary-lt">
                          {project.projectSize}
                        </span>
                      </td>
                      <td>
                        <span className="d-inline-flex align-items-center gap-1">
                          <IconTicket size={14} />
                          {project.ticketCounts.total}
                        </span>
                      </td>
                      <td>
                        <TicketProgress project={project} />
                      </td>
                      <td className="text-secondary text-nowrap">
                        {new Date(project.updatedAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
