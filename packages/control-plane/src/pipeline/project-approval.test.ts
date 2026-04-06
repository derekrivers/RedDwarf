import { describe, expect, it } from "vitest";
import { InMemoryPlanningRepository } from "@reddwarf/evidence";
import { FixtureGitHubIssuesAdapter } from "@reddwarf/integrations";
import type { ProjectSpec, TicketSpec } from "@reddwarf/contracts";
import { executeProjectApproval, advanceProjectTicket } from "./project-approval.js";

const testTimestamp = "2026-04-06T12:00:00.000Z";

function buildProjectSpec(
  overrides: Partial<ProjectSpec> = {}
): ProjectSpec {
  return {
    projectId: "project:task-100",
    sourceIssueId: "42",
    sourceRepo: "acme/platform",
    title: "Test project",
    summary: "A test project for approval flow.",
    projectSize: "medium",
    status: "pending_approval",
    complexityClassification: {
      size: "medium",
      reasoning: "Spans 3 packages.",
      signals: ["multi-package"]
    },
    approvalDecision: null,
    decidedBy: null,
    decisionSummary: null,
    amendments: null,
    clarificationQuestions: null,
    clarificationAnswers: null,
    clarificationRequestedAt: null,
    createdAt: testTimestamp,
    updatedAt: testTimestamp,
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
    description: "Implement feature one.",
    acceptanceCriteria: ["Feature works"],
    dependsOn: [],
    status: "pending",
    complexityClass: "low",
    riskClass: "low",
    githubSubIssueNumber: null,
    githubPrNumber: null,
    createdAt: testTimestamp,
    updatedAt: testTimestamp,
    ...overrides
  };
}

