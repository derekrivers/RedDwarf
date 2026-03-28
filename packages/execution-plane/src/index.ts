import { relative } from "node:path";
import { v1DisabledPhases } from "@reddwarf/contracts";
import type {
  AgentDefinition,
  DevelopmentAgent,
  DevelopmentDraft,
  MaterializedManagedWorkspace,
  OpenClawAgentRole,
  OpenClawAgentRoleDefinition,
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

const sharedOpenClawCanonicalSources = [
  "docs/open_claw_research.md",
  "openclaw_ai_dev_team_v_2_architecture.md",
  "standards/engineering.md"
] as const;

export const openClawAgentRoleDefinitions: OpenClawAgentRoleDefinition[] = [
  {
    agentId: "reddwarf-coordinator",
    role: "coordinator",
    displayName: "RedDwarf Coordinator",
    purpose:
      "Frames RedDwarf-approved work inside OpenClaw, preserves task boundaries, and delegates bounded analysis or validation work.",
    runtimePolicy: {
      toolProfile: "minimal",
      allow: ["group:fs", "group:sessions", "group:memory", "group:openclaw"],
      deny: ["group:automation", "group:messaging", "group:nodes"],
      sandboxMode: "read_only",
      model: { provider: "anthropic", model: "anthropic/claude-sonnet-4-6" }
    },
    bootstrapFiles: [
      {
        kind: "identity",
        relativePath: "agents/openclaw/rimmer/IDENTITY.md",
        description: "Arnold Rimmer identity and coordinator persona."
      },
      {
        kind: "soul",
        relativePath: "agents/openclaw/rimmer/SOUL.md",
        description: "Operating posture and system boundary guidance."
      },
      {
        kind: "agents",
        relativePath: "agents/openclaw/rimmer/AGENTS.md",
        description: "Runtime roster and delegation contract."
      },
      {
        kind: "tools",
        relativePath: "agents/openclaw/rimmer/TOOLS.md",
        description: "Tool-usage guardrails for coordination work."
      },
      {
        kind: "skill",
        relativePath: "agents/openclaw/rimmer/skills/reddwarf-openclaw/SKILL.md",
        description:
          "Runtime skill for coordinating bounded OpenClaw sessions."
      }
    ],
    canonicalSources: [...sharedOpenClawCanonicalSources, "agents/architect.md"]
  },
  {
    agentId: "reddwarf-analyst",
    role: "analyst",
    displayName: "RedDwarf Analyst",
    purpose:
      "Performs read-only codebase analysis, planning support, and evidence-friendly synthesis inside the approved task boundary.",
    runtimePolicy: {
      toolProfile: "coding",
      allow: ["group:fs", "group:memory", "group:web", "group:openclaw"],
      deny: ["group:automation", "group:messaging"],
      sandboxMode: "read_only",
      model: { provider: "anthropic", model: "anthropic/claude-opus-4-6" }
    },
    bootstrapFiles: [
      {
        kind: "identity",
        relativePath: "agents/openclaw/holly/IDENTITY.md",
        description: "Holly identity and architect persona."
      },
      {
        kind: "soul",
        relativePath: "agents/openclaw/holly/SOUL.md",
        description:
          "Operating posture and source hierarchy for analysis work."
      },
      {
        kind: "agents",
        relativePath: "agents/openclaw/holly/AGENTS.md",
        description: "Runtime roster and analyst handoff rules."
      },
      {
        kind: "tools",
        relativePath: "agents/openclaw/holly/TOOLS.md",
        description: "Tool-usage guardrails for read-only analysis."
      },
      {
        kind: "skill",
        relativePath: "agents/openclaw/holly/skills/issue_to_architecture_plan/SKILL.md",
        description:
          "Primary planning skill for issue-to-architecture-plan work."
      }
    ],
    canonicalSources: [
      ...sharedOpenClawCanonicalSources,
      "agents/architect.md",
      "agents/developer.md"
    ]
  },
  {
    agentId: "reddwarf-validator",
    role: "validator",
    displayName: "RedDwarf Validator",
    purpose:
      "Runs bounded checks, reviews evidence, and reports findings without expanding scope or mutating product code.",
    runtimePolicy: {
      toolProfile: "coding",
      allow: ["group:fs", "group:runtime", "group:memory", "group:openclaw"],
      deny: ["group:messaging"],
      sandboxMode: "workspace_write",
      model: { provider: "anthropic", model: "anthropic/claude-sonnet-4-6" }
    },
    bootstrapFiles: [
      {
        kind: "identity",
        relativePath: "agents/openclaw/kryten/IDENTITY.md",
        description: "Kryten identity and reviewer/verifier persona."
      },
      {
        kind: "soul",
        relativePath: "agents/openclaw/kryten/SOUL.md",
        description: "Operating posture for evidence and verification work."
      },
      {
        kind: "agents",
        relativePath: "agents/openclaw/kryten/AGENTS.md",
        description: "Runtime roster and validator handoff rules."
      },
      {
        kind: "tools",
        relativePath: "agents/openclaw/kryten/TOOLS.md",
        description: "Tool-usage guardrails for bounded verification."
      },
      {
        kind: "skill",
        relativePath: "agents/openclaw/kryten/skills/review_implementation_against_plan/SKILL.md",
        description:
          "Primary review skill for plan-vs-implementation verification."
      }
    ],
    canonicalSources: [...sharedOpenClawCanonicalSources, "agents/validation.md"]
  },
  {
    agentId: "reddwarf-developer",
    role: "developer",
    displayName: "RedDwarf Developer",
    purpose:
      "Implements approved architecture plans safely and within scope, producing code changes, test updates, and a clear review handoff.",
    runtimePolicy: {
      toolProfile: "coding",
      allow: ["group:fs", "group:runtime", "group:memory", "group:openclaw"],
      deny: ["group:automation", "group:messaging"],
      sandboxMode: "workspace_write",
      model: { provider: "anthropic", model: "anthropic/claude-sonnet-4-6" }
    },
    bootstrapFiles: [
      {
        kind: "identity",
        relativePath: "agents/openclaw/lister/IDENTITY.md",
        description: "Dave Lister identity and developer persona."
      },
      {
        kind: "soul",
        relativePath: "agents/openclaw/lister/SOUL.md",
        description: "Operating posture and implementation principles."
      },
      {
        kind: "agents",
        relativePath: "agents/openclaw/lister/AGENTS.md",
        description: "Runtime roster and developer standing orders."
      },
      {
        kind: "tools",
        relativePath: "agents/openclaw/lister/TOOLS.md",
        description: "Tool-usage guardrails for scoped implementation work."
      },
      {
        kind: "skill",
        relativePath: "agents/openclaw/lister/skills/implement_architecture_plan/SKILL.md",
        description:
          "Primary implementation skill for architecture-plan-to-code work."
      }
    ],
    canonicalSources: [...sharedOpenClawCanonicalSources, "agents/developer.md"]
  }
];
export function getOpenClawAgentRoleDefinition(
  role: OpenClawAgentRole
): OpenClawAgentRoleDefinition {
  const definition = openClawAgentRoleDefinitions.find(
    (entry) => entry.role === role
  );

  if (!definition) {
    throw new Error(`Missing OpenClaw agent role definition for ${role}.`);
  }

  return definition;
}

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
// Live LLM planning agent — Anthropic Messages API
// ============================================================

const DEFAULT_PLANNING_SYSTEM_PROMPT = [
  "You are operating inside the RedDwarf Dev Squad policy pack.",
  "",
  "Focus on deterministic planning:",
  "- refine acceptance criteria",
  "- identify affected surfaces",
  "- classify risk",
  "- respect restricted paths",
  "- produce evidence-friendly output",
  "",
  "Do not write product code or create PRs in v1.",
  "",
  "Respond with a JSON object — no markdown fences, no commentary — with exactly these fields:",
  '  "summary": string (one or two sentences describing the plan)',
  '  "assumptions": string[] (key assumptions the plan relies on)',
  '  "affectedAreas": string[] (file paths or surface areas that will change)',
  '  "constraints": string[] (hard constraints the implementation must honour)',
  '  "testExpectations": string[] (what tests or checks should be added or updated)'
].join("\n");

export interface AnthropicPlanningAgentOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  systemPrompt?: string;
  baseUrl?: string;
}

