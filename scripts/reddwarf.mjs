#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

loadRepoEnv();

const usage = `RedDwarf CLI

Usage:
  reddwarf submit --repo <owner/repo> --title <title> --summary <summary> --acceptance <criterion> [options]
  reddwarf report --run-id <run-id> [options]
  reddwarf report --last [options]

Submit options:
  --repo <owner/repo>          Repository the task belongs to
  --title <text>               Task title
  --summary <text>             Short task summary
  --acceptance <text>          Acceptance criterion (repeatable)
  --path <path>                Affected path (repeatable)
  --constraint <text>          Constraint (repeatable)
  --capability <name>          Requested capability (repeatable)
  --label <name>               Optional label (repeatable)
  --priority <1-5>             Priority hint (default: 3)
  --risk-class <low|medium|high|critical>
  --issue-number <number>      Optional source issue number
  --issue-url <url>            Optional source issue URL
  --api-url <url>              Operator API base URL (default: REDDWARF_API_URL or local :8080)
  --token <token>              Operator token (default: REDDWARF_OPERATOR_TOKEN)
  --json                       Print the raw JSON response
  --help                       Show this message

Report options:
  --run-id <id>                Pipeline run id to export
  --last                       Export the most recent run
  --out <dir>                  Output directory (default: current directory)
  --api-url <url>              Operator API base URL (default: REDDWARF_API_URL or local :8080)
  --token <token>              Operator token (default: REDDWARF_OPERATOR_TOKEN)
  --json                       Print the raw JSON report payload instead of markdown
  --help                       Show this message

Examples:
  reddwarf submit \\
    --repo acme/platform \\
    --title "Harden approval polling" \\
    --summary "Ensure the operator loop surfaces stale approvals." \\
    --acceptance "Blocked approvals appear in /blocked within one poll cycle." \\
    --path packages/control-plane/src/polling.ts

  reddwarf submit --repo acme/platform --title "Improve logs" --summary "..." \\
    --acceptance "Structured logs include task ids." --json

  reddwarf report --run-id acme-run-123 --out reports/
`;

const argv = process.argv.slice(2);
const command = argv[0];

if (!command || command === "--help" || command === "help") {
  process.stdout.write(`${usage}\n`);
  process.exit(0);
}

if (!["submit", "report"].includes(command)) {
  process.stderr.write(`Unknown command: ${command}\n\n${usage}\n`);
  process.exit(1);
}

if (command === "report") {
  await handleReportCommand(argv.slice(1));
  process.exit(0);
}

const { values } = parseArgs({
  args: argv.slice(1),
  allowPositionals: false,
  options: {
    repo: { type: "string" },
    title: { type: "string" },
    summary: { type: "string" },
    acceptance: { type: "string", multiple: true },
    path: { type: "string", multiple: true },
    constraint: { type: "string", multiple: true },
    capability: { type: "string", multiple: true },
    label: { type: "string", multiple: true },
    priority: { type: "string" },
    "risk-class": { type: "string" },
    "issue-number": { type: "string" },
    "issue-url": { type: "string" },
    "api-url": { type: "string" },
    token: { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean" }
  }
});

if (values.help) {
  process.stdout.write(`${usage}\n`);
  process.exit(0);
}

const repo = requiredString(values.repo, "--repo");
const title = requiredString(values.title, "--title");
const summary = requiredString(values.summary, "--summary");
const acceptanceCriteria = normalizeList(values.acceptance);

if (acceptanceCriteria.length === 0) {
  fail("At least one --acceptance value is required.");
}

const priority = values.priority === undefined ? 3 : Number.parseInt(values.priority, 10);
if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
  fail("--priority must be an integer between 1 and 5.");
}

const issueNumber =
  values["issue-number"] === undefined
    ? undefined
    : Number.parseInt(values["issue-number"], 10);
if (
  values["issue-number"] !== undefined &&
  (!Number.isInteger(issueNumber) || issueNumber <= 0)
) {
  fail("--issue-number must be a positive integer.");
}

const apiBaseUrl = resolveApiBaseUrl(values["api-url"]);
const operatorToken = resolveOperatorToken(values.token);

const payload = {
  repo,
  title,
  summary,
  priority,
  acceptanceCriteria,
  affectedPaths: normalizeList(values.path),
  constraints: normalizeList(values.constraint),
  requestedCapabilities: normalizeList(values.capability),
  labels: normalizeList(values.label),
  ...(values["risk-class"] !== undefined
    ? { riskClassHint: values["risk-class"] }
    : {}),
  ...(issueNumber !== undefined ? { issueNumber } : {}),
  ...(values["issue-url"] !== undefined ? { issueUrl: values["issue-url"] } : {})
};

