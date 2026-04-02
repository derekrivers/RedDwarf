import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  architectureReviewReportSchema,
  asIsoTimestamp,
  capabilities,
  type MaterializedManagedWorkspace,
  type TaskManifest
} from "@reddwarf/contracts";
import type {
  GitHubBranchSummary,
  OpenClawDispatchResult
} from "@reddwarf/integrations";
import type { PlanningPipelineLogger } from "./logger.js";
import { formatLiteralList } from "./workspace.js";

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

export interface ArchitectureReviewCompletionResult {
  reportPath: string;
  repoRoot: string | null;
}

export interface OpenClawCompletionAwaiter {
  waitForCompletion(input: {
    manifest: TaskManifest;
    workspace: MaterializedManagedWorkspace;
    sessionKey: string;
    dispatchResult: OpenClawDispatchResult;
    logger?: PlanningPipelineLogger;
    onHeartbeat: (() => Promise<void>) | undefined;
    heartbeatIntervalMs?: number;
  }): Promise<OpenClawCompletionResult>;
}

export interface ArchitectureReviewCompletionAwaiter {
  waitForCompletion(input: {
    manifest: TaskManifest;
    workspace: MaterializedManagedWorkspace;
    sessionKey: string;
    dispatchResult: OpenClawDispatchResult;
    logger?: PlanningPipelineLogger;
    onHeartbeat: (() => Promise<void>) | undefined;
    heartbeatIntervalMs?: number;
  }): Promise<ArchitectureReviewCompletionResult>;
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

export const DEFAULT_OPENCLAW_COMPLETION_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_OPENCLAW_HEARTBEAT_INTERVAL_MS = 30 * 1000;
export const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const COMMAND_FORCE_KILL_AFTER_TIMEOUT_MS = 5 * 1000;

export class OpenClawCompletionTimeoutError extends Error {
  readonly sessionKey: string;
  readonly timeoutMs: number;

  constructor(input: { sessionKey: string; timeoutMs: number; phase: "architect" | "developer" | "reviewer" }) {
    super(
      `Timed out waiting for OpenClaw ${input.phase} completion for session ${input.sessionKey} after ${input.timeoutMs}ms.`
    );
    this.name = "OpenClawCompletionTimeoutError";
    this.sessionKey = input.sessionKey;
    this.timeoutMs = input.timeoutMs;
  }
}

export class ExternalCommandTimeoutError extends Error {
  readonly executable: string;
  readonly args: string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(input: {
    executable: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
    stdout: string;
    stderr: string;
    redactValues?: string[] | undefined;
  }) {
    super(
      sanitizeSecretBearingText(
        `Command ${input.executable} ${input.args.join(" ")} timed out in ${input.cwd} after ${input.timeoutMs}ms: ${input.stderr || input.stdout || "(no output)"}`,
        input.redactValues ?? []
      )
    );
    this.name = "ExternalCommandTimeoutError";
    this.executable = input.executable;
    this.args = [...input.args];
    this.cwd = input.cwd;
    this.timeoutMs = input.timeoutMs;
    this.stdout = input.stdout;
    this.stderr = input.stderr;
  }
}

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
  const allowedCapabilities = capabilities.filter(
    (capability) =>
      capability === "can_write_code" ||
      workspace.descriptor.toolPolicy.allowedCapabilities.includes(capability)
  );
  const deniedCapabilities = capabilities.filter(
    (capability) => !allowedCapabilities.includes(capability)
  );

  workspace.descriptor.toolPolicy.mode = "development_readwrite";
  workspace.descriptor.toolPolicy.codeWriteEnabled = true;
  workspace.descriptor.toolPolicy.allowedCapabilities = allowedCapabilities;
  workspace.descriptor.allowedCapabilities = [
    ...new Set<import("@reddwarf/contracts").Capability>([
      ...workspace.descriptor.allowedCapabilities,
      "can_write_code"
    ])
  ];
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

  const toolsPath = workspace.instructions.files.toolsMd;
  const soulPath = workspace.instructions.files.soulMd;
  const taskSkillPath = workspace.instructions.files.taskSkillMd;

