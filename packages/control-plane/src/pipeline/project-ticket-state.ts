import type {
  ProjectSpec,
  TicketSpec
} from "@reddwarf/contracts";
import type {
  PersistedTaskSnapshot,
  PlanningRepository
} from "@reddwarf/evidence";

interface ProjectTicketMemory {
  projectId: string;
  ticketId: string;
}

type ProjectTicketStateRepository = Pick<
  PlanningRepository,
  "getProjectSpec" | "getTicketSpec" | "saveProjectSpec" | "saveTicketSpec"
>;

export interface ProjectTicketStateSyncResult {
  project: ProjectSpec | null;
  ticket: TicketSpec | null;
}

export function readProjectTicketMemory(
  snapshot: PersistedTaskSnapshot
): ProjectTicketMemory | null {
  const record = snapshot.memoryRecords.find(
    (entry) => entry.key === "project.ticket"
  );
  const value = record?.value;

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const projectId = (value as Record<string, unknown>)["projectId"];
  const ticketId = (value as Record<string, unknown>)["ticketId"];

  if (typeof projectId !== "string" || typeof ticketId !== "string") {
    return null;
  }

  const normalizedProjectId = projectId.trim();
  const normalizedTicketId = ticketId.trim();

  return normalizedProjectId.length > 0 && normalizedTicketId.length > 0
    ? { projectId: normalizedProjectId, ticketId: normalizedTicketId }
    : null;
}

export async function markProjectTicketFailedFromSnapshot(input: {
  repository: ProjectTicketStateRepository;
  snapshot: PersistedTaskSnapshot;
  updatedAt: string;
}): Promise<ProjectTicketStateSyncResult | null> {
  const memory = readProjectTicketMemory(input.snapshot);
  if (!memory) {
    return null;
  }

  const ticket = await input.repository.getTicketSpec(memory.ticketId);
  const project = await input.repository.getProjectSpec(memory.projectId);
  let updatedTicket = ticket;
  let updatedProject = project;

  if (ticket && ticket.status !== "failed" && ticket.status !== "merged") {
    updatedTicket = {
      ...ticket,
      status: "failed",
      updatedAt: input.updatedAt
    };
    await input.repository.saveTicketSpec(updatedTicket);
  }

  if (project && project.status !== "failed" && project.status !== "complete") {
    updatedProject = {
      ...project,
      status: "failed",
      updatedAt: input.updatedAt
    };
    await input.repository.saveProjectSpec(updatedProject);
  }

  return {
    project: updatedProject,
    ticket: updatedTicket
  };
}

export async function restoreProjectTicketExecutionFromSnapshot(input: {
  repository: ProjectTicketStateRepository;
  snapshot: PersistedTaskSnapshot;
  updatedAt: string;
}): Promise<ProjectTicketStateSyncResult | null> {
  const memory = readProjectTicketMemory(input.snapshot);
  if (!memory) {
    return null;
  }

  const ticket = await input.repository.getTicketSpec(memory.ticketId);
  const project = await input.repository.getProjectSpec(memory.projectId);
  let updatedTicket = ticket;
  let updatedProject = project;

  if (ticket?.status === "failed") {
    updatedTicket = {
      ...ticket,
      status: "dispatched",
      updatedAt: input.updatedAt
    };
    await input.repository.saveTicketSpec(updatedTicket);
  }

  if (project?.status === "failed") {
    updatedProject = {
      ...project,
      status: "executing",
      updatedAt: input.updatedAt
    };
    await input.repository.saveProjectSpec(updatedProject);
  }

  return {
    project: updatedProject,
    ticket: updatedTicket
  };
}