describe("executeProjectApproval", () => {
  it("creates sub-issues, dispatches first ticket, and transitions project to executing", async () => {
    const repository = new InMemoryPlanningRepository();
    const adapter = new FixtureGitHubIssuesAdapter({ repo: "acme/platform" });

    await repository.saveProjectSpec(buildProjectSpec());
    await repository.saveTicketSpec(buildTicketSpec());
    await repository.saveTicketSpec(
      buildTicketSpec({
        ticketId: "project:task-100:ticket:2",
        title: "Second ticket",
        dependsOn: ["project:task-100:ticket:1"]
      })
    );

    const result = await executeProjectApproval(
      { projectId: "project:task-100", decidedBy: "derek" },
      {
        repository,
        githubIssuesAdapter: adapter,
        clock: () => new Date("2026-04-06T13:00:00.000Z")
      }
    );

    // Project should be in executing status
    expect(result.project.status).toBe("executing");
    expect(result.project.approvalDecision).toBe("approve");
    expect(result.project.decidedBy).toBe("derek");

    // Sub-issues should be created
    expect(result.subIssuesCreated).toBe(2);
    expect(result.subIssuesFallback).toBe(false);

    // Tickets should have github_sub_issue_number set
    const ticket1 = result.tickets.find((t) => t.ticketId === "project:task-100:ticket:1");
    const ticket2 = result.tickets.find((t) => t.ticketId === "project:task-100:ticket:2");
    expect(ticket1?.githubSubIssueNumber).toBeDefined();
    expect(ticket1?.githubSubIssueNumber).not.toBeNull();
    expect(ticket2?.githubSubIssueNumber).toBeDefined();
    expect(ticket2?.githubSubIssueNumber).not.toBeNull();

    // First ticket (no dependencies) should be dispatched
    expect(result.dispatchedTicket).not.toBeNull();
    expect(result.dispatchedTicket?.ticketId).toBe("project:task-100:ticket:1");

    // Verify persisted status
    const persisted = await repository.getProjectSpec("project:task-100");
    expect(persisted?.status).toBe("executing");

    const persistedTicket1 = await repository.getTicketSpec("project:task-100:ticket:1");
    expect(persistedTicket1?.status).toBe("dispatched");

    const persistedTicket2 = await repository.getTicketSpec("project:task-100:ticket:2");
    expect(persistedTicket2?.status).toBe("pending");
  });

  it("creates sub-issues with priority index prefix in dependency order", async () => {
    const repository = new InMemoryPlanningRepository();
    const adapter = new FixtureGitHubIssuesAdapter({ repo: "acme/platform" });

    await repository.saveProjectSpec(buildProjectSpec());
    await repository.saveTicketSpec(buildTicketSpec({ title: "Foundation" }));
    await repository.saveTicketSpec(
      buildTicketSpec({
        ticketId: "project:task-100:ticket:2",
        title: "Building on top",
        dependsOn: ["project:task-100:ticket:1"]
      })
    );

    await executeProjectApproval(
      { projectId: "project:task-100", decidedBy: "derek" },
      {
        repository,
        githubIssuesAdapter: adapter,
        clock: () => new Date("2026-04-06T13:00:00.000Z")
      }
    );

    const subIssues = adapter.getCreatedSubIssues();
    expect(subIssues.size).toBe(2);

    // Verify priority index prefixes
    const titles = [...subIssues.values()].map((s) => s.ticketSpec.title);
    expect(titles[0]).toBe("[1/2] Foundation");
    expect(titles[1]).toBe("[2/2] Building on top");

    // Verify parent issue number
    for (const entry of subIssues.values()) {
      expect(entry.parentIssueNumber).toBe(42);
    }
  });

  it("falls back to Postgres-only when GitHub Issues adapter is disabled", async () => {
    const repository = new InMemoryPlanningRepository();
    const adapter = new FixtureGitHubIssuesAdapter({
      repo: "acme/platform",
      enabled: false
    });

    await repository.saveProjectSpec(buildProjectSpec());
    await repository.saveTicketSpec(buildTicketSpec());

    const result = await executeProjectApproval(
      { projectId: "project:task-100", decidedBy: "derek" },
      {
        repository,
        githubIssuesAdapter: adapter,
        clock: () => new Date("2026-04-06T13:00:00.000Z")
      }
    );

    expect(result.subIssuesCreated).toBe(0);
    expect(result.subIssuesFallback).toBe(true);

    // Dispatch still proceeds
    expect(result.dispatchedTicket).not.toBeNull();
    expect(result.dispatchedTicket?.ticketId).toBe("project:task-100:ticket:1");
    expect(result.project.status).toBe("executing");
  });

  it("falls back when no GitHub Issues adapter is provided", async () => {
    const repository = new InMemoryPlanningRepository();

    await repository.saveProjectSpec(buildProjectSpec());
    await repository.saveTicketSpec(buildTicketSpec());

    const result = await executeProjectApproval(
      { projectId: "project:task-100", decidedBy: "derek" },
      {
        repository,
        githubIssuesAdapter: null,
        clock: () => new Date("2026-04-06T13:00:00.000Z")
      }
    );

    expect(result.subIssuesCreated).toBe(0);
    expect(result.subIssuesFallback).toBe(true);
    expect(result.dispatchedTicket).not.toBeNull();
    expect(result.project.status).toBe("executing");
  });

  it("falls back when project has no source issue number", async () => {
    const repository = new InMemoryPlanningRepository();
    const adapter = new FixtureGitHubIssuesAdapter({ repo: "acme/platform" });

    await repository.saveProjectSpec(buildProjectSpec({ sourceIssueId: null }));
    await repository.saveTicketSpec(buildTicketSpec());

    const result = await executeProjectApproval(
      { projectId: "project:task-100", decidedBy: "derek" },
      {
        repository,
        githubIssuesAdapter: adapter,
        clock: () => new Date("2026-04-06T13:00:00.000Z")
      }
    );

    expect(result.subIssuesCreated).toBe(0);
    expect(result.subIssuesFallback).toBe(true);
    expect(result.dispatchedTicket).not.toBeNull();
  });

  it("throws when project is not in pending_approval status", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(buildProjectSpec({ status: "draft" }));

    await expect(
      executeProjectApproval(
        { projectId: "project:task-100", decidedBy: "derek" },
        { repository }
      )
    ).rejects.toThrow(/pending_approval/);
  });

  it("throws when project does not exist", async () => {
    const repository = new InMemoryPlanningRepository();

    await expect(
      executeProjectApproval(
        { projectId: "nonexistent", decidedBy: "derek" },
        { repository }
      )
    ).rejects.toThrow(/not found/);
  });

  it("dispatches the correct first-ready ticket with complex dependencies", async () => {
    const repository = new InMemoryPlanningRepository();

    await repository.saveProjectSpec(buildProjectSpec());

    // Ticket 1 depends on ticket 2, so ticket 2 should be dispatched first
    await repository.saveTicketSpec(
      buildTicketSpec({
        ticketId: "project:task-100:ticket:1",
        title: "Depends on ticket 2",
        dependsOn: ["project:task-100:ticket:2"]
      })
    );
    await repository.saveTicketSpec(
      buildTicketSpec({
        ticketId: "project:task-100:ticket:2",
        title: "Independent ticket",
        dependsOn: []
      })
    );

    const result = await executeProjectApproval(
      { projectId: "project:task-100", decidedBy: "derek" },
      {
        repository,
        githubIssuesAdapter: null,
        clock: () => new Date("2026-04-06T13:00:00.000Z")
      }
    );

    expect(result.dispatchedTicket?.ticketId).toBe("project:task-100:ticket:2");
  });
});