try {
  const response = await postJson(new URL("/tasks/inject", ensureTrailingSlash(apiBaseUrl)), payload, operatorToken);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const message =
      typeof response.body?.message === "string"
        ? response.body.message
        : `Operator API returned ${response.statusCode}.`;
    fail(message);
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(response.body, null, 2)}\n`);
    process.exit(0);
  }

  process.stdout.write(`Submitted task: ${response.body.manifest?.taskId ?? "unknown"}\n`);
  process.stdout.write(`Run: ${response.body.runId ?? "unknown"}\n`);
  process.stdout.write(`Next action: ${response.body.nextAction ?? "unknown"}\n`);
  if (response.body.approvalRequest?.requestId) {
    process.stdout.write(
      `Approval request: ${response.body.approvalRequest.requestId}\n`
    );
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

function loadRepoEnv() {
  try {
    const envContent = readFileSync(join(repoRoot, ".env"), "utf8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separator = trimmed.indexOf("=");
      if (separator <= 0) {
        continue;
      }

      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional for the CLI.
  }
}

function requiredString(value, flagName) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  fail(`${flagName} is required.`);
}

function normalizeList(value) {
  if (value === undefined) {
    return [];
  }

  return value.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

async function handleReportCommand(args) {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      "run-id": { type: "string" },
      last: { type: "boolean" },
      out: { type: "string" },
      "api-url": { type: "string" },
      token: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean" }
    }
  });

  if (values.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }

  const apiBaseUrl = resolveApiBaseUrl(values["api-url"]);
  const operatorToken = resolveOperatorToken(values.token);
  const outDir = values.out?.trim() || ".";

  let runId =
    typeof values["run-id"] === "string" && values["run-id"].trim().length > 0
      ? values["run-id"].trim()
      : null;

  if (values.last) {
    const runsResponse = await getResponse(
      new URL("/runs?limit=1", ensureTrailingSlash(apiBaseUrl)),
      operatorToken,
      "application/json"
    );
    if (runsResponse.statusCode < 200 || runsResponse.statusCode >= 300) {
      fail(`Failed to resolve the latest run: HTTP ${runsResponse.statusCode}`);
    }
    const runsBody = JSON.parse(runsResponse.body || "{}");
    runId = runsBody.runs?.[0]?.runId ?? null;
  }

  if (!runId) {
    fail("Provide --run-id <id> or --last.");
  }

  if (values.json) {
    const reportResponse = await getResponse(
      new URL(`/runs/${encodeURIComponent(runId)}/report`, ensureTrailingSlash(apiBaseUrl)),
      operatorToken,
      "application/json"
    );
    if (reportResponse.statusCode < 200 || reportResponse.statusCode >= 300) {
      fail(`Failed to export the run report: HTTP ${reportResponse.statusCode}`);
    }
    process.stdout.write(`${JSON.stringify(JSON.parse(reportResponse.body || "{}"), null, 2)}\n`);
    return;
  }

  const markdownResponse = await getResponse(
    new URL(`/runs/${encodeURIComponent(runId)}/report`, ensureTrailingSlash(apiBaseUrl)),
    operatorToken,
    "text/markdown"
  );
  if (markdownResponse.statusCode < 200 || markdownResponse.statusCode >= 300) {
    fail(`Failed to export the run report: HTTP ${markdownResponse.statusCode}`);
  }

  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  mkdirSync(outDir, { recursive: true });
  const filePath = join(outDir, `run-${runId.slice(0, 8)}.md`);
  writeFileSync(filePath, markdownResponse.body, "utf8");
  process.stdout.write(`Report written: ${filePath}\n`);
}

function resolveApiBaseUrl(override) {
  const fallbackPort = process.env.REDDWARF_API_PORT?.trim() || "8080";
  const raw =
    override?.trim() ||
    process.env.REDDWARF_API_URL?.trim() ||
    `http://127.0.0.1:${fallbackPort}`;

  try {
    return new URL(raw).toString();
  } catch {
    fail(`Invalid operator API URL: ${raw}`);
  }
}

function resolveOperatorToken(override) {
  const token = override?.trim() || process.env.REDDWARF_OPERATOR_TOKEN?.trim() || "";
  if (token.length === 0) {
    fail(
      "Operator API token is required. Set REDDWARF_OPERATOR_TOKEN or pass --token."
    );
  }

  return token;
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function postJson(url, body, token) {
  const requestImpl = url.protocol === "https:" ? httpsRequest : httpRequest;
  const payload = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = requestImpl(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk.toString();
        });
        res.on("end", () => {
          if (raw.trim().length === 0) {
            resolve({ statusCode: res.statusCode ?? 0, body: {} });
            return;
          }

          try {
            resolve({
              statusCode: res.statusCode ?? 0,
              body: JSON.parse(raw)
            });
          } catch (error) {
            reject(
              new Error(
                `Operator API returned non-JSON output: ${
                  error instanceof Error ? error.message : raw
                }`
              )
            );
          }
        });
      }
    );

    req.setTimeout(15_000, () => {
      req.destroy(new Error("Operator API request timed out."));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function getResponse(url, token, accept = "application/json") {
  const requestImpl = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = requestImpl(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: accept
        }
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk.toString();
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: raw
          });
        });
      }
    );

    req.setTimeout(15_000, () => {
      req.destroy(new Error("Operator API request timed out."));
    });
    req.on("error", reject);
    req.end();
  });
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
