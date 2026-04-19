import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconShieldOff, IconShieldCheck } from "@tabler/icons-react";
import { useToast } from "../components/toast-provider";
import type { DashboardApiClient, TaskSummary } from "../types/dashboard";

// Feature 186 — operator triage queue.
// Lists every task whose lifecycleStatus is `quarantined` and exposes a
// release action. Other triage verbs (notes, heartbeat-kick) are reachable
// from the run / approval detail pages.

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatTaskSource(task: TaskSummary): string {
  const issueNumber = task.source.issueNumber ?? task.source.issueId;
  return issueNumber ? `${task.source.repo}#${issueNumber}` : task.source.repo;
}

export function TriagePage(props: { apiClient: DashboardApiClient }) {
  const { apiClient } = props;
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);

  const tasksQuery = useQuery({
    queryKey: ["triage-quarantined-tasks"],
    queryFn: () => apiClient.listTasks({ lifecycleStatuses: ["quarantined"], limit: 100 }),
    refetchInterval: 15000
  });

  async function release(taskId: string) {
    setPendingTaskId(taskId);
    try {
      await apiClient.releaseTask(taskId);
      pushToast(`Released ${taskId} back to ready.`, "success");
      await queryClient.invalidateQueries({ queryKey: ["triage-quarantined-tasks"] });
    } catch (error) {
      pushToast(
        error instanceof Error ? error.message : "Failed to release task.",
        "error"
      );
    } finally {
      setPendingTaskId(null);
    }
  }

  const tasks = tasksQuery.data?.tasks ?? [];

  return (
    <div className="d-flex flex-column gap-3">
      <div className="card">
        <div className="card-header d-flex align-items-center justify-content-between">
          <div>
            <h3 className="card-title mb-0">
              <IconShieldOff size={18} className="me-2 text-orange" />
              Quarantined tasks
            </h3>
            <div className="text-secondary small">
              Tasks the operator put on hold. The dispatcher does not pick them
              up until released. Quarantine + reason flows live on the approval
              detail and task detail views.
            </div>
          </div>
        </div>
        <div className="table-responsive">
          <table className="table table-vcenter card-table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Source</th>
                <th>Phase</th>
                <th>Risk</th>
                <th>Quarantined at</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tasks.length === 0 && !tasksQuery.isLoading ? (
                <tr>
                  <td colSpan={6} className="text-secondary text-center py-4">
                    Nothing in quarantine.
                  </td>
                </tr>
              ) : null}
              {tasks.map((task) => (
                <tr key={task.taskId}>
                  <td>
                    <div className="fw-medium">{task.title}</div>
                    <div className="font-monospace small text-secondary">
                      {task.taskId}
                    </div>
                  </td>
                  <td>{formatTaskSource(task)}</td>
                  <td>{task.currentPhase}</td>
                  <td>
                    <span className="badge bg-secondary-lt text-secondary">
                      {task.riskClass}
                    </span>
                  </td>
                  <td className="text-nowrap">{formatDateTime(task.updatedAt)}</td>
                  <td className="text-end">
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-success"
                      disabled={pendingTaskId === task.taskId}
                      onClick={() => void release(task.taskId)}
                    >
                      <IconShieldCheck size={14} className="me-1" />
                      Release
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {tasksQuery.isError ? (
        <div className="alert alert-danger" role="alert">
          {tasksQuery.error instanceof Error
            ? tasksQuery.error.message
            : "Failed to load quarantined tasks."}
        </div>
      ) : null}
    </div>
  );
}
