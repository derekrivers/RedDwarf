import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconAlertCircle,
  IconBrandOpenai,
  IconCircleCheck,
  IconExternalLink,
  IconLink,
  IconRefresh,
  IconTool
} from "@tabler/icons-react";
import type {
  OpenClawFixPairingResponse,
  OpenClawModelProvider
} from "../api/client";
import type { DashboardApiClient } from "../types/dashboard";

const PAIRING_STATUS_QUERY_KEY = ["openclaw-pairing-status"] as const;
const CODEX_STATUS_QUERY_KEY = ["openclaw-codex-status"] as const;

const MODEL_PROVIDER_OPTIONS: Array<{
  value: OpenClawModelProvider;
  label: string;
  description: string;
}> = [
  {
    value: "openai-codex",
    label: "OpenAI Codex (ChatGPT subscription)",
    description:
      "Routes agents through your ChatGPT Plus/Pro subscription via OpenClaw's Codex OAuth. No API billing."
  },
  {
    value: "openai",
    label: "OpenAI API",
    description: "Uses the OpenAI API directly. Billed per token."
  },
  {
    value: "anthropic",
    label: "Anthropic API",
    description: "Uses the Anthropic API directly. Billed per token."
  }
];

export function OpenClawSettingsPage(props: { apiClient: DashboardApiClient }) {
  const { apiClient } = props;
  const queryClient = useQueryClient();
  const [lastFixResult, setLastFixResult] =
    useState<OpenClawFixPairingResponse | null>(null);
  const [showRawOutput, setShowRawOutput] = useState(false);
  const [selectedProvider, setSelectedProvider] =
    useState<OpenClawModelProvider | null>(null);
  const [providerResultMessage, setProviderResultMessage] = useState<
    string | null
  >(null);
  const [codexSessionId, setCodexSessionId] = useState<string | null>(null);
  const [codexAuthUrl, setCodexAuthUrl] = useState<string | null>(null);
  const [codexCallbackUrl, setCodexCallbackUrl] = useState("");
  const [codexLoginMessage, setCodexLoginMessage] = useState<string | null>(
    null
  );

  const statusQuery = useQuery({
    queryKey: PAIRING_STATUS_QUERY_KEY,
    queryFn: () => apiClient.getOpenClawPairingStatus(),
    refetchInterval: 15_000
  });

  const codexStatusQuery = useQuery({
    queryKey: CODEX_STATUS_QUERY_KEY,
    queryFn: () => apiClient.getOpenClawCodexStatus(),
    refetchInterval: 30_000
  });

  const fixMutation = useMutation({
    mutationFn: () => apiClient.fixOpenClawPairing(),
    onSuccess: (result) => {
      setLastFixResult(result);
      queryClient.invalidateQueries({ queryKey: PAIRING_STATUS_QUERY_KEY });
    }
  });

  const setProviderMutation = useMutation({
    mutationFn: (provider: OpenClawModelProvider) =>
      apiClient.setOpenClawModelProvider(provider),
    onSuccess: (result) => {
      setProviderResultMessage(result.message);
      queryClient.invalidateQueries({ queryKey: CODEX_STATUS_QUERY_KEY });
    }
  });

  const startCodexLoginMutation = useMutation({
    mutationFn: () => apiClient.startOpenClawCodexLogin(),
    onSuccess: (result) => {
      setCodexSessionId(result.sessionId);
      setCodexAuthUrl(result.authUrl);
      setCodexCallbackUrl("");
      setCodexLoginMessage(null);
    }
  });

  const completeCodexLoginMutation = useMutation({
    mutationFn: (args: { sessionId: string; callbackUrl: string }) =>
      apiClient.completeOpenClawCodexLogin(args.sessionId, args.callbackUrl),
    onSuccess: (result) => {
      if (result.completed) {
        setCodexLoginMessage(
          "Codex login completed. You can now switch the provider to OpenAI Codex."
        );
        setCodexSessionId(null);
        setCodexAuthUrl(null);
        setCodexCallbackUrl("");
        queryClient.invalidateQueries({ queryKey: CODEX_STATUS_QUERY_KEY });
      } else {
        setCodexLoginMessage(
          `Codex login did not complete cleanly (exit code ${result.exitCode ?? "?"}). Check CLI output below.`
        );
      }
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

  const codexStatus = codexStatusQuery.data ?? null;
  const codexStatusError =
    codexStatusQuery.error instanceof Error
      ? codexStatusQuery.error.message
      : null;
  const currentProvider: OpenClawModelProvider | null =
    codexStatus?.currentProvider ?? null;
  const codexSignedIn = codexStatus?.signedIn ?? false;
  const providerError =
    setProviderMutation.error instanceof Error
      ? setProviderMutation.error.message
      : null;
  const startCodexError =
    startCodexLoginMutation.error instanceof Error
      ? startCodexLoginMutation.error.message
      : null;
  const completeCodexError =
    completeCodexLoginMutation.error instanceof Error
      ? completeCodexLoginMutation.error.message
      : null;

  return (
    <div className="row g-4">
      <div className="col-lg-8">
        <div className="card mb-4">
          <div className="card-header">
            <h3 className="card-title d-flex align-items-center gap-2">
              <IconBrandOpenai size={20} stroke={1.75} />
              Model Provider
            </h3>
            <div className="card-actions">
              <button
                type="button"
                className="btn btn-sm btn-ghost-secondary"
                onClick={() => codexStatusQuery.refetch()}
                disabled={codexStatusQuery.isFetching}
              >
                <IconRefresh size={14} className="me-1" />
                Refresh
              </button>
            </div>
          </div>
          <div className="card-body">
            <p className="text-secondary mb-3">
              Select which upstream provider RedDwarf agents should use. The{" "}
              <strong>OpenAI Codex</strong> option routes every agent through
              your ChatGPT subscription via OpenClaw's Codex OAuth flow, so
              token usage is not billed to an API key.
            </p>

            {codexStatusQuery.isLoading ? (
              <div className="placeholder-glow mb-3">
                <div className="placeholder col-5 mb-2" />
                <div className="placeholder col-3" />
              </div>
            ) : codexStatusError ? (
              <div className="alert alert-danger d-flex align-items-start gap-2 mb-3">
                <IconAlertCircle size={18} className="mt-1 flex-shrink-0" />
                <div>
                  <div className="fw-bold">
                    Could not read Codex auth status
                  </div>
                  <div className="small">{codexStatusError}</div>
                </div>
              </div>
            ) : (
              <>
                <div className="mb-3 d-flex flex-wrap gap-2 align-items-center">
                  <span className="text-secondary">Current provider:</span>
                  <span className="badge bg-blue-lt">
                    {currentProvider ?? "not set"}
                  </span>
                  <span className="text-secondary">Codex signed in:</span>
                  <span
                    className={`badge ${codexSignedIn ? "bg-green-lt" : "bg-yellow-lt"}`}
                  >
                    {codexSignedIn ? "yes" : "no"}
                  </span>
                </div>
                {codexStatus?.roleBindings ? (
                  <div className="mb-3">
                    <div className="text-secondary small mb-1">
                      Active agent model bindings:
                    </div>
                    <ul className="list-unstyled small mb-0">
                      {Object.entries(codexStatus.roleBindings).map(
                        ([role, model]) => (
                          <li key={role}>
                            <span className="text-secondary">{role}:</span>{" "}
                            <code>{model}</code>
                          </li>
                        )
                      )}
                    </ul>
                  </div>
                ) : null}
              </>
            )}

            <div className="mb-3">
              <label className="form-label">Switch provider</label>
              <div className="d-flex flex-column gap-2">
                {MODEL_PROVIDER_OPTIONS.map((option) => {
                  const isCurrent = option.value === currentProvider;
                  const isSelected =
                    selectedProvider === option.value ||
                    (selectedProvider === null && isCurrent);
                  return (
                    <label
                      key={option.value}
                      className={`form-selectgroup-item ${isSelected ? "active" : ""}`}
                    >
                      <input
                        type="radio"
                        name="model-provider"
                        value={option.value}
                        className="form-selectgroup-input"
                        checked={isSelected}
                        onChange={() => setSelectedProvider(option.value)}
                      />
                      <span className="form-selectgroup-label d-flex align-items-start gap-2 text-start">
                        <span className="flex-grow-1">
                          <span className="fw-bold d-block">
                            {option.label}
                            {isCurrent ? (
                              <span className="badge bg-blue-lt ms-2">
                                current
                              </span>
                            ) : null}
                          </span>
                          <span className="small text-secondary">
                            {option.description}
                          </span>
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="d-flex flex-wrap gap-2 align-items-center">
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  setProviderMutation.isPending ||
                  selectedProvider === null ||
                  selectedProvider === currentProvider
                }
                onClick={() => {
                  if (!selectedProvider) return;
                  setProviderResultMessage(null);
                  setProviderMutation.mutate(selectedProvider);
                }}
              >
                {setProviderMutation.isPending
                  ? "Applying..."
                  : "Apply provider"}
              </button>
              <span className="text-secondary small">
                Updates <code>REDDWARF_MODEL_PROVIDER</code>, regenerates{" "}
                <code>openclaw.json</code>, and flags the container for
                restart.
              </span>
            </div>

            {providerError ? (
              <div className="alert alert-danger d-flex align-items-start gap-2 mt-3 mb-0">
                <IconAlertCircle size={18} className="mt-1 flex-shrink-0" />
                <div>
                  <div className="fw-bold">Failed to update provider</div>
                  <div className="small">{providerError}</div>
                </div>
              </div>
            ) : null}

            {providerResultMessage ? (
              <div className="alert alert-warning d-flex align-items-start gap-2 mt-3 mb-0">
                <IconCircleCheck size={18} className="mt-1 flex-shrink-0" />
                <div>
                  <div className="fw-bold">{providerResultMessage}</div>
                  <div className="small text-secondary">
                    Restart the <code>openclaw</code> container for the new
                    agent model bindings to take effect.
                  </div>
                </div>
              </div>
            ) : null}

            <hr className="my-4" />

            <h4 className="mb-2">ChatGPT (Codex) sign-in</h4>
            <p className="text-secondary small mb-3">
              Required before switching to <strong>OpenAI Codex</strong>. Click
              below to obtain an OpenAI auth URL, open it in a new tab, sign in
              to ChatGPT, then paste the redirect URL from your browser's
              address bar back into the field that appears.
            </p>

            <div className="d-flex flex-wrap gap-2 align-items-center mb-3">
              <button
                type="button"
                className="btn btn-outline-primary"
                disabled={startCodexLoginMutation.isPending}
                onClick={() => {
                  setCodexLoginMessage(null);
                  startCodexLoginMutation.mutate();
                }}
              >
                {startCodexLoginMutation.isPending
                  ? "Starting..."
                  : codexSignedIn
                    ? "Re-authenticate Codex"
                    : "Sign in to ChatGPT (Codex)"}
              </button>
            </div>

            {startCodexError ? (
              <div className="alert alert-danger d-flex align-items-start gap-2 mb-3">
                <IconAlertCircle size={18} className="mt-1 flex-shrink-0" />
                <div>
                  <div className="fw-bold">Could not start Codex login</div>
                  <div className="small">{startCodexError}</div>
                </div>
              </div>
            ) : null}

            {codexAuthUrl && codexSessionId ? (
              <div className="border rounded p-3 mb-3">
                <div className="fw-bold mb-2">Step 1 — open this URL</div>
                <a
                  href={codexAuthUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="d-inline-flex align-items-center gap-1 small text-break mb-3"
                >
                  <IconExternalLink size={14} />
                  {codexAuthUrl}
                </a>
                <div className="fw-bold mb-2">
                  Step 2 — paste the redirect URL from your browser's address
                  bar
                </div>
                <textarea
                  className="form-control mb-2"
                  rows={3}
                  placeholder="http://localhost:1455/?code=..."
                  value={codexCallbackUrl}
                  onChange={(event) =>
                    setCodexCallbackUrl(event.target.value)
                  }
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={
                    completeCodexLoginMutation.isPending ||
                    codexCallbackUrl.trim().length === 0
                  }
                  onClick={() =>
                    completeCodexLoginMutation.mutate({
                      sessionId: codexSessionId,
                      callbackUrl: codexCallbackUrl.trim()
                    })
                  }
                >
                  {completeCodexLoginMutation.isPending
                    ? "Completing..."
                    : "Submit redirect URL"}
                </button>
              </div>
            ) : null}

            {completeCodexError ? (
              <div className="alert alert-danger d-flex align-items-start gap-2 mb-0">
                <IconAlertCircle size={18} className="mt-1 flex-shrink-0" />
                <div>
                  <div className="fw-bold">Failed to complete Codex login</div>
                  <div className="small">{completeCodexError}</div>
                </div>
              </div>
            ) : null}

            {codexLoginMessage ? (
              <div className="alert alert-info mb-0">
                <div className="small">{codexLoginMessage}</div>
              </div>
            ) : null}
          </div>
        </div>

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
