import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
import {
  expandAllowedPathsForGeneratedArtifacts,
  isIgnoredGeneratedRepoPath,
  normalizeAllowedPaths,
  normalizeChangedRepoPath
} from "./allowed-paths.js";
import type { PlanningPipelineLogger } from "./logger.js";
import { normalizeOpenClawSessionKey } from "./openclaw-session-key.js";
import { readSessionTranscript } from "./openclaw-session.js";
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
    deniedPaths: string[];
    logger?: PlanningPipelineLogger;
  }): Promise<WorkspaceCommitPublicationResult>;
}

type RepoAwareWorkspace = MaterializedManagedWorkspace & { repoRoot?: string | null };

export const DEFAULT_OPENCLAW_COMPLETION_TIMEOUT_MS = 15 * 60 * 1000;
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

export class OpenClawSessionTerminatedError extends Error {
  readonly sessionKey: string;
  readonly sessionId: string | null;
  readonly agentId: string | null;
  readonly transcriptPath: string;
  readonly stopReason: string | null;
  readonly errorMessage: string | null;
  readonly totalEntries: number;

  constructor(input: {
    sessionKey: string;
    sessionId?: string | null;
    agentId?: string | null;
    transcriptPath: string;
    stopReason?: string | null;
    errorMessage?: string | null;
    totalEntries: number;
  }) {
    super(
      `OpenClaw session ${input.sessionKey} terminated before producing the required handoff` +
        `${input.stopReason ? ` (stopReason=${input.stopReason})` : ""}` +
        `${input.errorMessage ? `: ${input.errorMessage}` : "."}`
    );
    this.name = "OpenClawSessionTerminatedError";
    this.sessionKey = input.sessionKey;
    this.sessionId = input.sessionId ?? null;
    this.agentId = input.agentId ?? null;
    this.transcriptPath = input.transcriptPath;
    this.stopReason = input.stopReason ?? null;
    this.errorMessage = input.errorMessage ?? null;
    this.totalEntries = input.totalEntries;
  }
}

export class OpenClawSessionStalledError extends Error {
  readonly sessionKey: string;
  readonly sessionId: string | null;
  readonly agentId: string | null;
  readonly transcriptPath: string;
  readonly idleMs: number;
  readonly totalEntries: number;
  readonly lastUpdatedAt: string;

