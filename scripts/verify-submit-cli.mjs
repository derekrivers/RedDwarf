import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { join } from "node:path";
import { repoRoot, scriptsDir } from "./lib/config.mjs";

const execFileAsync = promisify(execFile);
const capturedRequests = [];

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk.toString();
  });
  req.on("end", () => {
    capturedRequests.push({
      method: req.method,
      path: req.url,
      authorization: req.headers.authorization,
      body: JSON.parse(raw)
    });
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        runId: "cli-run-1",
        nextAction: "await_human",
        manifest: {
          taskId: "cli-task-1",
          source: { repo: "acme/platform" }
        },
        approvalRequest: {
          requestId: "cli-task-1:approval:plan-1"
        }
      })
    );
  });
});

server.listen(0, "127.0.0.1");
await once(server, "listening");

const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Could not determine CLI verification server port.");
}

try {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      join(scriptsDir, "reddwarf.mjs"),
      "submit",
      "--repo",
      "acme/platform",
      "--title",
      "Submit a local task",
      "--summary",
      "Verify the CLI can inject a task into the operator API.",
      "--acceptance",
      "The CLI posts the structured task payload.",
      "--acceptance",
      "The response is printed as JSON when requested.",
      "--path",
      "packages/control-plane/src/operator-api.ts",
      "--constraint",
      "Keep the direct injection contract stable.",
      "--capability",
      "can_plan",
      "--capability",
      "can_archive_evidence",
      "--label",
      "local-cli",
      "--priority",
      "2",
      "--risk-class",
      "medium",
      "--issue-number",
      "321",
      "--issue-url",
      "https://github.com/acme/platform/issues/321",
      "--json"
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        REDDWARF_API_URL: `http://127.0.0.1:${address.port}`,
        REDDWARF_OPERATOR_TOKEN: "cli-verify-token"
      }
    }
  );

  const body = JSON.parse(stdout.trim());
  assert.equal(body.runId, "cli-run-1");
  assert.equal(body.nextAction, "await_human");
  assert.equal(body.manifest.taskId, "cli-task-1");

  assert.equal(capturedRequests.length, 1);
  assert.equal(capturedRequests[0].method, "POST");
  assert.equal(capturedRequests[0].path, "/tasks/inject");
  assert.equal(capturedRequests[0].authorization, "Bearer cli-verify-token");
  assert.deepEqual(capturedRequests[0].body, {
    repo: "acme/platform",
    title: "Submit a local task",
    summary: "Verify the CLI can inject a task into the operator API.",
    priority: 2,
    acceptanceCriteria: [
      "The CLI posts the structured task payload.",
      "The response is printed as JSON when requested."
    ],
    affectedPaths: ["packages/control-plane/src/operator-api.ts"],
    constraints: ["Keep the direct injection contract stable."],
    requestedCapabilities: ["can_plan", "can_archive_evidence"],
    labels: ["local-cli"],
    riskClassHint: "medium",
    issueNumber: 321,
    issueUrl: "https://github.com/acme/platform/issues/321"
  });

  process.stdout.write(
    `${JSON.stringify({ status: "ok", taskId: body.manifest.taskId, port: address.port }, null, 2)}\n`
  );
} finally {
  server.close();
}
