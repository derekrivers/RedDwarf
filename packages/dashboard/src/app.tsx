import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate
} from "react-router-dom";
import {
  IconActivityHeartbeat,
  IconChecklist,
  IconDatabase,
  IconFileSearch,
  IconGauge,
  IconLogout,
  IconMoon,
  IconRobot,
  IconSun
} from "@tabler/icons-react";
import type { ApprovalRequestStatus } from "@reddwarf/contracts";
import { LoginScreen } from "./components/login-screen";
import { PagePlaceholder } from "./components/page-placeholder";

const tokenStorageKey = "reddwarf-operator-token";
const themeStorageKey = "reddwarf-dashboard-theme";

type DashboardTheme = "light" | "dark";
type ShellHealthTone = "green" | "yellow" | "red" | "secondary";

interface HealthSummary {
  status: "ok";
  repository?: {
    status?: "healthy" | "degraded";
  };
  polling?: {
    status?: "idle" | "healthy" | "degraded";
  };
}

interface ApprovalsResponse {
  approvals: Array<{
    status: ApprovalRequestStatus;
  }>;
  total: number;
}

interface NavItem {
  to: string;
  label: string;
  icon: typeof IconGauge;
}

const navItems: NavItem[] = [
  { to: "/dashboard", label: "Dashboard", icon: IconGauge },
  { to: "/approvals", label: "Approvals", icon: IconChecklist },
  { to: "/pipeline", label: "Pipeline", icon: IconActivityHeartbeat },
  { to: "/evidence", label: "Evidence", icon: IconDatabase },
  { to: "/agents", label: "Agents", icon: IconRobot }
];

function getStoredTheme(): DashboardTheme {
  const storedTheme = window.sessionStorage.getItem(themeStorageKey);
  return storedTheme === "dark" ? "dark" : "light";
}

function readStoredToken(): string {
  return window.sessionStorage.getItem(tokenStorageKey) ?? "";
}

async function fetchShellJson<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (response.status === 401) {
    window.sessionStorage.removeItem(tokenStorageKey);
    throw new Error("Operator token is no longer valid.");
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { message?: string }
      | null;
    throw new Error(payload?.message ?? `Request failed with status ${response.status}.`);
  }

  return (await response.json()) as T;
}

function getHealthTone(health: HealthSummary | undefined): ShellHealthTone {
  if (!health) {
    return "secondary";
  }

  if (
    health.repository?.status === "degraded" ||
    health.polling?.status === "degraded"
  ) {
    return "yellow";
  }

  return health.status === "ok" ? "green" : "red";
}

function getHealthLabel(health: HealthSummary | undefined): string {
  if (!health) {
    return "Connecting";
  }

  if (
    health.repository?.status === "degraded" ||
    health.polling?.status === "degraded"
  ) {
    return "Degraded";
  }

  return "Healthy";
}

function useShellTheme(): [DashboardTheme, () => void] {
  const [theme, setTheme] = useState<DashboardTheme>(() => getStoredTheme());

  useEffect(() => {
    document.documentElement.setAttribute("data-bs-theme", theme);
    window.sessionStorage.setItem(themeStorageKey, theme);
  }, [theme]);

  return [theme, () => setTheme((current) => (current === "light" ? "dark" : "light"))];
}

function useTooltipBootstrap(): void {
  useEffect(() => {
    const bootstrapApi = (
      window as Window & {
        bootstrap?: {
          Tooltip: {
            getOrCreateInstance(element: Element): { dispose(): void };
          };
        };
      }
    ).bootstrap;

    if (!bootstrapApi) {
      return;
    }

    const elements = Array.from(document.querySelectorAll("[data-bs-toggle='tooltip']"));
    const tooltips = elements.map((element) =>
      bootstrapApi.Tooltip.getOrCreateInstance(element)
    );

    return () => {
      tooltips.forEach((tooltip) => tooltip.dispose());
    };
  }, []);
}

export function App() {
  const [token, setToken] = useState<string>(() => readStoredToken());

  useEffect(() => {
    if (!token) {
      return;
    }

    window.sessionStorage.setItem(tokenStorageKey, token);
  }, [token]);

  if (!token) {
    return <LoginScreen onAuthenticate={setToken} />;
  }

  return <DashboardShell token={token} onLogout={() => setToken("")} />;
}

