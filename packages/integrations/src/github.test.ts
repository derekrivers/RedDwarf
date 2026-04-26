import { describe, expect, it } from "vitest";
import { FixtureGitHubAdapter, FixtureGitHubIssuesAdapter, createPlanningInputFromGitHubIssue, formatTicketSpecBody, createGitHubIssuesAdapter } from "./github.js";
import { V1MutationDisabledError } from "./errors.js";
import type { GitHubIssueCandidate } from "./github.js";
import type { TicketSpec } from "@reddwarf/contracts";

const candidate: GitHubIssueCandidate = {
  repo: "acme/platform",
  issueNumber: 42,
  title: "Implement feature X",
  body: [
    "Overview of feature X.",
    "",
    "Acceptance Criteria:",
    "- Feature X is implemented",
    "- Tests pass",
    "",
    "Affected Paths:",
    "- src/feature-x.ts",
    "",
    "Requested Capabilities:",
    "- can_plan",
    "- can_write_code"
  ].join("\n"),
  labels: ["ai-eligible", "priority:60"],
  url: "https://github.com/acme/platform/issues/42",
  state: "open",
  author: "dev",
  baseBranch: "main"
};

describe("createPlanningInputFromGitHubIssue", () => {
  it("parses issue body sections into a planning input", () => {
    const input = createPlanningInputFromGitHubIssue(candidate);
    expect(input.source.issueNumber).toBe(42);
    expect(input.priority).toBe(60);
    expect(input.acceptanceCriteria).toEqual([
      "Feature X is implemented",
      "Tests pass"
    ]);
    expect(input.affectedPaths).toEqual(["src/feature-x.ts"]);
    expect(input.requestedCapabilities).toContain("can_plan");
  });

  it("stamps the playbook id and architect hints on metadata when the resolver matches (Feature 187)", () => {
    const input = createPlanningInputFromGitHubIssue(candidate, {
      playbookResolver: (labels) =>
        labels.includes("ai-eligible")
          ? {
              id: "docs-update",
              name: "Documentation update",
              architectHints: ["Restrict the diff to .md files."]
            }
          : null
    });
    expect(input.metadata).toMatchObject({
      playbook: {
        id: "docs-update",
        name: "Documentation update",
        architectHints: ["Restrict the diff to .md files."]
      }
    });
  });

  it("does not stamp playbook metadata when the resolver returns null", () => {
    const input = createPlanningInputFromGitHubIssue(candidate, {
      playbookResolver: () => null
    });
    expect((input.metadata as Record<string, unknown>)["playbook"]).toBeUndefined();
  });

  it("uses fallback acceptance criteria when body has none", () => {
    const input = createPlanningInputFromGitHubIssue(
      { ...candidate, body: "Simple description." },
      { fallbackAcceptanceCriteria: ["Custom fallback"] }
    );
    expect(input.acceptanceCriteria).toEqual(["Custom fallback"]);
  });

  it("defaults GitHub issue intake to planning, code writing, and evidence archival", () => {
    const input = createPlanningInputFromGitHubIssue({
      ...candidate,
      body: [
        "Overview of feature X.",
        "",
        "Acceptance Criteria:",
        "- Feature X is implemented",
        "- Tests pass",
        "",
        "Affected Paths:",
        "- src/feature-x.ts"
      ].join("\n")
    });

    expect(input.requestedCapabilities).toEqual([
      "can_plan",
      "can_write_code",
      "can_archive_evidence"
    ]);
  });

  it("accepts affected areas from the GitHub issue template", () => {
    const input = createPlanningInputFromGitHubIssue({
      ...candidate,
      body: [
        "Overview of feature X.",
        "",
        "Acceptance Criteria:",
        "- Feature X is implemented",
        "- Tests pass",
        "",
        "Affected Areas:",
        "- src/feature-x.ts",
        "- tests/feature-x.test.ts"
      ].join("\n")
    });

    expect(input.affectedPaths).toEqual([
      "src/feature-x.ts",
      "tests/feature-x.test.ts"
    ]);
  });

  it("parses a Proposed sub-tasks section as a decomposition hint", () => {
    const input = createPlanningInputFromGitHubIssue({
      ...candidate,
      body: [
        "## Goal",
        "",
        "Ship a multi-step refactor.",
        "",
        "## Acceptance Criteria",
        "",
        "- Feature works end-to-end.",
        "",
        "## Proposed sub-tasks",
        "",
        "1. Migrate the schema",
        "2. Update the API layer",
        "- Wire the UI to the new API"
      ].join("\n")
    });

    expect(input.proposedSubTasks).toEqual([
      "Migrate the schema",
      "Update the API layer",
      "Wire the UI to the new API"
    ]);
  });

  it("omits proposedSubTasks when the Proposed sub-tasks section is absent", () => {
    const input = createPlanningInputFromGitHubIssue({
      ...candidate,
      body: [
        "## Goal",
        "",
        "A small self-contained change.",
        "",
        "## Acceptance Criteria",
        "",
        "- Behavior matches spec."
      ].join("\n")
    });

    expect(input.proposedSubTasks).toBeUndefined();
  });

  it("parses markdown sections that include blank lines after headings", () => {
    const input = createPlanningInputFromGitHubIssue({
      ...candidate,
      body: [
        "## Summary",
        "",
        "Build a React to-do list app called Rimmers List.",
        "",
        "## Acceptance Criteria",
        "",
        "- Create `src/main.tsx` as the application entry point.",
        "- Create `src/App.tsx` as the main Rimmers List component.",
        "",
        "## Affected Paths",
        "",
        "- src/main.tsx",
        "- src/App.tsx",
        "- src/styles.css",
        "- tests/app.test.ts"
      ].join("\n")
    });

    expect(input.acceptanceCriteria).toEqual([
      "Create `src/main.tsx` as the application entry point.",
      "Create `src/App.tsx` as the main Rimmers List component."
    ]);
    expect(input.affectedPaths).toEqual([
      "src/main.tsx",
      "src/App.tsx",
      "src/styles.css",
      "tests/app.test.ts"
    ]);
  });

  it("parses comma-separated capabilities on a single bullet line", () => {
    const input = createPlanningInputFromGitHubIssue({
      ...candidate,
      body: [
        "## Summary",
        "",
        "Create a browser game.",
        "",
        "## Acceptance Criteria",
        "",
        "- The game runs in a browser.",
        "",
        "## Requested Capabilities",
        "",
        "- can_plan, can_write_code",
        "- can_run_tests",
        "- can_open_pr"
      ].join("\n")
    });

    expect(input.requestedCapabilities).toEqual([
      "can_plan",
      "can_write_code",
      "can_run_tests",
      "can_open_pr"
    ]);
  });

  it("parses requested capabilities from a fenced markdown body field", () => {
    const input = createPlanningInputFromGitHubIssue({
      ...candidate,
      body: [
        "### Body",
        "",
        "```md",
        "## Summary",
        "",
        "Create a browser-based Pac-Man shell.",
        "",
        "## Acceptance Criteria",
        "",
        "- Render the maze on a canvas.",
        "- Show score and lives HUD.",
        "",
        "## Affected Paths",
        "",
        "- games/pacman/index.html",
        "",
        "## Requested Capabilities",
        "",
        "- can_write_code",
        "- can_run_tests",
        "- can_open_pr",
        "```"
      ].join("\n")
    });

    expect(input.summary).toBe("Create a browser-based Pac-Man shell.");
    expect(input.acceptanceCriteria).toEqual([
      "Render the maze on a canvas.",
      "Show score and lives HUD."
    ]);
    expect(input.affectedPaths).toEqual(["games/pacman/index.html"]);
    expect(input.requestedCapabilities).toEqual([
      "can_write_code",
      "can_run_tests",
      "can_open_pr"
    ]);
  });

  it("parses fenced textarea sections from GitHub issue forms", () => {
    const input = createPlanningInputFromGitHubIssue({
      ...candidate,
      body: [
        "### Summary",
        "",
        "Add rate limiting to the operator API.",
        "",
        "### Acceptance Criteria",
        "",
        "```text",
        "requests above 100/min return 429",
        "authenticated routes keep existing behavior",
        "```",
        "",
        "### Affected Areas",
        "",
        "```text",
        "packages/control-plane/src/**",
        "packages/control-plane/src/index.test.ts",
        "```",
        "",
        "### Requested Capabilities",
        "",
        "```text",
        "can_write_code",
        "can_run_tests",
        "can_open_pr",
        "```"
      ].join("\n")
    });

    expect(input.summary).toBe("Add rate limiting to the operator API.");
    expect(input.acceptanceCriteria).toEqual([
      "requests above 100/min return 429",
      "authenticated routes keep existing behavior"
    ]);
    expect(input.affectedPaths).toEqual([
      "packages/control-plane/src/**",
      "packages/control-plane/src/index.test.ts"
    ]);
    expect(input.requestedCapabilities).toEqual([
      "can_write_code",
      "can_run_tests",
      "can_open_pr"
    ]);
  });

  it("stops affected paths at the next markdown heading", () => {
    const input = createPlanningInputFromGitHubIssue({
      ...candidate,
      body: [
        "## Summary",
        "",
        "Build a React to-do list app called Rimmers List.",
        "",
        "## Acceptance Criteria",
        "",
        "- Create `src/main.tsx` as the application entry point.",
        "",
        "## Affected Paths",
        "",
        "- src/main.tsx",
        "- src/App.tsx",
        "",
        "## Constraints",
        "",
        "- Use React as the frontend framework.",
        "",
        "## Risk Class",
        "",
        "low"
      ].join("\n")
    });

    expect(input.affectedPaths).toEqual(["src/main.tsx", "src/App.tsx"]);
  });

  it("builds summary text from narrative sections without appending later headings", () => {
    const input = createPlanningInputFromGitHubIssue({
      ...candidate,
      body: [
        "## Summary",
        "",
        "Build a React to-do list app called Rimmers List.",
        "",
        "## Why",
        "",
        "We want a simple but realistic end-to-end feature to validate the pipeline.",
        "",
        "## Desired Outcome",
        "",
        "A user can manage tasks in a Bootstrap-styled React interface.",
        "",
        "## Acceptance Criteria",
        "",
        "- Create `src/main.tsx` as the application entry point.",
        "",
        "## Risk Class",
        "",
        "low"
      ].join("\n")
    });

    expect(input.summary).toBe(
      "Build a React to-do list app called Rimmers List. We want a simple but realistic end-to-end feature to validate the pipeline. A user can manage tasks in a Bootstrap-styled React interface."
    );
  });
});

