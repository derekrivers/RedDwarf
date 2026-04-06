import {
  asIsoTimestamp,
  type ProjectSpec,
  type TicketSpec
} from "@reddwarf/contracts";
import type { PlanningRepository } from "@reddwarf/evidence";
import type { GitHubIssuesAdapter } from "@reddwarf/integrations";
import { V1MutationDisabledError } from "@reddwarf/integrations";

export interface ExecuteProjectApprovalInput {
  projectId: string;
  decidedBy: string;
  decisionSummary?: string | null | undefined;
}

export interface ExecuteProjectApprovalDependencies {
  repository: PlanningRepository;
  githubIssuesAdapter?: GitHubIssuesAdapter | null;
  clock?: () => Date;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

export interface ExecuteProjectApprovalResult {
  project: ProjectSpec;
  tickets: TicketSpec[];
  subIssuesCreated: number;
  subIssuesFallback: boolean;
  dispatchedTicket: TicketSpec | null;
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

  if (project.status !== "pending_approval") {
    throw new Error(
      `Project ${input.projectId} is in status '${project.status}'. Only projects in 'pending_approval' can be approved.`
    );
  }

  // Step 1: Transition to "approved"
  const approvedProject: ProjectSpec = {
    ...project,
    status: "approved",
    approvalDecision: "approve",
    decidedBy: input.decidedBy,
    decisionSummary: input.decisionSummary ?? null,
    updatedAt: now()
  };
  await repository.saveProjectSpec(approvedProject);
  logger?.info(`Project ${input.projectId} approved by ${input.decidedBy}.`);

  // Step 2: Load tickets and sort in dependency order
  const tickets = await repository.listTicketSpecs(input.projectId);
  const orderedTickets = sortTicketsByDependencyOrder(tickets);

  // Step 3: Create GitHub sub-issues (if adapter enabled)
  let subIssuesCreated = 0;
  let subIssuesFallback = false;
  const sourceIssueNumber = project.sourceIssueId
    ? parseInt(project.sourceIssueId, 10)
    : null;

  if (deps.githubIssuesAdapter && sourceIssueNumber !== null && !isNaN(sourceIssueNumber)) {
    try {
      for (let i = 0; i < orderedTickets.length; i++) {
        const ticket = orderedTickets[i]!;
        const prefixedTicket: TicketSpec = {
          ...ticket,
          title: `[${i + 1}/${orderedTickets.length}] ${ticket.title}`
        };

        const issueNumber = await deps.githubIssuesAdapter.createSubIssue(
          sourceIssueNumber,
          prefixedTicket
        );

        const updatedTicket: TicketSpec = {
          ...ticket,
          githubSubIssueNumber: issueNumber,
          updatedAt: now()
        };
        await repository.saveTicketSpec(updatedTicket);
        orderedTickets[i] = updatedTicket;
        subIssuesCreated++;

        logger?.info(
          `Created sub-issue #${issueNumber} for ticket ${ticket.ticketId} (${ticket.title}).`
        );
      }
    } catch (err) {
      if (err instanceof V1MutationDisabledError) {
        logger?.warn(
          `GitHub Issues adapter is disabled. Falling back to Postgres-only state. Dispatch will proceed without GitHub sub-issues.`
        );
        subIssuesFallback = true;
      } else {
        throw err;
      }
    }
  } else {
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

  // Step 4: Resolve first ready ticket and dispatch
  const nextTicket = await repository.resolveNextReadyTicket(input.projectId);
  let dispatchedTicket: TicketSpec | null = null;

  if (nextTicket) {
    const dispatched: TicketSpec = {
      ...nextTicket,
      status: "dispatched",
      updatedAt: now()
    };
    await repository.saveTicketSpec(dispatched);
    dispatchedTicket = dispatched;

    logger?.info(
      `Dispatched ticket ${nextTicket.ticketId} (${nextTicket.title}) to dev squad pipeline.`
    );
  } else {
    logger?.warn(
      `No ready tickets found for project ${input.projectId} after approval.`
    );
  }

  // Step 5: Transition project to "executing"
  const executingProject: ProjectSpec = {
    ...approvedProject,
    status: "executing",
    updatedAt: now()
  };
  await repository.saveProjectSpec(executingProject);
  logger?.info(`Project ${input.projectId} status updated to 'executing'.`);

  // Return the final ticket states
  const finalTickets = await repository.listTicketSpecs(input.projectId);

  return {
    project: executingProject,
    tickets: finalTickets,
    subIssuesCreated,
    subIssuesFallback,
    dispatchedTicket
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
      nextDispatchedTicket: null
    };
  }

  // Step 1: Mark ticket as merged with PR number
  const mergedTicket: TicketSpec = {
    ...ticket,
    status: "merged",
    githubPrNumber: input.githubPrNumber,
    updatedAt: now()
  };
  await repository.saveTicketSpec(mergedTicket);
  logger?.info(
    `Ticket ${input.ticketId} marked as merged (PR #${input.githubPrNumber}).`
  );

  // Step 2: Close the linked GitHub sub-issue
  if (deps.githubIssuesAdapter && ticket.githubSubIssueNumber !== null) {
    try {
      await deps.githubIssuesAdapter.closeIssue(ticket.githubSubIssueNumber);
      logger?.info(
        `Closed GitHub sub-issue #${ticket.githubSubIssueNumber} for ticket ${input.ticketId}.`
      );
    } catch (err) {
      if (err instanceof V1MutationDisabledError) {
        logger?.warn(
          `GitHub Issues adapter is disabled. Skipping sub-issue close for #${ticket.githubSubIssueNumber}.`
        );
      } else {
        logger?.warn(
          `Failed to close GitHub sub-issue #${ticket.githubSubIssueNumber}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  // Step 3: Resolve next ready ticket
  const nextTicket = await repository.resolveNextReadyTicket(ticket.projectId);
  let nextDispatchedTicket: TicketSpec | null = null;

  if (nextTicket) {
    // Dispatch the next ticket
    const dispatched: TicketSpec = {
      ...nextTicket,
      status: "dispatched",
      updatedAt: now()
    };
    await repository.saveTicketSpec(dispatched);
    nextDispatchedTicket = dispatched;

    logger?.info(
      `Dispatched next ticket ${nextTicket.ticketId} (${nextTicket.title}).`
    );

    return {
      outcome: "advanced",
      ticket: mergedTicket,
      project,
      nextDispatchedTicket
    };
  }

  // No more tickets — check if all are merged
  const allTickets = await repository.listTicketSpecs(ticket.projectId);
  const allMerged = allTickets.every((t) => t.status === "merged");

  if (allMerged) {
    const completedProject: ProjectSpec = {
      ...project,
      status: "complete",
      updatedAt: now()
    };
    await repository.saveProjectSpec(completedProject);
    logger?.info(
      `All tickets merged. Project ${ticket.projectId} marked as complete.`
    );

    return {
      outcome: "completed",
      ticket: mergedTicket,
      project: completedProject,
      nextDispatchedTicket: null
    };
  }

  // Some tickets remain but none are ready (could be blocked/failed)
  logger?.warn(
    `No ready tickets found for project ${ticket.projectId} but not all tickets are merged.`
  );

  return {
    outcome: "advanced",
    ticket: mergedTicket,
    project,
    nextDispatchedTicket: null
  };
}
