import { relative } from "node:path";
import { v1DisabledPhases } from "@reddwarf/contracts";
import type {
  AgentDefinition,
  DevelopmentAgent,
  DevelopmentDraft,
  MaterializedManagedWorkspace,
  PlanningAgent,
  PlanningDraft,
  PlanningTaskInput,
  ScmAgent,
  ScmDraft,
  TaskManifest,
  TaskPhase,
  ValidationAgent,
  ValidationDraft,
  WorkspaceContextBundle
} from "@reddwarf/contracts";

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

// ============================================================
// Deterministic agent implementations
// ============================================================

export class DeterministicPlanningAgent implements PlanningAgent {
  async createSpec(
    input: PlanningTaskInput,
    context: { manifest: TaskManifest; runId: string }
  ): Promise<PlanningDraft> {
    return {
      summary: `Plan task ${context.manifest.taskId} for ${input.source.repo}: ${input.title}`,
      assumptions: [
        "The task source is trustworthy and labels accurately reflect readiness.",
        "Human approval remains mandatory before any future code-writing or PR mutation."
      ],
      affectedAreas:
        input.affectedPaths.length > 0
          ? input.affectedPaths
          : ["planning-surface-only"],
      constraints: [
        "Do not write product code in RedDwarf v1.",
        "Archive all planning outputs as durable evidence."
      ],
      testExpectations: [
        "Validate schemas for manifest, spec, and workspace context bundle.",
        "Verify policy gate output and lifecycle records for the task."
      ]
    };
  }
}

export class DeterministicDeveloperAgent implements DevelopmentAgent {
  async createHandoff(
    bundle: WorkspaceContextBundle,
    context: {
      manifest: TaskManifest;
      runId: string;
      workspace: MaterializedManagedWorkspace;
      codeWriteEnabled: boolean;
    }
  ): Promise<DevelopmentDraft> {
    return {
      summary: `Prepare workspace ${context.workspace.workspaceId} for task ${context.manifest.taskId} without mutating product code.`,
      implementationNotes: [
        `Inspect the allowed paths ${formatLiteralList(bundle.allowedPaths)} before proposing any edits.`,
        "Capture implementation intent and evidence in the workspace artifacts directory while product writes remain disabled.",
        "Keep the developer handoff aligned with the planning constraints and acceptance criteria from the task contract."
      ],
      blockedActions: [
        "Product code writes remain disabled by default in the development phase.",
        "Review automation remains blocked in RedDwarf v1 for tasks that do not request SCM handoff."
      ],
      nextActions: [
        "Run the validation phase against the managed workspace before asking for review or SCM handoff.",
        "Escalate if the task truly requires code-write access before downstream phases land."
      ]
    };
  }
}

export class DeterministicValidationAgent implements ValidationAgent {
  async createPlan(
    _bundle: WorkspaceContextBundle,
    context: {
      manifest: TaskManifest;
      runId: string;
      workspace: MaterializedManagedWorkspace;
    }
  ): Promise<ValidationDraft> {
    return {
      summary: `Run deterministic lint and test checks for workspace ${context.workspace.workspaceId} before review or SCM handoff.`,
      commands: [
        {
          id: "lint",
          name: "Lint workspace artifacts",
          executable: process.execPath,
          args: ["-e", createValidationNodeScript("lint")]
        },
        {
          id: "test",
          name: "Validate workspace contracts",
          executable: process.execPath,
          args: ["-e", createValidationNodeScript("test")]
        }
      ]
    };
  }
}

export class DeterministicScmAgent implements ScmAgent {
  async createPullRequest(
    bundle: WorkspaceContextBundle,
    context: {
      manifest: TaskManifest;
      runId: string;
      workspace: MaterializedManagedWorkspace;
      baseBranch: string;
      validationSummary: string;
      validationReportPath: string;
    }
  ): Promise<ScmDraft> {
    const branchName = createScmBranchName(context.manifest.taskId, context.runId);

    return {
      summary: `Create approved branch ${branchName} and a pull request for task ${context.manifest.taskId}.`,
      baseBranch: context.baseBranch,
      branchName,
      pullRequestTitle: `[RedDwarf] ${context.manifest.title}`,
      pullRequestBody: createScmPullRequestBody({
        bundle,
        validationSummary: context.validationSummary,
        validationReportPath: context.validationReportPath,
        branchName,
        baseBranch: context.baseBranch,
        workspace: context.workspace,
        runId: context.runId
      }),
      labels: ["reddwarf", "automation", `risk:${context.manifest.riskClass}`]
    };
  }
}