describe("FixtureGitHubAdapter", () => {
  it("fetches a registered issue candidate", async () => {
    const adapter = new FixtureGitHubAdapter({ candidates: [candidate] });
    const result = await adapter.fetchIssueCandidate("acme/platform", 42);
    expect(result.title).toBe("Implement feature X");
  });

  it("throws for an unknown issue", async () => {
    const adapter = new FixtureGitHubAdapter({ candidates: [] });
    await expect(adapter.fetchIssueCandidate("acme/platform", 99)).rejects.toThrow();
  });

  it("throws V1MutationDisabledError for mutation operations by default", async () => {
    const adapter = new FixtureGitHubAdapter({ candidates: [candidate] });

    await expect(
      adapter.createIssue({ repo: "acme/platform", title: "New", body: "Body" })
    ).rejects.toBeInstanceOf(V1MutationDisabledError);

    await expect(
      adapter.createBranch("acme/platform", "main", "feature/test")
    ).rejects.toBeInstanceOf(V1MutationDisabledError);
  });

  it("lists candidates filtered by label", async () => {
    const adapter = new FixtureGitHubAdapter({ candidates: [candidate] });
    const found = await adapter.listIssueCandidates({
      repo: "acme/platform",
      labels: ["ai-eligible"]
    });
    expect(found).toHaveLength(1);

    const notFound = await adapter.listIssueCandidates({
      repo: "acme/platform",
      labels: ["non-existent-label"]
    });
    expect(notFound).toHaveLength(0);
  });
});

