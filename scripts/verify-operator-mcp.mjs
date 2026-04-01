import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { repoRoot } from "./lib/config.mjs";

function writeMessage(stream, message) {
  const json = JSON.stringify(message);
  stream.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
}

function createMcpClient(child) {
  let buffer = Buffer.alloc(0);
  const pending = new Map();

  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      const headerText = buffer.slice(0, headerEnd).toString("utf8");
      const match = /^Content-Length:\s*(\d+)$/im.exec(headerText);
      assert.ok(match, "MCP response missing Content-Length header");

      const contentLength = Number.parseInt(match[1] ?? "0", 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (buffer.length < messageEnd) {
        return;
      }

      const body = JSON.parse(buffer.slice(messageStart, messageEnd).toString("utf8"));
      buffer = buffer.slice(messageEnd);

      if (body.id !== undefined && pending.has(body.id)) {
        pending.get(body.id)(body);
        pending.delete(body.id);
      }
    }
  });

  return {
    request(id, method, params) {
      return new Promise((resolvePromise) => {
        pending.set(id, resolvePromise);
        writeMessage(child.stdin, {
          jsonrpc: "2.0",
          id,
          method,
          ...(params !== undefined ? { params } : {})
        });
      });
    },
    notify(method, params) {
      writeMessage(child.stdin, {
        jsonrpc: "2.0",
        method,
        ...(params !== undefined ? { params } : {})
      });
    }
  };
}

const operatorApiToken = "verify-operator-mcp-token";
const requests = [];
const operatorApi = createServer((req, res) => {
  requests.push({
    url: req.url ?? "",
    auth: String(req.headers.authorization ?? "")
  });

  if (req.headers.authorization !== `Bearer ${operatorApiToken}`) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  if (req.url?.startsWith("/tasks?")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        tasks: [
          {
            manifest: {
              taskId: "task-1",
              title: "Implement MCP bridge",
              summary: "Bridge task history into OpenClaw."
            }
          },
          {
            manifest: {
              taskId: "task-2",
              title: "Adjust docs",
              summary: "Documentation only."
            }
          }
        ],
        total: 2
      })
    );
    return;
  }

  if (req.url === "/runs/run-1/evidence") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        runId: "run-1",
        taskId: "task-1",
        evidenceRecords: [{ recordId: "evidence-1" }],
        total: 1
      })
    );
    return;
  }

  if (req.url === "/tasks/task-1") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        manifest: {
          taskId: "task-1",
          title: "Implement MCP bridge"
        },
        pipelineRuns: [{ runId: "run-1", status: "completed" }]
      })
    );
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found", url: req.url }));
});

operatorApi.listen(0, "127.0.0.1");
await once(operatorApi, "listening");

const address = operatorApi.address();
assert.ok(address && typeof address !== "string");

const child = spawn(process.execPath, [resolve(repoRoot, "scripts", "start-operator-mcp.mjs")], {
  cwd: repoRoot,
  env: {
    ...process.env,
    REDDWARF_API_URL: `http://127.0.0.1:${address.port}`,
    REDDWARF_OPERATOR_TOKEN: operatorApiToken
  },
  stdio: ["pipe", "pipe", "inherit"]
});

const client = createMcpClient(child);

try {
  const initialize = await client.request(1, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: {
      name: "verify-operator-mcp",
      version: "0.1.0"
    }
  });
  assert.equal(initialize.result.protocolVersion, "2025-03-26");
  assert.equal(initialize.result.serverInfo.name, "reddwarf-operator-mcp");

  client.notify("notifications/initialized");

  const toolsList = await client.request(2, "tools/list");
  const toolNames = toolsList.result.tools.map((tool) => tool.name);
  assert.deepEqual(toolNames, [
    "reddwarf_find_task_history",
    "reddwarf_get_task_history",
    "reddwarf_get_task_evidence",
    "reddwarf_list_runs",
    "reddwarf_get_run",
    "reddwarf_get_run_evidence"
  ]);

  const taskHistory = await client.request(3, "tools/call", {
    name: "reddwarf_find_task_history",
    arguments: {
      repo: "acme/repo",
      query: "mcp",
      limit: 20
    }
  });
  assert.equal(taskHistory.result.structuredContent.total, 1);
  assert.equal(taskHistory.result.structuredContent.tasks[0].manifest.taskId, "task-1");

  const taskDetail = await client.request(4, "tools/call", {
    name: "reddwarf_get_task_history",
    arguments: {
      taskId: "task-1"
    }
  });
  assert.equal(taskDetail.result.structuredContent.manifest.taskId, "task-1");

  const evidence = await client.request(5, "tools/call", {
    name: "reddwarf_get_run_evidence",
    arguments: {
      runId: "run-1"
    }
  });
  assert.equal(evidence.result.structuredContent.total, 1);

  assert.ok(requests.some((request) => request.url.startsWith("/tasks?")));
  assert.ok(requests.some((request) => request.url === "/runs/run-1/evidence"));
  assert.ok(requests.every((request) => request.auth === `Bearer ${operatorApiToken}`));

  console.log("Operator MCP bridge verification passed.");
} finally {
  child.kill("SIGTERM");
  operatorApi.close();
}