function DashboardShell(props: { token: string; onLogout: () => void }) {
  const { token, onLogout } = props;
  const [theme, toggleTheme] = useShellTheme();
  const location = useLocation();
  const navigate = useNavigate();
  useTooltipBootstrap();

  const healthQuery = useQuery({
    queryKey: ["shell-health", token],
    queryFn: () => fetchShellJson<HealthSummary>(token, "/health"),
    refetchInterval: 15000
  });

  const approvalsQuery = useQuery({
    queryKey: ["shell-approvals", token],
    queryFn: () =>
      fetchShellJson<ApprovalsResponse>(token, "/approvals?statuses=pending&limit=100"),
    refetchInterval: 10000
  });

  useEffect(() => {
    if (!(healthQuery.error instanceof Error) && !(approvalsQuery.error instanceof Error)) {
      return;
    }

    const error = healthQuery.error instanceof Error ? healthQuery.error : approvalsQuery.error;
    if (error instanceof Error && error.message.includes("no longer valid")) {
      onLogout();
      navigate("/", { replace: true });
    }
  }, [approvalsQuery.error, healthQuery.error, navigate, onLogout]);

  const approvalCount = approvalsQuery.data?.approvals.filter(
    (approval) => approval.status === "pending"
  ).length ?? 0;
  const healthTone = getHealthTone(healthQuery.data);
  const healthLabel = getHealthLabel(healthQuery.data);
  const pageTitle = useMemo(() => {
    const currentItem = navItems.find((item) => location.pathname.startsWith(item.to));
    return currentItem?.label ?? "Dashboard";
  }, [location.pathname]);

  return (
    <div className="page">
      <aside className="navbar navbar-vertical navbar-expand-lg" data-bs-theme={theme}>
        <div className="container-fluid">
          <button
            className="navbar-toggler"
            type="button"
            data-bs-toggle="collapse"
            data-bs-target="#dashboard-sidebar"
            aria-controls="dashboard-sidebar"
            aria-expanded="false"
            aria-label="Toggle navigation"
          >
            <span className="navbar-toggler-icon" />
          </button>
          <h1 className="navbar-brand navbar-brand-autodark mb-0">
            <span className="text-red">RedDwarf</span> Control
          </h1>
          <div className="collapse navbar-collapse" id="dashboard-sidebar">
            <ul className="navbar-nav pt-lg-3">
              {navItems.map((item) => {
                const Icon = item.icon;
                return (
                  <li className="nav-item" key={item.to}>
                    <NavLink
                      className={({ isActive }) =>
                        isActive ? "nav-link active" : "nav-link"
                      }
                      to={item.to}
                    >
                      <span className="nav-link-icon d-md-none d-lg-inline-block">
                        <Icon size={18} stroke={1.75} />
                      </span>
                      <span className="nav-link-title">{item.label}</span>
                      {item.to === "/approvals" ? (
                        <span className="badge badge-sm bg-red-lt ms-auto">
                          {approvalCount}
                        </span>
                      ) : null}
                    </NavLink>
                  </li>
                );
              })}
              <li className="nav-item">
                <span
                  className="nav-link disabled cursor-help"
                  data-bs-toggle="tooltip"
                  data-bs-placement="right"
                  title="Coming soon"
                >
                  <span className="nav-link-icon d-md-none d-lg-inline-block">
                    <IconFileSearch size={18} stroke={1.75} />
                  </span>
                  <span className="nav-link-title">Logs</span>
                </span>
              </li>
            </ul>
          </div>
        </div>
      </aside>
      <div className="page-wrapper">
        <header className="navbar navbar-expand-md d-print-none">
          <div className="container-xl">
            <div className="navbar-nav flex-row order-md-last align-items-center gap-2">
              <span className={`status status-${healthTone}`}>
                <span className="status-dot status-dot-animated" />
                {healthLabel}
              </span>
              <button className="btn btn-icon btn-ghost-secondary" onClick={toggleTheme} type="button">
                {theme === "light" ? <IconMoon size={18} /> : <IconSun size={18} />}
              </button>
              <button className="btn btn-outline-secondary" onClick={onLogout} type="button">
                <IconLogout className="me-2" size={18} />
                Logout
              </button>
            </div>
            <div className="navbar-nav flex-row">
              <div className="nav-item">
                <div className="page-pretitle">Operations</div>
                <h2 className="page-title mb-0">{pageTitle}</h2>
              </div>
            </div>
          </div>
        </header>
        <div className="page-body">
          <div className="container-xl">
            <Routes>
              <Route path="/" element={<Navigate replace to="/dashboard" />} />
              <Route
                path="/dashboard"
                element={
                  <PagePlaceholder
                    title="Dashboard"
                    description="Pipeline summary cards and recent activity land here next."
                  />
                }
              />
              <Route
                path="/approvals"
                element={
                  <PagePlaceholder
                    title="Approvals"
                    description="The approval queue will render here with live polling."
                  />
                }
              />
              <Route
                path="/approvals/:approvalId"
                element={
                  <PagePlaceholder
                    title="Approval Detail"
                    description="The approval review and decision surface will render here."
                  />
                }
              />
              <Route
                path="/pipeline"
                element={
                  <PagePlaceholder
                    title="Pipeline Runs"
                    description="Pipeline run history, filters, and row details will render here."
                  />
                }
              />
              <Route
                path="/evidence"
                element={
                  <PagePlaceholder
                    title="Evidence Browser"
                    description="Evidence search and JSON export will render here."
                  />
                }
              />
              <Route
                path="/agents"
                element={
                  <PagePlaceholder
                    title="Agent Status"
                    description="Agent cards and health status will render here."
                  />
                }
              />
              {/* <Route path="/logs" element={<LogsPage />} /> */}
              <Route path="*" element={<Navigate replace to="/dashboard" />} />
            </Routes>
          </div>
        </div>
      </div>
    </div>
  );
}
