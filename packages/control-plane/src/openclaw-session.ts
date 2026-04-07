import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { asIsoTimestamp } from "@reddwarf/contracts";
import type { OpenClawDispatchResult } from "@reddwarf/integrations";
import type { PlanningRepository } from "@reddwarf/evidence";
import { createMemoryRecord, createRunEvent } from "@reddwarf/evidence";
import { archiveEvidenceArtifact, buildArchivedArtifactMetadata } from "./workspace.js";
import type { ArchivedArtifactClass, ArchivedEvidenceArtifact } from "./workspace.js";
import { EventCodes } from "./pipeline/types.js";

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
 * A structured execution progress item emitted by an OpenClaw agent
 * during a long-running session. Available from OpenClaw >= v2026.4.5.
 */
export interface OpenClawExecutionItem {
  /** Unique item ID within the session. */
  id: string;
  /** Human-readable description of what the agent is doing. */
  title: string;
  /** Current status of this step. */
  status: "pending" | "active" | "done" | "failed" | "skipped";
  /** Wall-clock duration of this step in milliseconds, if completed. */
  durationMs?: number;
  /** Optional additional detail for this step. */
  detail?: string;
  /** ISO timestamp when this item was last updated. */
  updatedAt?: string;
}

/**
 * A structured plan update emitted by an OpenClaw agent.
 * Replaces or updates the agent's declared execution plan.
 */
export interface OpenClawPlanUpdate {
  items: OpenClawExecutionItem[];
  updatedAt?: string;
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
  /** Structured execution items extracted from plan_update / execution_item events. */
  executionItems: OpenClawExecutionItem[];
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
  // Track latest execution item state by item ID (last plan_update wins)
  const executionItemMap = new Map<string, OpenClawExecutionItem>();

  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]!) as Record<string, unknown>;

      // Check for plan_update / execution_item events before normalizing as a message
      const eventType = typeof parsed["type"] === "string" ? parsed["type"] : null;
      if (eventType === "plan_update") {
        const planUpdate = extractPlanUpdate(parsed);
        if (planUpdate) {
          for (const item of planUpdate.items) {
            executionItemMap.set(item.id, item);
          }
        }
        continue;
      }
      if (eventType === "execution_item") {
        const item = extractExecutionItem(parsed["item"]);
        if (item) {
          executionItemMap.set(item.id, item);
        }
        continue;
      }

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
    errors,
    executionItems: Array.from(executionItemMap.values())
  };
}

function extractExecutionItem(raw: unknown): OpenClawExecutionItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r["id"] !== "string" || typeof r["title"] !== "string") {
    return null;
  }
  const validStatuses = ["pending", "active", "done", "failed", "skipped"] as const;
  const status = validStatuses.includes(r["status"] as (typeof validStatuses)[number])
    ? (r["status"] as OpenClawExecutionItem["status"])
    : "pending";
  return {
    id: r["id"],
    title: r["title"],
    status,
    ...(typeof r["durationMs"] === "number" ? { durationMs: r["durationMs"] } : {}),
    ...(typeof r["detail"] === "string" ? { detail: r["detail"] } : {}),
    ...(typeof r["updatedAt"] === "string" ? { updatedAt: r["updatedAt"] } : {})
  };
}

function extractPlanUpdate(parsed: Record<string, unknown>): OpenClawPlanUpdate | null {
  const items = parsed["items"];
  if (!Array.isArray(items)) {
    return null;
  }
  const extracted: OpenClawExecutionItem[] = [];
  for (const item of items) {
    const extracted_item = extractExecutionItem(item);
    if (extracted_item) {
      extracted.push(extracted_item);
    }
  }
  return {
    items: extracted,
    ...(typeof parsed["updatedAt"] === "string" ? { updatedAt: parsed["updatedAt"] } : {})
  };
}

/**
 * Extract the final snapshot of execution items from a transcript.
 * Returns the items in the order they appear in the last plan_update.
 */
export function extractFinalExecutionItems(
  transcript: OpenClawSessionTranscript
): OpenClawExecutionItem[] {
  return transcript.executionItems;
}

