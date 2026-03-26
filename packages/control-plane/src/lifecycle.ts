import type {
  PhaseLifecycleStatus,
  TaskLifecycleStatus
} from "@reddwarf/contracts";

const taskLifecycleTransitions: Record<
  TaskLifecycleStatus,
  TaskLifecycleStatus[]
> = {
  draft: ["ready", "cancelled"],
  ready: ["active", "cancelled"],
  active: ["blocked", "completed", "failed", "cancelled"],
  blocked: ["ready", "active", "failed", "cancelled", "completed"],
  completed: [],
  failed: ["draft", "cancelled"],
  cancelled: []
};

const phaseLifecycleTransitions: Record<
  PhaseLifecycleStatus,
  PhaseLifecycleStatus[]
> = {
  pending: ["running", "skipped"],
  running: ["passed", "failed", "escalated", "skipped"],
  passed: [],
  failed: [],
  escalated: ["running", "skipped"],
  skipped: []
};

export function assertTaskLifecycleTransition(
  from: TaskLifecycleStatus,
  to: TaskLifecycleStatus
): void {
  if (!taskLifecycleTransitions[from].includes(to)) {
    throw new Error(`Illegal task lifecycle transition from ${from} to ${to}.`);
  }
}

export function assertPhaseLifecycleTransition(
  from: PhaseLifecycleStatus,
  to: PhaseLifecycleStatus
): void {
  if (!phaseLifecycleTransitions[from].includes(to)) {
    throw new Error(
      `Illegal phase lifecycle transition from ${from} to ${to}.`
    );
  }
}