  constructor(input: {
    sessionKey: string;
    sessionId?: string | null;
    agentId?: string | null;
    transcriptPath: string;
    idleMs: number;
    totalEntries: number;
    lastUpdatedAt: string;
  }) {
    super(
      `OpenClaw session ${input.sessionKey} stalled before producing the required handoff after ${input.idleMs}ms without transcript growth.`
    );
    this.name = "OpenClawSessionStalledError";
    this.sessionKey = input.sessionKey;
    this.sessionId = input.sessionId ?? null;
    this.agentId = input.agentId ?? null;
    this.transcriptPath = input.transcriptPath;
    this.idleMs = input.idleMs;
    this.totalEntries = input.totalEntries;
    this.lastUpdatedAt = input.lastUpdatedAt;
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
  readonly deniedPaths: string[];
  readonly changedFiles: string[];
  readonly violatingFiles: string[];

  constructor(input: {
    workspaceId: string;
    deniedPaths: string[];
    changedFiles: string[];
    violatingFiles: string[];
  }) {
    const scopeLabel =
      input.deniedPaths.length > 0 ? input.deniedPaths.join(", ") : "none";
    const violatingLabel = input.violatingFiles.join(", ");
    super(
      `Workspace ${input.workspaceId} changed files inside blocked repo paths. Blocked paths: ${scopeLabel}. Violating files: ${violatingLabel}.`
    );
    this.name = "AllowedPathViolationError";
    this.deniedPaths = [...input.deniedPaths];
    this.changedFiles = [...input.changedFiles];
    this.violatingFiles = [...input.violatingFiles];
  }
}

export function findDeniedChangedFiles(
  changedFiles: string[],
  deniedPaths: string[]
): string[] {
  const normalizedDeniedPaths = normalizeAllowedPaths(deniedPaths);

  return [...new Set(
    changedFiles
      .map((value) => normalizeChangedRepoPath(value))
      .filter((value) => value.length > 0)
      .filter((value) => !isIgnoredGeneratedRepoPath(value))
      .filter(
        (changedFile) =>
          normalizedDeniedPaths.some((deniedPath) =>
            repoPathMatchesPattern(changedFile, deniedPath)
          )
      )
  )].sort((left, right) => left.localeCompare(right));
}

export function findDisallowedChangedFiles(
  changedFiles: string[],
  deniedPaths: string[]
): string[] {
  return findDeniedChangedFiles(changedFiles, deniedPaths);
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

export async function assertWorkspaceRepoChangesWithinAllowedPaths(
  workspace: MaterializedManagedWorkspace,
  logger?: PlanningPipelineLogger
): Promise<void> {
  const repoRoot = readWorkspaceRepoRoot(workspace);
  if (!repoRoot) {
    return;
  }

  const statusBefore = await runCommand(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    repoRoot,
    logger
  );
  const changedFiles = parseGitStatusChangedFiles(statusBefore.stdout);

  assertChangedFilesAvoidDeniedPaths({
    workspaceId: workspace.workspaceId,
    deniedPaths: workspace.descriptor.deniedPaths,
    changedFiles
  });
}

const CAN_WRITE_CODE_GUIDANCE =
  "Write or modify product code only after the development phase is enabled and policy grants it. " +
  "When creating or replacing any file that is likely to exceed 150 lines, you must write it in multiple passes: " +
  "write a minimal working scaffold first, then build out each logical section with separate follow-up edit calls. " +
  "Do not attempt to produce a complete large file in a single write tool call. " +
  "Each intermediate write should leave the file syntactically valid or clearly marked as in-progress.";

function applyRequiredPatch(
  content: string,
  search: string | RegExp,
  replacement: string,
  description: string,
  alreadyApplied?: string | RegExp
): string {
  if (alreadyApplied) {
    const alreadyAppliedMatcher =
      typeof alreadyApplied === "string"
        ? alreadyApplied
        : new RegExp(alreadyApplied.source, alreadyApplied.flags.replace(/g/g, ""));

    if (
      typeof alreadyAppliedMatcher === "string"
        ? content.includes(alreadyAppliedMatcher)
        : alreadyAppliedMatcher.test(content)
    ) {
      return content;
    }
  }

  const searchMatcher =
    typeof search === "string"
      ? search
      : new RegExp(search.source, search.flags.replace(/g/g, ""));

  if (
    typeof searchMatcher === "string"
      ? !content.includes(searchMatcher)
      : !searchMatcher.test(content)
  ) {
    throw new Error(
      `enableWorkspaceCodeWriting: required patch "${description}" could not be applied — the expected string was not found. The workspace instruction files may be out of sync with the current runtime.`
    );
  }

  const patched = content.replace(search as string, replacement);

  if (patched === content) {
    throw new Error(
      `enableWorkspaceCodeWriting: required patch "${description}" could not be applied — the expected string was not found. The workspace instruction files may be out of sync with the current runtime.`
    );
  }

  return patched;
}

export async function enableWorkspaceCodeWriting(
  workspace: MaterializedManagedWorkspace
): Promise<void> {
  // Idempotency guard: if already upgraded in memory, the files are already patched.
  if (workspace.descriptor.toolPolicy.codeWriteEnabled) {
    return;
  }

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

  // --- TOOLS.md patches ---
  let toolsContent = await readFile(toolsPath, "utf8");

  toolsContent = applyRequiredPatch(
    toolsContent,
    /- Tool policy mode: `[^`]+`/,
    "- Tool policy mode: `development_readwrite`",
    "tool policy mode line",
    "- Tool policy mode: `development_readwrite`"
  );
  toolsContent = applyRequiredPatch(
    toolsContent,
    "- Code writing enabled: no",
    "- Code writing enabled: yes",
    "code writing enabled line",
    "- Code writing enabled: yes"
  );
  toolsContent = applyRequiredPatch(
    toolsContent,
    /- Allowed capabilities now: .*/,
    `- Allowed capabilities now: ${formatLiteralList(allowedCapabilities)}`,
    "allowed capabilities now line",
    `- Allowed capabilities now: ${formatLiteralList(allowedCapabilities)}`
  );
  toolsContent = applyRequiredPatch(
    toolsContent,
    /- Currently denied capabilities: .*/,
    `- Currently denied capabilities: ${formatLiteralList(deniedCapabilities)}`,
    "currently denied capabilities line",
    `- Currently denied capabilities: ${formatLiteralList(deniedCapabilities)}`
  );
  toolsContent = applyRequiredPatch(
    toolsContent,
    /- Developer orchestration is enabled in RedDwarf v1.*product code writes.*\./,
    "- Developer orchestration is enabled in RedDwarf v1 with product code writes enabled for this approved task.",
    "tool policy note",
    "- Developer orchestration is enabled in RedDwarf v1 with product code writes enabled for this approved task."
  );

  // Remove can_write_code from "Requested but denied" — it is now granted.
  toolsContent = toolsContent.replace(
    /^(- Requested but denied: )(`[^`]+`(?:, `[^`]+`)*)$/m,
    (_, prefix: string, list: string) => {
      const items = list.split(", ").filter((item) => item !== "`can_write_code`");
      return items.length === 0 ? `${prefix}none` : `${prefix}${items.join(", ")}`;
    }
  );

  // Remove "writing product code" from Escalate Instead Of — writes are now approved.
  const toolsWithoutWriteEscalation = toolsContent.replace(
    "\n- writing product code\n",
    "\n"
  );
  if (toolsWithoutWriteEscalation !== toolsContent) {
    toolsContent = toolsWithoutWriteEscalation;
  }

  // Insert can_write_code guidance so developers understand its scope.
  toolsContent = applyRequiredPatch(
    toolsContent,
    "## Allowed Capability Guidance\n\n",
    `## Allowed Capability Guidance\n\n### \`can_write_code\`\n\n${CAN_WRITE_CODE_GUIDANCE}\n\n`,
    "Allowed Capability Guidance section header",
    "### `can_write_code`"
  );

  await writeFile(toolsPath, toolsContent, "utf8");

  // --- SOUL.md patches ---
  let soulContent = await readFile(soulPath, "utf8");

  soulContent = applyRequiredPatch(
    soulContent,
    /- Product code writes .* stay inside the managed workspace and do not touch blocked repo paths\./,
    "- Product code writes are enabled for this approved development task; stay inside the managed workspace and do not touch blocked repo paths.",
    "product code writes guardrail line",
    "- Product code writes are enabled for this approved development task; stay inside the managed workspace and do not touch blocked repo paths."
  );

  // Add can_write_code to the Allowed capabilities list.
  soulContent = soulContent.replace(
    /^(- Allowed capabilities: )(`[^`]+`(?:, `[^`]+`)*)$/m,
    (_, prefix: string, list: string) => {
      const items = list.split(", ");
      if (!items.includes("`can_write_code`")) {
        items.unshift("`can_write_code`");
      }
      return `${prefix}${items.join(", ")}`;
    }
  );

  await writeFile(soulPath, soulContent, "utf8");

  // --- Task skill patches ---
  // Two variants exist depending on whether can_open_pr is in the policy. Both list
  // "code-writing" as something to escalate for; strip it from whichever variant is present.
  let taskSkillContent = await readFile(taskSkillPath, "utf8");

  taskSkillContent = applyRequiredPatch(
    taskSkillContent,
    /6\. Escalate whenever the task would require code-writing, (secrets[^.]+\.)/,
    "6. Escalate whenever the task would require $1",
    "escalation rule in task skill",
    /6\. Escalate whenever the task would require secrets[^.]+\./
  );

  await writeFile(taskSkillPath, taskSkillContent, "utf8");
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
  handoffFileName?: string;
  requiredHeadings?: readonly string[];
}

export function createArchitectHandoffAwaiter(
  options: ArchitectHandoffAwaiterOptions = {}
): OpenClawCompletionAwaiter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPENCLAW_COMPLETION_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const defaultHeartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_OPENCLAW_HEARTBEAT_INTERVAL_MS;
  const handoffFileName = options.handoffFileName ?? "architect-handoff.md";
  const requiredHeadings = options.requiredHeadings ?? [
    "# Architecture Handoff",
    "## Summary",
    "## Implementation Approach",
    "## Affected Files",
    "## Risks and Assumptions",
    "## Test Strategy"
  ];

