import type {
  PhaseLifecycleStatus,
  TaskLifecycleStatus
} from "@reddwarf/contracts";

const taskLifecycleTransitions: Record<
  TaskLifecycleStatus,
  TaskLifecycleStatus[]
> = {
  // Feature 186: `quarantined` is reachable from any non-terminal state via
  // operator action and releases back to `ready` or `cancelled` only —
  // dispatch is never resumed implicitly.
  draft: ["ready", "cancelled", "quarantined"],
  ready: ["active", "cancelled", "quarantined"],
  active: ["blocked", "completed", "failed", "cancelled", "quarantined"],
  blocked: ["ready", "active", "failed", "cancelled", "completed", "quarantined"],
  completed: [],
  failed: ["draft", "cancelled", "quarantined"],
  cancelled: [],
  quarantined: ["ready", "cancelled"]
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
