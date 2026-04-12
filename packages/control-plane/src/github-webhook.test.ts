import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  handleGitHubWebhook,
  readRawBody,
  verifyGitHubSignature,
  resolvePollMode,
  shouldStartPolling,
  describeIntakeMode,
  extractTicketId,
  type WebhookHandlerDependencies
} from "./github-webhook.js";
import { InMemoryPlanningRepository, createGitHubIssuePollingCursor } from "@reddwarf/evidence";
import { FixtureGitHubAdapter } from "@reddwarf/integrations";
import { DeterministicPlanningAgent } from "@reddwarf/control-plane";

// ============================================================
// Test helpers
// ============================================================

const TEST_SECRET = "test-webhook-secret-for-unit-tests";

function sign(body: string | Buffer, secret = TEST_SECRET): string {
  const hmac = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${hmac}`;
}

function makeIssuePayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    issue: {
      number: 42,
      title: "Add widget support",
      body: "## Summary\n\nAdd widget support to the dashboard.\n\n## Acceptance Criteria\n\n- Widget renders correctly",
      html_url: "https://github.com/acme/platform/issues/42",
      state: "open",
      user: { login: "testuser" },
      labels: [{ name: "ai-eligible" }],
      updated_at: "2026-04-12T10:00:00Z"
    },
    repository: {
      full_name: "acme/platform",
      default_branch: "main"
    },
    ...overrides
  };
}

function makeRawBody(payload: unknown): Buffer {
  return Buffer.from(JSON.stringify(payload), "utf-8");
}

async function createTestDeps(
  options: { trackRepo?: boolean; existingSpec?: boolean } = {}
): Promise<WebhookHandlerDependencies> {
  const repository = new InMemoryPlanningRepository();

  if (options.trackRepo !== false) {
    await repository.saveGitHubIssuePollingCursor(
      createGitHubIssuePollingCursor({
        repo: "acme/platform",
        updatedAt: "2026-04-12T09:00:00.000Z"
      })
    );
  }

  const github = new FixtureGitHubAdapter({
    candidates: [
      {
        repo: "acme/platform",
        issueNumber: 42,
        title: "Add widget support",
        body: "## Summary\n\nAdd widget support to the dashboard.\n\n## Acceptance Criteria\n\n- Widget renders correctly",
        labels: ["ai-eligible"],
        url: "https://github.com/acme/platform/issues/42",
        state: "open",
        author: "testuser"
      }
    ]
  });

  return {
    repository,
    github,
    planner: new DeterministicPlanningAgent(),
    clock: () => new Date("2026-04-12T10:00:00.000Z"),
    dryRun: false
  };
}

// ============================================================
// HMAC verification
// ============================================================

describe("verifyGitHubSignature", () => {
  it("returns true for a valid HMAC-SHA256 signature", () => {
    const body = Buffer.from('{"test": true}');
    const signature = sign(body);
    expect(verifyGitHubSignature(body, signature, TEST_SECRET)).toBe(true);
  });

  it("returns false for an invalid signature", () => {
    const body = Buffer.from('{"test": true}');
    expect(verifyGitHubSignature(body, "sha256=deadbeef", TEST_SECRET)).toBe(false);
  });

  it("returns false for a missing signature header", () => {
    const body = Buffer.from('{"test": true}');
    expect(verifyGitHubSignature(body, undefined, TEST_SECRET)).toBe(false);
  });

  it("returns false for a signature without sha256= prefix", () => {
    const body = Buffer.from('{"test": true}');
    const hmac = createHmac("sha256", TEST_SECRET).update(body).digest("hex");
    expect(verifyGitHubSignature(body, hmac, TEST_SECRET)).toBe(false);
  });
});

// ============================================================
// Poll mode helpers
// ============================================================

describe("poll mode helpers", () => {
  it("resolvePollMode defaults to auto", () => {
    const original = process.env.REDDWARF_POLL_MODE;
    delete process.env.REDDWARF_POLL_MODE;
    expect(resolvePollMode()).toBe("auto");
    if (original !== undefined) {
      process.env.REDDWARF_POLL_MODE = original;
    }
  });

  it("shouldStartPolling returns false for never mode", () => {
    expect(shouldStartPolling("never", false)).toBe(false);
    expect(shouldStartPolling("never", true)).toBe(false);
  });

  it("shouldStartPolling returns true for always mode", () => {
    expect(shouldStartPolling("always", false)).toBe(true);
    expect(shouldStartPolling("always", true)).toBe(true);
  });

  it("shouldStartPolling auto mode disables polling when webhook is set", () => {
    expect(shouldStartPolling("auto", true)).toBe(false);
    expect(shouldStartPolling("auto", false)).toBe(true);
  });

  it("describeIntakeMode returns correct mode labels", () => {
    expect(describeIntakeMode("auto", false)).toBe("polling");
    expect(describeIntakeMode("auto", true)).toBe("webhook");
    expect(describeIntakeMode("always", false)).toBe("polling");
    expect(describeIntakeMode("always", true)).toBe("webhook+polling");
    expect(describeIntakeMode("never", false)).toBe("disabled");
    expect(describeIntakeMode("never", true)).toBe("webhook");
  });
});

// ============================================================
// Webhook handler
// ============================================================

describe("handleGitHubWebhook", () => {
  it("rejects requests with an invalid HMAC signature", async () => {
    const deps = await createTestDeps();
    const payload = makeIssuePayload();
    const rawBody = makeRawBody(payload);

    const result = await handleGitHubWebhook(
      rawBody,
      "sha256=invalid",
      "issues",
      TEST_SECRET,
      deps
    );

    expect(result.status).toBe(401);
    expect(result.body.error).toBe("unauthorized");
  });

  it("rejects requests with a missing signature header", async () => {
    const deps = await createTestDeps();
    const payload = makeIssuePayload();
    const rawBody = makeRawBody(payload);

    const result = await handleGitHubWebhook(
      rawBody,
      undefined,
      "issues",
      TEST_SECRET,
      deps
    );

    expect(result.status).toBe(401);
    expect(result.body.error).toBe("unauthorized");
  });

  it("responds 200 to a ping event", async () => {
    const deps = await createTestDeps();
    const rawBody = Buffer.from("{}");
    const signature = sign(rawBody);

    const result = await handleGitHubWebhook(
      rawBody,
      signature,
      "ping",
      TEST_SECRET,
      deps
    );

    expect(result.status).toBe(200);
    expect(result.body.event).toBe("ping");
  });

  it("responds 200 and ignores unrecognised event types", async () => {
    const deps = await createTestDeps();
    const rawBody = Buffer.from("{}");
    const signature = sign(rawBody);

    const result = await handleGitHubWebhook(
      rawBody,
      signature,
      "push",
      TEST_SECRET,
      deps
    );

    expect(result.status).toBe(200);
    expect(result.body.message).toBe("Event type ignored.");
  });

  it("accepts a valid issues opened event and dispatches to the intake pipeline", async () => {
    const deps = await createTestDeps();
    const payload = makeIssuePayload();
    const rawBody = makeRawBody(payload);
    const signature = sign(rawBody);

    const result = await handleGitHubWebhook(
      rawBody,
      signature,
      "issues",
      TEST_SECRET,
      deps
    );

    expect(result.status).toBe(202);
    expect(result.body.event).toBe("issues");
    expect(result.body.action).toBe("opened");
    expect(result.body.repo).toBe("acme/platform");
    expect(result.body.issueNumber).toBe(42);
    expect(result.body.message).toBe("Issue accepted for processing.");
  });

  it("ignores issues events that are not opened", async () => {
    const deps = await createTestDeps();
    const payload = makeIssuePayload({ action: "closed" });
    const rawBody = makeRawBody(payload);
    const signature = sign(rawBody);

    const result = await handleGitHubWebhook(
      rawBody,
      signature,
      "issues",
      TEST_SECRET,
      deps
    );

    expect(result.status).toBe(200);
    expect(result.body.action).toBe("closed");
    expect(result.body.message).toBe("Only 'opened' actions are processed.");
  });

  it("ignores issues from untracked repositories", async () => {
    const deps = await createTestDeps({ trackRepo: false });
    const payload = makeIssuePayload();
    const rawBody = makeRawBody(payload);
    const signature = sign(rawBody);

    const result = await handleGitHubWebhook(
      rawBody,
      signature,
      "issues",
      TEST_SECRET,
      deps
    );

    expect(result.status).toBe(200);
    expect(result.body.message).toBe("Repository is not tracked. Issue ignored.");
  });

  it("ignores issues without the ai-eligible label", async () => {
    const deps = await createTestDeps();
    const payload = makeIssuePayload({
      issue: {
        ...makeIssuePayload().issue,
        labels: [{ name: "bug" }]
      }
    });
    const rawBody = makeRawBody(payload);
    const signature = sign(rawBody);

    const result = await handleGitHubWebhook(
      rawBody,
      signature,
      "issues",
      TEST_SECRET,
      deps
    );

    expect(result.status).toBe(200);
    expect(result.body.message).toBe("Issue does not have ai-eligible label. Ignored.");
  });
});

// ============================================================
// extractTicketId
// ============================================================

describe("extractTicketId", () => {
  it("extracts ticket_id from branch name", () => {
    expect(extractTicketId("reddwarf/ticket/abc-123", null)).toBe("abc-123");
  });

  it("extracts ticket_id from branch with nested path", () => {
    expect(extractTicketId("reddwarf/ticket/proj:ticket:5", null)).toBe("proj:ticket:5");
  });

  it("falls back to PR body comment", () => {
    expect(
      extractTicketId("feature/unrelated", "Some text\n<!-- reddwarf:ticket_id:xyz-789 -->\nMore text")
    ).toBe("xyz-789");
  });

  it("prefers branch name over PR body", () => {
    expect(
      extractTicketId("reddwarf/ticket/from-branch", "<!-- reddwarf:ticket_id:from-body -->")
    ).toBe("from-branch");
  });

  it("returns null when no ticket reference is found", () => {
    expect(extractTicketId("feature/some-branch", "No ticket reference here")).toBeNull();
  });

  it("returns null for empty branch and null body", () => {
    expect(extractTicketId("main", null)).toBeNull();
  });

  it("rejects ticket_id with invalid characters", () => {
    expect(extractTicketId("reddwarf/ticket/bad id spaces", null)).toBeNull();
  });
});

// ============================================================
// PR merge webhook handling
// ============================================================

function makePrPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "closed",
    pull_request: {
      number: 99,
      merged: true,
      head: { ref: "reddwarf/ticket/test-ticket-1" },
      body: "Implements test ticket 1",
      html_url: "https://github.com/acme/platform/pull/99"
    },
    repository: {
      full_name: "acme/platform"
    },
    ...overrides
  };
}

describe("handleGitHubWebhook — pull_request events", () => {
  it("ignores non-closed pull_request events", async () => {
    const deps = await createTestDeps();
    const payload = makePrPayload({ action: "opened" });
    const rawBody = makeRawBody(payload);
    const signature = sign(rawBody);

    const result = await handleGitHubWebhook(
      rawBody,
      signature,
      "pull_request",
      TEST_SECRET,
      deps
    );

    expect(result.status).toBe(200);
    expect(result.body.message).toBe("Only closed+merged pull requests are processed.");
  });

  it("ignores closed but not merged pull_request events", async () => {
    const deps = await createTestDeps();
    const payload = makePrPayload({
      pull_request: {
        ...makePrPayload().pull_request,
        merged: false
      }
    });
    const rawBody = makeRawBody(payload);
    const signature = sign(rawBody);

    const result = await handleGitHubWebhook(
      rawBody,
      signature,
      "pull_request",
      TEST_SECRET,
      deps
    );

    expect(result.status).toBe(200);
    expect(result.body.message).toBe("Only closed+merged pull requests are processed.");
  });

  it("ignores merged PRs with no ticket reference", async () => {
    const deps = await createTestDeps();
    const payload = makePrPayload({
      pull_request: {
        ...makePrPayload().pull_request,
        head: { ref: "feature/unrelated-work" },
        body: "Just a regular PR"
      }
    });
    const rawBody = makeRawBody(payload);
    const signature = sign(rawBody);

    const result = await handleGitHubWebhook(
      rawBody,
      signature,
      "pull_request",
      TEST_SECRET,
      deps
    );

    expect(result.status).toBe(200);
    expect(result.body.message).toBe("No ticket reference found in branch name or PR body. Ignored.");
  });

  it("accepts a merged PR with a ticket reference and returns 202", async () => {
    const deps = await createTestDeps();
    const payload = makePrPayload();
    const rawBody = makeRawBody(payload);
    const signature = sign(rawBody);

    const result = await handleGitHubWebhook(
      rawBody,
      signature,
      "pull_request",
      TEST_SECRET,
      deps
    );

    // The handler responds 202 immediately; advanceProjectTicket runs async
    // and will fail (no ticket in repo) but that doesn't affect the response.
    expect(result.status).toBe(202);
    expect(result.body.event).toBe("pull_request");
    expect(result.body.ticketId).toBe("test-ticket-1");
    expect(result.body.prNumber).toBe(99);
    expect(result.body.message).toBe("Merged PR accepted for ticket advancement.");
  });

  it("extracts ticket_id from PR body when branch doesn't match", async () => {
    const deps = await createTestDeps();
    const payload = makePrPayload({
      pull_request: {
        ...makePrPayload().pull_request,
        head: { ref: "feature/custom-branch" },
        body: "Some text\n<!-- reddwarf:ticket_id:body-ticket-42 -->\nMore text"
      }
    });
    const rawBody = makeRawBody(payload);
    const signature = sign(rawBody);

    const result = await handleGitHubWebhook(
      rawBody,
      signature,
      "pull_request",
      TEST_SECRET,
      deps
    );

    expect(result.status).toBe(202);
    expect(result.body.ticketId).toBe("body-ticket-42");
  });

  it("returns 400 for malformed pull_request payload", async () => {
    const deps = await createTestDeps();
    const payload = { action: "closed", not_a_pr: true };
    const rawBody = makeRawBody(payload);
    const signature = sign(rawBody);

    const result = await handleGitHubWebhook(
      rawBody,
      signature,
      "pull_request",
      TEST_SECRET,
      deps
    );

    expect(result.status).toBe(400);
    expect(result.body.error).toBe("bad_request");
  });
});
