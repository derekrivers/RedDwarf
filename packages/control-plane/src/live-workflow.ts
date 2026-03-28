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
    logger?: PlanningPipelineLogger;
  }): Promise<WorkspaceCommitPublicationResult>;
}

type RepoAwareWorkspace = MaterializedManagedWorkspace & { repoRoot?: string | null };

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
      const statusBefore = await runCommand("git", ["status", "--porcelain"], repoRoot, input.logger);
      if (statusBefore.stdout.trim().length === 0) {
        throw new Error(`Workspace ${input.workspace.workspaceId} does not contain any product-repo changes to publish.`);
      }

      await runCommand("git", ["config", "user.name", userName], repoRoot, input.logger);
      await runCommand("git", ["config", "user.email", userEmail], repoRoot, input.logger);
      await runCommand("git", ["add", "--all"], repoRoot, input.logger);
      await runCommand(
        "git",
        ["commit", "-m", `[RedDwarf] ${input.manifest.title}`],
        repoRoot,
        input.logger
      );

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
  return status.stdout.trim().length > 0;
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

function buildGitHubRemoteUrl(repo: string, token: string | null): string {
  return token && token.trim().length > 0
    ? `https://x-access-token:${encodeURIComponent(token)}@github.com/${repo}.git`
    : `https://github.com/${repo}.git`;
}