// ============================================================
// Private helpers
// ============================================================

function formatLiteralList(items: readonly string[]): string {
  if (items.length === 0) {
    return "none";
  }

  return items.map((item) => `\`${item}\``).join(", ");
}

function createScmBranchName(taskId: string, runId: string): string {
  return `reddwarf/${sanitizeBranchSegment(taskId)}/${sanitizeBranchSegment(runId)}`;
}

function sanitizeBranchSegment(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-/.]+|[-/.]+$/g, "");

  return sanitized.length > 0 ? sanitized : "task";
}

function createScmPullRequestBody(input: {
  bundle: WorkspaceContextBundle;
  validationSummary: string;
  validationReportPath: string;
  branchName: string;
  baseBranch: string;
  workspace: MaterializedManagedWorkspace;
  runId: string;
}): string {
  return [
    "## RedDwarf SCM Handoff",
    "",
    `- Task ID: ${input.bundle.manifest.taskId}`,
    `- Run ID: ${input.runId}`,
    `- Base branch: ${input.baseBranch}`,
    `- Head branch: ${input.branchName}`,
    `- Validation report: workspace://${input.workspace.workspaceId}/artifacts/${relative(input.workspace.artifactsDir, input.validationReportPath).replace(/\\/g, "/")}`,
    "",
    "### Summary",
    "",
    input.bundle.spec.summary,
    "",
    "### Validation",
    "",
    input.validationSummary,
    "",
    "### Acceptance Criteria",
    "",
    ...input.bundle.acceptanceCriteria.map((item) => `- ${item}`),
    ""
  ].join("\n");
}

function createValidationNodeScript(kind: "lint" | "test"): string {
  if (kind === "lint") {
    return [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const handoffPath = path.join(process.cwd(), "artifacts", "developer-handoff.md");',
      'const handoff = fs.readFileSync(handoffPath, "utf8");',
      'const requiredHeadings = ["# Development Handoff", "## Summary", "## Implementation Notes", "## Blocked Actions", "## Next Actions"];',
      "for (const heading of requiredHeadings) {",
      "  if (!handoff.includes(heading)) {",
      "    throw new Error(`Missing heading ${heading} in ${handoffPath}.`);",
      "  }",
      "}",
      'if (!handoff.includes("Code writing enabled: no")) {',
      '  throw new Error("Developer handoff must confirm code writing stays disabled.");',
      "}",
      'console.log("Validated developer handoff headings and guardrails.");'
    ].join("\n");
  }

  return [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const task = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".context", "task.json"), "utf8"));',
    'const descriptor = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".workspace", "workspace.json"), "utf8"));',
    'const tools = fs.readFileSync(path.join(process.cwd(), "TOOLS.md"), "utf8");',
    'if (task.currentPhase !== "validation") {',
    "  throw new Error(`Expected validation phase in task.json, received ${task.currentPhase}.`);",
    "}",
    'if (task.assignedAgentType !== "validation") {',
    "  throw new Error(`Expected validation agent assignment, received ${task.assignedAgentType}.`);",
    "}",
    'if (descriptor.toolPolicy.mode !== "validation_only") {',
    "  throw new Error(`Expected validation_only tool mode, received ${descriptor.toolPolicy.mode}.`);",
    "}",
    "if (descriptor.toolPolicy.codeWriteEnabled !== false) {",
    '  throw new Error("Validation workspace must keep code writing disabled.");',
    "}",
    'if (!descriptor.toolPolicy.allowedCapabilities.includes("can_run_tests")) {',
    '  throw new Error("Validation workspace must allow can_run_tests.");',
    "}",
    'if (!tools.includes("can_run_tests")) {',
    '  throw new Error("Runtime TOOLS.md must describe can_run_tests for validation.");',
    "}",
    'if (descriptor.credentialPolicy.mode === "scoped_env" && !descriptor.credentialPolicy.secretEnvFile) {',
    '  throw new Error("Scoped credential leases must declare a workspace-local secretEnvFile.");',
    "}",
    'console.log("Validated workspace contract for the validation phase.");'
  ].join("\n");
}