interface AnthropicMessagesResponse {
  content: Array<{ type: string; text?: string }>;
}

export interface FetchWithRetryOptions {
  url: string;
  init: RequestInit;
  maxAttempts?: number;
  retryableStatuses?: Set<number>;
  baseDelayMs?: number;
}

export async function fetchWithRetry(options: FetchWithRetryOptions): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? 3;
  const retryableStatuses = options.retryableStatuses ?? new Set([429, 529]);
  const baseDelayMs = options.baseDelayMs ?? 2000;
  let attempt = 0;

  while (true) {
    attempt++;
    const response = await fetch(options.url, options.init);

    if (!response.ok) {
      if (retryableStatuses.has(response.status) && attempt < maxAttempts) {
        const delay = attempt * baseDelayMs;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      const responseBody = await response.text().catch(() => "");
      throw new Error(`Anthropic API returned ${response.status}: ${responseBody}`);
    }

    return response;
  }
}

export function extractAnthropicTextContent(response: AnthropicMessagesResponse): string {
  const block = response.content.find((b) => b.type === "text");
  if (!block?.text) {
    throw new Error("Anthropic response contained no text content block.");
  }
  return block.text;
}

export class AnthropicPlanningAgent implements PlanningAgent {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly systemPrompt: string;
  private readonly baseUrl: string;

