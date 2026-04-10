import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconAlertCircle,
  IconCircleCheck,
  IconLink,
  IconRefresh,
  IconTool
} from "@tabler/icons-react";
import type { OpenClawFixPairingResponse } from "../api/client";
import type { DashboardApiClient } from "../types/dashboard";

const PAIRING_STATUS_QUERY_KEY = ["openclaw-pairing-status"] as const;

export function OpenClawSettingsPage(props: { apiClient: DashboardApiClient }) {
  const { apiClient } = props;
  const queryClient = useQueryClient();
  const [lastFixResult, setLastFixResult] =
    useState<OpenClawFixPairingResponse | null>(null);
  const [showRawOutput, setShowRawOutput] = useState(false);

  const statusQuery = useQuery({
    queryKey: PAIRING_STATUS_QUERY_KEY,
    queryFn: () => apiClient.getOpenClawPairingStatus(),
    refetchInterval: 15_000
  });

  const fixMutation = useMutation({
    mutationFn: () => apiClient.fixOpenClawPairing(),
    onSuccess: (result) => {
      setLastFixResult(result);
      queryClient.invalidateQueries({ queryKey: PAIRING_STATUS_QUERY_KEY });
    }
  });

  const pendingCount = statusQuery.data?.totalPending ?? 0;
  const operatorPending = (statusQuery.data?.pending ?? []).filter(
    (entry) => entry.role.toLowerCase() === "operator"
  );
  const hasOperatorPending = operatorPending.length > 0;

  const fixError =
    fixMutation.error instanceof Error ? fixMutation.error.message : null;
  const statusError =
    statusQuery.error instanceof Error ? statusQuery.error.message : null;

  return (
    <div className="row g-4">
      <div className="col-lg-8">
        <div className="card">
          <div className="card-header">
            <h3 className="card-title d-flex align-items-center gap-2">
              <IconLink size={20} stroke={1.75} />
              OpenClaw Pairing
            </h3>
            <div className="card-actions">
              <button
                type="button"
                className="btn btn-sm btn-ghost-secondary"
                onClick={() => statusQuery.refetch()}
                disabled={statusQuery.isFetching}
              >
                <IconRefresh size={14} className="me-1" />
                Refresh
              </button>
            </div>
          </div>
          <div className="card-body">
            <p className="text-secondary mb-3">
              When the OpenClaw Control UI keeps showing{" "}
              <code>pairing required</code>, the gateway has a pending
              operator-device request that needs to be approved inside the
              container. This panel approves it for you so you can reload the
              UI and reconnect.
            </p>

            {statusQuery.isLoading ? (
              <div className="placeholder-glow">
                <div className="placeholder col-6 mb-2" />
                <div className="placeholder col-4" />
              </div>
            ) : statusError ? (
              <div className="alert alert-danger d-flex align-items-start gap-2 mb-3">
                <IconAlertCircle size={18} className="mt-1 flex-shrink-0" />
                <div>
                  <div className="fw-bold">
                    Could not read OpenClaw pairing status
                  </div>
                  <div className="small">{statusError}</div>
                  <div className="small text-secondary mt-1">
                    Make sure the <code>openclaw</code> Docker compose service
                    is running.
                  </div>
                </div>
              </div>
            ) : (
              <div className="mb-3">
                <div className="d-flex align-items-center gap-2 mb-2">
                  <span className="text-secondary">Pending requests:</span>
                  <span
                    className={`badge ${
                      hasOperatorPending ? "bg-yellow-lt" : "bg-green-lt"
                    }`}
                  >
                    {pendingCount} total
                    {hasOperatorPending
                      ? ` · ${operatorPending.length} operator`
                      : ""}
                  </span>
                </div>
                {hasOperatorPending ? (
                  <ul className="list-unstyled small text-secondary mb-0">
                    {operatorPending.map((entry) => (
                      <li key={entry.requestId}>
                        <code>{entry.requestId}</code> ({entry.role})
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="small text-secondary">
                    No pending operator pairing requests detected.
                  </div>
                )}
              </div>
            )}

            <div className="d-flex flex-wrap gap-2 align-items-center">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setLastFixResult(null);
                  fixMutation.mutate();
                }}
                disabled={fixMutation.isPending}
              >
                <IconTool size={16} className="me-2" />
                {fixMutation.isPending
                  ? "Approving..."
                  : "Fix OpenClaw Pairing"}
              </button>
              <span className="text-secondary small">
                Runs <code>devices approve</code> inside the openclaw
                container for any pending operator request.
              </span>
            </div>

            {fixError ? (
              <div className="alert alert-danger d-flex align-items-start gap-2 mt-3 mb-0">
                <IconAlertCircle size={18} className="mt-1 flex-shrink-0" />
                <div>
                  <div className="fw-bold">Failed to fix pairing</div>
                  <div className="small">{fixError}</div>
                </div>
              </div>
            ) : null}

            {lastFixResult ? (
              <div
                className={`alert d-flex align-items-start gap-2 mt-3 mb-0 ${
                  lastFixResult.alreadyClean
                    ? "alert-info"
                    : "alert-success"
                }`}
              >
                <IconCircleCheck size={18} className="mt-1 flex-shrink-0" />
                <div className="flex-grow-1">
                  <div className="fw-bold">{lastFixResult.message}</div>
                  {lastFixResult.approved.length > 0 ? (
                    <ul className="small mb-2 mt-1">
                      {lastFixResult.approved.map((entry) => (
                        <li key={entry.requestId}>
                          Approved <code>{entry.requestId}</code> ({entry.role})
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost-secondary px-0"
                    onClick={() => setShowRawOutput((prev) => !prev)}
                  >
                    {showRawOutput ? "Hide" : "Show"} CLI output
                  </button>
                  {showRawOutput ? (
                    <pre className="mt-2 mb-0 p-2 bg-dark text-white rounded small overflow-auto">
                      {lastFixResult.rawOutput}
                    </pre>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="col-lg-4">
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">How this works</h3>
          </div>
          <div className="card-body small text-secondary">
            <p>
              The OpenClaw browser UI creates a pending operator-device pairing
              request on the gateway WebSocket. Until that request is approved
              inside the running container, the UI loops between{" "}
              <code>token_missing</code>, <code>connect failed</code>, and{" "}
              <code>pairing required</code>.
            </p>
            <p className="mb-2">
              <strong>Fix OpenClaw Pairing</strong> performs the documented
              workaround:
            </p>
            <ol className="mb-2">
              <li>
                <code>devices list</code> inside the openclaw container
              </li>
              <li>
                <code>devices approve &lt;request-id&gt;</code> for each
                pending operator request
              </li>
            </ol>
            <p className="mb-0">
              After it succeeds, reload the OpenClaw Control UI in the same
              browser session and reconnect.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
