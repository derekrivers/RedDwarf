import {
  asIsoTimestamp,
  planningSpecSchema,
  taskManifestSchema,
  type Capability,
  type PlanningTaskInput,
  type ProjectSpec,
  type TaskManifest,
  type TicketSpec
} from "@reddwarf/contracts";
import {
  createApprovalRequest,
  createEvidenceRecord,
  createMemoryRecord,
  deriveOrganizationId,
  type PlanningRepository,
  type PlanningTransactionRepository
} from "@reddwarf/evidence";
import type {
  GitHubWriter,
  GitHubIssuesAdapter,
  OpenClawTaskFlowAdapter,
  RequiredChecksScaffoldAdapter,
  WorkflowSurveyAdapter
} from "@reddwarf/integrations";
import {
  V1MutationDisabledError
} from "@reddwarf/integrations";
import { ensureProjectAutoMergeReady } from "./project-auto-merge-readiness.js";
import { buildPolicySnapshot, getPolicyVersion } from "@reddwarf/policy";
import {
  expandAllowedPathsForGeneratedArtifacts,
  normalizeAllowedPaths
} from "../allowed-paths.js";
import {
  readPlanningDefaultBranchFromSnapshot
} from "./shared.js";

export interface ExecuteProjectApprovalInput {
  projectId: string;
  decidedBy: string;
  decisionSummary?: string | null | undefined;
}

export interface ExecuteProjectApprovalDependencies {
  repository: PlanningRepository;
  githubIssuesAdapter?: GitHubIssuesAdapter | null;
  /** When provided and REDDWARF_TASKFLOW_ENABLED=true, creates a Task Flow on approval. Requires OpenClaw >= v2026.4.2. */
  taskFlowAdapter?: OpenClawTaskFlowAdapter | null;
  /**
   * When provided, installs the reddwarf-advance workflow file in the target repo on fresh project
   * approval. Best-effort: failure logs a warning but does not block the approval.
   */
  github?: GitHubWriter | null;
  /**
   * M25 F-192: when the approved project has auto-merge enabled but its
   * RequiredCheckContract is empty (greenfield repo, no surveyed
   * workflows), install a default `reddwarf-required-checks.yml`. If
   * detection fails (no recognized manifest), the project's
   * autoMergeEnabled is auto-flipped to false with an evidence record.
   * Best-effort: any failure logs a warning but does not block approval.
   */
  requiredChecksScaffoldAdapter?: RequiredChecksScaffoldAdapter | null;
  /**
   * M25 — workflow surveyor used by the readiness helper to re-derive the
   * contract from any workflow files the developer added between planning
   * and approval. When omitted, the readiness helper falls back to scaffold.
   */
  workflowSurveyAdapter?: WorkflowSurveyAdapter | null;
  clock?: () => Date;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

export interface ExecuteProjectApprovalResult {
  project: ProjectSpec;
  tickets: TicketSpec[];
  subIssuesCreated: number;
  subIssuesFallback: boolean;
  dispatchedTicket: TicketSpec | null;
  dispatchedTaskId: string | null;
  dispatchedTaskCreated: boolean;
}

function canResumeApprovedProject(project: ProjectSpec, tickets: TicketSpec[]): boolean {
  return (
    project.status === "approved" &&
    tickets.every(
      (ticket) =>
        ticket.status === "pending" &&
        ticket.githubPrNumber === null
    )
  );
}

function canBackfillMissingSubIssues(project: ProjectSpec, tickets: TicketSpec[]): boolean {
  return (
    project.status === "executing" &&
    tickets.length > 0 &&
    tickets.some((ticket) => ticket.githubSubIssueNumber === null) &&
    tickets.some((ticket) => ticket.status !== "pending") &&
    tickets.every((ticket) => ticket.githubPrNumber === null)
  );
}

export function createProjectTicketTaskId(ticketId: string): string {
  const withoutProjectPrefix = ticketId.replace(/^project:/, "");
  const normalized = withoutProjectPrefix
    .replace(/:ticket:/g, "-ticket-")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  return normalized.length > 0 ? normalized : "project-ticket";
}

function createParentTaskIdFromProjectId(projectId: string): string | null {
  if (!projectId.startsWith("project:")) {
    return null;
  }

  const taskId = projectId.slice("project:".length).trim();
  return taskId.length > 0 ? taskId : null;
}

async function completeParentProjectTask(input: {
  repository: Pick<PlanningTransactionRepository, "getManifest" | "updateManifest">;
  project: ProjectSpec;
  completedAt: string;
}): Promise<boolean> {
  const parentTaskId = createParentTaskIdFromProjectId(input.project.projectId);
  if (!parentTaskId) {
    return false;
  }

  const manifest = await input.repository.getManifest(parentTaskId);
  if (!manifest || manifest.lifecycleStatus === "completed") {
    return false;
  }

  await input.repository.updateManifest(
    taskManifestSchema.parse({
      ...manifest,
      currentPhase: "archive",
      lifecycleStatus: "completed",
      updatedAt: input.completedAt
    })
  );
  return true;
}

async function listDispatchedTicketsMissingTask(input: {
  repository: PlanningRepository;
  project: ProjectSpec;
  tickets: TicketSpec[];
}): Promise<TicketSpec[]> {
  if (
    input.project.status !== "executing" ||
    !input.tickets.every((ticket) => ticket.githubPrNumber === null)
  ) {
    return [];
  }

  const missingTasks: TicketSpec[] = [];

  for (const ticket of input.tickets) {
    if (ticket.status !== "dispatched") {
      continue;
    }

    const taskId = createProjectTicketTaskId(ticket.ticketId);
    const snapshot = await input.repository.getTaskSnapshot(taskId);
    if (!snapshot.manifest) {
      missingTasks.push(ticket);
    }
  }

  return missingTasks;
}

function normalizeTicketSummary(ticket: TicketSpec): string {
  const description = ticket.description.trim();
  if (description.length >= 20) {
    return description;
  }

  const fallback = `Project ticket ${ticket.title}: ${description || "Implement the approved project ticket scope."}`;
  return fallback.length >= 20
    ? fallback
    : `${fallback} Complete the approved ticket scope.`;
}

function normalizeDecisionSummary(
  value: string | null | undefined,
  fallback: string
): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
}

