import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { CiAdapter, CiCheckSuiteSnapshot } from "@reddwarf/integrations";
import type { MaterializedManagedWorkspace } from "./workspace.js";

export const workspaceCiDirName = "ci";
export const workspaceCiRequestsDirName = "requests";
export const workspaceCiLatestChecksFileName = "latest-checks.json";
export const workspaceCiResultsFileName = "request-results.json";
export const workspaceCiToolFileName = "reddwarf-ci.mjs";

export interface MaterializedWorkspaceCiTool {
  latestChecksPath: string;
  requestsDir: string;
  resultsPath: string;
  toolPath: string;
  snapshot: CiCheckSuiteSnapshot;
}

export interface WorkspaceCiRequestResult {
  requestFile: string;
  workflow: string;
  ref: string;
  status: "triggered" | "blocked";
  error: string | null;
}

export async function materializeWorkspaceCiTool(input: {
  workspace: MaterializedManagedWorkspace;
  repo: string;
  ref: string;
  ci: CiAdapter;
}): Promise<MaterializedWorkspaceCiTool> {
  const ciDir = join(input.workspace.stateDir, workspaceCiDirName);
  const requestsDir = join(ciDir, workspaceCiRequestsDirName);
  const resultsPath = join(ciDir, workspaceCiResultsFileName);
  const latestChecksPath = join(ciDir, workspaceCiLatestChecksFileName);
  const toolsDir = join(input.workspace.stateDir, "tools");
  const toolPath = join(toolsDir, workspaceCiToolFileName);
  const snapshot = await input.ci.getLatestChecks(input.repo, input.ref);

  await Promise.all([
    mkdir(ciDir, { recursive: true }),
    mkdir(requestsDir, { recursive: true }),
    mkdir(toolsDir, { recursive: true })
  ]);
  await Promise.all([
    writeFile(latestChecksPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8"),
    writeFile(resultsPath, "[]\n", "utf8"),
    writeFile(toolPath, renderWorkspaceCiToolScript(), "utf8")
  ]);

  return {
    latestChecksPath,
    requestsDir,
    resultsPath,
    toolPath,
    snapshot
  };
}

export async function processWorkspaceCiRequests(input: {
  workspace: MaterializedManagedWorkspace;
  repo: string;
  defaultRef: string;
  ci: CiAdapter;
}): Promise<WorkspaceCiRequestResult[]> {
  const ciDir = join(input.workspace.stateDir, workspaceCiDirName);
  const requestsDir = join(ciDir, workspaceCiRequestsDirName);
  const resultsPath = join(ciDir, workspaceCiResultsFileName);
  const latestChecksPath = join(ciDir, workspaceCiLatestChecksFileName);
  const requestFiles = (await readdir(requestsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const results: WorkspaceCiRequestResult[] = [];

  for (const requestFile of requestFiles) {
    const requestPath = join(requestsDir, requestFile);
    const raw = await readFile(requestPath, "utf8");
    const request = JSON.parse(raw) as {
      workflow?: string;
      ref?: string;
    };
    const workflow = typeof request.workflow === "string" ? request.workflow : "";
    const ref =
      typeof request.ref === "string" && request.ref.trim().length > 0
        ? request.ref
        : input.defaultRef;

    try {
      await input.ci.triggerWorkflow(input.repo, workflow, ref);
      results.push({
        requestFile,
        workflow,
        ref,
        status: "triggered",
        error: null
      });
    } catch (error) {
      results.push({
        requestFile,
        workflow,
        ref,
        status: "blocked",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const refreshedSnapshot = await input.ci.getLatestChecks(
    input.repo,
    input.defaultRef
  );
  await Promise.all([
    writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`, "utf8"),
    writeFile(
      latestChecksPath,
      `${JSON.stringify(refreshedSnapshot, null, 2)}\n`,
      "utf8"
    )
  ]);

  return results;
}

function renderWorkspaceCiToolScript(): string {
  return `#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolPath = fileURLToPath(import.meta.url);
const toolsDir = dirname(toolPath);
const stateDir = resolve(toolsDir, "..");
const ciDir = join(stateDir, "ci");
const latestChecksPath = join(ciDir, "latest-checks.json");
const requestsDir = join(ciDir, "requests");

const [, , command, ...args] = process.argv;

if (!command || command === "help" || command === "--help") {
  process.stdout.write([
    "Usage:",
    "  node .workspace/tools/reddwarf-ci.mjs latest",
    "  node .workspace/tools/reddwarf-ci.mjs trigger --workflow <name> [--ref <ref>]"
  ].join("\\n") + "\\n");
  process.exit(0);
}

if (command === "latest") {
  process.stdout.write(await readFile(latestChecksPath, "utf8"));
  process.exit(0);
}

if (command === "trigger") {
  const workflowFlagIndex = args.indexOf("--workflow");
  if (workflowFlagIndex === -1 || workflowFlagIndex + 1 >= args.length) {
    process.stderr.write("--workflow is required.\\n");
    process.exit(1);
  }

  const workflow = args[workflowFlagIndex + 1];
  const refFlagIndex = args.indexOf("--ref");
  const ref = refFlagIndex !== -1 && refFlagIndex + 1 < args.length
    ? args[refFlagIndex + 1]
    : null;
  const request = {
    workflow,
    ref,
    requestedAt: new Date().toISOString()
  };
  const filename = \`\${Date.now()}-\${workflow.replace(/[^a-z0-9._-]+/gi, "-")}.json\`;
  await mkdir(requestsDir, { recursive: true });
  const requestPath = join(requestsDir, filename);
  await writeFile(requestPath, JSON.stringify(request, null, 2) + "\\n", "utf8");
  process.stdout.write(JSON.stringify({ status: "queued", requestPath, workflow, ref }, null, 2) + "\\n");
  process.exit(0);
}

process.stderr.write(\`Unknown command: \${command}\\n\`);
process.exit(1);
`;
}
