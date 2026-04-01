import type {
  ApprovalRequest,
  EvidenceRecord,
  PhaseRecord,
  PipelineRun,
  PlanningSpec,
  RunEvent,
  RunSummary,
  TaskManifest,
  TaskPhase
} from "@reddwarf/contracts";
import type { PlanningRepository } from "@reddwarf/evidence";
import { summarizeRunTokenUsage, type RunTokenUsageSummary } from "./token-budget.js";

export interface RunReportPhase {
  phase: TaskPhase;
  status: "pending" | "running" | "passed" | "failed" | "escalated" | "blocked";
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  actor: string | null;
  tokenBudget: unknown | null;
}

export interface RunReportScmSection {
  branchName: string | null;
  pullRequestNumber: number | null;
  reportLocation: string | null;
  diffLocation: string | null;
}

export interface RunReportData {
  run: PipelineRun;
  task: TaskManifest;
  spec: PlanningSpec | null;
  approval: ApprovalRequest | null;
  summary: RunSummary | null;
  phases: RunReportPhase[];
  tokenUsage: RunTokenUsageSummary;
  scm: RunReportScmSection | null;
  evidenceRecords: EvidenceRecord[];
  runEvents: RunEvent[];
  phaseRecords: PhaseRecord[];
  prompts: Array<{
    phase: string;
    promptHash: string;
    promptPath: string | null;
  }>;
}

function buildPhaseTimeline(runEvents: RunEvent[]): RunReportPhase[] {
  const byPhase = new Map<TaskPhase, RunReportPhase>();

  for (const event of [...runEvents].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt)
  )) {
    const existing =
      byPhase.get(event.phase) ??
      {
        phase: event.phase,
        status: "pending",
        startedAt: null,
        completedAt: null,
        durationMs: null,
        actor: null,
        tokenBudget: null
      };

    if (event.code === "PHASE_RUNNING" && existing.startedAt === null) {
      existing.startedAt = event.createdAt;
      existing.status = "running";
    }

    if (
      event.code === "PHASE_PASSED" ||
      event.code === "PHASE_FAILED" ||
      event.code === "PHASE_ESCALATED" ||
      event.code === "PHASE_BLOCKED"
    ) {
      existing.completedAt = event.createdAt;
      existing.durationMs = event.durationMs ?? existing.durationMs;
      existing.status =
        event.code === "PHASE_PASSED"
          ? "passed"
          : event.code === "PHASE_FAILED"
            ? "failed"
            : event.code === "PHASE_ESCALATED"
              ? "escalated"
              : "blocked";
    }

    const actor = event.data["actor"];
    if (typeof actor === "string" && actor.trim().length > 0) {
      existing.actor = actor;
    }

    if ("tokenBudget" in event.data) {
      existing.tokenBudget = event.data["tokenBudget"] ?? null;
    }

    byPhase.set(event.phase, existing);
  }

  return [...byPhase.values()];
}

function extractScmSection(
  task: TaskManifest,
  evidenceRecords: EvidenceRecord[],
  runId: string
): RunReportScmSection | null {
  const reportRecord =
    evidenceRecords.find(
      (record) => record.recordId === `${task.taskId}:scm:${runId}:report`
    ) ?? null;
  const diffRecord =
    evidenceRecords.find(
      (record) => record.recordId === `${task.taskId}:scm:${runId}:diff`
    ) ?? null;

  if (!reportRecord && !diffRecord && !task.branchName && !task.prNumber) {
    return null;
  }

  return {
    branchName: task.branchName,
    pullRequestNumber: task.prNumber,
    reportLocation: reportRecord?.location ?? null,
    diffLocation: diffRecord?.location ?? null
  };
}

function extractPromptSnapshots(runEvents: RunEvent[]): RunReportData["prompts"] {
  const prompts = new Map<string, RunReportData["prompts"][number]>();

  for (const event of runEvents) {
    const raw = event.data["prompt"];
    if (!raw || typeof raw !== "object") {
      continue;
    }

    const phase = typeof (raw as Record<string, unknown>)["phase"] === "string"
      ? String((raw as Record<string, unknown>)["phase"])
      : event.phase;
    const promptHash = (raw as Record<string, unknown>)["promptHash"];
    if (typeof promptHash !== "string" || promptHash.trim().length === 0) {
      continue;
    }

    const promptPath = (raw as Record<string, unknown>)["promptPath"];
    prompts.set(`${phase}:${promptHash}`, {
      phase,
      promptHash,
      promptPath: typeof promptPath === "string" ? promptPath : null
    });
  }

  return [...prompts.values()].sort((left, right) =>
    left.phase.localeCompare(right.phase)
  );
}

export async function assembleRunReport(
  repository: PlanningRepository,
  runId: string
): Promise<RunReportData | null> {
  const run = await repository.getPipelineRun(runId);
  if (!run) {
    return null;
  }

  const [snapshot, summary, runEvents] = await Promise.all([
    repository.getTaskSnapshot(run.taskId),
    repository.getRunSummary(run.taskId, runId),
    repository.listRunEvents(run.taskId, runId)
  ]);

  if (!snapshot.manifest) {
    return null;
  }

  const approval =
    snapshot.approvalRequests
      .filter((request) => request.runId === runId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ??
    null;

  return {
    run,
    task: snapshot.manifest,
    spec: snapshot.spec,
    approval,
    summary,
    phases: buildPhaseTimeline(runEvents),
    tokenUsage: summarizeRunTokenUsage(runEvents),
    scm: extractScmSection(snapshot.manifest, snapshot.evidenceRecords, runId),
    evidenceRecords: snapshot.evidenceRecords,
    runEvents,
    phaseRecords: snapshot.phaseRecords,
    prompts: extractPromptSnapshots(runEvents)
  };
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return "n/a";
  }

  return value.replace("T", " ").replace(".000Z", " UTC");
}

