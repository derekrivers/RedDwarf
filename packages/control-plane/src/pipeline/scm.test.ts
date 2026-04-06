import { describe, expect, it } from "vitest";
import { appendProjectTicketIdMarker } from "./scm.js";

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