  constructor(options: AnthropicPlanningAgentOptions = {}) {
    const apiKey = options.apiKey ?? process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) {
      throw new Error(
        "AnthropicPlanningAgent requires an API key. " +
          "Set the ANTHROPIC_API_KEY environment variable or pass apiKey explicitly."
      );
    }
    this.apiKey = apiKey;
    this.model = options.model ?? "claude-sonnet-4-6";
    this.maxTokens = options.maxTokens ?? 2048;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_PLANNING_SYSTEM_PROMPT;
    this.baseUrl = options.baseUrl ?? "https://api.anthropic.com";
  }

  async createSpec(
    input: PlanningTaskInput,
    context: { manifest: TaskManifest; runId: string }
  ): Promise<PlanningDraft> {
    const userMessage = buildPlanningUserMessage(input, context);

    const response = await fetchWithRetry({
      url: `${this.baseUrl}/v1/messages`,
      init: {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: this.maxTokens,
          system: this.systemPrompt,
          messages: [{ role: "user", content: userMessage }]
        })
      }
    });

    const result = (await response.json()) as AnthropicMessagesResponse;
    const text = extractAnthropicTextContent(result);
    return parsePlanningDraft(text, input, context);
  }
}

/**
 * Create an AnthropicPlanningAgent from environment variables or explicit options.
 * Reads ANTHROPIC_API_KEY from the environment when no apiKey is provided.
 */
export function createAnthropicPlanningAgent(
  options: AnthropicPlanningAgentOptions = {}
): AnthropicPlanningAgent {
  return new AnthropicPlanningAgent(options);
}

export type PlanningAgentConfig =
  | { type: "deterministic" }
  | { type: "anthropic"; options?: AnthropicPlanningAgentOptions };

/**
 * Factory for selecting between the deterministic stub and the live Anthropic
 * planning agent based on a configuration object.
 *
 * Use `{ type: "deterministic" }` for tests and CI environments where no API
 * key is available. Use `{ type: "anthropic" }` for real planning runs.
 */
export function createPlanningAgent(config: PlanningAgentConfig): PlanningAgent {
  if (config.type === "anthropic") {
    return new AnthropicPlanningAgent(config.options);
  }
  return new DeterministicPlanningAgent();
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

function buildPlanningUserMessage(
  input: PlanningTaskInput,
  context: { manifest: TaskManifest; runId: string }
): string {
  const lines: string[] = [
    `Task ID: ${context.manifest.taskId}`,
    `Run ID: ${context.runId}`,
    `Repository: ${input.source.repo}`,
    ...(input.source.issueNumber !== undefined
      ? [`Issue: #${input.source.issueNumber}`]
      : []),
    `Title: ${input.title}`,
    `Summary: ${input.summary}`,
    `Priority: ${input.priority}`,
    ...(input.labels.length > 0 ? [`Labels: ${input.labels.join(", ")}`] : []),
    `Requested capabilities: ${input.requestedCapabilities.join(", ")}`
  ];

  if (input.affectedPaths.length > 0) {
    lines.push(`Affected paths: ${input.affectedPaths.join(", ")}`);
  }

  if (input.acceptanceCriteria.length > 0) {
    lines.push("", "Acceptance criteria:");
    for (const criterion of input.acceptanceCriteria) {
      lines.push(`- ${criterion}`);
    }
  }

  lines.push(
    "",
    "Produce a planning spec as a JSON object with fields: summary, assumptions, affectedAreas, constraints, testExpectations."
  );

  return lines.join("\n");
}

export function parsePlanningDraft(
  text: string,
  input: PlanningTaskInput,
  context: { manifest: TaskManifest; runId: string }
): PlanningDraft {
  const candidates: string[] = [text.trim()];
  const codeBlockMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const codeBlockText = codeBlockMatch?.[1];
  if (codeBlockText) {
    candidates.unshift(codeBlockText.trim());
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isValidPlanningDraft(parsed)) {
        return parsed;
      }
    } catch {
      // try the next candidate
    }
  }

  return {
    summary: `Planning pass for task ${context.manifest.taskId}: ${input.title}`,
    assumptions: ["LLM response could not be parsed as structured JSON; manual review required."],
    affectedAreas: input.affectedPaths.length > 0 ? [...input.affectedPaths] : ["to-be-determined"],
    constraints: [
      "Do not write product code in RedDwarf v1.",
      "Archive all planning outputs as durable evidence."
    ],
    testExpectations: ["Validate planning spec structure and evidence archival."]
  };
}

export function isValidPlanningDraft(value: unknown): value is PlanningDraft {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["summary"] === "string" &&
    Array.isArray(v["assumptions"]) &&
    Array.isArray(v["affectedAreas"]) &&
    Array.isArray(v["constraints"]) &&
    Array.isArray(v["testExpectations"])
  );
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

export {
  expectedBootstrapFileNames,
  bootstrapStructuralMarkers,
  validateBootstrapFileContent,
  validateAgentBootstrapAlignment,
  validateAllBootstrapAlignment
} from "./bootstrap-alignment.js";
export type {
  BootstrapFileViolation,
  BootstrapAlignmentResult,
  FullBootstrapAlignmentResult
} from "./bootstrap-alignment.js";

