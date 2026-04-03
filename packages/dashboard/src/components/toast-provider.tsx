import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import { IconCheck, IconExclamationCircle, IconInfoCircle } from "@tabler/icons-react";

type ToastTone = "success" | "error" | "info";

interface ToastItem {
  id: string;
  message: string;
  tone: ToastTone;
}

interface ToastContextValue {
  pushToast: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

function toneClassName(tone: ToastTone): string {
  switch (tone) {
    case "success":
      return "border-success";
    case "error":
      return "border-danger";
    case "info":
      return "border-blue";
  }
}

function ToastIcon(props: { tone: ToastTone }) {
  const { tone } = props;

  if (tone === "success") {
    return <IconCheck size={18} />;
  }

  if (tone === "error") {
    return <IconExclamationCircle size={18} />;
  }

  return <IconInfoCircle size={18} />;
}

export function ToastProvider(props: { children: ReactNode }) {
  const { children } = props;
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const pushToast = useCallback((message: string, tone: ToastTone = "info") => {
    setToasts((current) => [
      ...current,
      {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        message,
        tone
      }
    ]);
  }, []);

  useEffect(() => {
    if (toasts.length === 0) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setToasts((current) => current.slice(1));
    }, 3500);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [toasts]);

  const value = useMemo(() => ({ pushToast }), [pushToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-container toast-container-top toast-container-end p-3">
        {toasts.map((toast) => (
          <div
            className={`toast show dashboard-toast ${toneClassName(toast.tone)}`}
            key={toast.id}
            role="status"
          >
            <div className="toast-header">
              <span className="me-2 text-secondary">
                <ToastIcon tone={toast.tone} />
              </span>
              <strong className="me-auto">RedDwarf Control</strong>
              <button
                aria-label="Close"
                className="btn-close"
                onClick={() =>
                  setToasts((current) => current.filter((item) => item.id !== toast.id))
                }
                type="button"
              />
            </div>
            <div className="toast-body">{toast.message}</div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider.");
  }

  return context;
}
