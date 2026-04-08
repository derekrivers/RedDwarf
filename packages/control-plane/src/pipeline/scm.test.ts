import { describe, expect, it } from "vitest";
import { InMemoryPlanningRepository } from "@reddwarf/evidence";
import type { TicketSpec } from "@reddwarf/contracts";
import {
  appendProjectTicketIdMarker,
  markProjectTicketPullRequestOpen
} from "./scm.js";

const testTimestamp = "2026-04-06T12:00:00.000Z";

function buildTicketSpec(overrides: Partial<TicketSpec> = {}): TicketSpec {
  return {
    ticketId: "project:task-001:ticket:1",
    projectId: "project:task-001",
    title: "First ticket",
    description: "Implement the first project ticket.",
    acceptanceCriteria: ["The ticket is complete"],
    dependsOn: [],
    status: "dispatched",
    complexityClass: "low",
    riskClass: "low",
    githubSubIssueNumber: 2000,
    githubPrNumber: null,
    createdAt: testTimestamp,
    updatedAt: testTimestamp,
    ...overrides
  };
}

describe("appendProjectTicketIdMarker", () => {
  it("adds the project ticket marker expected by the merge workflow", () => {
    const body = appendProjectTicketIdMarker(
      "## RedDwarf SCM Handoff\n\nReady for review.\n",
      "project:derekrivers-firstvoyage-69:ticket:1"
    );

    expect(body).toContain(
      "<!-- reddwarf:ticket_id:project:derekrivers-firstvoyage-69:ticket:1 -->"
    );
  });

  it("does not duplicate an existing marker", () => {
    const marked =
      "Body\n\n<!-- reddwarf:ticket_id:project:task-001:ticket:1 -->\n";

    expect(
      appendProjectTicketIdMarker(marked, "project:task-001:ticket:1")
    ).toBe(marked);
  });
});

describe("markProjectTicketPullRequestOpen", () => {
  it("records the opened PR on the project ticket", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveTicketSpec(buildTicketSpec());

    const updated = await markProjectTicketPullRequestOpen({
      repository,
      ticketId: "project:task-001:ticket:1",
      pullRequestNumber: 71,
      updatedAt: "2026-04-06T13:00:00.000Z"
    });

    expect(updated?.status).toBe("pr_open");
    expect(updated?.githubPrNumber).toBe(71);
    const persisted = await repository.getTicketSpec("project:task-001:ticket:1");
    expect(persisted?.status).toBe("pr_open");
    expect(persisted?.githubPrNumber).toBe(71);
  });

  it("does not rewind an already merged ticket", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveTicketSpec(
      buildTicketSpec({ status: "merged", githubPrNumber: 71 })
    );

    const updated = await markProjectTicketPullRequestOpen({
      repository,
      ticketId: "project:task-001:ticket:1",
      pullRequestNumber: 72,
      updatedAt: "2026-04-06T13:00:00.000Z"
    });

    expect(updated?.status).toBe("merged");
    expect(updated?.githubPrNumber).toBe(71);
  });
});
