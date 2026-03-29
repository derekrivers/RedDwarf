import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  asIsoTimestamp,
  type MaterializedManagedWorkspace,
  type TaskManifest
} from "@reddwarf/contracts";
import type {
  GitHubBranchSummary,
  OpenClawDispatchResult
} from "@reddwarf/integrations";
import type { PlanningPipelineLogger } from "./logger.js";

export interface WorkspaceRepoBootstrapResult {
  repoRoot: string;
  baseBranch: string;
  remoteUrl: string;
}

export interface WorkspaceRepoBootstrapper {
  ensureRepo(input: {
    manifest: TaskManifest;
    workspace: MaterializedManagedWorkspace;
    baseBranch: string;
    logger?: PlanningPipelineLogger;
  }): Promise<WorkspaceRepoBootstrapResult>;
}

export interface OpenClawCompletionResult {
  handoffPath: string;
  repoRoot: string | null;
}

export interface OpenClawCompletionAwaiter {
  waitForCompletion(input: {
    manifest: TaskManifest;
    workspace: MaterializedManagedWorkspace;
    sessionKey: string;
    dispatchResult: OpenClawDispatchResult;
    logger?: PlanningPipelineLogger;
  }): Promise<OpenClawCompletionResult>;
}

export interface WorkspaceCommitPublicationResult {
  branch: GitHubBranchSummary;
  commitSha: string;
  changedFiles: string[];
  diff: string;
}

export interface WorkspaceCommitPublisher {
  publish(input: {
    manifest: TaskManifest;
    workspace: MaterializedManagedWorkspace;
    baseBranch: string;
    branchName: string;
    allowedPaths: string[];
    logger?: PlanningPipelineLogger;
  }): Promise<WorkspaceCommitPublicationResult>;
}

type RepoAwareWorkspace = MaterializedManagedWorkspace & { repoRoot?: string | null };

export class AllowedPathViolationError extends Error {
  readonly allowedPaths: string[];
  readonly changedFiles: string[];
  readonly violatingFiles: string[];

  constructor(input: {
    workspaceId: string;
    allowedPaths: string[];
    changedFiles: string[];
    violatingFiles: string[];
  }) {
    const scopeLabel =
      input.allowedPaths.length > 0 ? input.allowedPaths.join(", ") : "none";
    const violatingLabel = input.violatingFiles.join(", ");
    super(
      `Workspace ${input.workspaceId} changed files outside the approved path scope. Allowed paths: ${scopeLabel}. Violating files: ${violatingLabel}.`
    );
    this.name = "AllowedPathViolationError";
    this.allowedPaths = [...input.allowedPaths];
    this.changedFiles = [...input.changedFiles];
    this.violatingFiles = [...input.violatingFiles];
  }
}

export function findDisallowedChangedFiles(
  changedFiles: string[],
  allowedPaths: string[]
): string[] {
  const normalizedAllowedPaths = allowedPaths
    .map((value) => normalizeRepoRelativePath(value))
    .filter((value) => value.length > 0);

  return [...new Set(
    changedFiles
      .map((value) => normalizeRepoRelativePath(value))
      .filter((value) => value.length > 0)
      .filter(
        (changedFile) =>
          !normalizedAllowedPaths.some((allowedPath) =>
            repoPathMatchesAllowedPattern(changedFile, allowedPath)
          )
      )
  )].sort((left, right) => left.localeCompare(right));
}

export function assignWorkspaceRepoRoot(
  workspace: MaterializedManagedWorkspace,
  repoRoot: string | null
): void {
  (workspace as RepoAwareWorkspace).repoRoot = repoRoot;
}

export function readWorkspaceRepoRoot(
  workspace: MaterializedManagedWorkspace
): string | null {
  return (workspace as RepoAwareWorkspace).repoRoot ?? null;
}

export async function enableWorkspaceCodeWriting(
  workspace: MaterializedManagedWorkspace
): Promise<void> {
  workspace.descriptor.toolPolicy.codeWriteEnabled = true;
  workspace.descriptor.toolPolicy.notes = workspace.descriptor.toolPolicy.notes.map((note) =>
    note.includes("product code writes remain disabled by default")
      ? "Developer orchestration is enabled in RedDwarf v1 with product code writes enabled for this approved task."
      : note
  );

  await writeFile(
    workspace.stateFile,
    `${JSON.stringify(workspace.descriptor, null, 2)}\n`,
    "utf8"
  );
}

export interface GitHubWorkspaceRepoBootstrapperOptions {
  tokenEnvVar?: string;
}