// ── GitHub Issues Adapter (Feature 144) ──────────────────────────────────────

const sampleTicketSpec: TicketSpec = {
  ticketId: "ticket-001",
  projectId: "project-001",
  title: "Add user authentication",
  description: "Implement JWT-based authentication for the operator API.",
  acceptanceCriteria: [
    "POST /auth/login returns a JWT token",
    "Unauthenticated requests return 401",
    "Token expiry is configurable"
  ],
  dependsOn: [],
  status: "pending",
  complexityClass: "low",
  riskClass: "low",
  githubSubIssueNumber: null,
  githubPrNumber: null,
  requiredCheckContract: null,
  createdAt: "2026-04-06T00:00:00.000Z",
  updatedAt: "2026-04-06T00:00:00.000Z"
};

const ticketWithDependencies: TicketSpec = {
  ...sampleTicketSpec,
  ticketId: "ticket-002",
  title: "Add role-based access control",
  description: "Implement RBAC on top of JWT auth.",
  acceptanceCriteria: [
    "Admin role can access all endpoints",
    "Viewer role is read-only"
  ],
  dependsOn: ["ticket-001"]
};

describe("formatTicketSpecBody", () => {
  it("formats ticket spec as markdown with acceptance criteria checklist", () => {
    const body = formatTicketSpecBody(sampleTicketSpec, 10);
    expect(body).toContain("Parent issue: #10");
    expect(body).toContain("## Acceptance Criteria");
    expect(body).toContain("- [ ] POST /auth/login returns a JWT token");
    expect(body).toContain("- [ ] Unauthenticated requests return 401");
    expect(body).toContain("- [ ] Token expiry is configurable");
    expect(body).not.toContain("## Dependencies");
  });

  it("includes dependencies section when ticket has depends_on entries", () => {
    const body = formatTicketSpecBody(ticketWithDependencies, 10);
    expect(body).toContain("## Dependencies");
    expect(body).toContain("- ticket-001");
  });
});

