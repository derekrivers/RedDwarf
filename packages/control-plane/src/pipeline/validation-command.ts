import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ValidationCommand
} from "@reddwarf/contracts";
import {
  redactSecretValues,
  type SecretLease
} from "@reddwarf/integrations";
import {
  type MaterializedManagedWorkspace
} from "../workspace.js";
import { getDurationMs } from "./shared.js";
import { DEFAULT_VALIDATION_COMMAND_TIMEOUT_MS, type ExecutedValidationCommandResult } from "./types.js";

export async function executeValidationCommand(input: {
  command: ValidationCommand;
  workspace: MaterializedManagedWorkspace;
  startedAt: Date;
  secretLease?: SecretLease | null;
  timeoutMs?: number;
}): Promise<ExecutedValidationCommandResult> {
  const { command, workspace, startedAt } = input;
  const logPath = join(workspace.artifactsDir, `validation-${command.id}.log`);
  const timeoutMs = input.timeoutMs ?? DEFAULT_VALIDATION_COMMAND_TIMEOUT_MS;
  const execution = await new Promise<{
    exitCode: number;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    completedAt: Date;
    timedOut: boolean;
  }>((resolveCommand, rejectCommand) => {
    const child = spawn(command.executable, command.args, {
      cwd: workspace.workspaceRoot,
      env: {
        ...process.env,
        ...(input.secretLease?.environmentVariables ?? {}),
        REDDWARF_WORKSPACE_ID: workspace.workspaceId,
        REDDWARF_WORKSPACE_ROOT: workspace.workspaceRoot
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
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
        }, 5 * 1000);
      }, timeoutMs);
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderrChunks.push(chunk);
    });
    child.on("error", (error) => {
      clearTimers();
      rejectCommand(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimers();
      resolveCommand({
        exitCode: timedOut ? 124 : exitCode ?? 1,
        signal: signal ?? null,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        completedAt: new Date(),
        timedOut
      });
    });
  });

  const durationMs = getDurationMs(startedAt, execution.completedAt);
  const stdout = input.secretLease
    ? redactSecretValues(execution.stdout, input.secretLease)
    : execution.stdout;
  const stderr = input.secretLease
    ? redactSecretValues(execution.stderr, input.secretLease)
    : execution.stderr;
  await writeFile(
    logPath,
    [
      "# Validation Command Log",
      "",
      `- Command ID: ${command.id}`,
      `- Name: ${command.name}`,
      `- Executable: ${command.executable}`,
      `- Args: ${JSON.stringify(command.args)}`,
      `- Exit Code: ${execution.exitCode}`,
      `- Signal: ${execution.signal ?? "none"}`,
      `- Duration (ms): ${durationMs}`,
      `- Timed Out: ${execution.timedOut ? "yes" : "no"}`,
      `- Timeout (ms): ${timeoutMs}`,
      "",
      "## Stdout",
      "",
      stdout.length > 0 ? stdout.trimEnd() : "(empty)",
      "",
      "## Stderr",
      "",
      stderr.length > 0 ? stderr.trimEnd() : "(empty)",
      ""
    ].join("\n"),
    "utf8"
  );

  return {
    id: command.id,
    name: command.name,
    executable: command.executable,
    args: [...command.args],
    exitCode: execution.exitCode,
    signal: execution.signal,
    durationMs,
    status: execution.exitCode === 0 ? "passed" : "failed",
    logPath,
    stdout,
    stderr,
    timedOut: execution.timedOut,
    timeoutMs
  };
}
