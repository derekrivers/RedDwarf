import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { asIsoTimestamp } from "@reddwarf/contracts";
import type { OpenClawDispatchResult } from "@reddwarf/integrations";
import { archiveEvidenceArtifact, buildArchivedArtifactMetadata } from "./workspace.js";
import type { ArchivedArtifactClass, ArchivedEvidenceArtifact } from "./workspace.js";

// ── OpenClaw session JSONL types ─────────────────────────────────────────────

/**
 * A single entry in an OpenClaw session JSONL transcript.
 * OpenClaw stores sessions as newline-delimited JSON with role/content pairs.
 */
export interface OpenClawSessionEntry {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  timestamp?: string;
  toolName?: string;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
  stopReason?: string;
  errorMessage?: string;
  isError?: boolean;
  eventType?: string;
}

/**
 * Parsed OpenClaw session transcript with metadata.
 */
export interface OpenClawSessionTranscript {
  sessionKey: string;
  agentId: string;
  entries: OpenClawSessionEntry[];
  totalEntries: number;
  parsedAt: string;
  errors: string[];
}

/**
 * Result of capturing an OpenClaw session as phase evidence.
 */
export interface OpenClawSessionCaptureResult {
  transcript: OpenClawSessionTranscript;
  transcriptArtifact: ArchivedEvidenceArtifact | null;
  summaryArtifact: ArchivedEvidenceArtifact | null;
  metadata: Record<string, unknown>;
}

// ── Session JSONL parsing ────────────────────────────────────────────────────

/**
 * Parse an OpenClaw session JSONL string into a structured transcript.
 * Each line is expected to be a valid JSON object with at least `role` and
 * `content` fields. Lines that fail to parse are recorded as errors.
 */
export function parseSessionJsonl(
  jsonl: string,
  sessionKey: string,
  agentId: string
): OpenClawSessionTranscript {
  const lines = jsonl.split("\n").filter((line) => line.trim().length > 0);
  const entries: OpenClawSessionEntry[] = [];
  const errors: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]!) as Record<string, unknown>;
      const normalized = normalizeSessionEntry(parsed);
      if (normalized === null) {
        errors.push(`Line ${i + 1}: missing role or content field`);
        continue;
      }
      entries.push(normalized);
    } catch {
      errors.push(`Line ${i + 1}: invalid JSON`);
    }
  }

  return {
    sessionKey,
    agentId,
    entries,
    totalEntries: entries.length,
    parsedAt: asIsoTimestamp(),
    errors
  };
}

function normalizeSessionEntry(parsed: Record<string, unknown>): OpenClawSessionEntry | null {
  if (typeof parsed["role"] === "string" && typeof parsed["content"] === "string") {
    return {
      role: parsed["role"] as OpenClawSessionEntry["role"],
      content: parsed["content"],
      ...(typeof parsed["timestamp"] === "string" ? { timestamp: parsed["timestamp"] } : {}),
      ...(typeof parsed["toolName"] === "string" ? { toolName: parsed["toolName"] } : {}),
      ...(typeof parsed["toolCallId"] === "string" ? { toolCallId: parsed["toolCallId"] } : {}),
      ...(typeof parsed["metadata"] === "object" && parsed["metadata"] !== null
        ? { metadata: parsed["metadata"] as Record<string, unknown> }
        : {}),
      ...(typeof parsed["stopReason"] === "string" ? { stopReason: parsed["stopReason"] } : {}),
      ...(typeof parsed["errorMessage"] === "string"
        ? { errorMessage: parsed["errorMessage"] }
        : {}),
      ...(typeof parsed["isError"] === "boolean" ? { isError: parsed["isError"] } : {}),
      ...(typeof parsed["type"] === "string" ? { eventType: parsed["type"] } : {})
    };
  }

  if (parsed["type"] !== "message") {
    return null;
  }

  const message = parsed["message"];
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }

  const messageRecord = message as Record<string, unknown>;
  if (typeof messageRecord["role"] !== "string") {
    return null;
  }

  const normalizedRole =
    messageRecord["role"] === "toolResult"
      ? "tool"
      : messageRecord["role"];
  if (
    normalizedRole !== "system" &&
    normalizedRole !== "user" &&
    normalizedRole !== "assistant" &&
    normalizedRole !== "tool"
  ) {
    return null;
  }

  const content = normalizeMessageContent(messageRecord["content"]);
  return {
    role: normalizedRole,
    content,
    ...(typeof parsed["timestamp"] === "string" ? { timestamp: parsed["timestamp"] } : {}),
    ...(typeof messageRecord["toolName"] === "string" ? { toolName: messageRecord["toolName"] } : {}),
    ...(typeof messageRecord["toolCallId"] === "string" ? { toolCallId: messageRecord["toolCallId"] } : {}),
    ...(typeof messageRecord["stopReason"] === "string" ? { stopReason: messageRecord["stopReason"] } : {}),
    ...(typeof parsed["errorMessage"] === "string"
      ? { errorMessage: parsed["errorMessage"] }
      : {}),
    ...(typeof messageRecord["isError"] === "boolean" ? { isError: messageRecord["isError"] } : {}),
    ...(typeof parsed["type"] === "string" ? { eventType: parsed["type"] } : {})
  };
}

function normalizeMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return "";
      }
      const record = item as Record<string, unknown>;
      if (record["type"] === "text" && typeof record["text"] === "string") {
        return record["text"];
      }
      if (record["type"] === "thinking" && typeof record["thinking"] === "string") {
        return record["thinking"];
      }
      if (record["type"] === "toolCall") {
        const name = typeof record["name"] === "string" ? record["name"] : "unknown";
        return `[toolCall:${name}]`;
      }
      return "";
    })
    .filter((value) => value.length > 0)
    .join("\n\n");
}

/**
 * Read and parse an OpenClaw session JSONL file from disk.
 */
export async function readSessionTranscript(
  sessionJsonlPath: string,
  sessionKey: string,
  agentId: string
): Promise<OpenClawSessionTranscript> {
  const content = await readFile(sessionJsonlPath, "utf8");
  return parseSessionJsonl(content, sessionKey, agentId);
}

// ── Session evidence capture ─────────────────────────────────────────────────

/**
 * Extract the assistant's final response from a session transcript.
 * Returns the last assistant entry's content, or a fallback message.
 */
export function extractSessionSummary(transcript: OpenClawSessionTranscript): string {
  const assistantEntries = transcript.entries.filter((e) => e.role === "assistant");
  if (assistantEntries.length === 0) {
    return `No assistant response captured for session ${transcript.sessionKey}.`;
  }
  return assistantEntries[assistantEntries.length - 1]!.content;
}

/**
 * Build a human-readable session summary markdown from a transcript.
 */
export function buildSessionSummaryMarkdown(
  transcript: OpenClawSessionTranscript,
  dispatchResult: OpenClawDispatchResult
): string {
  const summary = extractSessionSummary(transcript);
  const lines = [
    "# OpenClaw Session Summary",
    "",
    `- Session key: ${transcript.sessionKey}`,
    `- Agent: ${transcript.agentId}`,
    `- Session ID: ${dispatchResult.sessionId ?? "unknown"}`,
    `- Total entries: ${transcript.totalEntries}`,
    `- Parsed at: ${transcript.parsedAt}`,
    ...(transcript.errors.length > 0
      ? ["", "## Parse Errors", "", ...transcript.errors.map((e) => `- ${e}`)]
      : []),
    "",
    "## Agent Output",
    "",
    summary,
    ""
  ];
  return lines.join("\n");
}

export interface CaptureSessionEvidenceInput {
  taskId: string;
  runId: string;
  phase: string;
  transcript: OpenClawSessionTranscript;
  dispatchResult: OpenClawDispatchResult;
  workspaceRoot: string;
  evidenceRoot?: string;
}

/**
 * Capture an OpenClaw session transcript and summary as durable phase
 * evidence. Writes the full JSONL transcript and a summary markdown to
 * the workspace artifacts directory, then archives both into the evidence
 * root for persistence beyond workspace teardown.
 */
export async function captureSessionEvidence(
  input: CaptureSessionEvidenceInput
): Promise<OpenClawSessionCaptureResult> {
  const artifactsDir = join(input.workspaceRoot, "artifacts");
  await mkdir(artifactsDir, { recursive: true });

  // Write transcript JSONL to workspace
  const transcriptPath = join(artifactsDir, "session-transcript.jsonl");
  const transcriptContent = input.transcript.entries
    .map((entry) => JSON.stringify(entry))
    .join("\n") + "\n";
  await writeFile(transcriptPath, transcriptContent, "utf8");

  // Write summary markdown to workspace
  const summaryPath = join(artifactsDir, "session-summary.md");
  const summaryContent = buildSessionSummaryMarkdown(input.transcript, input.dispatchResult);
  await writeFile(summaryPath, summaryContent, "utf8");

  // Archive both as evidence
  const transcriptArtifact = await archiveEvidenceArtifact({
    taskId: input.taskId,
    runId: input.runId,
    phase: input.phase,
    sourcePath: transcriptPath,
    targetRoot: input.workspaceRoot,
    evidenceRoot: input.evidenceRoot,
    fileName: "session-transcript.jsonl"
  });

  const summaryArtifact = await archiveEvidenceArtifact({
    taskId: input.taskId,
    runId: input.runId,
    phase: input.phase,
    sourcePath: summaryPath,
    targetRoot: input.workspaceRoot,
    evidenceRoot: input.evidenceRoot,
    fileName: "session-summary.md"
  });

  const metadata: Record<string, unknown> = {
    sessionKey: input.transcript.sessionKey,
    agentId: input.transcript.agentId,
    totalEntries: input.transcript.totalEntries,
    parseErrors: input.transcript.errors.length,
    transcriptArtifact: buildArchivedArtifactMetadata({
      archivedArtifact: transcriptArtifact,
      artifactClass: "log" as ArchivedArtifactClass,
      sourceLocation: `workspace://${input.taskId}/artifacts/session-transcript.jsonl`,
      sourcePath: transcriptPath
    }),
    summaryArtifact: buildArchivedArtifactMetadata({
      archivedArtifact: summaryArtifact,
      artifactClass: "report" as ArchivedArtifactClass,
      sourceLocation: `workspace://${input.taskId}/artifacts/session-summary.md`,
      sourcePath: summaryPath
    })
  };

  return {
    transcript: input.transcript,
    transcriptArtifact,
    summaryArtifact,
    metadata
  };
}
