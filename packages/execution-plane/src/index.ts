import type { AgentDefinition, TaskPhase } from "@reddwarf/contracts";

export const agentDefinitions: AgentDefinition[] = [
  {
    id: "architect-default",
    displayName: "Architect Agent",
    type: "architect",
    capabilities: ["can_plan", "can_archive_evidence"],
    activePhases: ["planning"],
    enabled: true,
    description: "Produces planning specs, constraints, and acceptance mappings."
  },
  {
    id: "developer-placeholder",
    displayName: "Developer Agent",
    type: "developer",
    capabilities: ["can_write_code", "can_run_tests"],
    activePhases: ["development"],
    enabled: false,
    description: "Declared for future autonomous development, disabled in v1."
  },
  {
    id: "validation-placeholder",
    displayName: "Validation Agent",
    type: "validation",
    capabilities: ["can_run_tests"],
    activePhases: ["validation"],
    enabled: false,
    description: "Declared for future validation gates, disabled in v1."
  },
  {
    id: "reviewer-placeholder",
    displayName: "Reviewer Agent",
    type: "reviewer",
    capabilities: ["can_review"],
    activePhases: ["review"],
    enabled: false,
    description: "Declared for future review gates, disabled in v1."
  },
  {
    id: "scm-placeholder",
    displayName: "SCM Agent",
    type: "scm",
    capabilities: ["can_open_pr"],
    activePhases: ["scm"],
    enabled: false,
    description: "Declared for future branch and PR automation, disabled in v1."
  }
];

const disabledPhases = new Set<TaskPhase>(["development", "validation", "review", "scm"]);

export function phaseIsExecutable(phase: TaskPhase): boolean {
  return !disabledPhases.has(phase);
}

export function assertPhaseExecutable(phase: TaskPhase): void {
  if (!phaseIsExecutable(phase)) {
    throw new Error(`Phase ${phase} is declared but disabled in RedDwarf v1.`);
  }
}