  const toolsContent = await readFile(toolsPath, "utf8");
  await writeFile(
    toolsPath,
    toolsContent
      .replace(
        /- Tool policy mode: `[^`]+`/,
        "- Tool policy mode: `development_readwrite`"
      )
      .replace(/- Code writing enabled: no/, "- Code writing enabled: yes")
      .replace(
        /- Allowed capabilities now: .*/,
        `- Allowed capabilities now: ${formatLiteralList(allowedCapabilities)}`
      )
      .replace(
        /- Currently denied capabilities: .*/,
        `- Currently denied capabilities: ${formatLiteralList(deniedCapabilities)}`
      )
      .replace(
        /Developer orchestration is enabled in RedDwarf v1, but product code writes remain disabled by default\./,
        "Developer orchestration is enabled in RedDwarf v1 with product code writes enabled for this approved task."
      ),
    "utf8"
  );

  const soulContent = await readFile(soulPath, "utf8");
  await writeFile(
    soulPath,
    soulContent.replace(
      "- Product code writes remain disabled; stay inside the approved workspace and path scope.",
      "- Product code writes are enabled for this approved development task; stay inside the approved workspace and path scope."
    ),
    "utf8"
  );

  const taskSkillContent = await readFile(taskSkillPath, "utf8");
  await writeFile(
    taskSkillPath,
    taskSkillContent.replace(
      "6. Escalate whenever the task would require code-writing, secrets outside approved scopes, or a blocked phase in v1.",
      "6. Escalate whenever the task would require secrets outside approved scopes or a blocked phase in v1."
    ),
    "utf8"
  );
}

export interface GitHubWorkspaceRepoBootstrapperOptions {
  tokenEnvVar?: string;
  commandTimeoutMs?: number;
}

export function createGitHubWorkspaceRepoBootstrapper(
  options: GitHubWorkspaceRepoBootstrapperOptions = {}
): WorkspaceRepoBootstrapper {
  const tokenEnvVar = options.tokenEnvVar ?? "GITHUB_TOKEN";
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;

  return {
    async ensureRepo(input) {
      const repoRoot = join(input.workspace.workspaceRoot, "repo");
      const remoteUrl = buildGitHubRemoteUrl(input.manifest.source.repo);

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
        input.logger,
        {
          ...createGitHubCommandOptions(process.env[tokenEnvVar] ?? null),
          timeoutMs: commandTimeoutMs
        }
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
  heartbeatIntervalMs?: number;
}

export function createArchitectHandoffAwaiter(
  options: ArchitectHandoffAwaiterOptions = {}
): OpenClawCompletionAwaiter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPENCLAW_COMPLETION_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const defaultHeartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_OPENCLAW_HEARTBEAT_INTERVAL_MS;

  return {
    async waitForCompletion(input) {
      const handoffPath = join(input.workspace.artifactsDir, "architect-handoff.md");
      const deadline = Date.now() + timeoutMs;
      let lastHeartbeatAt = Date.now();
      const heartbeatIntervalMs =
        input.heartbeatIntervalMs ?? defaultHeartbeatIntervalMs;

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

        lastHeartbeatAt = await emitHeartbeatIfDue({
          lastHeartbeatAt,
          heartbeatIntervalMs,
          onHeartbeat: input.onHeartbeat
        });
        await sleep(pollIntervalMs);
      }

      throw new OpenClawCompletionTimeoutError({
        sessionKey: input.sessionKey,
        timeoutMs,
        phase: "architect"
      });
    }
  };
}

export interface DeveloperHandoffAwaiterOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
}

export function createDeveloperHandoffAwaiter(
  options: DeveloperHandoffAwaiterOptions = {}
): OpenClawCompletionAwaiter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPENCLAW_COMPLETION_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const defaultHeartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_OPENCLAW_HEARTBEAT_INTERVAL_MS;

  return {
    async waitForCompletion(input) {
      const handoffPath = join(input.workspace.artifactsDir, "developer-handoff.md");
      const repoRoot = readWorkspaceRepoRoot(input.workspace);
      const deadline = Date.now() + timeoutMs;
      let lastHeartbeatAt = Date.now();
      const heartbeatIntervalMs =
        input.heartbeatIntervalMs ?? defaultHeartbeatIntervalMs;

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

        lastHeartbeatAt = await emitHeartbeatIfDue({
          lastHeartbeatAt,
          heartbeatIntervalMs,
          onHeartbeat: input.onHeartbeat
        });
        await sleep(pollIntervalMs);
      }

      throw new OpenClawCompletionTimeoutError({
        sessionKey: input.sessionKey,
        timeoutMs,
        phase: "developer"
      });
    }
  };
}

export interface ArchitectureReviewAwaiterOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
}

export function createArchitectureReviewAwaiter(
  options: ArchitectureReviewAwaiterOptions = {}
): ArchitectureReviewCompletionAwaiter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPENCLAW_COMPLETION_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const defaultHeartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_OPENCLAW_HEARTBEAT_INTERVAL_MS;

  return {
    async waitForCompletion(input) {
      const reportPath = join(input.workspace.artifactsDir, "architecture-review.json");
      const repoRoot = readWorkspaceRepoRoot(input.workspace);
      const deadline = Date.now() + timeoutMs;
      let lastHeartbeatAt = Date.now();
      const heartbeatIntervalMs =
        input.heartbeatIntervalMs ?? defaultHeartbeatIntervalMs;

      while (Date.now() < deadline) {
        if (await pathExists(reportPath)) {
          try {
            const report = JSON.parse(await readFile(reportPath, "utf8"));
            architectureReviewReportSchema.parse(report);
            return { reportPath, repoRoot };
          } catch {
            // keep polling until the agent writes a valid structured verdict
          }
        }

        lastHeartbeatAt = await emitHeartbeatIfDue({
          lastHeartbeatAt,
          heartbeatIntervalMs,
          onHeartbeat: input.onHeartbeat
        });
        await sleep(pollIntervalMs);
      }

      throw new OpenClawCompletionTimeoutError({
        sessionKey: input.sessionKey,
        timeoutMs,
        phase: "reviewer"
      });
    }
  };
}

export interface GitWorkspaceCommitPublisherOptions {
  userName?: string;
  userEmail?: string;
  tokenEnvVar?: string;
  commandTimeoutMs?: number;
}

export function createGitWorkspaceCommitPublisher(
  options: GitWorkspaceCommitPublisherOptions = {}
): WorkspaceCommitPublisher {
  const userName = options.userName ?? "RedDwarf";
  const userEmail = options.userEmail ?? "reddwarf@local.invalid";
  const tokenEnvVar = options.tokenEnvVar ?? "GITHUB_TOKEN";
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;

  return {
    async publish(input) {
      const repoRoot = readWorkspaceRepoRoot(input.workspace);
      if (!repoRoot) {
        throw new Error(`Workspace ${input.workspace.workspaceId} does not have a repo checkout to publish.`);
      }

      const commandOptions = { timeoutMs: commandTimeoutMs };

      await runCommand("git", ["checkout", "-B", input.branchName], repoRoot, input.logger, commandOptions);
      await runCommand("git", ["config", "user.name", userName], repoRoot, input.logger, commandOptions);
      await runCommand("git", ["config", "user.email", userEmail], repoRoot, input.logger, commandOptions);

      const statusBefore = await runCommand("git", ["status", "--porcelain"], repoRoot, input.logger, commandOptions);
      const uncommittedChangedFiles = parseGitStatusChangedFiles(statusBefore.stdout);
      const hasUncommittedChanges = uncommittedChangedFiles.length > 0;

      assertChangedFilesWithinAllowedPaths({
        workspaceId: input.workspace.workspaceId,
        allowedPaths: input.allowedPaths,
        changedFiles: uncommittedChangedFiles
      });

      if (hasUncommittedChanges) {
        await runCommand("git", ["add", "--all"], repoRoot, input.logger, commandOptions);
        await runCommand(
          "git",
          ["commit", "-m", `[RedDwarf] ${input.manifest.title}`],
          repoRoot,
          input.logger,
          commandOptions
        );
      } else {
        // The developer agent may have already committed changes directly.
        // Verify there are commits beyond the base branch before proceeding.
        const revCount = await runCommand(
          "git",
          ["rev-list", "--count", `${input.baseBranch}..HEAD`],
          repoRoot,
          input.logger,
          commandOptions
        );
        if (parseInt(revCount.stdout.trim(), 10) === 0) {
          throw new Error(`Workspace ${input.workspace.workspaceId} does not contain any product-repo changes to publish.`);
        }
      }

      const commitSha = (await runCommand("git", ["rev-parse", "HEAD"], repoRoot, input.logger, commandOptions)).stdout.trim();
      const changedFiles = (await runCommand(
        "git",
        ["diff", "--name-only", `${input.baseBranch}..HEAD`],
        repoRoot,
        input.logger,
        commandOptions
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
        input.logger,
        commandOptions
      )).stdout;
      const githubCommandOptions = {
        ...createGitHubCommandOptions(process.env[tokenEnvVar] ?? null),
        timeoutMs: commandTimeoutMs
      };
      const pushRemote = buildGitHubRemoteUrl(input.manifest.source.repo);

      await runCommand(
        "git",
        ["push", "-u", pushRemote, `${input.branchName}:${input.branchName}`],
        repoRoot,
        input.logger,
        githubCommandOptions
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

interface GitHubCommandOptions extends CommandExecutionOptions {}

function createGitHubCommandOptions(
  token: string | null | undefined
): GitHubCommandOptions {
  const trimmedToken = token?.trim() ?? "";

  if (trimmedToken.length === 0) {
    return {};
  }

  const encodedCredential = Buffer.from(
    `x-access-token:${trimmedToken}`,
    "utf8"
  ).toString("base64");

  return {
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${encodedCredential}`
    },
    redactValues: [trimmedToken, encodedCredential]
  };
}

