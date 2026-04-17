import { describe, expect, it } from "vitest";
import {
  buildOpenClawProjectArchitectPrompt,
  parseArchitectHandoffMarkdown,
  parseProjectArchitectHandoff
} from "./prompts.js";
import type { PlanningTaskInput, TaskManifest } from "@reddwarf/contracts";

const sampleInput: PlanningTaskInput = {
  source: { provider: "github", repo: "acme/platform", issueNumber: 10 },
  title: "Add project mode",
  summary: "Introduce project-mode planning with ticket decomposition.",
  priority: 3,
  dryRun: false,
  labels: ["ai-eligible"],
  acceptanceCriteria: [
    "Holly produces ProjectSpec with tickets",
    "Clarification loop works",
    "Single-issue path unchanged"
  ],
  affectedPaths: [
    "packages/control-plane/src/pipeline/planning.ts",
    "packages/contracts/src/planning.ts"
  ],
  requestedCapabilities: ["can_plan", "can_write_code"],
  metadata: {}
};

const sampleManifest = {
  taskId: "task:acme-platform:10:run-001",
  title: "Add project mode",
  summary: "Introduce project-mode planning with ticket decomposition.",
  source: { provider: "github", repo: "acme/platform", issueNumber: 10 },
  riskClass: "medium",
  requestedCapabilities: ["can_plan", "can_write_code"]
} as unknown as TaskManifest;

describe("buildOpenClawProjectArchitectPrompt", () => {
  it("includes project mode instructions and required handoff format", () => {
    const prompt = buildOpenClawProjectArchitectPrompt(
      sampleInput,
      sampleManifest,
      "/var/lib/reddwarf/workspaces/test",
      "/var/lib/reddwarf/workspaces/test/repo",
      "/var/lib/reddwarf/workspaces/test/REPO_INDEX.md",
      "/var/lib/reddwarf/workspaces/test/artifacts/project-architect-handoff.md"
    );

    expect(prompt).toContain("Planning mode: project");
    expect(prompt).toContain("project-mode");
    expect(prompt).toContain("## Required Handoff Format");
    expect(prompt).toContain("### Ticket:");
    expect(prompt).toContain("## Clarification Needed");
    expect(prompt).toContain("at least 2 tickets");
    expect(prompt).toContain("Task ID: task:acme-platform:10:run-001");
    expect(prompt).toContain("Repository: acme/platform");
    expect(prompt).toContain("Repository index: /var/lib/reddwarf/workspaces/test/REPO_INDEX.md");
    expect(prompt).toContain("Start by reading the repository index file above");
  });

  it("includes untrusted issue data block", () => {
    const prompt = buildOpenClawProjectArchitectPrompt(
      sampleInput,
      sampleManifest,
      "/workspace",
      "/workspace/repo",
      "/workspace/REPO_INDEX.md",
      "/workspace/handoff.md"
    );
    expect(prompt).toContain("## Untrusted GitHub Issue Data");
    expect(prompt).toContain("Add project mode");
  });

  it("surfaces proposedSubTasks as a decomposition hint when present", () => {
    const prompt = buildOpenClawProjectArchitectPrompt(
      {
        ...sampleInput,
        proposedSubTasks: [
          "Migrate the schema",
          "Update the API layer",
          "Wire the UI to the new API"
        ]
      },
      sampleManifest,
      "/workspace",
      "/workspace/repo",
      "/workspace/REPO_INDEX.md",
      "/workspace/handoff.md"
    );

    expect(prompt).toContain("proposedSubTasks");
    expect(prompt).toContain("Migrate the schema");
    expect(prompt).toContain("Update the API layer");
    expect(prompt).toContain("strong hint");
  });

  it("does not mention proposedSubTasks payload when the hint is absent", () => {
    const prompt = buildOpenClawProjectArchitectPrompt(
      sampleInput,
      sampleManifest,
      "/workspace",
      "/workspace/repo",
      "/workspace/REPO_INDEX.md",
      "/workspace/handoff.md"
    );

    expect(prompt).toContain('"proposedSubTasks": []');
  });

  it("includes clarification context when provided", () => {
    const prompt = buildOpenClawProjectArchitectPrompt(
      sampleInput,
      sampleManifest,
      "/workspace",
      "/workspace/repo",
      "/workspace/REPO_INDEX.md",
      "/workspace/handoff.md",
      {
        questions: ["What framework?", "What database?"],
        answers: {
          "What framework?": "React with Vite",
          "What database?": "PostgreSQL"
        }
      }
    );

    expect(prompt).toContain("## Prior Clarification Round");
    expect(prompt).toContain("What framework?");
    expect(prompt).toContain("React with Vite");
    expect(prompt).toContain("What database?");
    expect(prompt).toContain("PostgreSQL");
  });

  it("omits clarification block when no context provided", () => {
    const prompt = buildOpenClawProjectArchitectPrompt(
      sampleInput,
      sampleManifest,
      "/workspace",
      "/workspace/repo",
      "/workspace/REPO_INDEX.md",
      "/workspace/handoff.md",
      null
    );

    expect(prompt).not.toContain("## Prior Clarification Round");
  });

  it("includes amendments context when provided", () => {
    const prompt = buildOpenClawProjectArchitectPrompt(
      sampleInput,
      sampleManifest,
      "/workspace",
      "/workspace/repo",
      "/workspace/REPO_INDEX.md",
      "/workspace/handoff.md",
      null,
      "Please add more detail to ticket 2's acceptance criteria."
    );

    expect(prompt).toContain("## Prior Review Amendments");
    expect(prompt).toContain("more detail to ticket 2");
  });

  it("includes both clarification and amendments context", () => {
    const prompt = buildOpenClawProjectArchitectPrompt(
      sampleInput,
      sampleManifest,
      "/workspace",
      "/workspace/repo",
      "/workspace/REPO_INDEX.md",
      "/workspace/handoff.md",
      {
        questions: ["What framework?"],
        answers: { "What framework?": "React" }
      },
      "Add more tickets for testing."
    );

    expect(prompt).toContain("## Prior Clarification Round");
    expect(prompt).toContain("## Prior Review Amendments");
    expect(prompt).toContain("Add more tickets for testing");
  });
});