describe("FixtureGitHubIssuesAdapter", () => {
  it("creates a sub-issue and returns an issue number", async () => {
    const adapter = new FixtureGitHubIssuesAdapter({ repo: "acme/platform" });
    const issueNumber = await adapter.createSubIssue(10, sampleTicketSpec);
    expect(issueNumber).toBeGreaterThanOrEqual(2_000);

    const created = adapter.getCreatedSubIssues().get(issueNumber);
    expect(created).toBeDefined();
    expect(created!.parentIssueNumber).toBe(10);
    expect(created!.ticketSpec.ticketId).toBe("ticket-001");
    expect(created!.body).toContain("- [ ] POST /auth/login returns a JWT token");
  });

  it("honors a per-operation repo override", async () => {
    const adapter = new FixtureGitHubIssuesAdapter({ repo: "acme/platform" });
    const issueNumber = await adapter.createSubIssue(
      10,
      sampleTicketSpec,
      "acme/other-platform"
    );

    const created = adapter.getCreatedSubIssues().get(issueNumber);
    expect(created?.repo).toBe("acme/other-platform");
    await expect(adapter.getIssue(issueNumber, "acme/other-platform")).resolves.toMatchObject({
      repo: "acme/other-platform"
    });
  });

  it("closes an issue", async () => {
    const adapter = new FixtureGitHubIssuesAdapter({ repo: "acme/platform" });
    const issueNumber = await adapter.createSubIssue(10, sampleTicketSpec);
    await adapter.closeIssue(issueNumber);
    expect(adapter.getClosedIssues().has(issueNumber)).toBe(true);
  });

  it("getIssue returns closed state for closed issues", async () => {
    const adapter = new FixtureGitHubIssuesAdapter({ repo: "acme/platform" });
    const issueNumber = await adapter.createSubIssue(10, sampleTicketSpec);

    const openStatus = await adapter.getIssue(issueNumber);
    expect(openStatus.state).toBe("open");

    await adapter.closeIssue(issueNumber);
    const closedStatus = await adapter.getIssue(issueNumber);
    expect(closedStatus.state).toBe("closed");
  });

  it("throws V1MutationDisabledError when disabled", async () => {
    const adapter = new FixtureGitHubIssuesAdapter({ repo: "acme/platform", enabled: false });
    await expect(adapter.createSubIssue(10, sampleTicketSpec)).rejects.toBeInstanceOf(V1MutationDisabledError);
    await expect(adapter.closeIssue(100)).rejects.toBeInstanceOf(V1MutationDisabledError);
  });

  it("getIssue works even when adapter is disabled", async () => {
    const adapter = new FixtureGitHubIssuesAdapter({ repo: "acme/platform", enabled: false });
    const status = await adapter.getIssue(42);
    expect(status.repo).toBe("acme/platform");
    expect(status.issueNumber).toBe(42);
  });
});

