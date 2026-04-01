import { afterEach, describe, expect, it } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { createOperatorMcpBridge } from "./operator-mcp.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
});

async function createMockOperatorServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
) {
  const server = createServer();
  server.on("request", handler);
  servers.push(server);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock operator server failed to bind.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

describe("createOperatorMcpBridge", () => {
  it("lists the RedDwarf MCP tools", () => {
    const bridge = createOperatorMcpBridge({
      baseUrl: "http://127.0.0.1:1",
      operatorToken: "token",
      fetchImpl: fetch
    });

    const tools = bridge.listTools().map((tool) => tool.name);
    expect(tools).toEqual([
      "reddwarf_find_task_history",
      "reddwarf_get_task_history",
      "reddwarf_get_task_evidence",
      "reddwarf_list_runs",
      "reddwarf_get_run",
      "reddwarf_get_run_evidence"
    ]);
  });

  it("filters task history results by query text", async () => {
    const requests: string[] = [];
    const server = await createMockOperatorServer((req, res) => {
      requests.push(String(req.url));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          tasks: [
            {
              manifest: {
                taskId: "task-1",
                title: "Tighten operator MCP bridge",
                summary: "Connect task history through MCP."
              }
            },
            {
              manifest: {
                taskId: "task-2",
                title: "Unrelated cleanup",
                summary: "Something else"
              }
            }
          ],
          total: 2
        })
      );
    });

    const bridge = createOperatorMcpBridge({
      baseUrl: server.baseUrl,
      operatorToken: "token"
    });
    const result = await bridge.callTool("reddwarf_find_task_history", {
      repo: "acme/repo",
      query: "mcp",
      limit: 20
    });
    if ("isError" in result) {
      throw new Error(result.content[0]?.text ?? "Expected successful tool result.");
    }
    const successResult = result as typeof result & { structuredContent: unknown };

    expect(requests[0]).toContain("/tasks?");
    expect(requests[0]).toContain("repo=acme%2Frepo");
    expect(requests[0]).toContain("limit=20");
    expect(successResult.structuredContent).toMatchObject({
      total: 1,
      tasks: [{ manifest: { taskId: "task-1" } }]
    });
  });

  it("requests run evidence from the matching operator API route", async () => {
    const requests: string[] = [];
    const server = await createMockOperatorServer((req, res) => {
      requests.push(String(req.url));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          runId: "run-123",
          taskId: "task-123",
          evidenceRecords: [{ recordId: "evidence-1" }],
          total: 1
        })
      );
    });

    const bridge = createOperatorMcpBridge({
      baseUrl: server.baseUrl,
      operatorToken: "token"
    });
    const result = await bridge.callTool("reddwarf_get_run_evidence", {
      runId: "run-123"
    });
    if ("isError" in result) {
      throw new Error(result.content[0]?.text ?? "Expected successful tool result.");
    }
    const successResult = result as typeof result & { structuredContent: unknown };

    expect(requests[0]).toBe("/runs/run-123/evidence");
    expect(successResult.structuredContent).toMatchObject({
      runId: "run-123",
      total: 1
    });
  });

  it("returns an MCP tool error payload for unknown tools", async () => {
    const bridge = createOperatorMcpBridge({
      baseUrl: "http://127.0.0.1:1",
      operatorToken: "token",
      fetchImpl: fetch
    });

    const result = await bridge.callTool("reddwarf_missing_tool", {});
    const errorResult = result as typeof result & { isError: true };
    expect(errorResult.isError).toBe(true);
    expect(errorResult.content[0]?.text).toContain("Unknown RedDwarf MCP tool");
  });
});
