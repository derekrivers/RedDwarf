import { describe, expect, it } from "vitest";
import {
  FixtureOpenClawDispatchAdapter,
  OPENCLAW_BASE_URL_ENV,
  OPENCLAW_HOOK_TOKEN_ENV,
  OPENCLAW_HOOK_TOKEN_SCOPE
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