describe("advanceProjectTicket", () => {
  it("merges a ticket, closes sub-issue, and dispatches next ready ticket", async () => {
    const repository = new InMemoryPlanningRepository();
    const adapter = new FixtureGitHubIssuesAdapter({ repo: "acme/platform" });

    await repository.saveProjectSpec(
      buildProjectSpec({ status: "executing" })
    );
    await repository.saveTicketSpec(
      buildTicketSpec({
        status: "dispatched",
        githubSubIssueNumber: 2000
      })
    );
    await repository.saveTicketSpec(
      buildTicketSpec({
        ticketId: "project:task-100:ticket:2",
        title: "Second ticket",
        dependsOn: ["project:task-100:ticket:1"],
        githubSubIssueNumber: 2001
      })
    );

    const result = await advanceProjectTicket(
      { ticketId: "project:task-100:ticket:1", githubPrNumber: 55 },
      {
        repository,
        githubIssuesAdapter: adapter,
        clock: () => new Date("2026-04-06T14:00:00.000Z")
      }
    );

    expect(result.outcome).toBe("advanced");
    expect(result.ticket.status).toBe("merged");
    expect(result.ticket.githubPrNumber).toBe(55);
    expect(result.nextDispatchedTicket?.ticketId).toBe("project:task-100:ticket:2");

    // Sub-issue should have been closed
    expect(adapter.getClosedIssues().has(2000)).toBe(true);

    // Verify persisted
    const persistedTicket1 = await repository.getTicketSpec("project:task-100:ticket:1");
    expect(persistedTicket1?.status).toBe("merged");

    const persistedTicket2 = await repository.getTicketSpec("project:task-100:ticket:2");
    expect(persistedTicket2?.status).toBe("dispatched");
  });

  it("completes the project when all tickets are merged", async () => {
    const repository = new InMemoryPlanningRepository();

    await repository.saveProjectSpec(
      buildProjectSpec({ status: "executing" })
    );
    await repository.saveTicketSpec(
      buildTicketSpec({ status: "merged" })
    );
    await repository.saveTicketSpec(
      buildTicketSpec({
        ticketId: "project:task-100:ticket:2",
        title: "Last ticket",
        status: "dispatched",
        dependsOn: ["project:task-100:ticket:1"]
      })
    );

    const result = await advanceProjectTicket(
      { ticketId: "project:task-100:ticket:2", githubPrNumber: 56 },
      {
        repository,
        clock: () => new Date("2026-04-06T14:00:00.000Z")
      }
    );

    expect(result.outcome).toBe("completed");
    expect(result.project.status).toBe("complete");

    const persisted = await repository.getProjectSpec("project:task-100");
    expect(persisted?.status).toBe("complete");
  });

  it("is idempotent for already-merged tickets", async () => {
    const repository = new InMemoryPlanningRepository();

    await repository.saveProjectSpec(
      buildProjectSpec({ status: "executing" })
    );
    await repository.saveTicketSpec(
      buildTicketSpec({ status: "merged", githubPrNumber: 55 })
    );

    const result = await advanceProjectTicket(
      { ticketId: "project:task-100:ticket:1", githubPrNumber: 55 },
      { repository }
    );

    expect(result.outcome).toBe("already_merged");
    expect(result.nextDispatchedTicket).toBeNull();
  });

  it("throws when ticket does not exist", async () => {
    const repository = new InMemoryPlanningRepository();

    await expect(
      advanceProjectTicket(
        { ticketId: "nonexistent", githubPrNumber: 1 },
        { repository }
      )
    ).rejects.toThrow(/not found/);
  });

  it("handles advance without GitHub Issues adapter", async () => {
    const repository = new InMemoryPlanningRepository();

    await repository.saveProjectSpec(
      buildProjectSpec({ status: "executing" })
    );
    await repository.saveTicketSpec(
      buildTicketSpec({
        status: "dispatched",
        githubSubIssueNumber: 2000
      })
    );

    const result = await advanceProjectTicket(
      { ticketId: "project:task-100:ticket:1", githubPrNumber: 55 },
      {
        repository,
        githubIssuesAdapter: null,
        clock: () => new Date("2026-04-06T14:00:00.000Z")
      }
    );

    expect(result.outcome).toBe("completed");
    expect(result.ticket.status).toBe("merged");
  });
});