export function createGitHubWorkspaceRepoBootstrapper(
  options: GitHubWorkspaceRepoBootstrapperOptions = {}
): WorkspaceRepoBootstrapper {
  const tokenEnvVar = options.tokenEnvVar ?? "GITHUB_TOKEN";

  return {
    async ensureRepo(input) {
      const repoRoot = join(input.workspace.workspaceRoot, "repo");
      const remoteUrl = buildGitHubRemoteUrl(
        input.manifest.source.repo,
        process.env[tokenEnvVar] ?? null
      );

      if (await pathExists(join(repoRoot, ".git"))) {
        return {
          repoRoot,
          baseBranch: input.baseBranch,
          remoteUrl
        };
      }

      await runCommand(
        "git",
        ["clone", "--depth", "1", "--branch", input.baseBranch, remoteUrl, repoRoot],
        input.workspace.workspaceRoot,
        input.logger
      );

      return {
        repoRoot,
        baseBranch: input.baseBranch,
        remoteUrl
      };
    }
  };
}

export interface ArchitectHandoffAwaiterOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export function createArchitectHandoffAwaiter(
  options: ArchitectHandoffAwaiterOptions = {}
): OpenClawCompletionAwaiter {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;

  return {
    async waitForCompletion(input) {
      const handoffPath = join(input.workspace.artifactsDir, "architect-handoff.md");
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        if (await pathExists(handoffPath)) {
          const handoff = await readFile(handoffPath, "utf8");
          const headings = [
            "# Architecture Handoff",
            "## Summary",
            "## Implementation Approach",
            "## Affected Files",
            "## Risks and Assumptions",
            "## Test Strategy"
          ];
          const hasAllHeadings = headings.every((heading) => handoff.includes(heading));

          if (hasAllHeadings) {
            return { handoffPath, repoRoot: null };
          }
        }

        await sleep(pollIntervalMs);
      }

      throw new Error(
        `Timed out waiting for OpenClaw architect completion for session ${input.sessionKey}.`
      );
    }
  };
}

export interface DeveloperHandoffAwaiterOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export function createDeveloperHandoffAwaiter(
  options: DeveloperHandoffAwaiterOptions = {}
): OpenClawCompletionAwaiter {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;

  return {
    async waitForCompletion(input) {
      const handoffPath = join(input.workspace.artifactsDir, "developer-handoff.md");
      const repoRoot = readWorkspaceRepoRoot(input.workspace);
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        if (await pathExists(handoffPath)) {
          const handoff = await readFile(handoffPath, "utf8");
          const headings = [
            "# Development Handoff",
            "## Summary",
            "## Implementation Notes",
            "## Blocked Actions",
            "## Next Actions"
          ];
          const hasAllHeadings = headings.every((heading) => handoff.includes(heading));
          const codeWritingEnabled = handoff.includes("Code writing enabled: yes");
          const repoReady = !repoRoot || (await repositoryHasChanges(repoRoot, input.logger));

          if (hasAllHeadings && codeWritingEnabled && repoReady) {
            return { handoffPath, repoRoot };
          }
        }

        await sleep(pollIntervalMs);
      }

      throw new Error(
        `Timed out waiting for OpenClaw developer completion for session ${input.sessionKey}.`
      );
    }
  };
}

export interface GitWorkspaceCommitPublisherOptions {
  userName?: string;
  userEmail?: string;
  tokenEnvVar?: string;
}

export function createGitWorkspaceCommitPublisher(
  options: GitWorkspaceCommitPublisherOptions = {}
): WorkspaceCommitPublisher {
  const userName = options.userName ?? "RedDwarf";
  const userEmail = options.userEmail ?? "reddwarf@local.invalid";
  const tokenEnvVar = options.tokenEnvVar ?? "GITHUB_TOKEN";

  return {
    async publish(input) {
      const repoRoot = readWorkspaceRepoRoot(input.workspace);
      if (!repoRoot) {
        throw new Error(`Workspace ${input.workspace.workspaceId} does not have a repo checkout to publish.`);
      }

      await runCommand("git", ["checkout", "-B", input.branchName], repoRoot, input.logger);
      await runCommand("git", ["config", "user.name", userName], repoRoot, input.logger);
      await runCommand("git", ["config", "user.email", userEmail], repoRoot, input.logger);

      const statusBefore = await runCommand("git", ["status", "--porcelain"], repoRoot, input.logger);
      const uncommittedChangedFiles = parseGitStatusChangedFiles(statusBefore.stdout);
      const hasUncommittedChanges = uncommittedChangedFiles.length > 0;

      assertChangedFilesWithinAllowedPaths({
        workspaceId: input.workspace.workspaceId,
        allowedPaths: input.allowedPaths,
        changedFiles: uncommittedChangedFiles
      });

      if (hasUncommittedChanges) {
        await runCommand("git", ["add", "--all"], repoRoot, input.logger);
        await runCommand(
          "git",
          ["commit", "-m", `[RedDwarf] ${input.manifest.title}`],
          repoRoot,
          input.logger
        );
      } else {
        // The developer agent may have already committed changes directly.
        // Verify there are commits beyond the base branch before proceeding.
        const revCount = await runCommand(
          "git",
          ["rev-list", "--count", `${input.baseBranch}..HEAD`],
          repoRoot,
          input.logger
        );
        if (parseInt(revCount.stdout.trim(), 10) === 0) {
          throw new Error(`Workspace ${input.workspace.workspaceId} does not contain any product-repo changes to publish.`);
        }
      }

      const commitSha = (await runCommand("git", ["rev-parse", "HEAD"], repoRoot, input.logger)).stdout.trim();
      const changedFiles = (await runCommand(
        "git",
        ["diff", "--name-only", `${input.baseBranch}..HEAD`],
        repoRoot,
        input.logger
      )).stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      assertChangedFilesWithinAllowedPaths({
        workspaceId: input.workspace.workspaceId,
        allowedPaths: input.allowedPaths,
        changedFiles
      });

      const diff = (await runCommand(
        "git",
        ["diff", `${input.baseBranch}..HEAD`],
        repoRoot,
        input.logger
      )).stdout;
      const pushRemote = buildGitHubRemoteUrl(
        input.manifest.source.repo,
        process.env[tokenEnvVar] ?? null
      );

      await runCommand(
        "git",
        ["push", "-u", pushRemote, `${input.branchName}:${input.branchName}`],
        repoRoot,
        input.logger
      );

      return {
        branch: {
          repo: input.manifest.source.repo,
          baseBranch: input.baseBranch,
          branchName: input.branchName,
          ref: `refs/heads/${input.branchName}`,
          url: `https://github.com/${input.manifest.source.repo}/tree/${encodeURIComponent(input.branchName)}`,
          createdAt: asIsoTimestamp()
        },
        commitSha,
        changedFiles,
        diff
      };
    }
  };
}

