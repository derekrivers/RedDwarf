/**
 * scripts/e2e-cleanup.mjs
 *
 * Cleans up GitHub resources created by the E2E integration test.
 * Closes the PR, deletes the branch, and closes the issue.
 *
 * Required environment:
 *   GITHUB_TOKEN        — GitHub PAT with repo scope
 *   E2E_TARGET_REPO     — GitHub repo in owner/repo format
 *
 * Required arguments (pass any combination):
 *   --issue <number>    — issue number to close
 *   --pr <number>       — PR number to close
 *   --branch <name>     — branch name to delete
 *
 * Usage:
 *   node scripts/e2e-cleanup.mjs --issue 5 --pr 6 --branch reddwarf/task-abc123
 *   E2E_TARGET_REPO=owner/repo corepack pnpm e2e:cleanup -- --issue 5 --pr 6 --branch reddwarf/task-abc123
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createScriptLogger, formatError } from "./lib/config.mjs";

// ── Load .env from repo root (no external dependency) ───────────────────────
const __scriptdir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__scriptdir, "..", ".env");
try {
  const envContent = readFileSync(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex < 1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
} catch {
  // .env is optional
}

const { log, logError } = createScriptLogger("e2e-cleanup");

const repo = process.env.E2E_TARGET_REPO;
if (!repo) {
  logError("E2E_TARGET_REPO is required (e.g. owner/repo)");
  process.exit(1);
}
if (!process.env.GITHUB_TOKEN) {
  logError("GITHUB_TOKEN is required");
  process.exit(1);
}

// ── Argument parsing ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let issueNumber = null;
let prNumber = null;
let branchName = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--issue" && args[i + 1]) issueNumber = Number(args[++i]);
  else if (args[i] === "--pr" && args[i + 1]) prNumber = Number(args[++i]);
  else if (args[i] === "--branch" && args[i + 1]) branchName = args[++i];
}

if (!issueNumber && !prNumber && !branchName) {
  logError("At least one of --issue, --pr, or --branch is required");
  log("Usage: node scripts/e2e-cleanup.mjs --issue 5 --pr 6 --branch reddwarf/task-abc123");
  process.exit(1);
}

// ── GitHub helpers ──────────────────────────────────────────────────────────

const [owner, repoName] = repo.split("/");
const headers = {
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "Content-Type": "application/json"
};

async function closePullRequest(pr) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/pulls/${pr}`,
    { method: "PATCH", headers, body: JSON.stringify({ state: "closed" }) }
  );
  if (res.ok) {
    log(`Closed PR #${pr}`);
  } else {
    logError(`Failed to close PR #${pr} (${res.status} ${res.statusText})`);
  }
}

async function deleteBranch(branch) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/git/refs/heads/${branch}`,
    { method: "DELETE", headers }
  );
  if (res.ok || res.status === 204) {
    log(`Deleted branch ${branch}`);
  } else if (res.status === 422) {
    log(`Branch ${branch} not found (already deleted?)`);
  } else {
    logError(`Failed to delete branch ${branch} (${res.status} ${res.statusText})`);
  }
}

async function closeIssue(issue) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/issues/${issue}`,
    { method: "PATCH", headers, body: JSON.stringify({ state: "closed" }) }
  );
  if (res.ok) {
    log(`Closed issue #${issue}`);
  } else {
    logError(`Failed to close issue #${issue} (${res.status} ${res.statusText})`);
  }
}

// ── Execute cleanup ─────────────────────────────────────────────────────────

try {
  log(`Cleaning up resources in ${repo}...`);

  // Order matters: close PR before deleting branch, close issue last
  if (prNumber) await closePullRequest(prNumber);
  if (branchName) await deleteBranch(branchName);
  if (issueNumber) await closeIssue(issueNumber);

  log("Cleanup complete.");
} catch (err) {
  logError(`Cleanup failed: ${formatError(err)}`);
  process.exit(1);
}
