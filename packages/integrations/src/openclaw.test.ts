import { describe, expect, it, vi, afterEach } from "vitest";
import {
  AcpxOpenClawDispatchAdapter,
  FixtureOpenClawDispatchAdapter,
  HttpOpenClawDispatchAdapter,
  OPENCLAW_BASE_URL_ENV,
  OPENCLAW_HOOK_TOKEN_ENV,
  OPENCLAW_HOOK_TOKEN_SCOPE,
  sanitizeUserContent,
  enforcePromptLengthCap
} from "./openclaw.js";
import type { OpenClawDispatchRequest } from "./openclaw.js";

const request: OpenClawDispatchRequest = {
  sessionKey: "github:issue:acme/repo:42",
  agentId: "reddwarf-analyst",
  prompt: "Analyse this task."
};

describe("FixtureOpenClawDispatchAdapter", () => {
  it("accepts and records a dispatch", async () => {
    const adapter = new FixtureOpenClawDispatchAdapter();
    const result = await adapter.dispatch(request);
    expect(result.accepted).toBe(true);
    expect(result.sessionKey).toBe(request.sessionKey);
    expect(adapter.dispatches).toHaveLength(1);
  });

  it("rejects dispatches when rejectAll is true", async () => {
    const adapter = new FixtureOpenClawDispatchAdapter({ rejectAll: true });
    const result = await adapter.dispatch(request);
    expect(result.accepted).toBe(false);
    expect(result.sessionId).toBeNull();
  });

  it("returns a custom fixedSessionId", async () => {
    const adapter = new FixtureOpenClawDispatchAdapter({ fixedSessionId: "my-session" });
    const result = await adapter.dispatch(request);
    expect(result.sessionId).toBe("my-session");
  });
});

describe("OpenClaw constants", () => {
  it("exports well-known constant values", () => {
    expect(OPENCLAW_HOOK_TOKEN_SCOPE).toBe("openclaw");
    expect(OPENCLAW_HOOK_TOKEN_ENV).toBe("OPENCLAW_HOOK_TOKEN");
    expect(OPENCLAW_BASE_URL_ENV).toBe("OPENCLAW_BASE_URL");
  });
});

// ── HttpOpenClawDispatchAdapter ───────────────────────────────────────────────

function makeMockFetch(
  status: number,
  body: string,
  ok = status >= 200 && status < 300
): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    text: () => Promise.resolve(body)
  } as unknown as Response);
}

describe("HttpOpenClawDispatchAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when constructed without a base URL", () => {
    expect(
      () => new HttpOpenClawDispatchAdapter({ hookToken: "tok" })
    ).toThrow("base URL");
  });

  it("throws when constructed without a hook token", () => {
    expect(
      () => new HttpOpenClawDispatchAdapter({ baseUrl: "http://localhost:3578" })
    ).toThrow("hook token");
  });

  it("returns a successful dispatch result with sessionId from JSON response", async () => {
    const mockFetch = makeMockFetch(200, JSON.stringify({ sessionId: "sess-abc", message: "ok" }));
    vi.stubGlobal("fetch", mockFetch);

    const adapter = new HttpOpenClawDispatchAdapter({
      baseUrl: "http://localhost:3578",
      hookToken: "test-token",
      maxAttempts: 1,
      baseDelayMs: 0
    });

    const result = await adapter.dispatch(request);

    expect(result.accepted).toBe(true);
    expect(result.sessionKey).toBe(request.sessionKey);
    expect(result.sessionId).toBe("sess-abc");
    expect(result.statusMessage).toBe("ok");
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("returns null sessionId and null statusMessage for an empty JSON response body", async () => {
    vi.stubGlobal("fetch", makeMockFetch(200, ""));

    const adapter = new HttpOpenClawDispatchAdapter({
      baseUrl: "http://localhost:3578",
      hookToken: "test-token",
      maxAttempts: 1,
      baseDelayMs: 0
    });

    const result = await adapter.dispatch(request);
    expect(result.accepted).toBe(true);
    expect(result.sessionId).toBeNull();
    expect(result.statusMessage).toBeNull();
  });

  it("throws a descriptive error when the response body is non-JSON", async () => {
    vi.stubGlobal("fetch", makeMockFetch(200, "<html>Bad Gateway</html>"));

    const adapter = new HttpOpenClawDispatchAdapter({
      baseUrl: "http://localhost:3578",
      hookToken: "test-token",
      maxAttempts: 1,
      baseDelayMs: 0
    });

    await expect(adapter.dispatch(request)).rejects.toThrow("non-JSON response");
  });

  it("throws immediately for a non-retryable 4xx error", async () => {
    vi.stubGlobal("fetch", makeMockFetch(401, "Unauthorized", false));

    const adapter = new HttpOpenClawDispatchAdapter({
      baseUrl: "http://localhost:3578",
      hookToken: "bad-token",
      maxAttempts: 3,
      baseDelayMs: 0
    });

    await expect(adapter.dispatch(request)).rejects.toThrow("401");
  });

  it("retries on a 429 response and throws after max attempts", async () => {
    const mockFetch = makeMockFetch(429, "Too Many Requests", false);
    vi.stubGlobal("fetch", mockFetch);

    const adapter = new HttpOpenClawDispatchAdapter({
      baseUrl: "http://localhost:3578",
      hookToken: "test-token",
      maxAttempts: 3,
      baseDelayMs: 0
    });

    await expect(adapter.dispatch(request)).rejects.toThrow("429");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("succeeds on the second attempt after a 429 retry", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ ok: false, status: 429, text: () => Promise.resolve("retry") } as unknown as Response);
      }
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ sessionId: "s-retry" })) } as unknown as Response);
    });
    vi.stubGlobal("fetch", mockFetch);

    const adapter = new HttpOpenClawDispatchAdapter({
      baseUrl: "http://localhost:3578",
      hookToken: "test-token",
      maxAttempts: 3,
      baseDelayMs: 0
    });

    const result = await adapter.dispatch(request);
    expect(result.accepted).toBe(true);
    expect(result.sessionId).toBe("s-retry");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("sends the correct Authorization header and request shape", async () => {
    const mockFetch = makeMockFetch(200, JSON.stringify({ sessionId: "s1" }));
    vi.stubGlobal("fetch", mockFetch);

    const adapter = new HttpOpenClawDispatchAdapter({
      baseUrl: "http://localhost:3578/",
      hookToken: "my-hook-token",
      maxAttempts: 1,
      baseDelayMs: 0
    });

    await adapter.dispatch({ ...request, metadata: { taskId: "t1" } });

    const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3578/hooks/agent");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer my-hook-token");
    const parsed = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(parsed["agentId"]).toBe(request.agentId);
    expect(parsed["sessionKey"]).toBe(request.sessionKey);
    expect(parsed["deliver"]).toBe(false);
    expect((parsed["metadata"] as Record<string, unknown>)["taskId"]).toBe("t1");
  });

  it("passes deliver: true when set in the request", async () => {
    const mockFetch = makeMockFetch(200, JSON.stringify({ sessionId: "s1" }));
    vi.stubGlobal("fetch", mockFetch);

    const adapter = new HttpOpenClawDispatchAdapter({
      baseUrl: "http://localhost:3578",
      hookToken: "tok",
      maxAttempts: 1,
      baseDelayMs: 0
    });

    await adapter.dispatch({ ...request, deliver: true });

    const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(parsed["deliver"]).toBe(true);
  });
});

// ── AcpxOpenClawDispatchAdapter ─────────────────────────────────────────────

describe("AcpxOpenClawDispatchAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when constructed without a base URL", () => {
    expect(
      () => new AcpxOpenClawDispatchAdapter({ hookToken: "tok" })
    ).toThrow("base URL");
  });

  it("throws when constructed without a hook token", () => {
    expect(
      () => new AcpxOpenClawDispatchAdapter({ baseUrl: "http://localhost:3578" })
    ).toThrow("hook token");
  });

  it("returns a successful dispatch result", async () => {
    const body = JSON.stringify({ sessionId: "acpx-sess-1" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ sessionId: "acpx-sess-1" }),
      text: () => Promise.resolve(body)
    } as unknown as Response));

    const adapter = new AcpxOpenClawDispatchAdapter({
      baseUrl: "http://localhost:3578",
      hookToken: "test-token",
      maxAttempts: 1,
      baseDelayMs: 0
    });

    const result = await adapter.dispatch(request);
    expect(result.accepted).toBe(true);
    expect(result.sessionId).toBe("acpx-sess-1");
  });

  it("retries on 429 and succeeds on the second attempt", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ ok: false, status: 429, text: () => Promise.resolve("retry") } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ sessionId: "acpx-retry" }),
        text: () => Promise.resolve(JSON.stringify({ sessionId: "acpx-retry" }))
      } as unknown as Response);
    });
    vi.stubGlobal("fetch", mockFetch);

    const adapter = new AcpxOpenClawDispatchAdapter({
      baseUrl: "http://localhost:3578",
      hookToken: "tok",
      maxAttempts: 3,
      baseDelayMs: 0
    });

    const result = await adapter.dispatch(request);
    expect(result.accepted).toBe(true);
    expect(result.sessionId).toBe("acpx-retry");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting retry attempts on 429", async () => {
    const mockFetch = makeMockFetch(429, "Too Many Requests", false);
    vi.stubGlobal("fetch", mockFetch);

    const adapter = new AcpxOpenClawDispatchAdapter({
      baseUrl: "http://localhost:3578",
      hookToken: "tok",
      maxAttempts: 2,
      baseDelayMs: 0
    });

    await expect(adapter.dispatch(request)).rejects.toThrow("429");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws immediately for a 404 version mismatch (not retryable)", async () => {
    const mockFetch = makeMockFetch(404, "Not Found", false);
    vi.stubGlobal("fetch", mockFetch);

    const adapter = new AcpxOpenClawDispatchAdapter({
      baseUrl: "http://localhost:3578",
      hookToken: "tok",
      maxAttempts: 3,
      baseDelayMs: 0
    });

    await expect(adapter.dispatch(request)).rejects.toThrow("404");
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("posts to /acpx/sessions with the correct payload shape", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ sessionId: "acpx-1" })
    } as unknown as Response);
    vi.stubGlobal("fetch", mockFetch);

    const adapter = new AcpxOpenClawDispatchAdapter({
      baseUrl: "http://localhost:3578",
      hookToken: "my-acpx-token",
      maxAttempts: 1
    });

    await adapter.dispatch({ ...request, metadata: { runId: "r-1" } });

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3578/acpx/sessions");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer my-acpx-token");
    const parsed = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(parsed["prompt"]).toBeDefined();
    expect(parsed["sessionKey"]).toBe(request.sessionKey);
    expect(parsed["agentId"]).toBe(request.agentId);
    expect((parsed["metadata"] as Record<string, unknown>)["runId"]).toBe("r-1");
  });
});

// ── Prompt sanitization and length cap ──────────────────────────────────────

describe("sanitizeUserContent", () => {
  it("strips null bytes and control characters", () => {
    expect(sanitizeUserContent("hello\x00world\x07")).toBe("helloworld");
  });

  it("preserves tabs, newlines, and carriage returns", () => {
    expect(sanitizeUserContent("line1\nline2\ttab\rend")).toBe("line1\nline2\ttab\rend");
  });

  it("strips C1 control characters", () => {
    expect(sanitizeUserContent("test\x80\x9Fend")).toBe("testend");
  });
});

describe("enforcePromptLengthCap", () => {
  it("returns the prompt unchanged when under the cap", () => {
    expect(enforcePromptLengthCap("short prompt", 1000)).toBe("short prompt");
  });

  it("truncates and appends a marker when exceeding the cap", () => {
    const result = enforcePromptLengthCap("x".repeat(200), 100);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result).toContain("[... prompt truncated");
  });
});