async function repositoryHasChanges(
  repoRoot: string,
  logger?: PlanningPipelineLogger
): Promise<boolean> {
  if (!(await pathExists(join(repoRoot, ".git")))) {
    return false;
  }

  const status = await runCommand("git", ["status", "--porcelain"], repoRoot, logger);
  if (status.stdout.trim().length > 0) {
    return true;
  }

  // Also detect committed changes: compare HEAD against the initial clone ref.
  // A shallow clone with --depth 1 starts with exactly one commit; any additional
  // local commits indicate the developer agent made and committed changes.
  try {
    const revCount = await runCommand("git", ["rev-list", "--count", "HEAD"], repoRoot, logger);
    return parseInt(revCount.stdout.trim(), 10) > 1;
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCommand(
  executable: string,
  args: string[],
  cwd: string,
  logger?: PlanningPipelineLogger
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      const stdout = stdoutChunks.join("");
      const stderr = stderrChunks.join("");
      if ((exitCode ?? 1) !== 0) {
        reject(
          new Error(
            `Command ${executable} ${args.join(" ")} failed in ${cwd} with exit code ${exitCode ?? 1}: ${stderr || stdout}`
          )
        );
        return;
      }
      logger?.info?.("External command completed.", {
        executable,
        args,
        cwd
      });
      resolve({ stdout, stderr });
    });
  });
}

function parseGitStatusChangedFiles(statusOutput: string): string[] {
  return statusOutput
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length >= 4)
    .map((line) => line.slice(3).trim())
    .map((path) => {
      const renameSeparator = path.lastIndexOf(" -> ");
      return renameSeparator >= 0 ? path.slice(renameSeparator + 4) : path;
    })
    .filter((path) => path.length > 0);
}

function assertChangedFilesWithinAllowedPaths(input: {
  workspaceId: string;
  allowedPaths: string[];
  changedFiles: string[];
}): void {
  const violatingFiles = findDisallowedChangedFiles(
    input.changedFiles,
    input.allowedPaths
  );

  if (violatingFiles.length === 0) {
    return;
  }

  throw new AllowedPathViolationError({
    workspaceId: input.workspaceId,
    allowedPaths: input.allowedPaths,
    changedFiles: input.changedFiles,
    violatingFiles
  });
}

function normalizeRepoRelativePath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
}

function repoPathMatchesAllowedPattern(
  repoPath: string,
  allowedPath: string
): boolean {
  return globPatternToRegExp(allowedPath).test(repoPath);
}

function globPatternToRegExp(pattern: string): RegExp {
  let regex = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    const nextCharacter = pattern[index + 1] ?? "";

    if (character === "*" && nextCharacter === "*") {
      regex += ".*";
      index += 1;
      continue;
    }

    if (character === "*") {
      regex += "[^/]*";
      continue;
    }

    if (/[\\[\]{}()+?.^$|]/.test(character)) {
      regex += `\\${character}`;
      continue;
    }

    regex += character;
  }

  regex += "$";
  return new RegExp(regex);
}

function buildGitHubRemoteUrl(repo: string, token: string | null): string {
  return token && token.trim().length > 0
    ? `https://x-access-token:${encodeURIComponent(token)}@github.com/${repo}.git`
    : `https://github.com/${repo}.git`;
}

