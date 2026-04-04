import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "./client";
import { clearOperatorToken, readOperatorToken, writeOperatorToken } from "../lib/session";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

function createSessionStorage(): StorageLike {
  const values = new Map<string, string>();

  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
    clear() {
      values.clear();
    }
  };
}

describe("dashboard api client", () => {
  const sessionStorage = createSessionStorage();
  const assignMock = vi.fn();

  beforeEach(() => {
    sessionStorage.clear();
    assignMock.mockReset();
    vi.unstubAllGlobals();
    vi.stubGlobal("window", {
      sessionStorage,
      location: {
        assign: assignMock
      }
    });
  });

  it("attaches the operator token from session storage and hardcodes decidedBy", async () => {
    writeOperatorToken("token-123");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          approval: {
            requestId: "approval-1",
            taskId: "task-1"
          },
          manifest: {
            taskId: "task-1"
          }
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createApiClient({ baseUrl: "http://localhost:8080" });
    await client.resolveApproval("approval-1", "approve", "Ship it.");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/approvals/approval-1/resolve",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token-123",
          "Content-Type": "application/json"
        }),
        body: JSON.stringify({
          decision: "approve",
          decidedBy: "operator",
          decisionSummary: "Ship it."
        })
      })
    );
  });

  it("prefers an explicit token so the first authenticated request does not race session storage", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createApiClient({
      baseUrl: "http://localhost:8080",
      token: "fresh-login-token"
    });

    await client.getHealth();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/health",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer fresh-login-token"
        })
      })
    );
    expect(readOperatorToken()).toBe("");
  });

  it("clears the stored token and calls onUnauthorized after a 401 response", async () => {
    writeOperatorToken("expired-token");
    const onUnauthorized = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ message: "nope" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        })
      )
    );

    const client = createApiClient({
      baseUrl: "http://localhost:8080",
      onUnauthorized
    });

    await expect(client.getHealth()).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      message: "Operator token is no longer valid."
    });
    expect(readOperatorToken()).toBe("");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("throws ApiError with status and response message for non-2xx responses", async () => {
    writeOperatorToken("token-456");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ message: "Server exploded." }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        })
      )
    );

    const client = createApiClient({ baseUrl: "http://localhost:8080" });

    await expect(client.getPipelineRuns()).rejects.toMatchObject({
      name: "ApiError",
      status: 500,
      message: "Server exploded."
    });
  });

  it("redirects to login when unauthorized without an override handler", async () => {
    writeOperatorToken("expired-token");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ message: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        })
      )
    );

    const client = createApiClient({ baseUrl: "http://localhost:8080" });

    await expect(client.getHealth()).rejects.toMatchObject({ status: 401 });
    expect(assignMock).toHaveBeenCalledWith("/");
    expect(readOperatorToken()).toBe("");
    clearOperatorToken();
  });
});
