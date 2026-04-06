import { describe, expect, it } from "vitest";
import type { ProjectSpec, TicketSpec } from "@reddwarf/contracts";
import {
  InMemoryPlanningRepository,
  createMemoryRecord
} from "@reddwarf/evidence";
import {
  markProjectTicketFailedFromSnapshot,
  restoreProjectTicketExecutionFromSnapshot
} from "./project-ticket-state.js";

const timestamp = "2026-04-06T12:00:00.000Z";

function buildProjectSpec(
  overrides: Partial<ProjectSpec> = {}
): ProjectSpec {
  return {
    projectId: "project:task-100",
    sourceIssueId: "42",
    sourceRepo: "acme/platform",
    title: "Project ticket state sync",
    summary: "Project used to test child task failure propagation.",
    projectSize: "medium",
    status: "executing",
    complexityClassification: null,
    approvalDecision: "approve",
    decidedBy: "operator",
    decisionSummary: "Approved.",
    amendments: null,
    clarificationQuestions: null,
    clarificationAnswers: null,
    clarificationRequestedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

function buildTicketSpec(
  overrides: Partial<TicketSpec> = {}
): TicketSpec {
  return {
    ticketId: "project:task-100:ticket:1",
    projectId: "project:task-100",
    title: "First ticket",
    description: "Implement the first ticket.",
    acceptanceCriteria: ["It works"],
    dependsOn: [],
    status: "dispatched",
    complexityClass: "low",
    riskClass: "low",
    githubSubIssueNumber: 2000,
    githubPrNumber: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

async function saveProjectTicketMemory(
  repository: InMemoryPlanningRepository,
  taskId = "task-100-ticket-1"
): Promise<void> {
  await repository.saveMemoryRecord(
    createMemoryRecord({
      memoryId: `${taskId}:memory:task:project-ticket`,
      taskId,
      scope: "task",
      provenance: "pipeline_derived",
      key: "project.ticket",
      title: "Project ticket dispatch metadata",
      value: {
        projectId: "project:task-100",
        ticketId: "project:task-100:ticket:1",
        githubSubIssueNumber: 2000,
        sourceRepo: "acme/platform"
      },
      repo: "acme/platform",
      organizationId: "acme",
      tags: ["project", "ticket"],
      createdAt: timestamp,
      updatedAt: timestamp
    })
  );
}

describe("project ticket state sync", () => {
  it("marks the project and ticket failed when a child task escalates", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(buildProjectSpec());
    await repository.saveTicketSpec(buildTicketSpec());
    await saveProjectTicketMemory(repository);
    const snapshot = await repository.getTaskSnapshot("task-100-ticket-1");

    await markProjectTicketFailedFromSnapshot({
      repository,
      snapshot,
      updatedAt: "2026-04-06T13:00:00.000Z"
    });

    const project = await repository.getProjectSpec("project:task-100");
    const ticket = await repository.getTicketSpec("project:task-100:ticket:1");
    expect(project?.status).toBe("failed");
    expect(ticket?.status).toBe("failed");
    expect(project?.updatedAt).toBe("2026-04-06T13:00:00.000Z");
    expect(ticket?.updatedAt).toBe("2026-04-06T13:00:00.000Z");
  });

  it("restores project execution state when a failed child task retry is approved", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(buildProjectSpec({ status: "failed" }));
    await repository.saveTicketSpec(buildTicketSpec({ status: "failed" }));
    await saveProjectTicketMemory(repository);
    const snapshot = await repository.getTaskSnapshot("task-100-ticket-1");

    await restoreProjectTicketExecutionFromSnapshot({
      repository,
      snapshot,
      updatedAt: "2026-04-06T14:00:00.000Z"
    });

    const project = await repository.getProjectSpec("project:task-100");
    const ticket = await repository.getTicketSpec("project:task-100:ticket:1");
    expect(project?.status).toBe("executing");
    expect(ticket?.status).toBe("dispatched");
    expect(project?.updatedAt).toBe("2026-04-06T14:00:00.000Z");
    expect(ticket?.updatedAt).toBe("2026-04-06T14:00:00.000Z");
  });
});