describe("parseProjectArchitectHandoff", () => {
  const validHandoff = [
    "# Project Architecture Handoff",
    "",
    "- Task ID: task:acme-platform:10:run-001",
    "- Repository: acme/platform",
    "- Architect: Holly (reddwarf-analyst)",
    "- Confidence: high",
    "- Confidence reason: Clear requirements and well-understood codebase.",
    "",
    "## Project Title",
    "",
    "Project Mode Implementation",
    "",
    "## Project Summary",
    "",
    "Implement the planning corridor with ticket decomposition and clarification loop.",
    "",
    "## Tickets",
    "",
    "### Ticket: Add complexity classifier",
    "",
    "- Complexity: low",
    "- Depends on: none",
    "",
    "#### Description",
    "",
    "Implement classifyComplexity function in the Rimmer module.",
    "",
    "#### Acceptance Criteria",
    "",
    "- Function returns size, reasoning, and signals",
    "- Small/medium/large thresholds are correct",
    "",
    "### Ticket: Add ProjectSpec schema",
    "",
    "- Complexity: medium",
    "- Depends on: Add complexity classifier",
    "",
    "#### Description",
    "",
    "Create project_specs and ticket_specs tables with Postgres persistence.",
    "",
    "#### Acceptance Criteria",
    "",
    "- Migration creates both tables",
    "- Repository implements CRUD operations",
    "- resolveNextReady returns first unblocked ticket",
    ""
  ].join("\n");

  it("parses a valid project handoff into a ProjectPlanningDraft", () => {
    const result = parseProjectArchitectHandoff(validHandoff);
    expect(result.outcome).toBe("project_spec");
    if (result.outcome !== "project_spec") throw new Error("Expected project_spec");

    const { draft } = result;
    expect(draft.title).toBe("Project Mode Implementation");
    expect(draft.summary).toContain("planning corridor");
    expect(draft.confidence.level).toBe("high");
    expect(draft.tickets).toHaveLength(2);
  });

  it("parses ticket titles, descriptions, and acceptance criteria", () => {
    const result = parseProjectArchitectHandoff(validHandoff);
    if (result.outcome !== "project_spec") throw new Error("Expected project_spec");

    const [ticket1, ticket2] = result.draft.tickets;

    expect(ticket1!.title).toBe("Add complexity classifier");
    expect(ticket1!.complexityClass).toBe("low");
    expect(ticket1!.dependsOn).toEqual([]);
    expect(ticket1!.description).toContain("classifyComplexity");
    expect(ticket1!.acceptanceCriteria).toContain("Function returns size, reasoning, and signals");
    expect(ticket1!.acceptanceCriteria).toHaveLength(2);

    expect(ticket2!.title).toBe("Add ProjectSpec schema");
    expect(ticket2!.complexityClass).toBe("medium");
    expect(ticket2!.dependsOn).toEqual(["Add complexity classifier"]);
    expect(ticket2!.acceptanceCriteria).toHaveLength(3);
  });

  it("treats an exact dependency title containing commas as a single dependency", () => {
    const handoff = [
      "# Project Architecture Handoff",
      "",
      "- Confidence: high",
      "- Confidence reason: Clear browser-game decomposition.",
      "",
      "## Project Title",
      "",
      "Complete Pac-Man game",
      "",
      "## Project Summary",
      "",
      "Complete the existing browser game implementation.",
      "",
      "## Tickets",
      "",
      "### Ticket: Add four ghosts with movement and wall-respecting AI",
      "",
      "- Complexity: high",
      "- Depends on: none",
      "",
      "#### Description",
      "",
      "Add the ghost entities.",
      "",
      "#### Acceptance Criteria",
      "",
      "- Four ghosts move through the maze.",
      "",
      "### Ticket: Implement frightened mode, ghost-eating scoring, and Pac-Man/ghost collision",
      "",
      "- Complexity: medium",
      "- Depends on: Add four ghosts with movement and wall-respecting AI",
      "",
      "#### Description",
      "",
      "Add power-pellet and collision interactions.",
      "",
      "#### Acceptance Criteria",
      "",
      "- Frightened ghosts can be eaten.",
      "",
      "### Ticket: Add game-over screen, victory screen, and restart flow",
      "",
      "- Complexity: low",
      "- Depends on: Implement frightened mode, ghost-eating scoring, and Pac-Man/ghost collision",
      "",
      "#### Description",
      "",
      "Add end-state screens.",
      "",
      "#### Acceptance Criteria",
      "",
      "- Restart works without a page reload."
    ].join("\n");

    const result = parseProjectArchitectHandoff(handoff);
    if (result.outcome !== "project_spec") throw new Error("Expected project_spec");

    expect(result.draft.tickets[2]!.dependsOn).toEqual([
      "Implement frightened mode, ghost-eating scoring, and Pac-Man/ghost collision"
    ]);
  });

  it("detects clarification requests and returns clarification_needed outcome", () => {
    const clarificationHandoff = [
      "# Project Architecture Handoff",
      "",
      "- Task ID: task:test:1:run-001",
      "- Repository: acme/platform",
      "- Architect: Holly (reddwarf-analyst)",
      "- Confidence: low",
      "- Confidence reason: Insufficient context to produce a complete plan.",
      "",
      "## Project Title",
      "",
      "## Project Summary",
      "",
      "## Tickets",
      "",
      "## Clarification Needed",
      "",
      "- What authentication mechanism should be used?",
      "- Should the API support OAuth2 or just API keys?",
      "- What is the expected rate limit per user?"
    ].join("\n");

    const result = parseProjectArchitectHandoff(clarificationHandoff);
    expect(result.outcome).toBe("clarification_needed");
    if (result.outcome !== "clarification_needed") throw new Error("Expected clarification_needed");

    expect(result.clarification.questions).toHaveLength(3);
    expect(result.clarification.questions[0]).toBe("What authentication mechanism should be used?");
  });

  it("throws when fewer than 2 tickets are produced without clarification", () => {
    const singleTicketHandoff = [
      "# Project Architecture Handoff",
      "",
      "- Task ID: task:test:1:run-001",
      "- Repository: acme/platform",
      "- Architect: Holly (reddwarf-analyst)",
      "- Confidence: medium",
      "- Confidence reason: Simple task.",
      "",
      "## Project Title",
      "",
      "Simple Task",
      "",
      "## Project Summary",
      "",
      "A simple task.",
      "",
      "## Tickets",
      "",
      "### Ticket: The only ticket",
      "",
      "- Complexity: low",
      "- Depends on: none",
      "",
      "#### Description",
      "",
      "Do the thing.",
      "",
      "#### Acceptance Criteria",
      "",
      "- It works"
    ].join("\n");

    expect(() => parseProjectArchitectHandoff(singleTicketHandoff)).toThrow(
      /at least 2 tickets/
    );
  });

  it("throws when a ticket dependency does not match another ticket title", () => {
    const handoff = [
      "# Project Architecture Handoff",
      "",
      "- Confidence: medium",
      "- Confidence reason: Decomposed into dependent tickets.",
      "",
      "## Project Title",
      "",
      "Dependency validation",
      "",
      "## Project Summary",
      "",
      "A project with an invalid dependency reference.",
      "",
      "## Tickets",
      "",
      "### Ticket: First ticket",
      "",
      "- Complexity: low",
      "- Depends on: none",
      "",
      "#### Description",
      "",
      "First.",
      "",
      "#### Acceptance Criteria",
      "",
      "- Works",
      "",
      "### Ticket: Second ticket",
      "",
      "- Complexity: low",
      "- Depends on: Missing ticket",
      "",
      "#### Description",
      "",
      "Second.",
      "",
      "#### Acceptance Criteria",
      "",
      "- Also works"
    ].join("\n");

    expect(() => parseProjectArchitectHandoff(handoff)).toThrow(
      /depends on unknown ticket/
    );
  });

  it("throws when ticket titles are duplicated", () => {
    const handoff = [
      "# Project Architecture Handoff",
      "",
      "- Confidence: medium",
      "- Confidence reason: Decomposed into tickets.",
      "",
      "## Project Title",
      "",
      "Duplicate validation",
      "",
      "## Project Summary",
      "",
      "A project with duplicated ticket titles.",
      "",
      "## Tickets",
      "",
      "### Ticket: Shared title",
      "",
      "- Complexity: low",
      "- Depends on: none",
      "",
      "#### Description",
      "",
      "First.",
      "",
      "#### Acceptance Criteria",
      "",
      "- Works",
      "",
      "### Ticket: Shared title",
      "",
      "- Complexity: low",
      "- Depends on: none",
      "",
      "#### Description",
      "",
      "Second.",
      "",
      "#### Acceptance Criteria",
      "",
      "- Also works"
    ].join("\n");

    expect(() => parseProjectArchitectHandoff(handoff)).toThrow(
      /duplicated/
    );
  });

  it("throws when ticket dependencies contain a cycle", () => {
    const handoff = [
      "# Project Architecture Handoff",
      "",
      "- Confidence: medium",
      "- Confidence reason: Decomposed into cyclic tickets.",
      "",
      "## Project Title",
      "",
      "Cycle validation",
      "",
      "## Project Summary",
      "",
      "A project with a dependency cycle.",
      "",
      "## Tickets",
      "",
      "### Ticket: First ticket",
      "",
      "- Complexity: low",
      "- Depends on: Second ticket",
      "",
      "#### Description",
      "",
      "First.",
      "",
      "#### Acceptance Criteria",
      "",
      "- Works",
      "",
      "### Ticket: Second ticket",
      "",
      "- Complexity: low",
      "- Depends on: First ticket",
      "",
      "#### Description",
      "",
      "Second.",
      "",
      "#### Acceptance Criteria",
      "",
      "- Also works"
    ].join("\n");

    expect(() => parseProjectArchitectHandoff(handoff)).toThrow(
      /dependency cycle/
    );
  });

  it("fuzzy-resolves abbreviated dependency titles to known ticket titles", () => {
    const handoff = [
      "# Project Architecture Handoff",
      "",
      "- Confidence: high",
      "- Confidence reason: Good decomposition.",
      "",
      "## Project Title",
      "",
      "Fuzzy deps",
      "",
      "## Project Summary",
      "",
      "A project testing fuzzy dependency resolution.",
      "",
      "## Tickets",
      "",
      "### Ticket: Scaffold app shell and game registry",
      "",
      "- Complexity: medium",
      "- Depends on: none",
      "",
      "#### Description",
      "",
      "Set up the base project.",
      "",
      "#### Acceptance Criteria",
      "",
      "- App loads",
      "",
      "### Ticket: Implement score entry form with localStorage persistence",
      "",
      "- Complexity: medium",
      "- Depends on: Scaffold app shell and game registry",
      "",
      "#### Description",
      "",
      "Build the score form.",
      "",
      "#### Acceptance Criteria",
      "",
      "- Scores persist",
      "",
      "### Ticket: Build admin data management and export workflows",
      "",
      "- Complexity: low",
      // Abbreviated reference — should fuzzy-match the full title above
      "- Depends on: Implement score entry",
      "",
      "#### Description",
      "",
      "Admin panel.",
      "",
      "#### Acceptance Criteria",
      "",
      "- Export works"
    ].join("\n");

    // Should NOT throw — fuzzy matching should resolve "Implement score entry"
    // to "Implement score entry form with localStorage persistence"
    const result = parseProjectArchitectHandoff(handoff);
    if (result.outcome !== "project_spec") throw new Error("Expected project_spec");
    expect(result.draft.tickets).toHaveLength(3);

    const adminTicket = result.draft.tickets.find(
      (t) => t.title === "Build admin data management and export workflows"
    );
    expect(adminTicket).toBeDefined();
    expect(adminTicket!.dependsOn).toEqual([
      "Implement score entry form with localStorage persistence"
    ]);
  });

  it("parses numbered list clarification questions", () => {
    const handoff = [
      "# Project Architecture Handoff",
      "",
      "- Confidence: low",
      "- Confidence reason: Need more info.",
      "",
      "## Project Title",
      "",
      "## Project Summary",
      "",
      "## Tickets",
      "",
      "## Clarification Needed",
      "",
      "1. What database should be used?",
      "2. Is there an existing auth system?"
    ].join("\n");

    const result = parseProjectArchitectHandoff(handoff);
    expect(result.outcome).toBe("clarification_needed");
    if (result.outcome !== "clarification_needed") throw new Error("Expected clarification_needed");
    expect(result.clarification.questions).toHaveLength(2);
    expect(result.clarification.questions[0]).toBe("What database should be used?");
  });

  it("defaults confidence to medium when absent", () => {
    const handoff = [
      "# Project Architecture Handoff",
      "",
      "## Project Title",
      "",
      "Test Project",
      "",
      "## Project Summary",
      "",
      "A test project.",
      "",
      "## Tickets",
      "",
      "### Ticket: First ticket",
      "",
      "- Complexity: low",
      "- Depends on: none",
      "",
      "#### Description",
      "",
      "First.",
      "",
      "#### Acceptance Criteria",
      "",
      "- Works",
      "",
      "### Ticket: Second ticket",
      "",
      "- Complexity: low",
      "- Depends on: none",
      "",
      "#### Description",
      "",
      "Second.",
      "",
      "#### Acceptance Criteria",
      "",
      "- Also works"
    ].join("\n");

    const result = parseProjectArchitectHandoff(handoff);
    if (result.outcome !== "project_spec") throw new Error("Expected project_spec");
    expect(result.draft.confidence.level).toBe("medium");
  });

  it("produces identical output for single-issue path (baseline unchanged)", () => {
    // The existing parseArchitectHandoffMarkdown function must still work unchanged
    const singleIssueHandoff = [
      "# Architecture Handoff",
      "",
      "- Task ID: task:test:1:run-001",
      "- Repository: acme/platform",
      "- Architect: Holly (reddwarf-analyst)",
      "- Confidence: high",
      "- Confidence reason: Well-scoped task.",
      "",
      "## Summary",
      "",
      "Add a settings button.",
      "",
      "## Implementation Approach",
      "",
      "Create a React component.",
      "",
      "## Affected Files",
      "",
      "- src/settings.tsx",
      "",
      "## Risks and Assumptions",
      "",
      "- None significant",
      "",
      "## Test Strategy",
      "",
      "- Unit test the component",
      "",
      "## Non-Goals",
      "",
      "- No backend changes"
    ].join("\n");

    const draft = parseArchitectHandoffMarkdown(singleIssueHandoff);
    expect(draft.summary).toContain("Add a settings button");
    expect(draft.affectedAreas).toContain("src/settings.tsx");
    expect(draft.confidence.level).toBe("high");
  });
});