function renderSpecMarkdown(spec: PlanningSpec): string[] {
  return [
    "## Planning Spec",
    "",
    `Summary: ${spec.summary}`,
    `Confidence: ${spec.confidenceLevel} (${spec.confidenceReason})`,
    "",
    "Assumptions:",
    ...(spec.assumptions.length > 0 ? spec.assumptions.map((item) => `- ${item}`) : ["- none"]),
    "",
    "Affected Areas:",
    ...(spec.affectedAreas.length > 0
      ? spec.affectedAreas.map((item) => `- ${item}`)
      : ["- none"]),
    "",
    "Constraints:",
    ...(spec.constraints.length > 0 ? spec.constraints.map((item) => `- ${item}`) : ["- none"]),
    "",
    "Acceptance Criteria:",
    ...(spec.acceptanceCriteria.length > 0
      ? spec.acceptanceCriteria.map((item) => `- ${item}`)
      : ["- none"]),
    "",
    "Test Expectations:",
    ...(spec.testExpectations.length > 0
      ? spec.testExpectations.map((item) => `- ${item}`)
      : ["- none"]),
    ""
  ];
}

export function renderRunReportMarkdown(report: RunReportData): string {
  const lines: string[] = [];

  if (report.run.dryRun) {
    lines.push("> WARNING: DRY RUN. No GitHub mutations were made.");
    lines.push("");
  }

  lines.push("# Pipeline Run Report");
  lines.push("");
  lines.push(`- Run ID: ${report.run.runId}`);
  lines.push(`- Task ID: ${report.task.taskId}`);
  lines.push(`- Status: ${report.run.status}`);
  lines.push(`- Started: ${formatTimestamp(report.run.startedAt)}`);
  lines.push(`- Completed: ${formatTimestamp(report.run.completedAt)}`);
  lines.push("");
  lines.push("## Task");
  lines.push("");
  lines.push(`- Repository: ${report.task.source.repo}`);
  lines.push(`- Title: ${report.task.title}`);
  lines.push(
    `- Source issue: ${
      report.task.source.issueUrl ??
      (report.task.source.issueNumber !== undefined
        ? `#${report.task.source.issueNumber}`
        : "n/a")
    }`
  );
  lines.push(`- Risk class: ${report.task.riskClass}`);
  lines.push(`- Approval mode: ${report.task.approvalMode}`);
  lines.push("");

  if (report.spec) {
    lines.push(...renderSpecMarkdown(report.spec));
  }

  if (report.approval) {
    lines.push("## Approval");
    lines.push("");
    lines.push(`- Request ID: ${report.approval.requestId}`);
    lines.push(`- Status: ${report.approval.status}`);
    lines.push(`- Mode: ${report.approval.approvalMode}`);
    lines.push(`- Requested by: ${report.approval.requestedBy}`);
    if (report.approval.decision) {
      lines.push(`- Decision: ${report.approval.decision}`);
    }
    if (report.approval.decisionSummary) {
      lines.push(`- Decision summary: ${report.approval.decisionSummary}`);
    }
    lines.push("");
  }

  lines.push("## Phase Timeline");
  lines.push("");
  lines.push("| Phase | Status | Started | Completed | Duration |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const phase of report.phases) {
    lines.push(
      `| ${phase.phase} | ${phase.status} | ${formatTimestamp(phase.startedAt)} | ${formatTimestamp(
        phase.completedAt
      )} | ${phase.durationMs === null ? "n/a" : `${phase.durationMs} ms`} |`
    );
  }
  lines.push("");

  lines.push("## Token Usage");
  lines.push("");
  lines.push(`- Total estimated tokens: ${report.tokenUsage.totalEstimatedTokens}`);
  lines.push(`- Total actual input tokens: ${report.tokenUsage.totalActualInputTokens}`);
  lines.push(`- Total actual output tokens: ${report.tokenUsage.totalActualOutputTokens}`);
  lines.push(`- Total actual tokens: ${report.tokenUsage.totalActualTokens}`);
  lines.push(`- Any phase exceeded budget: ${report.tokenUsage.anyPhaseExceeded ? "yes" : "no"}`);
  lines.push("");

  if (report.scm) {
    lines.push("## SCM");
    lines.push("");
    lines.push(`- Branch: ${report.scm.branchName ?? "n/a"}`);
    lines.push(`- Pull request: ${report.scm.pullRequestNumber ?? "n/a"}`);
    lines.push(`- Report artifact: ${report.scm.reportLocation ?? "n/a"}`);
    lines.push(`- Diff artifact: ${report.scm.diffLocation ?? "n/a"}`);
    lines.push("");
  }

  if (report.prompts.length > 0) {
    lines.push("## Prompt Snapshots");
    lines.push("");
    lines.push("| Phase | Hash | Path |");
    lines.push("| --- | --- | --- |");
    for (const prompt of report.prompts) {
      lines.push(
        `| ${prompt.phase} | ${prompt.promptHash} | ${prompt.promptPath ?? "n/a"} |`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
