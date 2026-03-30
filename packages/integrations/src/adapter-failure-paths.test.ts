import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvVarSecretsAdapter } from "./secrets.js";
import { HttpOpenClawDispatchAdapter } from "./openclaw.js";
import type { SecretLeaseRequest } from "./secrets.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const baseSecretRequest: SecretLeaseRequest = {
  taskId: "task-1",
  repo: "acme/platform",
  agentType: "developer",
  phase: "development",
  environment: "staging",
  riskClass: "medium",
  approvalMode: "human_signoff_required",
  requestedCapabilities: ["can_use_secrets"],
  allowedSecretScopes: ["my_scope"]
};

// ── EnvVarSecretsAdapter failure paths ────────────────────────────────────────

describe("EnvVarSecretsAdapter failure paths", () => {
  it("requestSecret throws when the env var is not set", async () => {
    vi.stubEnv("REDDWARF_SECRET_MY_KEY", undefined as unknown as string);
    const adapter = new EnvVarSecretsAdapter();
    await expect(adapter.requestSecret("my_key")).rejects.toThrow(
      /no environment variable.*REDDWARF_SECRET_MY_KEY.*found/i
    );
  });

  it("returns null when no scope variables are found in the environment", async () => {
    // No env vars matching the scope prefix — resolveScope returns null
    const adapter = new EnvVarSecretsAdapter();
    const lease = await adapter.issueTaskSecrets(baseSecretRequest);
    // The scope prefix REDDWARF_SECRET_MY_SCOPE_ has no matching env vars → null
    expect(lease).toBeNull();
  });

  it("returns null when allowedSecretScopes is empty", async () => {
    const adapter = new EnvVarSecretsAdapter({
      scopes: { my_scope: { TOKEN: "tok" } }
    });
    const lease = await adapter.issueTaskSecrets({
      ...baseSecretRequest,
      allowedSecretScopes: []
    });
    expect(lease).toBeNull();
  });

  it("throws for a high-risk task regardless of scope configuration", async () => {
    const adapter = new EnvVarSecretsAdapter({
      scopes: { my_scope: { TOKEN: "tok" } }
    });
    await expect(
      adapter.issueTaskSecrets({ ...baseSecretRequest, riskClass: "high" })
    ).rejects.toThrow(/denied for high-risk/i);
  });

  it("injects variables from a matching env-var scope prefix", async () => {
    vi.stubEnv("REDDWARF_SECRET_MY_SCOPE_API_TOKEN", "my-injected-token");
    const adapter = new EnvVarSecretsAdapter();
    const lease = await adapter.issueTaskSecrets(baseSecretRequest);

    expect(lease).not.toBeNull();
    expect(lease?.secretScopes).toContain("my_scope");
    expect(lease?.environmentVariables["API_TOKEN"]).toBe("my-injected-token");
  });

  it("uses an explicit scope map when provided instead of env-var scanning", async () => {
    // This env var should NOT be used because an explicit scope map is set
    vi.stubEnv("REDDWARF_SECRET_MY_SCOPE_EXTRA", "should-not-appear");
    const adapter = new EnvVarSecretsAdapter({
      scopes: { my_scope: { EXPLICIT_KEY: "explicit-value" } }
    });
    const lease = await adapter.issueTaskSecrets(baseSecretRequest);

    expect(lease?.environmentVariables["EXPLICIT_KEY"]).toBe("explicit-value");
    expect(lease?.environmentVariables["EXTRA"]).toBeUndefined();
  });
});

// ── HttpOpenClawDispatchAdapter failure paths ─────────────────────────────────

describe("HttpOpenClawDispatchAdapter failure paths", () => {
  const adapterOptions = {
    baseUrl: "http://gateway.local",
    hookToken: "hook-tok"
  };

  const dispatchRequest = {
    sessionKey: "github:issue:acme/repo:1",
    agentId: "reddwarf-analyst",
    prompt: "Analyse task."
  };

  it("throws on 401 unauthorized response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"message":"Unauthorized"}'
    }));

    const adapter = new HttpOpenClawDispatchAdapter(adapterOptions);
    await expect(adapter.dispatch(dispatchRequest)).rejects.toThrow("401");
  });

  it("throws on 500 server error response after exhausting retries", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error"
    }));

    // maxAttempts=1 to avoid the test taking too long on retries
    const adapter = new HttpOpenClawDispatchAdapter({ ...adapterOptions, maxAttempts: 1 });
    await expect(adapter.dispatch(dispatchRequest)).rejects.toThrow("500");
  });

  it("retries on 429 and throws when max attempts exhausted", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "Too Many Requests"
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new HttpOpenClawDispatchAdapter({
      ...adapterOptions,
      maxAttempts: 2,
      baseDelayMs: 1
    });

    await expect(adapter.dispatch(dispatchRequest)).rejects.toThrow("429");
    // Should have attempted twice (initial + 1 retry)
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("parses accepted:true result from a non-empty JSON response body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ sessionId: "sess-99", message: "queued" })
    }));

    const adapter = new HttpOpenClawDispatchAdapter(adapterOptions);
    const result = await adapter.dispatch(dispatchRequest);

    expect(result.accepted).toBe(true);
    expect(result.sessionId).toBe("sess-99");
    expect(result.statusMessage).toBe("queued");
  });

  it("returns null sessionId and statusMessage for an empty response body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: async () => ""
    }));

    const adapter = new HttpOpenClawDispatchAdapter(adapterOptions);
    const result = await adapter.dispatch(dispatchRequest);

    expect(result.accepted).toBe(true);
    expect(result.sessionId).toBeNull();
    expect(result.statusMessage).toBeNull();
  });

  it("sends the Bearer token in the Authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new HttpOpenClawDispatchAdapter(adapterOptions);
    await adapter.dispatch(dispatchRequest);

    const calledWith = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((calledWith.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer hook-tok"
    );
  });
});