export function sanitizeSecretBearingText(
  value: string,
  redactValues: string[] = []
): string {
  let sanitized = value;

  for (const candidate of redactValues) {
    if (candidate.trim().length === 0) {
      continue;
    }

    sanitized = sanitized.split(candidate).join("[REDACTED]");
  }

  sanitized = sanitized.replace(
    /https:\/\/x-access-token:[^@\s]+@github\.com\//gi,
    "https://x-access-token:[REDACTED]@github.com/"
  );
  sanitized = sanitized.replace(
    /authorization:\s*basic\s+[a-z0-9+/=]+/gi,
    "AUTHORIZATION: basic [REDACTED]"
  );
  sanitized = sanitized.replace(
    /authorization:\s*bearer\s+[^\s]+/gi,
    "Authorization: Bearer [REDACTED]"
  );

  return sanitized;
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

async function emitHeartbeatIfDue(input: {
  lastHeartbeatAt: number;
  heartbeatIntervalMs: number;
  onHeartbeat: (() => Promise<void>) | undefined;
}): Promise<number> {
  if (!input.onHeartbeat) {
    return input.lastHeartbeatAt;
  }

  const now = Date.now();
  if (now - input.lastHeartbeatAt < input.heartbeatIntervalMs) {
    return input.lastHeartbeatAt;
  }

  await input.onHeartbeat();
  return now;
}

interface CommandExecutionOptions {
  env?: NodeJS.ProcessEnv;
  redactValues?: string[];
  timeoutMs?: number;
}

async function runCommand(
  executable: string,
  args: string[],
  cwd: string,
  logger?: PlanningPipelineLogger,
  options: CommandExecutionOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | null = null;
    let forceKillHandle: NodeJS.Timeout | null = null;

    const clearTimers = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (forceKillHandle) {
        clearTimeout(forceKillHandle);
        forceKillHandle = null;
      }
    };

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill();
        forceKillHandle = setTimeout(() => {
          child.kill("SIGKILL");
        }, COMMAND_FORCE_KILL_AFTER_TIMEOUT_MS);
      }, timeoutMs);
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      clearTimers();
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimers();
      const stdout = stdoutChunks.join("");
      const stderr = stderrChunks.join("");
      if (timedOut) {
        reject(
          new ExternalCommandTimeoutError({
            executable,
            args,
            cwd,
            timeoutMs,
            stdout,
            stderr,
            redactValues: options.redactValues
          })
        );
        return;
      }
      if ((exitCode ?? 1) !== 0) {
        reject(
          new Error(
            sanitizeSecretBearingText(
              `Command ${executable} ${args.join(" ")} failed in ${cwd} with exit code ${exitCode ?? 1}: ${stderr || stdout}`,
              options.redactValues
            )
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

function buildGitHubRemoteUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}



