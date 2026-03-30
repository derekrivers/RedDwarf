import { afterEach, describe, expect, it, vi } from "vitest";
import { RestGitHubAdapter } from "./github.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeIssueResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 42,
    title: "Plan feature X",
    body: "Body text.",
    state: "open",
    html_url: "https://github.com/acme/platform/issues/42",
    labels: [{ name: "ai-eligible" }],
    assignees: [{ login: "alice" }],
    user: { login: "bob" },
    updated_at: "2026-03-01T00:00:00.000Z",
    created_at: "2026-03-01T00:00:00.000Z",
    milestone: null,
    ...overrides
  };
}

function makeRepoResponse(): Record<string, unknown> {
  return { default_branch: "main" };
}

function makeOkJsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response;
}

function makeErrorResponse(status: number, body = ""): Response {
  return {
    ok: false,
    status,
    json: async () => { throw new Error("not json"); },
    text: async () => body
  } as unknown as Response;
}

// ── readIssueStatus (getIssueStatusSnapshot) ─────────────────────────────────

describe("RestGitHubAdapter.readIssueStatus", () => {
  it("returns a snapshot from a successful API response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeOkJsonResponse(makeIssueResponse()))
      .mockResolvedValueOnce(makeOkJsonResponse(makeRepoResponse()));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new RestGitHubAdapter({ token: "test-token" });
    const snapshot = await adapter.readIssueStatus("acme/platform", 42);

    expect(snapshot.repo).toBe("acme/platform");
    expect(snapshot.issueNumber).toBe(42);
    expect(snapshot.state).toBe("open");
    expect(snapshot.labels).toEqual(["ai-eligible"]);
    expect(snapshot.assignees).toEqual(["alice"]);
    expect(snapshot.defaultBranch).toBe("main");
    expect(snapshot.milestone).toBeNull();
  });

  it("throws on 404 not-found response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeErrorResponse(404, '{"message":"Not Found"}')
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new RestGitHubAdapter({ token: "test-token" });
    await expect(adapter.readIssueStatus("acme/platform", 999)).rejects.toThrow("404");
  });

  it("throws on 401 unauthorized response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeErrorResponse(401, '{"message":"Bad credentials"}')
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new RestGitHubAdapter({ token: "expired-token" });
    await expect(adapter.readIssueStatus("acme/platform", 42)).rejects.toThrow("401");
  });
});

// ── listIssueCandidates ───────────────────────────────────────────────────────

describe("RestGitHubAdapter.listIssueCandidates", () => {
  it("returns candidates from a successful list response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeOkJsonResponse([makeIssueResponse(), makeIssueResponse({ number: 43, title: "Another" })])
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new RestGitHubAdapter({ token: "test-token" });
    const candidates = await adapter.listIssueCandidates({
      repo: "acme/platform",
      states: ["open"],
      limit: 10
    });

    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.issueNumber).toBe(42);
    expect(candidates[0]!.labels).toEqual(["ai-eligible"]);
  });

  it("passes label filter as a query parameter", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkJsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new RestGitHubAdapter({ token: "test-token" });
    await adapter.listIssueCandidates({
      repo: "acme/platform",
      labels: ["ai-eligible", "priority:7"],
      states: ["open"]
    });

    const calledUrl: string = fetchMock.mock.calls[0]?.[0];
    expect(calledUrl).toContain("labels=ai-eligible%2Cpriority%3A7");
  });

  it("throws on 401 unauthorized response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeErrorResponse(401, '{"message":"Bad credentials"}')
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new RestGitHubAdapter({ token: "bad-token" });
    await expect(
      adapter.listIssueCandidates({ repo: "acme/platform" })
    ).rejects.toThrow("401");
  });
});

// ── fetchIssueCandidate ───────────────────────────────────────────────────────

describe("RestGitHubAdapter.fetchIssueCandidate", () => {
  it("returns a candidate from a successful fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeOkJsonResponse(makeIssueResponse({ body: "Body content" }))
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new RestGitHubAdapter({ token: "test-token" });
    const candidate = await adapter.fetchIssueCandidate("acme/platform", 42);

    expect(candidate.issueNumber).toBe(42);
    expect(candidate.body).toBe("Body content");
    expect(candidate.author).toBe("bob");
  });

  it("throws on 404 for a missing issue", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeErrorResponse(404, '{"message":"Not Found"}')
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new RestGitHubAdapter({ token: "test-token" });
    await expect(adapter.fetchIssueCandidate("acme/platform", 9999)).rejects.toThrow("404");
  });
});

// ── Timeout ───────────────────────────────────────────────────────────────────

describe("RestGitHubAdapter timeout handling", () => {
  it("throws a timeout error when fetch times out", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn().mockImplementation((_url, init) =>
      new Promise((_, reject) => {
        const signal = (init as RequestInit).signal;
        signal?.addEventListener("abort", () => reject(signal.reason));
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new RestGitHubAdapter({ token: "test-token", requestTimeoutMs: 50 });
    const pending = adapter.fetchIssueCandidate("acme/platform", 42);
    await vi.advanceTimersByTimeAsync(50);

    await expect(pending).rejects.toThrow(/timed out/i);
  });
});

// ── 429 rate-limit on list issues ────────────────────────────────────────────

describe("RestGitHubAdapter.listIssueCandidates 429 rate limit", () => {
  it("throws immediately on 429 (no built-in retry)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeErrorResponse(429, '{"message":"rate limit exceeded"}')
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new RestGitHubAdapter({ token: "test-token" });
    await expect(
      adapter.listIssueCandidates({ repo: "acme/platform" })
    ).rejects.toThrow("429");

    // RestGitHubAdapter does not retry — single call expected
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
