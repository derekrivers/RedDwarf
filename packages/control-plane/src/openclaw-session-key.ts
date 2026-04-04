import type { TaskManifest } from "@reddwarf/contracts";

export function buildOpenClawIssueSessionKey(input: {
  repo: string;
  issueNumber?: number;
  taskId: string;
}): string {
  const repo = input.repo.trim().toLowerCase();
  const issueOrTaskId = input.issueNumber ?? input.taskId;
  return `github:issue:${repo}:${issueOrTaskId}`;
}

export function buildOpenClawIssueSessionKeyFromManifest(
  manifest: Pick<TaskManifest, "taskId" | "source">
): string {
  return buildOpenClawIssueSessionKey({
    repo: manifest.source.repo,
    ...(manifest.source.issueNumber !== undefined
      ? { issueNumber: manifest.source.issueNumber }
      : {}),
    taskId: manifest.taskId
  });
}

export function normalizeOpenClawSessionKey(sessionKey: string): string {
  const trimmed = sessionKey.trim();
  const prefix = "github:issue:";

  if (!trimmed.startsWith(prefix)) {
    return trimmed;
  }

  const remainder = trimmed.slice(prefix.length);
  const separatorIndex = remainder.lastIndexOf(":");
  if (separatorIndex <= 0 || separatorIndex === remainder.length - 1) {
    return trimmed;
  }

  const repo = remainder.slice(0, separatorIndex).trim().toLowerCase();
  const issueOrTaskId = remainder.slice(separatorIndex + 1).trim();
  if (repo.length === 0 || issueOrTaskId.length === 0) {
    return trimmed;
  }

  return `${prefix}${repo}:${issueOrTaskId}`;
}
