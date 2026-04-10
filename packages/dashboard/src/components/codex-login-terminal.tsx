import { useEffect, useRef, useState } from "react";
import { IconX } from "@tabler/icons-react";
import { ApiError, openOpenClawCodexLoginStream } from "../api/client";
import type { DashboardApiClient } from "../types/dashboard";

type Status = "connecting" | "streaming" | "exited" | "error" | "closed";

interface CodexLoginTerminalProps {
  apiClient: DashboardApiClient;
  onClose: () => void;
  onSuccess?: () => void;
}

/**
 * Streaming terminal replacement for the old start/paste REST flow.
 *
 * Opens GET /openclaw/codex-login/stream (NDJSON long-poll) and renders each
 * `data` frame into a scrolling monospace panel. The first `session` frame
 * carries the sessionId we pass to POST /openclaw/codex-login/input for
 * forwarding stdin (primarily the redirect URL the user pastes back after
 * authenticating in their local browser).
 */
export function CodexLoginTerminal(props: CodexLoginTerminalProps) {
  const { apiClient, onClose, onSuccess } = props;
  const [lines, setLines] = useState<string>("");
  const [status, setStatus] = useState<Status>("connecting");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [sending, setSending] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLPreElement | null>(null);

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
        if (!cancelled && status === "streaming") {
          setStatus("closed");
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
              Codex login terminal
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
            <p className="text-secondary small mb-2">
              Open the <code>https://auth.openai.com/...</code> URL printed below in a
              local browser tab, sign in to ChatGPT, then paste the redirect URL
              your browser lands on (it will look like{" "}
              <code>http://localhost:1455/?code=...</code>) into the input box and
              press Enter.
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
                maxHeight: "400px",
                minHeight: "240px"
              }}
            >
              {lines || (status === "connecting" ? "Connecting...\n" : "")}
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
                autoFocus
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
