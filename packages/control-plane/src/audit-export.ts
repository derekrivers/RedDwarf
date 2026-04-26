import type {
  ApprovalRequest,
  EvidenceRecord,
  TaskManifest
} from "@reddwarf/contracts";

// Feature 185 — Audit-log export.
//
// Flat row type surfaced by `GET /audit/export`. Joins every approval decision
// with the task manifest that drove it, so an operator can answer compliance
// questions like "every autonomous change that touched packages/billing in Q2"
// without bespoke SQL. All fields derive from existing persisted data — no new
// events captured, no new tables.
//
// M25 F-197 — `kind` discriminator + auto-merge columns. Auto-merge gate
// decisions (recorded by F-194 as gate_decision evidence records titled
// "Auto-merge decision: …") flow through the same CSV with `kind="auto_merge"`
// rows. The new `decision` value carries the AutoMergeOutcome string; the
// `gateFailures` and `headSha` columns are populated only for auto-merge rows.

export type AuditEntryKind = "approval" | "auto_merge";

export interface AuditEntry {
  kind: AuditEntryKind;
  requestId: string;
  taskId: string;
  runId: string;
  repo: string | null;
  issueNumber: number | null;
  phase: ApprovalRequest["phase"];
  status: ApprovalRequest["status"] | "auto_merge";
  decision: ApprovalRequest["decision"] | string;
  decidedBy: string | null;
  decisionSummary: string | null;
  riskClass: ApprovalRequest["riskClass"];
  policyVersion: string | null;
  prNumber: number | null;
  prUrl: string | null;
  // M25 F-197 — auto-merge-only columns; null on approval rows.
  gateFailures: string | null;
  headSha: string | null;
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
      kind: "approval" as const,
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
      gateFailures: null,
      headSha: null,
      createdAt: approval.createdAt,
      updatedAt: approval.updatedAt,
      resolvedAt: approval.resolvedAt
    };
  });
}

// M25 F-197 — build audit entries from auto-merge gate_decision evidence
// records. Recognises records whose title starts with "Auto-merge decision:".
// All metadata fields are read defensively: malformed/missing entries fall
// back to safe nulls so a single corrupt record never breaks the export.
export function buildAutoMergeAuditEntries(
  records: readonly EvidenceRecord[],
  manifestsByTaskId: ReadonlyMap<string, TaskManifest>
): AuditEntry[] {
  return records
    .filter(
      (r) => r.kind === "gate_decision" && r.title.startsWith("Auto-merge decision")
    )
    .map((r) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      const manifest = manifestsByTaskId.get(r.taskId);
      const repo = manifest?.source?.repo ?? null;
      const issueNumber = manifest?.source?.issueNumber ?? null;
      const prNumber = typeof meta.prNumber === "number" ? meta.prNumber : null;
      const policyVersion = manifest?.policyVersion ?? null;
      const failedGates = Array.isArray(meta.failedGates)
        ? (meta.failedGates as unknown[]).map(String).join("|")
        : null;
      const headSha = typeof meta.headSha === "string" ? meta.headSha : null;
      const outcome = typeof meta.outcome === "string" ? meta.outcome : "unknown";
      const reason = typeof meta.reason === "string" ? meta.reason : null;
      return {
        kind: "auto_merge" as const,
        requestId: r.recordId,
        taskId: r.taskId,
        runId: "",
        repo,
        issueNumber,
        phase: "scm" as const,
        status: "auto_merge" as const,
        decision: outcome,
        decidedBy: "reddwarf-evaluator",
        decisionSummary: reason,
        riskClass: "low" as const,
        policyVersion,
        prNumber,
        prUrl: buildPrUrl(repo, prNumber),
        gateFailures: failedGates,
        headSha,
        createdAt: r.createdAt,
        updatedAt: r.createdAt,
        resolvedAt: r.createdAt
      };
    });
}

// ── CSV rendering ──────────────────────────────────────────────────────────
//
// Escape per RFC 4180: wrap fields in double-quotes when they contain a comma,
// newline, carriage return, or double-quote; double-up embedded quotes.

const AUDIT_CSV_COLUMNS: Array<keyof AuditEntry> = [
  "kind",
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
  // M25 F-197 — populated for kind=auto_merge rows; empty on approval rows.
  "gateFailures",
  "headSha",
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
