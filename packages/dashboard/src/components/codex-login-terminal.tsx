import { useEffect, useRef, useState } from "react";
import { IconCheck, IconCopy, IconX } from "@tabler/icons-react";
import { ApiError, openOpenClawCodexLoginStream } from "../api/client";
import type { DashboardApiClient } from "../types/dashboard";

type Status = "connecting" | "streaming" | "exited" | "error" | "closed";

interface CodexLoginTerminalProps {
  apiClient: DashboardApiClient;
  onClose: () => void;
  onSuccess?: () => void;
}

/**
 * Codex login modal. Primary path: shows the exact `docker compose exec`
 * command to run in a local terminal so the operator can drive the openclaw
 * CLI's OAuth flow directly (where they have a real TTY and can follow
 * openclaw's prompts as designed). A secondary embedded NDJSON stream view
 * mirrors the same flow inside the browser when it is working.
 */
export function CodexLoginTerminal(props: CodexLoginTerminalProps) {
  const { apiClient, onClose, onSuccess } = props;
  const [lines, setLines] = useState<string>("");
  const [status, setStatus] = useState<Status>("connecting");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLPreElement | null>(null);

  const loginCommand =
    "docker compose -f infra/docker/docker-compose.yml --profile openclaw exec openclaw node dist/index.js models auth login --provider openai-codex --set-default";

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      try {
        for await (const frame of openOpenClawCodexLoginStream(controller.signal)) {
          if (cancelled) {
            break;
          }
          if (frame.type === "session") {
            sessionIdRef.current = frame.sessionId;
            setStatus("streaming");
            continue;
          }
          if (frame.type === "data") {
            setLines((prev) => prev + frame.text);
            continue;
          }
          if (frame.type === "exit") {
            setExitCode(frame.code);
            setStatus("exited");
            if (frame.code === 0) {
              onSuccess?.();
            }
            continue;
          }
          if (frame.type === "error") {
            setErrorMessage(frame.message);
            setStatus("error");
            continue;
          }
        }
        if (!cancelled) {
          setStatus((prev) => (prev === "streaming" ? "closed" : prev));
        }
      } catch (err) {
        if (cancelled) {
          return;
        }
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        setErrorMessage(
          err instanceof ApiError || err instanceof Error
            ? err.message
            : "Failed to open Codex login stream."
        );
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // onSuccess is stable-ish; we intentionally only want this effect once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  const sessionId = sessionIdRef.current;
  const canSend =
    status === "streaming" &&
    sessionId !== null &&
    inputValue.trim().length > 0 &&
    !sending;

  const sendInput = async (raw: string, appendNewline: boolean) => {
    if (!sessionId) {
      return;
    }
    setSending(true);
    try {
      const payload = appendNewline ? `${raw}\n` : raw;
      await apiClient.sendOpenClawCodexLoginInput(sessionId, payload);
      setInputValue("");
    } catch (err) {
      setErrorMessage(
        err instanceof ApiError || err instanceof Error
          ? err.message
          : "Failed to send input to Codex login session."
      );
    } finally {
      setSending(false);
    }
  };

  const copyCommand = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(loginCommand);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = loginCommand;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // best-effort copy
    }
  };

  const statusBadgeClass =
    status === "streaming"
      ? "bg-blue-lt"
      : status === "exited" && exitCode === 0
        ? "bg-green-lt"
        : status === "exited" || status === "error"
          ? "bg-red-lt"
          : "bg-secondary-lt";

  const statusLabel =
    status === "connecting"
      ? "Connecting..."
      : status === "streaming"
        ? "Live"
        : status === "exited"
          ? `Exited (${exitCode ?? "?"})`
          : status === "error"
            ? "Error"
            : "Closed";

  return (
    <div
      className="modal modal-blur fade show d-block"
      role="dialog"
      aria-modal="true"
      style={{ backgroundColor: "rgba(0, 0, 0, 0.5)" }}
    >
      <div className="modal-dialog modal-xl modal-dialog-centered modal-dialog-scrollable">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title d-flex align-items-center gap-2">
              Codex login
              <span className={`badge ${statusBadgeClass}`}>{statusLabel}</span>
            </h5>
            <button
              type="button"
              className="btn-close"
              aria-label="Close"
              onClick={onClose}
            />
          </div>
          <div className="modal-body">
            <div className="mb-4">
              <h6 className="mb-2">1. Start the Codex login flow</h6>
              <p className="text-secondary small mb-2">
                Run this command in a local terminal from the repository root.
                openclaw will print an <code>https://auth.openai.com/...</code>{" "}
                URL — open it in your browser, sign in to ChatGPT, then paste
                the <code>http://localhost:1455/?code=...</code> redirect URL
                back into the same terminal when openclaw asks for it.
              </p>
              <div className="d-flex align-items-stretch gap-2">
                <pre
                  className="bg-dark text-light rounded p-3 mb-0 flex-grow-1"
                  style={{
                    fontFamily:
                      '"JetBrains Mono", "Fira Code", Menlo, Consolas, monospace',
                    fontSize: "12px",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                    overflowX: "auto"
                  }}
                >
                  {loginCommand}
                </pre>
                <button
                  type="button"
                  className="btn btn-outline-primary d-inline-flex align-items-center gap-1"
                  onClick={() => {
                    void copyCommand();
                  }}
                  title="Copy command"
                >
                  {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="text-secondary small mt-2 mb-0">
                When the login completes, come back here and switch the
                provider to <strong>OpenAI Codex</strong>. The auth status card
                will update automatically.
              </p>
            </div>

            <div>
              <h6 className="mb-2">
                2. Live view (optional, mirrors openclaw inside the browser)
              </h6>
              <p className="text-secondary small mb-2">
                If streaming works in your environment you can drive the same
                flow from here: read the URL below, open it locally, then paste
                the redirect URL into the input box and press Enter.
              </p>
              <pre
                ref={scrollRef}
                className="bg-dark text-light rounded p-3 mb-3"
                style={{
                  fontFamily:
                    '"JetBrains Mono", "Fira Code", Menlo, Consolas, monospace',
                  fontSize: "12px",
                  whiteSpace: "pre-wrap",
                  overflowY: "auto",
                  maxHeight: "360px",
                  minHeight: "200px"
                }}
              >
                {lines ||
                  (status === "connecting"
                    ? "Connecting to openclaw...\n"
                    : "(no output yet)\n")}
              </pre>
              {errorMessage ? (
                <div className="alert alert-danger d-flex align-items-start gap-2 mb-3">
                  <IconX size={18} className="mt-1 flex-shrink-0" />
                  <div className="small">{errorMessage}</div>
                </div>
              ) : null}
              <form
                className="d-flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (canSend) {
                    void sendInput(inputValue.trim(), true);
                  }
                }}
              >
                <input
                  type="text"
                  className="form-control font-monospace"
                  placeholder="Paste redirect URL or type a reply, then press Enter"
                  value={inputValue}
                  onChange={(event) => setInputValue(event.target.value)}
                  disabled={status !== "streaming" || sending}
                />
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={!canSend}
                >
                  Send
                </button>
              </form>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