function extractTicketAffectedPaths(ticket: TicketSpec): string[] {
  const text = [
    ticket.description,
    ...ticket.acceptanceCriteria
  ].join("\n");
  const candidates = new Set<string>();

  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const candidate = match[1]?.trim();
    if (candidate) {
      candidates.add(candidate);
    }
  }

  for (const token of text.split(/\s+/g)) {
    const candidate = token
      .replace(/^[("'[]+|[)"'\],.;:]+$/g, "")
      .trim();
    if (
      candidate.length > 0 &&
      !candidate.includes("://") &&
      !candidate.startsWith("#") &&
      (candidate.includes("/") || /\.[a-zA-Z0-9]+$/.test(candidate))
    ) {
      candidates.add(candidate);
    }
  }

  const normalized = normalizeAllowedPaths(
    [...candidates].filter((candidate) => !candidate.includes(" "))
  );
  return normalized.length > 0 ? normalized : ["**/*"];
}

function createProjectTicketSource(input: {
  project: ProjectSpec;
  ticket: TicketSpec;
}): PlanningTaskInput["source"] {
  const issueNumber =
    input.ticket.githubSubIssueNumber ??
    (input.project.sourceIssueId
      ? Number.parseInt(input.project.sourceIssueId, 10)
      : undefined);
  const source: PlanningTaskInput["source"] = {
    provider: "github",
    repo: input.project.sourceRepo,
    ...(issueNumber !== undefined && Number.isFinite(issueNumber)
      ? {
          issueNumber,
          issueUrl: `https://github.com/${input.project.sourceRepo}/issues/${issueNumber}`
        }
      : {})
  };
  return source;
}

async function readProjectDefaultBranch(
  repository: Pick<PlanningTransactionRepository, "getTaskSnapshot">,
  project: ProjectSpec
): Promise<string> {
  const parentTaskId = project.projectId.startsWith("project:")
    ? project.projectId.slice("project:".length)
    : null;

  if (!parentTaskId) {
    return "main";
  }

  const parentSnapshot = await repository.getTaskSnapshot(parentTaskId);
  if (!parentSnapshot.manifest) {
    return "main";
  }

  return readPlanningDefaultBranchFromSnapshot(parentSnapshot);
}

const projectTicketCapabilities: Capability[] = [
  "can_write_code",
  "can_run_tests",
  "can_open_pr",
  "can_archive_evidence"
];

export interface ProjectTicketTaskMaterializationResult {
  taskId: string;
  created: boolean;
}

async function materializeProjectTicketTask(input: {
  repository: PlanningTransactionRepository;
  project: ProjectSpec;
  ticket: TicketSpec;
  decidedBy: string;
  decisionSummary?: string | null | undefined;
  now: () => string;
}): Promise<ProjectTicketTaskMaterializationResult> {
  const { repository, project, ticket, now } = input;
  const taskId = createProjectTicketTaskId(ticket.ticketId);
  const existingSnapshot = await repository.getTaskSnapshot(taskId);
  const taskCreatedAt = existingSnapshot.manifest?.createdAt ?? now();
  const updatedAt = now();
  const source = createProjectTicketSource({ project, ticket });
  const affectedPaths = extractTicketAffectedPaths(ticket);
  const summary = normalizeTicketSummary(ticket);
  const defaultBranch = await readProjectDefaultBranch(repository, project);
  const planningInput: PlanningTaskInput = {
    source,
    title: ticket.title,
    summary,
    priority: 50,
    dryRun: false,
    labels: ["ai-eligible", "reddwarf-ticket"],
    acceptanceCriteria:
      ticket.acceptanceCriteria.length > 0
        ? ticket.acceptanceCriteria
        : [`Complete project ticket ${ticket.ticketId}.`],
    affectedPaths,
    requestedCapabilities: projectTicketCapabilities,
    metadata: {
      projectId: project.projectId,
      ticketId: ticket.ticketId,
      githubSubIssueNumber: ticket.githubSubIssueNumber,
      githubPrNumber: ticket.githubPrNumber,
      github: {
        baseBranch: defaultBranch
      }
    }
  };
  const policySnapshot = buildPolicySnapshot(
    planningInput,
    ticket.riskClass,
    "human_signoff_required",
    {
      level: "high",
      reason: "Ticket was generated from an approved ProjectSpec."
    }
  );
  const expandedPolicySnapshot = {
    ...policySnapshot,
    allowedPaths: expandAllowedPathsForGeneratedArtifacts(
      normalizeAllowedPaths([
        ...policySnapshot.allowedPaths,
        ...affectedPaths
      ])
    )
  };
  const spec = planningSpecSchema.parse({
    specId: `${taskId}:planning-spec`,
    taskId,
    summary,
    assumptions: [
      `This task implements project ticket ${ticket.ticketId} from ${project.projectId}.`
    ],
    affectedAreas: affectedPaths,
    constraints: [
      `Project ID: ${project.projectId}`,
      `Ticket ID: ${ticket.ticketId}`,
      "Keep the pull request scoped to this ticket and include the RedDwarf ticket marker in the PR body."
    ],
    acceptanceCriteria: planningInput.acceptanceCriteria,
    testExpectations: [
      "Run the most relevant local verification for the changed paths."
    ],
    recommendedAgentType: "developer",
    riskClass: ticket.riskClass,
    confidenceLevel: "high",
    confidenceReason: "Ticket was generated from an approved ProjectSpec.",
    projectSize: "small",
    createdAt: taskCreatedAt
  });
  const manifest = taskManifestSchema.parse({
    taskId,
    source,
    title: ticket.title,
    summary,
    priority: planningInput.priority,
    dryRun: planningInput.dryRun,
    riskClass: ticket.riskClass,
    approvalMode: "human_signoff_required",
    currentPhase: "development",
    lifecycleStatus: "ready",
    assignedAgentType: "developer",
    requestedCapabilities: projectTicketCapabilities,
    retryCount: 0,
    evidenceLinks: [
      `db://manifest/${taskId}:manifest`,
      `db://planning_spec/${spec.specId}`,
      `db://gate_decision/${taskId}:approval:project`
    ],
    workspaceId: null,
    branchName: null,
    prNumber: null,
    policyVersion: getPolicyVersion(),
    createdAt: taskCreatedAt,
    updatedAt
  }) satisfies TaskManifest;
  const approval = createApprovalRequest({
    requestId: `${taskId}:approval:project`,
    taskId,
    runId: `${taskId}:project-approval`,
    phase: "policy_gate",
    dryRun: false,
    confidenceLevel: "high",
    confidenceReason: "Ticket was approved as part of the project plan.",
    approvalMode: "human_signoff_required",
    status: "approved",
    riskClass: ticket.riskClass,
    summary: `Project ticket ${ticket.ticketId} was approved through ${project.projectId}.`,
    requestedCapabilities: projectTicketCapabilities,
    allowedPaths: expandedPolicySnapshot.allowedPaths,
    blockedPhases: expandedPolicySnapshot.blockedPhases,
    policyReasons: expandedPolicySnapshot.reasons,
    requestedBy: "project-approval",
    decidedBy: input.decidedBy,
    decision: "approve",
    decisionSummary:
      normalizeDecisionSummary(
        input.decisionSummary,
        `Approved through project ${project.projectId}.`
      ),
    createdAt: taskCreatedAt,
    updatedAt,
    resolvedAt: updatedAt
  });

  if (!existingSnapshot.manifest) {
    await repository.saveManifest(manifest);
  }
  if (!existingSnapshot.spec) {
    await repository.savePlanningSpec(spec);
  }
  if (!existingSnapshot.policySnapshot) {
    await repository.savePolicySnapshot(taskId, expandedPolicySnapshot);
  }
  if (
    !existingSnapshot.approvalRequests.some(
      (request) => request.requestId === approval.requestId
    )
  ) {
    await repository.saveApprovalRequest(approval);
  }
  if (
    !existingSnapshot.evidenceRecords.some(
      (record) => record.recordId === `${taskId}:manifest`
    )
  ) {
    await repository.saveEvidenceRecord(
      createEvidenceRecord({
        recordId: `${taskId}:manifest`,
        taskId,
        kind: "manifest",
        title: "Project ticket task manifest",
        metadata: {
          phase: "policy_gate" as const,
          projectId: project.projectId,
          ticketId: ticket.ticketId
        },
        createdAt: taskCreatedAt
      })
    );
  }
  if (
    !existingSnapshot.evidenceRecords.some(
      (record) => record.recordId === `${taskId}:spec`
    )
  ) {
    await repository.saveEvidenceRecord(
      createEvidenceRecord({
        recordId: `${taskId}:spec`,
        taskId,
        kind: "planning_spec",
        title: "Project ticket planning specification",
        metadata: {
          phase: "planning" as const,
          projectId: project.projectId,
          ticketId: ticket.ticketId,
          specId: spec.specId
        },
        createdAt: taskCreatedAt
      })
    );
  }

  // Idempotency: only create memory records if they don't already exist
  const existingMemoryIds = new Set(
    existingSnapshot.memoryRecords.map((r) => r.memoryId)
  );

  if (!existingMemoryIds.has(`${taskId}:memory:task:planning`)) {
    await repository.saveMemoryRecord(
      createMemoryRecord({
        memoryId: `${taskId}:memory:task:planning`,
        taskId,
        scope: "task",
        provenance: "pipeline_derived",
        key: "planning.brief",
        title: "Project ticket planning brief",
        value: {
          specId: spec.specId,
          summary: spec.summary,
          acceptanceCriteria: spec.acceptanceCriteria,
          affectedAreas: spec.affectedAreas,
          constraints: spec.constraints,
          policyReasons: expandedPolicySnapshot.reasons,
          approvalMode: manifest.approvalMode,
          confidenceLevel: spec.confidenceLevel,
          confidenceReason: spec.confidenceReason,
          allowedSecretScopes: expandedPolicySnapshot.allowedSecretScopes,
          defaultBranch,
          projectId: project.projectId,
          ticketId: ticket.ticketId
        },
        repo: project.sourceRepo,
        organizationId: deriveOrganizationId(project.sourceRepo),
        tags: ["planning", "project", "ticket"],
        createdAt: taskCreatedAt,
        updatedAt
      })
    );
  }
  if (!existingMemoryIds.has(`${taskId}:memory:task:project-ticket`)) {
    await repository.saveMemoryRecord(
      createMemoryRecord({
        memoryId: `${taskId}:memory:task:project-ticket`,
        taskId,
        scope: "task",
        provenance: "pipeline_derived",
        key: "project.ticket",
        title: "Project ticket dispatch metadata",
        value: {
          projectId: project.projectId,
          ticketId: ticket.ticketId,
          githubSubIssueNumber: ticket.githubSubIssueNumber,
          sourceRepo: project.sourceRepo
        },
        repo: project.sourceRepo,
        organizationId: deriveOrganizationId(project.sourceRepo),
        tags: ["project", "ticket"],
        createdAt: taskCreatedAt,
        updatedAt
      })
    );
  }
  if (!existingMemoryIds.has(`${taskId}:memory:task:architect-handoff`)) {
    await repository.saveMemoryRecord(
      createMemoryRecord({
        memoryId: `${taskId}:memory:task:architect-handoff`,
        taskId,
        scope: "task",
        provenance: "pipeline_derived",
        key: "architect.handoff",
        title: "Project ticket architect handoff",
        value: {
          summary: spec.summary,
          affectedAreas: spec.affectedAreas,
          assumptions: spec.assumptions,
          constraints: spec.constraints,
          testExpectations: spec.testExpectations,
          source: "project-mode"
        },
        repo: project.sourceRepo,
        organizationId: deriveOrganizationId(project.sourceRepo),
        tags: ["planning", "architect", "project", "ticket"],
        createdAt: taskCreatedAt,
        updatedAt
      })
    );
  }

  return {
    taskId,
    created: !existingSnapshot.manifest
  };
}

function hasValidGitHubIssuesAdapter(
  adapter: ExecuteProjectApprovalDependencies["githubIssuesAdapter"]
): adapter is NonNullable<ExecuteProjectApprovalDependencies["githubIssuesAdapter"]> {
  return (
    adapter !== null &&
    adapter !== undefined &&
    typeof adapter.createSubIssue === "function" &&
    typeof adapter.closeIssue === "function"
  );
}

/**
 * Execute the post-approval workflow for a project plan:
 *
 * 1. Transition project to "approved"
 * 2. Create GitHub sub-issues for each ticket in dependency order (if adapter enabled)
 * 3. Update each ticket with its github_sub_issue_number
 * 4. Resolve the first ready ticket and mark it as "dispatched"
 * 5. Transition project to "executing"
 *
 * If the GitHub Issues adapter is disabled or unavailable, falls back to
 * Postgres-only state with a warning. Dispatch still proceeds.
 */
export async function executeProjectApproval(
  input: ExecuteProjectApprovalInput,
  deps: ExecuteProjectApprovalDependencies
): Promise<ExecuteProjectApprovalResult> {
  const { repository, clock = () => new Date(), logger } = deps;
  const now = () => asIsoTimestamp(clock());

  const project = await repository.getProjectSpec(input.projectId);
  if (!project) {
    throw new Error(`Project ${input.projectId} not found.`);
  }

  const tickets = await repository.listTicketSpecs(input.projectId);
  const resumableApprovedProject = canResumeApprovedProject(project, tickets);
  const backfillingMissingSubIssues = canBackfillMissingSubIssues(project, tickets);
  const dispatchedTicketsMissingTask = await listDispatchedTicketsMissingTask({
    repository,
    project,
    tickets
  });
  const materializingDispatchedTicketTask =
    dispatchedTicketsMissingTask.length > 0;

  if (
    project.status !== "pending_approval" &&
    !resumableApprovedProject &&
    !backfillingMissingSubIssues &&
    !materializingDispatchedTicketTask
  ) {
    throw new Error(
      `Project ${input.projectId} is in status '${project.status}'. Only projects in 'pending_approval' can be approved, unless the project is already 'approved' and all tickets are still pending, or the project is executing with recoverable missing GitHub sub-issue links or dispatched child tasks before any PR has opened.`
    );
  }

  if (deps.githubIssuesAdapter && !hasValidGitHubIssuesAdapter(deps.githubIssuesAdapter)) {
    throw new Error(
      "Configured githubIssuesAdapter does not implement createSubIssue/closeIssue."
    );
  }

  if (
    backfillingMissingSubIssues &&
    !hasValidGitHubIssuesAdapter(deps.githubIssuesAdapter)
  ) {
    throw new Error(
      `Project ${input.projectId} is already executing with missing GitHub sub-issues, but no GitHub Issues adapter is configured to backfill them.`
    );
  }

  // Step 1: Build the approved project state
  // M25: `let` (not const) — the readiness helper below may rebuild this with
  // a populated requiredCheckContract or a forced autoMergeEnabled=false.
  let approvedProject: ProjectSpec = resumableApprovedProject
    ? {
        ...project,
        approvalDecision: project.approvalDecision ?? "approve",
        decidedBy: project.decidedBy ?? input.decidedBy,
        decisionSummary: project.decisionSummary ?? input.decisionSummary ?? null,
        updatedAt: now()
      }
    : backfillingMissingSubIssues
    ? {
        ...project,
        approvalDecision: project.approvalDecision ?? "approve",
        decidedBy: project.decidedBy ?? input.decidedBy,
        decisionSummary: project.decisionSummary ?? input.decisionSummary ?? null,
        updatedAt: now()
      }
    : materializingDispatchedTicketTask
    ? {
        ...project,
        approvalDecision: project.approvalDecision ?? "approve",
        decidedBy: project.decidedBy ?? input.decidedBy,
        decisionSummary: project.decisionSummary ?? input.decisionSummary ?? null,
        updatedAt: now()
      }
    : {
        ...project,
        status: "approved" as const,
        approvalDecision: "approve",
        decidedBy: input.decidedBy,
        decisionSummary: input.decisionSummary ?? null,
        updatedAt: now()
      };
  logger?.info(
    resumableApprovedProject
      ? `Resuming approved project ${input.projectId} after an incomplete approval.`
      : backfillingMissingSubIssues
        ? `Backfilling missing GitHub sub-issues for executing project ${input.projectId}.`
        : materializingDispatchedTicketTask
          ? `Materializing missing dispatched ticket task for executing project ${input.projectId}.`
      : `Project ${input.projectId} approved by ${input.decidedBy}.`
  );

  // Step 2: Sort tickets in dependency order
  const orderedTickets = sortTicketsByDependencyOrder(tickets);

  // Step 3: Create GitHub sub-issues BEFORE the transaction (external side effect).
  // Guard against concurrent approvals by atomically checking + marking the project
  // status inside a short transaction before starting external work.
  if (
    !resumableApprovedProject &&
    !backfillingMissingSubIssues &&
    !materializingDispatchedTicketTask
  ) {
    await repository.runInTransaction(async (txRepo) => {
      const freshProject = await txRepo.getProjectSpec(input.projectId);
      if (!freshProject || freshProject.status !== "pending_approval") {
        throw new Error(
          `Concurrent approval detected: project ${input.projectId} is no longer in 'pending_approval' status (current: '${freshProject?.status ?? "not found"}').`
        );
      }
      // Mark as approved under lock to prevent concurrent approvals from proceeding
      await txRepo.saveProjectSpec({ ...approvedProject });
    });
  }

  // Ensure reddwarf-advance.yml is present in the target repo on fresh approval.
  // Best-effort: failure warns but does not block the approval flow.
  if (
    deps.github &&
    !resumableApprovedProject &&
    !backfillingMissingSubIssues &&
    !materializingDispatchedTicketTask
  ) {
    try {
      const wfResult = await deps.github.ensureWorkflowFile(project.sourceRepo);
      if (wfResult.created) {
        logger?.info(`Installed reddwarf-advance.yml workflow in ${project.sourceRepo}.`);
      } else {
        logger?.info(`reddwarf-advance.yml already present in ${project.sourceRepo} — skipped installation.`);
      }
    } catch (wfErr) {
      const wfErrMsg = wfErr instanceof Error ? wfErr.message : String(wfErr);
      logger?.warn(`Failed to install reddwarf-advance.yml in ${project.sourceRepo}: ${wfErrMsg}`);
    }

    // F-186 follow-up: pre-flight check that reddwarf-advance.yml's required
    // secret + variable are actually configured on the target repo. Without
    // them, every PR-merged event hits an `exit 1` in the workflow and the
    // ticket queue silently stops advancing. Cast through unknown — the
    // RestGitHubAdapter implements GitHubActionsConfigReader; fixture
    // adapters typically don't (the methods just won't be there → skip).
    const configReader = deps.github as unknown as
      | import("@reddwarf/integrations").GitHubActionsConfigReader
      | undefined;
    if (
      configReader &&
      typeof configReader.getRepoActionsVariable === "function" &&
      typeof configReader.hasRepoActionsSecret === "function"
    ) {
      try {
        const [variable, hasSecret] = await Promise.all([
          configReader.getRepoActionsVariable(project.sourceRepo, "REDDWARF_OPERATOR_API_URL"),
          configReader.hasRepoActionsSecret(project.sourceRepo, "REDDWARF_OPERATOR_TOKEN")
        ]);
        const missing: string[] = [];
        if (!variable) missing.push("variable REDDWARF_OPERATOR_API_URL");
        if (!hasSecret) missing.push("secret REDDWARF_OPERATOR_TOKEN");
        if (missing.length > 0) {
          logger?.warn(
            `M25 advance pre-flight: ${project.sourceRepo} is missing ${missing.join(" + ")}. ` +
            `reddwarf-advance.yml will fail on every PR merge until these are set; the project ticket queue will not advance. ` +
            `Fix with: ` +
            `gh secret set REDDWARF_OPERATOR_TOKEN --repo ${project.sourceRepo} --body "<your-operator-token>"; ` +
            `gh variable set REDDWARF_OPERATOR_API_URL --repo ${project.sourceRepo} --body "<your-operator-api-url>".`
          );
        } else {
          logger?.info(
            `M25 advance pre-flight: ${project.sourceRepo} has both REDDWARF_OPERATOR_TOKEN secret and REDDWARF_OPERATOR_API_URL variable configured.`
          );
        }
      } catch (preflightErr) {
        const preflightMsg = preflightErr instanceof Error ? preflightErr.message : String(preflightErr);
        logger?.warn(
          `M25 advance pre-flight: failed to inspect Actions config on ${project.sourceRepo}: ${preflightMsg}. ` +
          `Cannot confirm reddwarf-advance.yml will work after merges.`
        );
      }
    }
  }

  // M25 — make the project "auto-merge ready" when it opted in: re-survey
  // workflows (in case the dev added CI between planning and approval) and
  // fall back to the F-192 scaffold for greenfield repos. The helper also
  // populates the project's RequiredCheckContract so the F-194 evaluator
  // doesn't block at gate 3 — the original F-192 path forgot to do this.
  if (
    !resumableApprovedProject &&
    !backfillingMissingSubIssues &&
    !materializingDispatchedTicketTask &&
    approvedProject.autoMergeEnabled === true
  ) {
    const readiness = await ensureProjectAutoMergeReady(approvedProject, {
      workflowSurveyAdapter: deps.workflowSurveyAdapter ?? null,
      scaffoldAdapter: deps.requiredChecksScaffoldAdapter ?? null,
      clock,
      ...(logger ? { logger } : {})
    });
    if (readiness.forceDisableAutoMerge) {
      approvedProject = {
        ...readiness.project,
        autoMergeEnabled: false,
        updatedAt: now()
      };
      logger?.warn(
        `M25 readiness: ${readiness.outcome} — auto-merge disabled for ${project.projectId}: ${readiness.reason}`
      );
    } else {
      approvedProject = readiness.project;
      logger?.info(
        `M25 readiness: ${readiness.outcome} — ${readiness.reason}`
      );
    }
    await repository.saveProjectSpec({ ...approvedProject });
  }

  // Collect issue numbers to persist atomically inside the final transaction.
  let subIssuesCreated = 0;
  let subIssuesFallback = false;
  const sourceIssueNumber = project.sourceIssueId
    ? parseInt(project.sourceIssueId, 10)
    : null;
  const hasMissingSubIssues = orderedTickets.some(
    (ticket) => ticket.githubSubIssueNumber === null
  );
  const subIssueResults: Array<{ index: number; issueNumber: number }> = [];

  if (!hasMissingSubIssues) {
    subIssuesFallback = false;
  } else if (
    hasValidGitHubIssuesAdapter(deps.githubIssuesAdapter) &&
    sourceIssueNumber !== null &&
    !isNaN(sourceIssueNumber)
  ) {
    try {
      for (let i = 0; i < orderedTickets.length; i++) {
        const ticket = orderedTickets[i]!;
        if (ticket.githubSubIssueNumber !== null) {
          continue;
        }
        const prefixedTicket: TicketSpec = {
          ...ticket,
          title: `[${i + 1}/${orderedTickets.length}] ${ticket.title}`
        };

        const issueNumber = await deps.githubIssuesAdapter.createSubIssue(
          sourceIssueNumber,
          prefixedTicket,
          project.sourceRepo
        );

        subIssueResults.push({ index: i, issueNumber });
        // Update local state for dependency resolution
        orderedTickets[i] = {
          ...ticket,
          githubSubIssueNumber: issueNumber,
          updatedAt: now()
        };
        subIssuesCreated++;

        logger?.info(
          `Created sub-issue #${issueNumber} for ticket ${ticket.ticketId} (${ticket.title}).`
        );
      }
    } catch (err) {
      if (err instanceof V1MutationDisabledError) {
        if (backfillingMissingSubIssues) {
          throw err;
        }
        logger?.warn(
          `GitHub Issues adapter is disabled. Falling back to Postgres-only state. Dispatch will proceed without GitHub sub-issues.`
        );
        subIssuesFallback = true;
      } else {
        throw err;
      }
    }
  } else {
    if (backfillingMissingSubIssues) {
      throw new Error(
        `Project ${input.projectId} is already executing with missing GitHub sub-issues, but sub-issue creation cannot run because the GitHub Issues adapter or source issue number is unavailable.`
      );
    }
    if (!deps.githubIssuesAdapter) {
      logger?.warn(
        `No GitHub Issues adapter configured. Falling back to Postgres-only state.`
      );
    } else if (sourceIssueNumber === null || isNaN(sourceIssueNumber)) {
      logger?.warn(
        `Project has no valid source issue number. Skipping sub-issue creation.`
      );
    }
    subIssuesFallback = true;
  }

  // Step 4-6: All DB mutations inside a single transaction for atomicity
  const txResult = await repository.runInTransaction(async (txRepo) => {
    // Persist approved project (skip if already saved by concurrency guard above)
    if (resumableApprovedProject || backfillingMissingSubIssues || materializingDispatchedTicketTask) {
      await txRepo.saveProjectSpec(approvedProject);
    }

    // Persist sub-issue numbers on tickets
    for (const { index, issueNumber } of subIssueResults) {
      const ticket = orderedTickets[index]!;
      const updatedTicket: TicketSpec = {
        ...ticket,
        githubSubIssueNumber: issueNumber,
        updatedAt: now()
      };
      await txRepo.saveTicketSpec(updatedTicket);
      orderedTickets[index] = updatedTicket;
    }

    // Resolve first ready ticket and dispatch (with row-level locking in tx)
    const nextTicket = await txRepo.resolveNextReadyTicket(input.projectId);
    let dispatchedTicket: TicketSpec | null = null;

    if (backfillingMissingSubIssues || materializingDispatchedTicketTask) {
      dispatchedTicket =
        orderedTickets.find((ticket) => ticket.status === "dispatched") ?? null;
    } else if (nextTicket) {
      const dispatched: TicketSpec = {
        ...nextTicket,
        status: "dispatched",
        updatedAt: now()
      };
      await txRepo.saveTicketSpec(dispatched);
      dispatchedTicket = dispatched;

      logger?.info(
        `Dispatched ticket ${nextTicket.ticketId} (${nextTicket.title}) to dev squad pipeline.`
      );
    } else {
      logger?.warn(
        `No ready tickets found for project ${input.projectId} after approval.`
      );
    }

    // Transition project to "executing"
    const executingProject: ProjectSpec = {
      ...approvedProject,
      status: "executing",
      updatedAt: now()
    };
    await txRepo.saveProjectSpec(executingProject);
    logger?.info(`Project ${input.projectId} status updated to 'executing'.`);

    // Materialize child task for dispatched ticket
    let dispatchedTaskId: string | null = null;
    let dispatchedTaskCreated = false;
    if (dispatchedTicket) {
      const materialized = await materializeProjectTicketTask({
        repository: txRepo,
        project: executingProject,
        ticket: dispatchedTicket,
        decidedBy: input.decidedBy,
        decisionSummary: input.decisionSummary,
        now
      });
      dispatchedTaskId = materialized.taskId;
      dispatchedTaskCreated = materialized.created;
      logger?.info(
        materialized.created
          ? `Materialized ready child task ${materialized.taskId} for project ticket ${dispatchedTicket.ticketId}.`
          : `Project ticket ${dispatchedTicket.ticketId} already has child task ${materialized.taskId}.`
      );
    }

    // Read final ticket states inside the transaction
    const finalTickets = await txRepo.listTicketSpecs(input.projectId);

    return {
      executingProject,
      finalTickets,
      dispatchedTicket,
      dispatchedTaskId,
      dispatchedTaskCreated
    };
  });

  // Feature 150: Create a Task Flow in mirrored mode when enabled and adapter is available.
  // This is a best-effort external side effect — failure does not block approval.
  if (
    process.env["REDDWARF_TASKFLOW_ENABLED"] === "true" &&
    deps.taskFlowAdapter
  ) {
    try {
      const sortedTickets = sortTicketsByDependencyOrder(txResult.finalTickets);
      const flowResult = await deps.taskFlowAdapter.createFlow({
        externalId: input.projectId,
        label: txResult.executingProject.title ?? `Project ${input.projectId}`,
        mode: "mirrored",
        children: sortedTickets.map((t) => ({
          externalId: t.ticketId,
          label: t.title,
          dependsOn: t.dependsOn
        }))
      });
      // Store the flowId in a memory record on the parent task for recovery
      await repository.saveMemoryRecord(
        createMemoryRecord({
          memoryId: `taskflow:${input.projectId}`,
          scope: "task",
          provenance: "pipeline_derived",
          key: `project.taskflow.flowId:${input.projectId}`,
          title: `Task Flow ID for project ${input.projectId}`,
          value: { flowId: flowResult.flowId, projectId: input.projectId },
          createdAt: flowResult.createdAt
        })
      );
      logger?.info(
        `Created Task Flow ${flowResult.flowId} for project ${input.projectId} (${sortedTickets.length} children).`
      );
    } catch (flowErr) {
      const flowErrMsg = flowErr instanceof Error ? flowErr.message : String(flowErr);
      logger?.warn(`Failed to create Task Flow for project ${input.projectId}: ${flowErrMsg}`);
    }
  }

  return {
    project: txResult.executingProject,
    tickets: txResult.finalTickets,
    subIssuesCreated,
    subIssuesFallback,
    dispatchedTicket: txResult.dispatchedTicket,
    dispatchedTaskId: txResult.dispatchedTaskId,
    dispatchedTaskCreated: txResult.dispatchedTaskCreated
  };
}

/**
 * Sort tickets so that dependencies come before dependents.
 * Uses a simple topological sort.
 */
function sortTicketsByDependencyOrder(tickets: TicketSpec[]): TicketSpec[] {
  const ticketMap = new Map(tickets.map((t) => [t.ticketId, t]));
  const sorted: TicketSpec[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(ticketId: string): void {
    if (visited.has(ticketId)) return;
    if (visiting.has(ticketId)) return; // cycle — skip
    visiting.add(ticketId);

    const ticket = ticketMap.get(ticketId);
    if (!ticket) return;

    for (const dep of ticket.dependsOn) {
      visit(dep);
    }

    visiting.delete(ticketId);
    visited.add(ticketId);
    sorted.push(ticket);
  }

  for (const ticket of tickets) {
    visit(ticket.ticketId);
  }

  return sorted;
}

// ============================================================
// Ticket advance (merge-driven execution)
// ============================================================

export interface AdvanceProjectTicketInput {
  ticketId: string;
  githubPrNumber: number;
}

export interface AdvanceProjectTicketDependencies {
  repository: PlanningRepository;
  githubIssuesAdapter?: GitHubIssuesAdapter | null;
  /** When provided and REDDWARF_TASKFLOW_ENABLED=true, signals Task Flow state transitions. */
  taskFlowAdapter?: OpenClawTaskFlowAdapter | null;
  clock?: () => Date;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

export type AdvanceProjectTicketOutcome =
  | "advanced"
  | "completed"
  | "already_merged";

export interface AdvanceProjectTicketResult {
  outcome: AdvanceProjectTicketOutcome;
  ticket: TicketSpec;
  project: ProjectSpec;
  nextDispatchedTicket: TicketSpec | null;
  nextDispatchedTaskId: string | null;
  nextDispatchedTaskCreated: boolean;
}

/**
 * Advance the project ticket queue after a PR merge:
 *
 * 1. Set the ticket status to "merged" and record the PR number
 * 2. Close the linked GitHub sub-issue (if adapter enabled)
 * 3. Call resolveNextReadyTicket():
 *    - If a next ticket exists, dispatch it and label its sub-issue "in-progress"
 *    - If none remain, set project status to "complete"
 *
 * Idempotent: re-running on an already-merged ticket logs a warning and
 * returns without mutating state.
 */
export async function advanceProjectTicket(
  input: AdvanceProjectTicketInput,
  deps: AdvanceProjectTicketDependencies
): Promise<AdvanceProjectTicketResult> {
  const { repository, clock = () => new Date(), logger } = deps;
  const now = () => asIsoTimestamp(clock());

  // Validate PR number before any state mutation
  if (
    !Number.isFinite(input.githubPrNumber) ||
    !Number.isInteger(input.githubPrNumber) ||
    input.githubPrNumber <= 0
  ) {
    throw new Error(
      `Invalid GitHub PR number: ${input.githubPrNumber}. Must be a positive integer.`
    );
  }

  const ticket = await repository.getTicketSpec(input.ticketId);
  if (!ticket) {
    throw new Error(`Ticket ${input.ticketId} not found.`);
  }

  const project = await repository.getProjectSpec(ticket.projectId);
  if (!project) {
    throw new Error(`Project ${ticket.projectId} not found.`);
  }

  // Idempotent: already-merged ticket
  if (ticket.status === "merged") {
    logger?.warn(
      `Ticket ${input.ticketId} is already merged. No state mutation performed.`
    );
    return {
      outcome: "already_merged",
      ticket,
      project,
      nextDispatchedTicket: null,
      nextDispatchedTaskId: null,
      nextDispatchedTaskCreated: false
    };
  }

  if (project.status !== "executing") {
    throw new Error(
      `Project ${project.projectId} is in status '${project.status}' and cannot advance ticket ${input.ticketId}.`
    );
  }

  if (ticket.status !== "dispatched" && ticket.status !== "pr_open") {
    throw new Error(
      `Ticket ${input.ticketId} is in status '${ticket.status}' and cannot be advanced from a PR merge callback.`
    );
  }

  // All DB mutations inside a single transaction for atomicity.
  // GitHub API call (close sub-issue) is performed after the transaction
  // since it's an external side effect that shouldn't block the commit.
  const txResult = await repository.runInTransaction(async (txRepo) => {
    // Step 1: Mark ticket as merged with PR number
    const mergedTicket: TicketSpec = {
      ...ticket,
      status: "merged",
      githubPrNumber: input.githubPrNumber,
      updatedAt: now()
    };
    await txRepo.saveTicketSpec(mergedTicket);
    logger?.info(
      `Ticket ${input.ticketId} marked as merged (PR #${input.githubPrNumber}).`
    );

    // Step 2: Resolve next ready ticket (with row-level locking in tx)
    const nextTicket = await txRepo.resolveNextReadyTicket(ticket.projectId);
    let nextDispatchedTicket: TicketSpec | null = null;

    if (nextTicket) {
      // Dispatch the next ticket
      const updatedProject: ProjectSpec = {
        ...project,
        updatedAt: now()
      };
      await txRepo.saveProjectSpec(updatedProject);
      const dispatched: TicketSpec = {
        ...nextTicket,
        status: "dispatched",
        updatedAt: now()
      };
      await txRepo.saveTicketSpec(dispatched);
      nextDispatchedTicket = dispatched;
      const materialized = await materializeProjectTicketTask({
        repository: txRepo,
        project,
        ticket: dispatched,
        decidedBy: "project-advance",
        decisionSummary: `Dispatched after merging ${input.ticketId}.`,
        now
      });

      logger?.info(
        `Dispatched next ticket ${nextTicket.ticketId} (${nextTicket.title}).`
      );

      return {
        outcome: "advanced" as const,
        ticket: mergedTicket,
        project: updatedProject,
        nextDispatchedTicket,
        nextDispatchedTaskId: materialized.taskId,
        nextDispatchedTaskCreated: materialized.created
      };
    }

    // No more tickets — check if all are merged
    const allTickets = await txRepo.listTicketSpecs(ticket.projectId);
    const allMerged = allTickets.every((t) => t.status === "merged");

    if (allMerged) {
      const completedAt = now();
      const completedProject: ProjectSpec = {
        ...project,
        status: "complete",
        updatedAt: completedAt
      };
      await txRepo.saveProjectSpec(completedProject);
      await completeParentProjectTask({
        repository: txRepo,
        project: completedProject,
        completedAt
      });
      logger?.info(
        `All tickets merged. Project ${ticket.projectId} marked as complete.`
      );

      return {
        outcome: "completed" as const,
        ticket: mergedTicket,
        project: completedProject,
        nextDispatchedTicket: null,
        nextDispatchedTaskId: null,
        nextDispatchedTaskCreated: false
      };
    }

    // Some tickets remain but none are ready (could be blocked/failed)
    logger?.warn(
      `No ready tickets found for project ${ticket.projectId} but not all tickets are merged.`
    );

    return {
      outcome: "advanced" as const,
      ticket: mergedTicket,
      project,
      nextDispatchedTicket: null,
      nextDispatchedTaskId: null,
      nextDispatchedTaskCreated: false
    };
  });

  // Step 3: Close the linked GitHub sub-issue (external side effect, after tx commit)
  if (deps.githubIssuesAdapter && ticket.githubSubIssueNumber !== null) {
    try {
      await deps.githubIssuesAdapter.closeIssue(
        ticket.githubSubIssueNumber,
        project.sourceRepo
      );
      logger?.info(
        `Closed GitHub sub-issue #${ticket.githubSubIssueNumber} for ticket ${input.ticketId}.`
      );
    } catch (err) {
      if (err instanceof V1MutationDisabledError) {
        logger?.warn(
          `GitHub Issues adapter is disabled. Skipping sub-issue close for #${ticket.githubSubIssueNumber}.`
        );
      } else {
        // M2: Log at error level — operator should be alerted that GitHub state is inconsistent
        const errMsg = err instanceof Error ? err.message : String(err);
        logger?.warn(
          `ERROR: Failed to close GitHub sub-issue #${ticket.githubSubIssueNumber} for ticket ${input.ticketId}. ` +
          `The ticket is marked as merged in the database but the GitHub issue remains open. ` +
          `Manual intervention required: ${errMsg}`
        );
      }
    }
  }

  // Feature 150: Signal Task Flow state transition when enabled.
  if (
    process.env["REDDWARF_TASKFLOW_ENABLED"] === "true" &&
    deps.taskFlowAdapter
  ) {
    try {
      const flowMemory = await deps.repository.listMemoryRecords({
        scope: "task",
        keyPrefix: `project.taskflow.flowId:${ticket.projectId}`
      });
      const flowId = flowMemory.length > 0
        ? (flowMemory[0]!.value as Record<string, unknown>)["flowId"] as string | null
        : null;
      if (flowId) {
        await deps.taskFlowAdapter.advanceFlow(flowId, input.ticketId);
        logger?.info(`Advanced Task Flow ${flowId} past ticket ${input.ticketId}.`);
      }
    } catch (flowErr) {
      const flowErrMsg = flowErr instanceof Error ? flowErr.message : String(flowErr);
      logger?.warn(`Failed to advance Task Flow for ticket ${input.ticketId}: ${flowErrMsg}`);
    }
  }

  return txResult;
}
