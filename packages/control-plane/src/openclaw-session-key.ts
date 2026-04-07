import type { TaskManifest } from "@reddwarf/contracts";

/**
 * A branded string type that guarantees the session key has been run through
 * `normalizeOpenClawSessionKey()`. Functions that dispatch, await, or look up
 * sessions should accept `NormalizedSessionKey` instead of raw `string` to
 * prevent mixed-case repo key mismatches at compile time.
 */
declare const NormalizedSessionKeyBrand: unique symbol;
export type NormalizedSessionKey = string & { readonly [NormalizedSessionKeyBrand]: true };

export function buildOpenClawIssueSessionKey(input: {
  repo: string;
  issueNumber?: number;
  taskId: string;
}): NormalizedSessionKey {
  const repo = input.repo.trim().toLowerCase();
  const issueOrTaskId = input.issueNumber ?? input.taskId;
  return `github:issue:${repo}:${issueOrTaskId}` as NormalizedSessionKey;
}

export function buildOpenClawIssueSessionKeyFromManifest(
  manifest: Pick<TaskManifest, "taskId" | "source">
): NormalizedSessionKey {
  return buildOpenClawIssueSessionKey({
    repo: manifest.source.repo,
    ...(manifest.source.issueNumber !== undefined
      ? { issueNumber: manifest.source.issueNumber }
      : {}),
    taskId: manifest.taskId
  });
}

export function normalizeOpenClawSessionKey(sessionKey: string): NormalizedSessionKey {
  const trimmed = sessionKey.trim();
  const prefix = "github:issue:";

  if (!trimmed.startsWith(prefix)) {
    return trimmed as NormalizedSessionKey;
  }

  const remainder = trimmed.slice(prefix.length);
  const separatorIndex = remainder.lastIndexOf(":");
  if (separatorIndex <= 0 || separatorIndex === remainder.length - 1) {
    return trimmed as NormalizedSessionKey;
  }

  const repo = remainder.slice(0, separatorIndex).trim().toLowerCase();
  const issueOrTaskId = remainder.slice(separatorIndex + 1).trim();
  if (repo.length === 0 || issueOrTaskId.length === 0) {
    return trimmed as NormalizedSessionKey;
  }

  return `${prefix}${repo}:${issueOrTaskId}` as NormalizedSessionKey;
}
