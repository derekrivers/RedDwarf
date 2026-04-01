import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const requests = [];
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const scriptsDir = __dirname;

const server = createServer((req, res) => {
  requests.push({
    method: req.method,
    path: req.url,
    accept: req.headers.accept,
    authorization: req.headers.authorization
  });

  if (req.url === "/runs?limit=1") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ runs: [{ runId: "report-run-1" }], total: 1 }));
    return;
  }

  if (req.url === "/runs/report-run-1/report") {
    res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
    res.end("# Pipeline Run Report\n\n- Run ID: report-run-1\n");
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(0, "127.0.0.1");
await once(server, "listening");

const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Could not determine report CLI verification port.");
}

const outDir = await mkdtemp(join(tmpdir(), "reddwarf-report-cli-"));

try {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      join(scriptsDir, "reddwarf.mjs"),
      "report",
      "--last",
      "--out",
      outDir
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        REDDWARF_API_URL: `http://127.0.0.1:${address.port}`,
        REDDWARF_OPERATOR_TOKEN: "report-verify-token"
      }
    }
  );

  assert.match(stdout, /Report written:/);
  const reportPath = stdout.trim().split(": ").at(-1);
  assert.ok(reportPath, "CLI should print the output report path");

  const markdown = await readFile(reportPath, "utf8");
  assert.match(markdown, /# Pipeline Run Report/);
  assert.match(markdown, /report-run-1/);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].path, "/runs?limit=1");
  assert.equal(requests[0].accept, "application/json");
  assert.equal(requests[0].authorization, "Bearer report-verify-token");
  assert.equal(requests[1].path, "/runs/report-run-1/report");
  assert.equal(requests[1].accept, "text/markdown");
  assert.equal(requests[1].authorization, "Bearer report-verify-token");

  process.stdout.write(
    `${JSON.stringify({ status: "ok", outDir, reportPath }, null, 2)}\n`
  );
} finally {
  server.close();
  await rm(outDir, { recursive: true, force: true });
}