  return {
    async waitForCompletion(input) {
      const handoffPath = join(input.workspace.artifactsDir, handoffFileName);
      const deadline = Date.now() + timeoutMs;
      let lastHeartbeatAt = Date.now();
      const heartbeatIntervalMs =
        input.heartbeatIntervalMs ?? defaultHeartbeatIntervalMs;

      while (Date.now() < deadline) {
        if (await pathExists(handoffPath)) {
          const handoff = await readFile(handoffPath, "utf8");
          const hasAllHeadings = requiredHeadings.every((heading) =>
            handoff.includes(heading)
          );

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
  /**
   * How long transcript silence triggers a stall error when the session is
   * NOT currently executing a tool call. Defaults to 2 minutes.
   *
   * Keep this short — it catches sessions that have genuinely gone quiet
   * between turns (e.g. the provider stopped responding mid-conversation).
   */
  sessionIdleTimeoutMs?: number;
  /**
   * How long transcript silence is tolerated when the last assistant entry
   * has `stopReason: "toolUse"` (i.e. a tool call is in flight). Defaults to
   * 8 minutes.
   *
   * This should be large enough to cover slow but legitimate operations such
   * as `npm install`, a full test suite run, or a large file-system scan.
   * The agent itself will produce a new transcript entry the moment the tool
   * result arrives, which resets the sliding deadline automatically.
   */
  toolExecutionGracePeriodMs?: number;
  openClawHomePath?: string;
  maxRuntimeMs?: number;
  /**
   * How long to wait before flagging a code-write session that has produced
   * zero write tool calls. When elapsed with no write operations and
   * `codeWriteEnabled` is true, the effective idle timeout is tightened to
   * catch sessions stuck in long planning or single-write attempts. Defaults
   * to 4 minutes.
   */
  noWriteActivityWarningMs?: number;
  /**
   * Tightened idle timeout applied when `noWriteActivityWarningMs` has
   * elapsed with zero write operations. Defaults to 60 seconds (versus the
   * normal 2-minute sessionIdleTimeoutMs).
   */
  tightenedIdleTimeoutMs?: number;
}

export function createDeveloperHandoffAwaiter(
  options: DeveloperHandoffAwaiterOptions = {}
): OpenClawCompletionAwaiter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPENCLAW_COMPLETION_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const defaultHeartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_OPENCLAW_HEARTBEAT_INTERVAL_MS;
  const sessionIdleTimeoutMs = options.sessionIdleTimeoutMs ?? 2 * 60 * 1000;
  const toolExecutionGracePeriodMs = options.toolExecutionGracePeriodMs ?? 8 * 60 * 1000;
  const openClawHomePath = resolveOpenClawHomePath(options.openClawHomePath);
  const maxRuntimeMs = options.maxRuntimeMs ?? null;
  const noWriteActivityWarningMs = options.noWriteActivityWarningMs ?? 4 * 60 * 1000;
  const tightenedIdleTimeoutMs = options.tightenedIdleTimeoutMs ?? 60 * 1000;

  return {
    async waitForCompletion(input) {
      const handoffPath = join(input.workspace.artifactsDir, "developer-handoff.md");
      const repoRoot = readWorkspaceRepoRoot(input.workspace);
      const startedAt = Date.now();
      let progressDeadline = startedAt + timeoutMs;
      const hardDeadline = maxRuntimeMs === null ? null : startedAt + maxRuntimeMs;
      let lastHeartbeatAt = Date.now();
      const heartbeatIntervalMs =
        input.heartbeatIntervalMs ?? defaultHeartbeatIntervalMs;
      const codeWriteEnabled = input.workspace.descriptor.toolPolicy.codeWriteEnabled;
      const sessionTranscriptPath = await resolveOpenClawSessionTranscriptPath({
        openClawHomePath,
        sessionKey: input.sessionKey,
        sessionId: input.dispatchResult.sessionId ?? null,
        agentId: input.dispatchResult.agentId ?? null
      });
      let lastTranscriptSignature: string | null = null;
      let lastTranscriptGrowthAt: number | null = null;
      let lastRepoSignature: string | null = null;
      let lastWriteOperationsCount = 0;
      let writeStallWarningEmitted = false;

      while (
        Date.now() < progressDeadline &&
        (hardDeadline === null || Date.now() < hardDeadline)
      ) {
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
          const expectedCodeWritingDeclaration = handoff.includes(
            `Code writing enabled: ${codeWriteEnabled ? "yes" : "no"}`
          );
          const repoHasChanges = repoRoot
            ? await repositoryHasChanges(repoRoot, input.logger)
            : false;

          if (!codeWriteEnabled && repoHasChanges) {
            throw new Error(
              `Developer workspace ${input.workspace.workspaceId} produced repository changes while code writing was disabled.`
            );
          }

          if (
            hasAllHeadings &&
            expectedCodeWritingDeclaration &&
            (codeWriteEnabled ? repoHasChanges : true)
          ) {
            return { handoffPath, repoRoot };
          }
        }

        if (repoRoot !== null) {
          const repoSignature = await inspectRepositoryProgressSignature(
            repoRoot,
            input.logger
          );
          if (repoSignature !== null && repoSignature !== lastRepoSignature) {
            lastRepoSignature = repoSignature;
            progressDeadline = Date.now() + timeoutMs;
          }
        }

        if (sessionTranscriptPath !== null && await pathExists(sessionTranscriptPath)) {
          const transcriptStatus = await inspectOpenClawSessionTranscript(sessionTranscriptPath, {
            sessionKey: input.sessionKey,
            agentId: input.dispatchResult.agentId ?? "unknown-agent"
          });
          const signature = `${transcriptStatus.size}:${transcriptStatus.totalEntries}:${transcriptStatus.lastEntryTimestamp ?? ""}:${transcriptStatus.lastAssistantStopReason ?? ""}:${transcriptStatus.lastTerminalErrorMessage ?? ""}`;

          if (signature !== lastTranscriptSignature) {
            lastTranscriptSignature = signature;
            lastTranscriptGrowthAt = Date.now();
            progressDeadline = Date.now() + timeoutMs;
          }

          // Write-activity is a strong progress signal independent of overall
          // transcript growth. Each new file-write or edit resets the sliding
          // deadline so long-running write sessions are never killed mid-commit.
          if (transcriptStatus.writeOperationsCount > lastWriteOperationsCount) {
            lastWriteOperationsCount = transcriptStatus.writeOperationsCount;
            progressDeadline = Date.now() + timeoutMs;
          }

          if (transcriptStatus.lastAssistantStopReason !== null) {
            throw new OpenClawSessionTerminatedError({
              sessionKey: input.sessionKey,
              sessionId: input.dispatchResult.sessionId ?? null,
              agentId: input.dispatchResult.agentId ?? null,
              transcriptPath: sessionTranscriptPath,
              stopReason: transcriptStatus.lastAssistantStopReason,
              errorMessage: transcriptStatus.lastTerminalErrorMessage,
              totalEntries: transcriptStatus.totalEntries
            });
          }

          if (transcriptStatus.lastTerminalErrorMessage !== null) {
            throw new OpenClawSessionTerminatedError({
              sessionKey: input.sessionKey,
              sessionId: input.dispatchResult.sessionId ?? null,
              agentId: input.dispatchResult.agentId ?? null,
              transcriptPath: sessionTranscriptPath,
              stopReason: transcriptStatus.lastAssistantStopReason,
              errorMessage: transcriptStatus.lastTerminalErrorMessage,
              totalEntries: transcriptStatus.totalEntries
            });
          }

          // Detect sessions that have been running for a while with code-write
          // enabled but zero write tool calls. This catches agents stuck in
          // extended planning or about to attempt one massive single-file write.
          // When detected, tighten the idle timeout to surface stalls faster.
          const elapsedMs = Date.now() - startedAt;
          const inWriteStall =
            codeWriteEnabled &&
            elapsedMs >= noWriteActivityWarningMs &&
            transcriptStatus.writeOperationsCount === 0;

          if (inWriteStall && !writeStallWarningEmitted) {
            writeStallWarningEmitted = true;
            input.logger?.warn?.(
              `Developer session ${input.sessionKey} has been running for ${Math.round(elapsedMs / 1000)}s with code writing enabled but zero write operations. ` +
              `The agent may be stuck in extended planning or preparing a single large write. Tightening idle detection.`
            );
          }

          // Use a longer idle tolerance when the agent is in the middle of a
          // tool call. npm install, a full test suite, or a large file scan can
          // all take several minutes without producing transcript output.
          // The short sessionIdleTimeoutMs is reserved for truly idle sessions
          // where no tool call is in flight. When a write-stall is detected,
          // tighten the non-tool idle timeout to catch stalls faster.
          const baseIdleTimeoutMs = inWriteStall
            ? tightenedIdleTimeoutMs
            : sessionIdleTimeoutMs;
          const activeIdleTimeoutMs = transcriptStatus.isWaitingForToolResult
            ? toolExecutionGracePeriodMs
            : baseIdleTimeoutMs;

          if (
            lastTranscriptGrowthAt !== null &&
            Date.now() - lastTranscriptGrowthAt >= activeIdleTimeoutMs
          ) {
            throw new OpenClawSessionStalledError({
              sessionKey: input.sessionKey,
              sessionId: input.dispatchResult.sessionId ?? null,
              agentId: input.dispatchResult.agentId ?? null,
              transcriptPath: sessionTranscriptPath,
              idleMs: Date.now() - lastTranscriptGrowthAt,
              totalEntries: transcriptStatus.totalEntries,
              lastUpdatedAt: new Date(transcriptStatus.modifiedAtMs).toISOString()
            });
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

function resolveOpenClawHomePath(explicitHomePath?: string): string {
  if (explicitHomePath && explicitHomePath.trim().length > 0) {
    return resolve(explicitHomePath);
  }

  const configPath =
    process.env.REDDWARF_OPENCLAW_CONFIG_PATH ?? "runtime-data/openclaw-home/openclaw.json";
  return dirname(resolve(configPath));
}

async function resolveOpenClawSessionTranscriptPath(input: {
  openClawHomePath: string;
  sessionKey: string;
  sessionId: string | null;
  agentId: string | null;
}): Promise<string | null> {
  const agentId = input.agentId;
  if (!agentId) {
    return null;
  }

  if (input.sessionId) {
    const directTranscriptPath = join(
      input.openClawHomePath,
      "agents",
      agentId,
      "sessions",
      `${input.sessionId}.jsonl`
    );
    if (await pathExists(directTranscriptPath)) {
      return directTranscriptPath;
    }
  }

  const resolvedSessionId = await resolveOpenClawSessionIdFromRegistry({
    openClawHomePath: input.openClawHomePath,
    sessionKey: input.sessionKey,
    agentId
  });
  if (!resolvedSessionId) {
    return null;
  }

  return join(
    input.openClawHomePath,
    "agents",
    agentId,
    "sessions",
    `${resolvedSessionId}.jsonl`
  );
}

async function resolveOpenClawSessionIdFromRegistry(input: {
  openClawHomePath: string;
  sessionKey: string;
  agentId: string;
}): Promise<string | null> {
  const sessionsRegistryPath = join(
    input.openClawHomePath,
    "agents",
    input.agentId,
    "sessions",
    "sessions.json"
  );

  if (!(await pathExists(sessionsRegistryPath))) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(sessionsRegistryPath, "utf8"));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const expectedNormalizedKey = `agent:${input.agentId}:${normalizeOpenClawSessionKey(input.sessionKey)}`;
  const expectedRawKey = `agent:${input.agentId}:${input.sessionKey}`;

  for (const [entryKey, entryValue] of Object.entries(parsed)) {
    if (
      entryKey !== expectedRawKey &&
      normalizeOpenClawRegistrySessionKey(entryKey, input.agentId) !== expectedNormalizedKey
    ) {
      continue;
    }

    if (!entryValue || typeof entryValue !== "object" || Array.isArray(entryValue)) {
      continue;
    }

    const sessionId = (entryValue as Record<string, unknown>)["sessionId"];
    if (typeof sessionId === "string" && sessionId.trim().length > 0) {
      return sessionId;
    }
  }

  return null;
}

function normalizeOpenClawRegistrySessionKey(entryKey: string, agentId: string): string {
  const prefix = `agent:${agentId}:`;
  if (!entryKey.startsWith(prefix)) {
    return entryKey;
  }

  const sessionKey = entryKey.slice(prefix.length);
  return `${prefix}${normalizeOpenClawSessionKey(sessionKey)}`;
}

/**
 * Tool names that indicate a write/mutation operation. When the agent is
 * executing one of these tools the transcript may be silent for an extended
 * period (e.g. npm install, running a test suite) without the session being
 * stalled.
 */
const WRITE_TOOL_PATTERN = /write|edit|patch|create|str_replace/i;

async function inspectOpenClawSessionTranscript(
  transcriptPath: string,
  input: { sessionKey: string; agentId: string }
): Promise<{
  size: number;
  modifiedAtMs: number;
  totalEntries: number;
  lastEntryTimestamp: string | null;
  lastAssistantStopReason: string | null;
  lastTerminalErrorMessage: string | null;
  /** True when the last assistant entry has stopReason "toolUse" — the agent is
   *  mid-tool-call and the transcript will be silent until the tool responds. */
  isWaitingForToolResult: boolean;
  /** Number of tool calls whose name matches a write/mutation pattern.
   *  Increases to this counter reset the progress deadline even when the
   *  overall transcript signature has not changed. */
  writeOperationsCount: number;
}> {
  const [stats, transcript] = await Promise.all([
    stat(transcriptPath),
    readSessionTranscript(transcriptPath, input.sessionKey, input.agentId)
  ]);
  const lastEntry = transcript.entries[transcript.entries.length - 1] ?? null;

  // Find the last assistant entry specifically (may differ from lastEntry when
  // a tool result entry appears after the last assistant turn).
  const lastAssistantEntry =
    [...transcript.entries].reverse().find((e) => e.role === "assistant") ?? null;

  const terminalAssistantStopReason =
    lastAssistantEntry !== null &&
    typeof lastAssistantEntry.stopReason === "string" &&
    lastAssistantEntry.stopReason !== "toolUse"
      ? lastAssistantEntry.stopReason
      : null;

  const terminalErrorMessage =
    lastAssistantEntry !== null &&
    typeof lastAssistantEntry.errorMessage === "string" &&
    lastAssistantEntry.errorMessage.trim().length > 0
      ? lastAssistantEntry.errorMessage
      : null;

  const isWaitingForToolResult =
    lastAssistantEntry !== null && lastAssistantEntry.stopReason === "toolUse";

  const writeOperationsCount = transcript.entries.filter(
    (e) =>
      typeof e.toolName === "string" && WRITE_TOOL_PATTERN.test(e.toolName)
  ).length;

  return {
    size: stats.size,
    modifiedAtMs: stats.mtimeMs,
    totalEntries: transcript.totalEntries,
    lastEntryTimestamp: lastEntry?.timestamp ?? null,
    lastAssistantStopReason: terminalAssistantStopReason,
    lastTerminalErrorMessage: terminalErrorMessage,
    isWaitingForToolResult,
    writeOperationsCount
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

      assertChangedFilesAvoidDeniedPaths({
        workspaceId: input.workspace.workspaceId,
        deniedPaths: input.deniedPaths,
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

      assertChangedFilesAvoidDeniedPaths({
        workspaceId: input.workspace.workspaceId,
        deniedPaths: input.deniedPaths,
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

async function inspectRepositoryProgressSignature(
  repoRoot: string,
  logger?: PlanningPipelineLogger
): Promise<string | null> {
  if (!(await pathExists(join(repoRoot, ".git")))) {
    return null;
  }

  try {
    const [status, revCount] = await Promise.all([
      runCommand("git", ["status", "--porcelain"], repoRoot, logger),
      runCommand("git", ["rev-list", "--count", "HEAD"], repoRoot, logger)
    ]);
    return `${status.stdout.trim()}::${revCount.stdout.trim()}`;
  } catch {
    return null;
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

function assertChangedFilesAvoidDeniedPaths(input: {
  workspaceId: string;
  deniedPaths: string[];
  changedFiles: string[];
}): void {
  const violatingFiles = findDeniedChangedFiles(
    input.changedFiles,
    input.deniedPaths
  );

  if (violatingFiles.length === 0) {
    return;
  }

  throw new AllowedPathViolationError({
    workspaceId: input.workspaceId,
    deniedPaths: input.deniedPaths,
    changedFiles: input.changedFiles,
    violatingFiles
  });
}

function repoPathMatchesPattern(
  repoPath: string,
  pathPattern: string
): boolean {
  return globPatternToRegExp(pathPattern).test(repoPath);
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
