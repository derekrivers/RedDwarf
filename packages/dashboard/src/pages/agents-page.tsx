import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { dashboardAgentRoleDefinitions } from "@reddwarf/execution-plane/dashboard-agent-roles";
import type { DashboardApiClient } from "../types/dashboard";

function formatDateTime(value: string | null): string {
  if (!value) {
    return "No evidence yet";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export function AgentsPage(props: { apiClient: DashboardApiClient }) {
  const { apiClient } = props;

  const runsQuery = useQuery({
    queryKey: ["agents-page-runs"],
    queryFn: () => apiClient.getPipelineRuns({ limit: 50 }),
    refetchInterval: 15000
  });

  const evidenceQueries = useQueries({
    queries: (runsQuery.data?.runs ?? []).map((run) => ({
      queryKey: ["agents-page-evidence", run.runId],
      queryFn: () => apiClient.getEvidenceForRun(run.runId),
      staleTime: 30000
    }))
  });

  const lastSeenByAgent = useMemo(() => {
    const entries = new Map<string, string>();

    evidenceQueries.forEach((query) => {
      if (!query.data) {
        return;
      }

      query.data.evidenceRecords.forEach((record) => {
        const metadataAgentId =
          typeof record.metadata.agentId === "string" ? record.metadata.agentId : null;
        const metadataSource =
          typeof record.metadata.source === "string" ? record.metadata.source : null;

        dashboardAgentRoleDefinitions.forEach((definition) => {
          const matches =
            metadataAgentId === definition.agentId ||
            metadataSource?.includes(definition.agentId);

          if (!matches) {
            return;
          }

          const currentValue = entries.get(definition.agentId);
          if (!currentValue || new Date(record.createdAt).getTime() > new Date(currentValue).getTime()) {
            entries.set(definition.agentId, record.createdAt);
          }
        });
      });
    });

    return entries;
  }, [evidenceQueries]);

  if (runsQuery.isLoading) {
    return (
      <div className="empty">
        <div className="spinner-border text-red" role="status" />
        <p className="empty-title mt-3">Loading agent status</p>
      </div>
    );
  }

  if (runsQuery.isError) {
    return (
      <div className="alert alert-danger" role="alert">
        {runsQuery.error instanceof Error ? runsQuery.error.message : "Unable to load agent status."}
      </div>
    );
  }

  return (
    <div className="row row-cards">
      {dashboardAgentRoleDefinitions.map((definition) => {
        const lastSeen = lastSeenByAgent.get(definition.agentId) ?? null;
        const healthy = lastSeen !== null;

        return (
          <div className="col-md-6 col-xl-4" key={definition.agentId}>
            <div className="card h-100">
              <div className="card-body">
                <div className="d-flex align-items-center justify-content-between mb-3">
                  <div>
                    <h3 className="card-title mb-1">{definition.displayName}</h3>
                    <div className="text-secondary text-capitalize">{definition.role}</div>
                  </div>
                  <span className={healthy ? "status status-green" : "status status-secondary"}>
                    <span className="status-dot" />
                    {healthy ? "Healthy" : "Unconfigured"}
                  </span>
                </div>
                <p className="text-secondary">{definition.purpose}</p>
                <div className="mb-3">
                  <div className="text-secondary mb-2">Permission scopes</div>
                  <div className="d-flex flex-wrap gap-2">
                    {definition.runtimePolicy.allow.map((scope) => (
                      <span className="badge badge-outline" key={scope}>
                        {scope}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="text-secondary">Last seen</div>
                <div className="fw-medium">{formatDateTime(lastSeen)}</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
