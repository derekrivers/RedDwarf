import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  AgentQualityMetricsFilters,
  AgentQualityMetricsResponse,
  DashboardApiClient
} from "../types/dashboard";

// Feature 179 — Agent quality telemetry aggregates (M24 F-179).
//
// Operator-facing answer to "after we changed Holly's SOUL.md on pack v14,
// did validation pass rate go up or down?" — aggregates phase_records,
// run_events, and task_manifests.policyVersion over a time window. No new
// events captured; all numbers are already persisted.

function toLocalInputValue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInputValue(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function passRateTone(rate: number, total: number): string {
  if (total === 0) return "bg-secondary-lt text-secondary";
  if (rate >= 0.9) return "bg-green-lt text-green";
  if (rate >= 0.6) return "bg-yellow-lt text-yellow";
  return "bg-red-lt text-red";
}

// Feature 181 — Policy-pack outcome dashboard (M24 F-181).
//
// Pivots the per-(phase, policyVersion) rows from F-179 into a matrix with
// phases as rows and pack versions as columns, then renders the pass-rate
// delta between adjacent versions so operators can answer "did pack v15
// improve the numbers over v14?" without exporting a spreadsheet.

interface PolicyPackPivotCell {
  total: number;
  passRate: number;
  passed: number;
  failed: number;
  escalated: number;
}

interface PolicyPackPivot {
  phases: string[];
  policyVersions: string[];
  cells: Map<string, PolicyPackPivotCell>;
}

function pivotKey(phase: string, policyVersion: string): string {
  return `${phase}\u0001${policyVersion}`;
}

function buildPolicyPackPivot(
  rows: ReadonlyArray<{
    phase: string;
    policyVersion: string;
    passed: number;
    failed: number;
    escalated: number;
    total: number;
    passRate: number;
  }>
): PolicyPackPivot {
  const phases = [...new Set(rows.map((r) => r.phase))].sort();
  const policyVersions = [...new Set(rows.map((r) => r.policyVersion))].sort();
  const cells = new Map<string, PolicyPackPivotCell>();
  for (const row of rows) {
    cells.set(pivotKey(row.phase, row.policyVersion), {
      total: row.total,
      passRate: row.passRate,
      passed: row.passed,
      failed: row.failed,
      escalated: row.escalated
    });
  }
  return { phases, policyVersions, cells };
}

function formatDelta(delta: number): string {
  const pct = delta * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}pp`;
}

function deltaTone(delta: number): string {
  if (Math.abs(delta) < 0.01) return "text-secondary";
  return delta > 0 ? "text-green" : "text-red";
}

export function AgentQualityPage(props: { apiClient: DashboardApiClient }) {
  const { apiClient } = props;
  const [sinceInput, setSinceInput] = useState("");
  const [untilInput, setUntilInput] = useState("");
  const [activeFilters, setActiveFilters] = useState<AgentQualityMetricsFilters>({});

  const metricsQuery = useQuery<AgentQualityMetricsResponse>({
    queryKey: ["agent-quality-metrics", activeFilters],
    queryFn: () => apiClient.getAgentQualityMetrics(activeFilters),
    refetchInterval: 30000
  });

  function applyFilters() {
    const next: AgentQualityMetricsFilters = {};
    const since = fromLocalInputValue(sinceInput);
    const until = fromLocalInputValue(untilInput);
    if (since) next.since = since;
    if (until) next.until = until;
    setActiveFilters(next);
  }

  function resetFilters() {
    setSinceInput("");
    setUntilInput("");
    setActiveFilters({});
  }

  const data = metricsQuery.data;
  const outcomes = data?.phaseOutcomes ?? [];
  const latencies = data?.phaseLatencies ?? [];
  const failures = data?.failureClasses ?? [];
  const pivot = buildPolicyPackPivot(outcomes);

  return (
    <div className="d-flex flex-column gap-3">
      <div className="card">
        <div className="card-header">
          <h3 className="card-title mb-0">Time window</h3>
        </div>
        <div className="card-body">
          <div className="row g-3 align-items-end">
            <div className="col-md-4">
              <label className="form-label" htmlFor="metrics-since">Since</label>
              <input
                id="metrics-since"
                type="datetime-local"
                className="form-control"
                value={sinceInput}
                onChange={(e) => setSinceInput(e.target.value)}
              />
            </div>
            <div className="col-md-4">
              <label className="form-label" htmlFor="metrics-until">Until</label>
              <input
                id="metrics-until"
                type="datetime-local"
                className="form-control"
                value={untilInput}
                onChange={(e) => setUntilInput(e.target.value)}
              />
            </div>
            <div className="col-md-4 d-flex gap-2">
              <button className="btn btn-primary flex-fill" type="button" onClick={applyFilters}>
                Apply
              </button>
              <button className="btn btn-outline-secondary" type="button" onClick={resetFilters}>
                Reset
              </button>
            </div>
          </div>
          <div className="text-secondary small mt-3">
            Filters bound <code>phase_records.created_at</code> and <code>run_events.created_at</code>.
            Leave blank to see all history.
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title mb-0">Phase outcomes</h3>
          <div className="text-secondary small">
            Pass / fail / escalate per (phase, policy pack version). Click a column
            to spot regressions across pack upgrades.
          </div>
        </div>
        <div className="table-responsive">
          <table className="table table-vcenter card-table">
            <thead>
              <tr>
                <th>Phase</th>
                <th>Policy pack</th>
                <th className="text-end">Passed</th>
                <th className="text-end">Failed</th>
                <th className="text-end">Escalated</th>
                <th className="text-end">Total</th>
                <th className="text-end">Pass rate</th>
              </tr>
            </thead>
            <tbody>
              {outcomes.length === 0 && !metricsQuery.isLoading ? (
                <tr>
                  <td colSpan={7} className="text-secondary text-center py-4">
                    No phase records in the selected window.
                  </td>
                </tr>
              ) : null}
              {outcomes.map((row) => (
                <tr key={`${row.phase}:${row.policyVersion}`}>
                  <td>{row.phase}</td>
                  <td className="font-monospace">{row.policyVersion}</td>
                  <td className="text-end">{row.passed}</td>
                  <td className="text-end">{row.failed}</td>
                  <td className="text-end">{row.escalated}</td>
                  <td className="text-end">{row.total}</td>
                  <td className="text-end">
                    <span className={`badge ${passRateTone(row.passRate, row.total)}`}>
                      {formatPercent(row.passRate)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title mb-0">Policy pack comparison</h3>
          <div className="text-secondary small">
            Pass rate per phase, pivoted by policy-pack version. The delta column
            shows the pass-rate change from the preceding pack — green means the
            new pack improved outcomes, red means regression. Feature 181.
          </div>
        </div>
        <div className="table-responsive">
          <table className="table table-vcenter card-table">
            <thead>
              <tr>
                <th>Phase</th>
                {pivot.policyVersions.map((version, idx) => (
                  <th key={version} className="text-end font-monospace">
                    {version}
                    {idx > 0 ? (
                      <span className="text-secondary small ms-2">vs {pivot.policyVersions[idx - 1]}</span>
                    ) : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pivot.phases.length === 0 && !metricsQuery.isLoading ? (
                <tr>
                  <td colSpan={Math.max(2, pivot.policyVersions.length + 1)} className="text-secondary text-center py-4">
                    Need at least one recorded phase outcome to compare packs.
                  </td>
                </tr>
              ) : null}
              {pivot.phases.map((phase) => (
                <tr key={`pivot:${phase}`}>
                  <td>{phase}</td>
                  {pivot.policyVersions.map((version, idx) => {
                    const cell = pivot.cells.get(pivotKey(phase, version));
                    const prevCell = idx > 0
                      ? pivot.cells.get(pivotKey(phase, pivot.policyVersions[idx - 1]!))
                      : null;
                    const delta = cell && prevCell && prevCell.total > 0 && cell.total > 0
                      ? cell.passRate - prevCell.passRate
                      : null;
                    return (
                      <td key={version} className="text-end">
                        {cell ? (
                          <div className="d-flex flex-column align-items-end">
                            <span className={`badge ${passRateTone(cell.passRate, cell.total)}`}>
                              {formatPercent(cell.passRate)}
                            </span>
                            <span className="text-secondary small">n={cell.total}</span>
                            {delta !== null ? (
                              <span className={`small ${deltaTone(delta)}`}>{formatDelta(delta)}</span>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-secondary">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title mb-0">Phase latency</h3>
          <div className="text-secondary small">
            Distribution of completed-phase durations taken from
            <code>PHASE_PASSED</code> / <code>PHASE_FAILED</code> run events.
          </div>
        </div>
        <div className="table-responsive">
          <table className="table table-vcenter card-table">
            <thead>
              <tr>
                <th>Phase</th>
                <th>Policy pack</th>
                <th className="text-end">Samples</th>
                <th className="text-end">Mean</th>
                <th className="text-end">p50</th>
                <th className="text-end">p95</th>
              </tr>
            </thead>
            <tbody>
              {latencies.length === 0 && !metricsQuery.isLoading ? (
                <tr>
                  <td colSpan={6} className="text-secondary text-center py-4">
                    No phase-latency events in the selected window.
                  </td>
                </tr>
              ) : null}
              {latencies.map((row) => (
                <tr key={`lat:${row.phase}:${row.policyVersion}`}>
                  <td>{row.phase}</td>
                  <td className="font-monospace">{row.policyVersion}</td>
                  <td className="text-end">{row.sampleCount}</td>
                  <td className="text-end">{formatMs(row.meanMs)}</td>
                  <td className="text-end">{formatMs(row.p50Ms)}</td>
                  <td className="text-end">{formatMs(row.p95Ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title mb-0">Failure classes</h3>
          <div className="text-secondary small">
            Distribution of <code>failure_class</code> on run events — sorted by
            frequency. Large numbers here suggest a prompt or policy shift, not
            agent incompetence.
          </div>
        </div>
        <div className="table-responsive">
          <table className="table table-vcenter card-table">
            <thead>
              <tr>
                <th>Failure class</th>
                <th>Phase</th>
                <th className="text-end">Count</th>
              </tr>
            </thead>
            <tbody>
              {failures.length === 0 && !metricsQuery.isLoading ? (
                <tr>
                  <td colSpan={3} className="text-secondary text-center py-4">
                    No failure-classed events in the selected window.
                  </td>
                </tr>
              ) : null}
              {failures.map((row) => (
                <tr key={`${row.failureClass}:${row.phase}`}>
                  <td>{row.failureClass}</td>
                  <td>{row.phase}</td>
                  <td className="text-end">{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {metricsQuery.isError ? (
        <div className="alert alert-danger" role="alert">
          Failed to load metrics:{" "}
          {metricsQuery.error instanceof Error
            ? metricsQuery.error.message
            : String(metricsQuery.error)}
        </div>
      ) : null}
    </div>
  );
}

export { fromLocalInputValue, toLocalInputValue };
