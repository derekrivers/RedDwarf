import { v1DisabledPhases } from "@reddwarf/contracts";
import type { AgentDefinition, TaskPhase } from "@reddwarf/contracts";

export const agentDefinitions: AgentDefinition[] = [
  {
    id: "architect-default",
    displayName: "Architect Agent",
    type: "architect",
    capabilities: ["can_plan", "can_archive_evidence"],
    activePhases: ["planning"],
    enabled: true,
    description:
      "Produces planning specs, constraints, and acceptance mappings."
  },
  {
    id: "developer-default",
    displayName: "Developer Agent",
    type: "developer",
    capabilities: ["can_archive_evidence", "can_use_secrets"],
    activePhases: ["development"],
    enabled: true,
    description:
      "Runs the developer phase inside an isolated workspace while product code writes remain disabled by default."
  },
  {
    id: "validation-default",
    displayName: "Validation Agent",
    type: "validation",
    capabilities: ["can_run_tests", "can_archive_evidence", "can_use_secrets"],
    activePhases: ["validation"],
    enabled: true,
    description:
      "Runs deterministic lint and test commands inside the managed workspace before review or SCM."
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
    id: "scm-default",
    displayName: "SCM Agent",
    type: "scm",
    capabilities: ["can_open_pr", "can_archive_evidence"],
    activePhases: ["scm"],
    enabled: true,
    description:
      "Creates approved branches and pull requests after validation while keeping product code writes disabled."
  }
];

const disabledPhases = new Set<TaskPhase>(v1DisabledPhases);

export function phaseIsExecutable(phase: TaskPhase): boolean {
  return !disabledPhases.has(phase);
}

export function assertPhaseExecutable(phase: TaskPhase): void {
  if (!phaseIsExecutable(phase)) {
    throw new Error(`Phase ${phase} is declared but disabled in RedDwarf v1.`);
  }
}
