import type { ApprovalRequest, TaskManifest } from "@reddwarf/contracts";

// Feature 185 — Audit-log export.
//
// Flat row type surfaced by `GET /audit/export`. Joins every approval decision
// with the task manifest that drove it, so an operator can answer compliance
// questions like "every autonomous change that touched packages/billing in Q2"
// without bespoke SQL. All fields derive from existing persisted data — no new
// events captured, no new tables.

export interface AuditEntry {
  requestId: string;
  taskId: string;
  runId: string;
  repo: string | null;
  issueNumber: number | null;
  phase: ApprovalRequest["phase"];
  status: ApprovalRequest["status"];
  decision: ApprovalRequest["decision"];
  decidedBy: string | null;
  decisionSummary: string | null;
  riskClass: ApprovalRequest["riskClass"];
  policyVersion: string | null;
  prNumber: number | null;
  prUrl: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

function buildPrUrl(repo: string | null, prNumber: number | null): string | null {
  if (!repo || prNumber === null) return null;
  return `https://github.com/${repo}/pull/${prNumber}`;
}

export function buildAuditEntries(
  approvals: readonly ApprovalRequest[],
  manifestsByTaskId: ReadonlyMap<string, TaskManifest>
): AuditEntry[] {
  return approvals.map((approval) => {
    const manifest = manifestsByTaskId.get(approval.taskId);
    const repo = manifest?.source?.repo ?? null;
    const issueNumber = manifest?.source?.issueNumber ?? null;
    const prNumber = manifest?.prNumber ?? null;
    const policyVersion = manifest?.policyVersion ?? null;
    return {
      requestId: approval.requestId,
      taskId: approval.taskId,
      runId: approval.runId,
      repo,
      issueNumber,
      phase: approval.phase,
      status: approval.status,
      decision: approval.decision,
      decidedBy: approval.decidedBy,
      decisionSummary: approval.decisionSummary,
      riskClass: approval.riskClass,
      policyVersion,
      prNumber,
      prUrl: buildPrUrl(repo, prNumber),
      createdAt: approval.createdAt,
      updatedAt: approval.updatedAt,
      resolvedAt: approval.resolvedAt
    };
  });
}

// ── CSV rendering ──────────────────────────────────────────────────────────
//
// Escape per RFC 4180: wrap fields in double-quotes when they contain a comma,
// newline, carriage return, or double-quote; double-up embedded quotes.

const AUDIT_CSV_COLUMNS: Array<keyof AuditEntry> = [
  "requestId",
  "taskId",
  "runId",
  "repo",
  "issueNumber",
  "phase",
  "status",
  "decision",
  "decidedBy",
  "decisionSummary",
  "riskClass",
  "policyVersion",
  "prNumber",
  "prUrl",
  "createdAt",
  "updatedAt",
  "resolvedAt"
];

function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function renderAuditCsv(entries: readonly AuditEntry[]): string {
  const header = AUDIT_CSV_COLUMNS.join(",");
  const rows = entries.map((entry) =>
    AUDIT_CSV_COLUMNS.map((col) => escapeCsvCell(entry[col])).join(",")
  );
  return [header, ...rows].join("\r\n") + "\r\n";
}

// ── Filter helpers ─────────────────────────────────────────────────────────

export function filterAuditEntriesByRepo(
  entries: readonly AuditEntry[],
  repo: string | null
): AuditEntry[] {
  if (!repo) return [...entries];
  return entries.filter(
    (entry) => entry.repo !== null && entry.repo.toLowerCase() === repo.toLowerCase()
  );
}
