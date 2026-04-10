import { useEffect, useRef, useState } from "react";
import { IconX } from "@tabler/icons-react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import { ApiError, openOpenClawCodexLoginStream } from "../api/client";
import type { DashboardApiClient } from "../types/dashboard";

type Status = "connecting" | "streaming" | "exited" | "error" | "closed";

interface CodexLoginTerminalProps {
  apiClient: DashboardApiClient;
  onClose: () => void;
  onSuccess?: () => void;
}

function base64ToBytes(b64: string): Uint8Array {
  // Normalize: strip any whitespace, accept URL-safe variants, re-pad.
  const clean = b64
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padLen = (4 - (clean.length % 4)) % 4;
  const padded = clean + "=".repeat(padLen);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Full interactive openclaw login terminal. Mounts an xterm.js terminal,
 * consumes the NDJSON stream from GET /openclaw/codex-login/stream (which
 * emits base64-encoded raw PTY bytes), and forwards every keystroke back
 * via POST /openclaw/codex-login/input. Behaves exactly like running the
 * openclaw login CLI in a local terminal.
 */
export function CodexLoginTerminal(props: CodexLoginTerminalProps) {
  const { apiClient, onClose, onSuccess } = props;
  const [status, setStatus] = useState<Status>("connecting");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const pendingInputRef = useRef<string>("");
  const statusRef = useRef<Status>("connecting");

  // Keep a ref mirror of status so stream callbacks read current state.
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // Mount xterm.js once.
  useEffect(() => {
    if (!containerRef.current) {
      return;
    }
    const term = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily:
        '"JetBrains Mono", "Fira Code", Menlo, Consolas, monospace',
      fontSize: 13,
      theme: {
        background: "#0b0e14",
        foreground: "#e6e6e6",
        cursor: "#e6e6e6"
      },
      scrollback: 5000
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    try {
      fitAddon.fit();
    } catch {
      // fit may fail if the modal is still animating in; ignore.
    }
    term.writeln("Connecting to openclaw...");
    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // xterm.js focuses its internal hidden textarea; we must give it time
    // to mount before calling focus or Bootstrap's modal focus trap steals it.
    const focusTimer = window.setTimeout(() => {
      try {
        term.focus();
      } catch {
        // term may already be disposed
      }
    }, 50);

    const handleResize = () => {
      try {
        fitAddon.fit();
      } catch {
        // ignore
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("resize", handleResize);
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Input is fully decoupled from xterm's focus management. Capture
  // keydown + paste events at the document level while the modal is
  // mounted and POST them directly to the PTY input endpoint. The
  // xterm.js terminal is display-only.
  useEffect(() => {
    const sendToPty = (data: string) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) {
        pendingInputRef.current += data;
        return;
      }
      if (statusRef.current !== "streaming") {
        return;
      }
      void apiClient
        .sendOpenClawCodexLoginInput(sessionId, data)
        .catch((err) => {
          setErrorMessage(
            err instanceof ApiError || err instanceof Error
              ? err.message
              : "Failed to send input to Codex login session."
          );
        });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // If the user is typing into an unrelated input/textarea outside
      // our modal, don't hijack.
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA")
      ) {
        return;
      }
      // Let the browser's native paste handler fire for Ctrl/Cmd+V.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
        return;
      }
      // Allow standard copy / select-all in the modal.
      if (
        (event.ctrlKey || event.metaKey) &&
        ["c", "a"].includes(event.key.toLowerCase())
      ) {
        return;
      }

      let data: string | null = null;
      if (event.key === "Enter") {
        data = "\r";
      } else if (event.key === "Backspace") {
        data = "\x7f";
      } else if (event.key === "Tab") {
        data = "\t";
      } else if (event.key === "Escape") {
        data = "\x1b";
      } else if (event.key === "ArrowUp") {
        data = "\x1b[A";
      } else if (event.key === "ArrowDown") {
        data = "\x1b[B";
      } else if (event.key === "ArrowRight") {
        data = "\x1b[C";
      } else if (event.key === "ArrowLeft") {
        data = "\x1b[D";
      } else if (event.key === " ") {
        data = " ";
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
        data = event.key;
      }

      if (data === null) {
        return;
      }
      event.preventDefault();
      sendToPty(data);
    };

    const onPaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text");
      if (!text) {
        return;
      }
      event.preventDefault();
      sendToPty(text);
    };

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("paste", onPaste, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("paste", onPaste, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Open the NDJSON stream once.
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      try {
        for await (const frame of openOpenClawCodexLoginStream(controller.signal)) {
          if (cancelled) {
            break;
          }
          const term = terminalRef.current;
          if (frame.type === "session") {
            sessionIdRef.current = frame.sessionId;
            setStatus("streaming");
            // Flush any keystrokes the user typed before the session was ready.
            const pending = pendingInputRef.current;
            pendingInputRef.current = "";
            if (pending.length > 0) {
              void apiClient
                .sendOpenClawCodexLoginInput(frame.sessionId, pending)
                .catch(() => {
                  // best-effort flush
                });
            }
            continue;
          }
          if (frame.type === "data") {
            if (term) {
              try {
                term.write(base64ToBytes(frame.data));
              } catch (decodeErr) {
                console.error(
                  "[codex-login] base64 decode failed",
                  decodeErr,
                  frame.data.slice(0, 80)
                );
              }
            }
            continue;
          }
          if (frame.type === "exit") {
            setExitCode(frame.code);
            setStatus("exited");
            if (term) {
              term.writeln("");
              term.writeln(
                `\u001b[90m[openclaw exited with code ${frame.code ?? "?"}]\u001b[0m`
              );
            }
            if (frame.code === 0) {
              onSuccess?.();
            }
            continue;
          }
          if (frame.type === "error") {
            setErrorMessage(frame.message);
            setStatus("error");
            if (term) {
              term.writeln("");
              term.writeln(`\u001b[31m[error] ${frame.message}\u001b[0m`);
            }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
              openclaw Codex login
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
            <p className="text-secondary small mb-3">
              A live openclaw CLI session is attached to the terminal below.
              Follow the prompts: open the <code>auth.openai.com</code> URL it
              prints in a local browser tab, sign in to ChatGPT, then paste the{" "}
              <code>localhost:1455/?code=...</code> redirect URL back into this
              terminal and press Enter — exactly like running openclaw from a
              shell.
            </p>
            <div
              ref={containerRef}
              onClick={() => {
                try {
                  terminalRef.current?.focus();
                } catch {
                  // ignore
                }
              }}
              style={{
                width: "100%",
                height: "480px",
                backgroundColor: "#0b0e14",
                padding: "8px",
                borderRadius: "6px",
                cursor: "text"
              }}
            />
            {errorMessage ? (
              <div className="alert alert-danger d-flex align-items-start gap-2 mt-3 mb-0">
                <IconX size={18} className="mt-1 flex-shrink-0" />
                <div className="small">{errorMessage}</div>
              </div>
            ) : null}
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
