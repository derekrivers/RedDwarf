import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { IconDownload, IconAlertTriangle } from "@tabler/icons-react";
import type {
  AuditExportFilters,
  AuditExportResponse,
  DashboardApiClient
} from "../types/dashboard";

// Feature 185 — Audit-log export (M24 F-185).
//
// Compliance / review surface for "every autonomous change that touched X in
// window Y". Thin client over GET /audit/export — a JSON preview of the joined
// approvals × manifests and a CSV download button backed by the same endpoint.

function toLocalInputValue(iso: string | null): string {
  if (!iso) return "";
  // datetime-local expects "YYYY-MM-DDTHH:MM" in local TZ
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInputValue(value: string): string | undefined {
  if (!value) return undefined;
  // Browser gives us local time; turn it into an ISO instant.
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function decisionBadgeClass(decision: string | null): string {
  switch (decision) {
    case "approve":
      return "bg-green-lt text-green";
    case "reject":
      return "bg-red-lt text-red";
    case "rework":
      return "bg-orange-lt text-orange";
    default:
      return "bg-secondary-lt text-secondary";
  }
}

export function AuditPage(props: { apiClient: DashboardApiClient }) {
  const { apiClient } = props;

  const [sinceInput, setSinceInput] = useState("");
  const [untilInput, setUntilInput] = useState("");
  const [repoInput, setRepoInput] = useState("");
  const [activeFilters, setActiveFilters] = useState<AuditExportFilters>({});

  const auditQuery = useQuery<AuditExportResponse>({
    queryKey: ["audit-export", activeFilters],
    queryFn: () => apiClient.getAuditExport(activeFilters)
  });

  function applyFilters() {
    const next: AuditExportFilters = {};
    const since = fromLocalInputValue(sinceInput);
    const until = fromLocalInputValue(untilInput);
    const repo = repoInput.trim();
    if (since) next.since = since;
    if (until) next.until = until;
    if (repo) next.repo = repo;
    setActiveFilters(next);
  }

  function resetFilters() {
    setSinceInput("");
    setUntilInput("");
    setRepoInput("");
    setActiveFilters({});
  }

  const csvUrl = apiClient.buildAuditCsvUrl(activeFilters);
  const entries = auditQuery.data?.entries ?? [];

  return (
    <div className="d-flex flex-column gap-3">
      <div className="card">
        <div className="card-header">
          <h3 className="card-title mb-0">Audit export filters</h3>
        </div>
        <div className="card-body">
          <div className="row g-3">
            <div className="col-md-3">
              <label className="form-label" htmlFor="audit-since">Since</label>
              <input
                id="audit-since"
                type="datetime-local"
                className="form-control"
                value={sinceInput}
                onChange={(e) => setSinceInput(e.target.value)}
              />
            </div>
            <div className="col-md-3">
              <label className="form-label" htmlFor="audit-until">Until</label>
              <input
                id="audit-until"
                type="datetime-local"
                className="form-control"
                value={untilInput}
                onChange={(e) => setUntilInput(e.target.value)}
              />
            </div>
            <div className="col-md-4">
              <label className="form-label" htmlFor="audit-repo">Repo (optional)</label>
              <input
                id="audit-repo"
                type="text"
                className="form-control"
                placeholder="owner/repo"
                value={repoInput}
                onChange={(e) => setRepoInput(e.target.value)}
              />
            </div>
            <div className="col-md-2 d-flex align-items-end gap-2">
              <button
                className="btn btn-primary flex-fill"
                type="button"
                onClick={applyFilters}
              >
                Apply
              </button>
              <button
                className="btn btn-outline-secondary"
                type="button"
                onClick={resetFilters}
              >
                Reset
              </button>
            </div>
          </div>
          <div className="text-secondary small mt-3">
            Filters match the approval's last-decision timestamp (<code>updated_at</code>).
            Window filters are ISO date-times; repo filter matches case-insensitively.
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header d-flex align-items-center justify-content-between">
          <div>
            <h3 className="card-title mb-0">Audit entries</h3>
            <div className="text-secondary small">
              {auditQuery.isLoading
                ? "Loading…"
                : `${auditQuery.data?.total ?? 0} entries`}
              {auditQuery.data?.truncated ? (
                <span className="badge bg-orange-lt text-orange ms-2">
                  <IconAlertTriangle size={12} className="me-1" />
                  truncated at 100 — narrow the window
                </span>
              ) : null}
            </div>
          </div>
          <a
            className="btn btn-success"
            href={csvUrl}
            download
            target="_blank"
            rel="noopener"
          >
            <IconDownload className="me-2" size={18} />
            Download CSV
          </a>
        </div>
        <div className="table-responsive">
          <table className="table table-vcenter card-table">
            <thead>
              <tr>
                <th>Request</th>
                <th>Repo</th>
                <th>Phase</th>
                <th>Decision</th>
                <th>Decided by</th>
                <th>Risk</th>
                <th>PR</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 && !auditQuery.isLoading ? (
                <tr>
                  <td colSpan={8} className="text-secondary text-center py-4">
                    No audit entries match the current filters.
                  </td>
                </tr>
              ) : null}
              {entries.map((entry) => (
                <tr key={entry.requestId}>
                  <td>
                    <div className="font-monospace small">{entry.requestId}</div>
                    <div className="text-secondary small">{entry.taskId}</div>
                  </td>
                  <td>
                    {entry.repo ?? <span className="text-secondary">—</span>}
                    {entry.issueNumber ? (
                      <span className="text-secondary small">#{entry.issueNumber}</span>
                    ) : null}
                  </td>
                  <td>{entry.phase}</td>
                  <td>
                    <span className={`badge ${decisionBadgeClass(entry.decision)}`}>
                      {entry.decision ?? entry.status}
                    </span>
                  </td>
                  <td>{entry.decidedBy ?? <span className="text-secondary">—</span>}</td>
                  <td>{entry.riskClass}</td>
                  <td>
                    {entry.prUrl ? (
                      <a href={entry.prUrl} target="_blank" rel="noopener">
                        #{entry.prNumber}
                      </a>
                    ) : (
                      <span className="text-secondary">—</span>
                    )}
                  </td>
                  <td className="text-nowrap">{formatDateTime(entry.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {auditQuery.isError ? (
        <div className="alert alert-danger" role="alert">
          Failed to load audit entries:{" "}
          {auditQuery.error instanceof Error
            ? auditQuery.error.message
            : String(auditQuery.error)}
        </div>
      ) : null}
    </div>
  );
}

// Re-export helpers for tests.
export { fromLocalInputValue, toLocalInputValue };
