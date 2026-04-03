import { Fragment, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { HighlightedJson } from "../components/highlighted-json";
import type { DashboardApiClient } from "../types/dashboard";

interface EvidenceRow {
  runId: string;
  taskId: string;
  record: Awaited<ReturnType<DashboardApiClient["getEvidenceForRun"]>>["evidenceRecords"][number];
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatEvidencePhase(row: EvidenceRow): string {
  return typeof row.record.metadata.phase === "string"
    ? row.record.metadata.phase
    : "unknown";
}

function exportEvidenceRow(row: EvidenceRow): void {
  const content = JSON.stringify(row.record, null, 2);
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${row.runId}-${row.record.recordId}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export function EvidencePage(props: { apiClient: DashboardApiClient }) {
  const { apiClient } = props;
  const [searchTerm, setSearchTerm] = useState("");
  const [expandedRecordId, setExpandedRecordId] = useState<string | null>(null);

  const runsQuery = useQuery({
    queryKey: ["evidence-runs"],
    queryFn: () => apiClient.getPipelineRuns({ limit: 50 }),
    refetchInterval: 15000
  });

  const evidenceQueries = useQueries({
    queries: (runsQuery.data?.runs ?? []).map((run) => ({
      queryKey: ["evidence-run", run.runId],
      queryFn: () => apiClient.getEvidenceForRun(run.runId),
      staleTime: 30000
    }))
  });

  const evidenceRows = useMemo(() => {
    const rows: EvidenceRow[] = [];

    evidenceQueries.forEach((query) => {
      if (!query.data) {
        return;
      }

      query.data.evidenceRecords.forEach((record) => {
        rows.push({
          runId: query.data.runId,
          taskId: query.data.taskId,
          record
        });
      });
    });

    rows.sort(
      (left, right) =>
        new Date(right.record.createdAt).getTime() - new Date(left.record.createdAt).getTime()
    );

    return rows;
  }, [evidenceQueries]);

  const filteredRows = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    if (!needle) {
      return evidenceRows;
    }

    return evidenceRows.filter((row) => row.runId.toLowerCase().includes(needle));
  }, [evidenceRows, searchTerm]);

  if (runsQuery.isLoading) {
    return (
      <div className="empty">
        <div className="spinner-border text-red" role="status" />
        <p className="empty-title mt-3">Loading evidence</p>
      </div>
    );
  }

  if (runsQuery.isError) {
    return (
      <div className="alert alert-danger" role="alert">
        {runsQuery.error instanceof Error ? runsQuery.error.message : "Unable to load evidence."}
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-header flex-wrap gap-3">
        <h3 className="card-title">Evidence Browser</h3>
        <div className="ms-auto">
          <input
            className="form-control"
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Filter by run ID"
            type="search"
            value={searchTerm}
          />
        </div>
      </div>
      <div className="table-responsive">
        <table className="table table-vcenter card-table">
          <thead>
            <tr>
              <th>Run ID</th>
              <th>Phase</th>
              <th>Type</th>
              <th>Recorded At</th>
              <th>Size</th>
              <th className="w-1">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <div className="empty py-5">
                    <p className="empty-title">No evidence rows match that run ID.</p>
                  </div>
                </td>
              </tr>
            ) : (
              filteredRows.map((row) => {
                const isExpanded = expandedRecordId === row.record.recordId;
                const size = new Blob([JSON.stringify(row.record)]).size;

                return (
                  <Fragment key={row.record.recordId}>
                    <tr>
                      <td className="text-secondary">{row.runId}</td>
                      <td className="text-secondary text-capitalize">
                        {formatEvidencePhase(row).replaceAll("_", " ")}
                      </td>
                      <td>{row.record.kind}</td>
                      <td className="text-secondary">{formatDateTime(row.record.createdAt)}</td>
                      <td className="text-secondary">{size} bytes</td>
                      <td>
                        <div className="btn-list flex-nowrap">
                          <button
                            className="btn btn-sm btn-outline-secondary"
                            onClick={() =>
                              setExpandedRecordId((current) =>
                                current === row.record.recordId ? null : row.record.recordId
                              )
                            }
                            type="button"
                          >
                            {isExpanded ? "Hide" : "Raw JSON"}
                          </button>
                          <button
                            className="btn btn-sm btn-primary"
                            onClick={() => exportEvidenceRow(row)}
                            type="button"
                          >
                            Export
                          </button>
                        </div>
                      </td>
                    </tr>
                    {isExpanded ? (
                      <tr>
                        <td colSpan={6}>
                          <HighlightedJson value={row.record} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