describe("createGitHubIssuesAdapter", () => {
  it("throws V1MutationDisabledError when REDDWARF_GITHUB_ISSUES_ENABLED is not true", () => {
    const original = process.env["REDDWARF_GITHUB_ISSUES_ENABLED"];
    try {
      delete process.env["REDDWARF_GITHUB_ISSUES_ENABLED"];
      expect(() => createGitHubIssuesAdapter()).toThrow(V1MutationDisabledError);

      process.env["REDDWARF_GITHUB_ISSUES_ENABLED"] = "false";
      expect(() => createGitHubIssuesAdapter()).toThrow(V1MutationDisabledError);
    } finally {
      if (original !== undefined) {
        process.env["REDDWARF_GITHUB_ISSUES_ENABLED"] = original;
      } else {
        delete process.env["REDDWARF_GITHUB_ISSUES_ENABLED"];
      }
    }
  });

  it("throws when GITHUB_TOKEN is missing", () => {
    const origEnabled = process.env["REDDWARF_GITHUB_ISSUES_ENABLED"];
    const origToken = process.env["GITHUB_TOKEN"];
    try {
      process.env["REDDWARF_GITHUB_ISSUES_ENABLED"] = "true";
      delete process.env["GITHUB_TOKEN"];
      expect(() => createGitHubIssuesAdapter()).toThrow("GITHUB_TOKEN");
    } finally {
      if (origEnabled !== undefined) process.env["REDDWARF_GITHUB_ISSUES_ENABLED"] = origEnabled;
      else delete process.env["REDDWARF_GITHUB_ISSUES_ENABLED"];
      if (origToken !== undefined) process.env["GITHUB_TOKEN"] = origToken;
      else delete process.env["GITHUB_TOKEN"];
    }
  });

  it("does not require GITHUB_REPO until an operation lacks a repo override", async () => {
    const origEnabled = process.env["REDDWARF_GITHUB_ISSUES_ENABLED"];
    const origToken = process.env["GITHUB_TOKEN"];
    const origRepo = process.env["GITHUB_REPO"];
    try {
      process.env["REDDWARF_GITHUB_ISSUES_ENABLED"] = "true";
      process.env["GITHUB_TOKEN"] = "ghp_test";
      delete process.env["GITHUB_REPO"];
      const adapter = createGitHubIssuesAdapter();
      await expect(adapter.createSubIssue(10, sampleTicketSpec)).rejects.toThrow(
        "requires a repo"
      );
    } finally {
      if (origEnabled !== undefined) process.env["REDDWARF_GITHUB_ISSUES_ENABLED"] = origEnabled;
      else delete process.env["REDDWARF_GITHUB_ISSUES_ENABLED"];
      if (origToken !== undefined) process.env["GITHUB_TOKEN"] = origToken;
      else delete process.env["GITHUB_TOKEN"];
      if (origRepo !== undefined) process.env["GITHUB_REPO"] = origRepo;
      else delete process.env["GITHUB_REPO"];
    }
  });
});