const KNOWN_ROLES = new Set(["system", "user", "assistant", "tool", "toolResult"]);
const KNOWN_EVENT_TYPES = new Set(["message", "plan_update", "execution_item"]);

function normalizeSessionEntry(parsed: Record<string, unknown>): OpenClawSessionEntry | null {
  // Reject entries with unknown event types — prevents a crafted transcript from
  // injecting event types that could confuse stall/termination detection.
  const eventType = typeof parsed["type"] === "string" ? parsed["type"] : null;
  if (eventType !== null && !KNOWN_EVENT_TYPES.has(eventType) && !KNOWN_ROLES.has(parsed["role"] as string)) {
    return null;
  }

  if (typeof parsed["role"] === "string" && typeof parsed["content"] === "string") {
    const rawRole = parsed["role"] === "toolResult" ? "tool" : parsed["role"];
    if (!KNOWN_ROLES.has(parsed["role"]) && rawRole !== "tool") {
      return null;
    }
    return {
      role: rawRole as OpenClawSessionEntry["role"],
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

// ── Execution item persistence ───────────────────────────────────────────────

export interface PersistExecutionItemsInput {
  repository: Pick<PlanningRepository, "saveRunEvent">;
  taskId: string;
  runId: string;
  phase: string;
  transcript: OpenClawSessionTranscript;
  baseEventId: string;
  createdAt: string;
}

/**
 * Persist structured execution items from an OpenClaw session transcript
 * as AGENT_PROGRESS_ITEM run events. This function is a no-op when the
 * transcript has no execution items (e.g. older OpenClaw versions or agents
 * that do not emit structured plan updates).
 *
 * Requires OpenClaw >= v2026.4.5 and REDDWARF_EXECUTION_ITEMS_ENABLED=true
 * on the caller side. The function itself is always safe to call.
 */
export async function persistExecutionItems(
  input: PersistExecutionItemsInput
): Promise<number> {
  const items = input.transcript.executionItems;
  if (items.length === 0) {
    return 0;
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    await input.repository.saveRunEvent(
      createRunEvent({
        eventId: `${input.baseEventId}:exec-item:${item.id ?? i}`,
        taskId: input.taskId,
        runId: input.runId,
        phase: input.phase as Parameters<typeof createRunEvent>[0]["phase"],
        level: item.status === "failed" ? "error" : "info",
        code: EventCodes.AGENT_PROGRESS_ITEM,
        message: item.title,
        data: {
          itemId: item.id,
          status: item.status,
          ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
          ...(item.detail ? { detail: item.detail } : {}),
          ...(item.updatedAt ? { updatedAt: item.updatedAt } : {})
        },
        createdAt: input.createdAt
      })
    );
  }

  return items.length;
}

// ── Dreaming memory integration (Feature 156) ────────────────────────────────

/**
 * A single learning extracted from an OpenClaw dreaming pass (dreams.md).
 */
export interface DreamingLearning {
  /** Short title — first line or heading of the observation. */
  title: string;
  /** Full observation text. */
  body: string;
  /** Topic tags inferred from the content (e.g. "architecture", "testing", "react"). */
  tags: string[];
}

/**
 * Parse an OpenClaw dreams.md file and extract structured learnings.
 * The dreams.md format is a markdown document with optional sections;
 * each top-level heading (##) is treated as a distinct learning.
 *
 * Returns an empty array if the content is empty or unparseable.
 */
export function parseDreamsMarkdown(content: string): DreamingLearning[] {
  const trimmed = content.trim();
  if (!trimmed) {
    return [];
  }

  // Split on top-level headings (## or ###)
  const headingRegex = /^#{2,3}\s+(.+)$/m;
  const sections = trimmed.split(/^(?=#{2,3}\s)/m).filter(Boolean);

  const learnings: DreamingLearning[] = [];

  for (const section of sections) {
    const lines = section.split("\n");
    const headingLine = lines[0] ?? "";
    const headingMatch = headingRegex.exec(headingLine);
    const title = headingMatch ? headingMatch[1]!.trim() : headingLine.replace(/^#+\s*/, "").trim();
    const body = lines.slice(1).join("\n").trim();

    if (!title && !body) {
      continue;
    }

    // Infer tags from keywords in title and body
    const combined = `${title} ${body}`.toLowerCase();
    const tags: string[] = ["dreaming"];
    const tagKeywords: [string, string][] = [
      ["architecture", "architecture"],
      ["test", "testing"],
      ["react", "react"],
      ["typescript", "typescript"],
      ["database", "database"],
      ["performance", "performance"],
      ["security", "security"],
      ["api", "api"],
      ["migration", "migration"],
      ["pattern", "patterns"]
    ];
    for (const [keyword, tag] of tagKeywords) {
      if (combined.includes(keyword) && !tags.includes(tag)) {
        tags.push(tag);
      }
    }

    learnings.push({ title: title || "Observation", body, tags });
  }

  // If no headings were found, treat the whole document as one learning
  if (learnings.length === 0 && trimmed) {
    const firstLine = trimmed.split("\n")[0] ?? "Dreaming observation";
    learnings.push({
      title: firstLine.replace(/^#+\s*/, "").trim().slice(0, 120),
      body: trimmed,
      tags: ["dreaming"]
    });
  }

  return learnings;
}

export interface CaptureDreamingMemoryInput {
  repository: Pick<PlanningRepository, "saveMemoryRecord" | "listMemoryRecords">;
  workspaceRoot: string;
  taskId: string;
  repo: string;
  agentRole: string;
  createdAt: string;
}

export interface CaptureDreamingMemoryResult {
  persisted: number;
  skipped: number;
  dreamsFound: boolean;
}

/**
 * After an agent session completes, check for a dreams.md file written by
 * OpenClaw's dreaming pass and capture structured learnings as repo-scoped
 * memory records. Requires OpenClaw >= v2026.4.5 and
 * REDDWARF_DREAMING_MEMORY_ENABLED=true on the caller side.
 *
 * Deduplicates observations by content hash so repeated sessions on the same
 * repository do not accumulate identical memories.
 *
 * The dreams.md file is expected at `{workspaceRoot}/dreams.md`.
 */
export async function captureDreamingMemory(
  input: CaptureDreamingMemoryInput
): Promise<CaptureDreamingMemoryResult> {
  const dreamsPath = join(input.workspaceRoot, "dreams.md");
  let content: string;
  try {
    content = await readFile(dreamsPath, "utf8");
  } catch {
    // No dreams.md — the agent did not run a dreaming pass or OpenClaw version < v2026.4.5
    return { persisted: 0, skipped: 0, dreamsFound: false };
  }

  const learnings = parseDreamsMarkdown(content);
  if (learnings.length === 0) {
    return { persisted: 0, skipped: 0, dreamsFound: true };
  }

  // Fetch existing dreaming memories for this repo to deduplicate
  const existingMemories = await input.repository.listMemoryRecords({
    scope: "repo",
    tags: ["dreaming"]
  });
  const existingKeys = new Set(existingMemories.map((m) => m.key));

  let persisted = 0;
  let skipped = 0;

  for (const learning of learnings) {
    // Key is a hash of the title + body so identical observations are deduplicated
    const contentHash = createHash("sha256")
      .update(`${learning.title}\n${learning.body}`)
      .digest("hex")
      .slice(0, 16);
    const memoryKey = `dreaming:${input.repo}:${contentHash}`;

    if (existingKeys.has(memoryKey)) {
      skipped++;
      continue;
    }

    await input.repository.saveMemoryRecord(
      createMemoryRecord({
        memoryId: `${input.taskId}:dreaming:${contentHash}`,
        scope: "repo" as "repo",
        provenance: "agent_observed" as "agent_observed",
        key: memoryKey,
        title: learning.title,
        value: {
          body: learning.body,
          agentRole: input.agentRole,
          sourceTaskId: input.taskId
        },
        repo: input.repo,
        tags: learning.tags,
        createdAt: input.createdAt
      })
    );
    existingKeys.add(memoryKey);
    persisted++;
  }

  return { persisted, skipped, dreamsFound: true };
}
