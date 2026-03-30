// Re-export deterministic agents from execution-plane
export {
  DeterministicDeveloperAgent,
  DeterministicPlanningAgent,
  DeterministicScmAgent,
  DeterministicValidationAgent
} from "@reddwarf/execution-plane";

// Types and interfaces
export type {
  PhaseDefinition,
  PlanningConcurrencyOptions,
  PhaseTimingOptions,
  PlanningPipelineDependencies,
  PlanningPipelineResult,
  RunDeveloperPhaseInput,
  RunValidationPhaseInput,
  RunScmPhaseInput,
  DevelopmentPhaseDependencies,
  ValidationPhaseDependencies,
  ScmPhaseDependencies,
  DevelopmentPhaseResult,
  ValidationPhaseResult,
  ScmPhaseResult,
  ResolveApprovalRequestInput,
  ResolveApprovalRequestDependencies,
  ResolveApprovalRequestResult,
  SweepStaleRunsOptions,
  SweepStaleRunsResult,
  SweepOrphanedStateOptions,
  SweepOrphanedStateRepair,
  SweepOrphanedStateResult,
  OrphanType,
  OrphanRepairAction,
  DispatchReadyTaskInput,
  DispatchReadyTaskDependencies,
  DispatchPhaseOutcome,
  DispatchReadyTaskResult
} from "./types.js";

// PhaseRunContext is defined in shared.ts
export type { PhaseRunContext } from "./shared.js";

// Value exports from types
export {
  phaseRegistry,
  PlanningPipelineFailure
} from "./types.js";

// Context helpers
export { createPhaseRunContext } from "./context.js";

// Shared utilities
export { waitWithHeartbeat } from "./shared.js";

// Workspace path utilities
export { buildRuntimeWorkspacePath } from "./workspace-path.js";

// Pipeline phase functions
export { runPlanningPipeline } from "./planning.js";
export { runDeveloperPhase } from "./development.js";
export { runValidationPhase } from "./validation.js";
export { runScmPhase } from "./scm.js";
export { resolveApprovalRequest } from "./approval.js";
export { sweepStaleRuns, sweepOrphanedDispatcherState } from "./sweep.js";
export { dispatchReadyTask } from "./dispatch.js";
