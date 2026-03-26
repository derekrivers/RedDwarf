import {
  approvalDecisions,
  approvalModes,
  approvalRequestStatuses,
  concurrencyStrategies,
  evidenceKinds,
  eventLevels,
  failureClasses,
  memoryProvenances,
  memoryScopes,
  phaseLifecycleStatuses,
  pipelineRunStatuses,
  riskClasses,
  taskLifecycleStatuses,
  taskPhases
} from "@reddwarf/contracts";
import { integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const taskPhaseEnum = pgEnum("task_phase", taskPhases);
export const taskLifecycleStatusEnum = pgEnum("task_lifecycle_status", taskLifecycleStatuses);
export const phaseLifecycleStatusEnum = pgEnum("phase_lifecycle_status", phaseLifecycleStatuses);
export const riskClassEnum = pgEnum("risk_class", riskClasses);
export const approvalModeEnum = pgEnum("approval_mode", approvalModes);
export const approvalRequestStatusEnum = pgEnum("approval_request_status", approvalRequestStatuses);
export const approvalDecisionEnum = pgEnum("approval_decision", approvalDecisions);
export const evidenceKindEnum = pgEnum("evidence_kind", evidenceKinds);
export const eventLevelEnum = pgEnum("event_level", eventLevels);
export const failureClassEnum = pgEnum("failure_class", failureClasses);
export const memoryScopeEnum = pgEnum("memory_scope", memoryScopes);
export const memoryProvenanceEnum = pgEnum("memory_provenance", memoryProvenances);
export const concurrencyStrategyEnum = pgEnum("concurrency_strategy", concurrencyStrategies);
export const pipelineRunStatusEnum = pgEnum("pipeline_run_status", pipelineRunStatuses);

export const manifestsTable = pgTable("task_manifests", {
  taskId: text("task_id").primaryKey(),
  source: jsonb("source").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  priority: integer("priority").notNull(),
  riskClass: riskClassEnum("risk_class").notNull(),
  approvalMode: approvalModeEnum("approval_mode").notNull(),
  currentPhase: taskPhaseEnum("current_phase").notNull(),
  lifecycleStatus: taskLifecycleStatusEnum("lifecycle_status").notNull(),
  assignedAgentType: text("assigned_agent_type").notNull(),
  requestedCapabilities: jsonb("requested_capabilities").notNull(),
  retryCount: integer("retry_count").notNull(),
  evidenceLinks: jsonb("evidence_links").notNull(),
  workspaceId: text("workspace_id"),
  branchName: text("branch_name"),
  prNumber: integer("pr_number"),
  policyVersion: text("policy_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const phaseRecordsTable = pgTable(
  "phase_records",
  {
    recordId: text("record_id").notNull(),
    taskId: text("task_id").notNull(),
    phase: taskPhaseEnum("phase").notNull(),
    status: phaseLifecycleStatusEnum("status").notNull(),
    actor: text("actor").notNull(),
    summary: text("summary").notNull(),
    details: jsonb("details").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.recordId, table.taskId] })
  })
);

export const planningSpecsTable = pgTable("planning_specs", {
  specId: text("spec_id").primaryKey(),
  taskId: text("task_id").notNull(),
  summary: text("summary").notNull(),
  assumptions: jsonb("assumptions").notNull(),
  affectedAreas: jsonb("affected_areas").notNull(),
  constraints: jsonb("constraints").notNull(),
  acceptanceCriteria: jsonb("acceptance_criteria").notNull(),
  testExpectations: jsonb("test_expectations").notNull(),
  recommendedAgentType: text("recommended_agent_type").notNull(),
  riskClass: riskClassEnum("risk_class").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const policySnapshotsTable = pgTable("policy_snapshots", {
  taskId: text("task_id").primaryKey(),
  snapshot: jsonb("snapshot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const evidenceRecordsTable = pgTable("evidence_records", {
  recordId: text("record_id").primaryKey(),
  taskId: text("task_id").notNull(),
  kind: evidenceKindEnum("kind").notNull(),
  title: text("title").notNull(),
  location: text("location").notNull(),
  metadata: jsonb("metadata").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const runEventsTable = pgTable("run_events", {
  eventId: text("event_id").primaryKey(),
  taskId: text("task_id").notNull(),
  runId: text("run_id").notNull(),
  phase: taskPhaseEnum("phase").notNull(),
  level: eventLevelEnum("level").notNull(),
  code: text("code").notNull(),
  message: text("message").notNull(),
  failureClass: failureClassEnum("failure_class"),
  durationMs: integer("duration_ms"),
  data: jsonb("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const memoryRecordsTable = pgTable("memory_records", {
  memoryId: text("memory_id").primaryKey(),
  taskId: text("task_id"),
  scope: memoryScopeEnum("scope").notNull(),
  provenance: memoryProvenanceEnum("provenance").notNull(),
  key: text("key").notNull(),
  title: text("title").notNull(),
  value: jsonb("value").notNull(),
  repo: text("repo"),
  organizationId: text("organization_id"),
  sourceUri: text("source_uri"),
  tags: jsonb("tags").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const pipelineRunsTable = pgTable("pipeline_runs", {
  runId: text("run_id").primaryKey(),
  taskId: text("task_id").notNull(),
  concurrencyKey: text("concurrency_key").notNull(),
  strategy: concurrencyStrategyEnum("strategy").notNull(),
  status: pipelineRunStatusEnum("status").notNull(),
  blockedByRunId: text("blocked_by_run_id"),
  overlapReason: text("overlap_reason"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  staleAt: timestamp("stale_at", { withTimezone: true }),
  metadata: jsonb("metadata").notNull()
});

export const approvalRequestsTable = pgTable("approval_requests", {
  requestId: text("request_id").primaryKey(),
  taskId: text("task_id").notNull(),
  runId: text("run_id").notNull(),
  phase: taskPhaseEnum("phase").notNull(),
  approvalMode: approvalModeEnum("approval_mode").notNull(),
  status: approvalRequestStatusEnum("status").notNull(),
  riskClass: riskClassEnum("risk_class").notNull(),
  summary: text("summary").notNull(),
  requestedCapabilities: jsonb("requested_capabilities").notNull(),
  allowedPaths: jsonb("allowed_paths").notNull(),
  blockedPhases: jsonb("blocked_phases").notNull(),
  policyReasons: jsonb("policy_reasons").notNull(),
  requestedBy: text("requested_by").notNull(),
  decidedBy: text("decided_by"),
  decision: approvalDecisionEnum("decision"),
  decisionSummary: text("decision_summary"),
  comment: text("comment"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true })
});

