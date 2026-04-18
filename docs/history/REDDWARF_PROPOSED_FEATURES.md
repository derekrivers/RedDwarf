# RedDwarf — Proposed Feature Implementations

> **Purpose:** Deep implementation reference for six proposed features, each buildable without a VPS. Use this alongside `FEATURE_BOARD.md` when picking up any of these items. Each section covers motivation, schema migrations, TypeScript contracts, control-plane logic, operator API surface, and wiring notes.

**Priority reset note:** These features are ordered by value-to-effort ratio, not by architecture plane. Features 1–3 have high day-one operational payoff and should be considered before M16 intake work resumes. Features 4–6 are lower effort and can be slotted between larger items.

---

## Contents

1. [Dry-run / Simulation Mode](#1-dry-run--simulation-mode)
2. [Plan Confidence Gate](#2-plan-confidence-gate)
3. [Token Budget Enforcement](#3-token-budget-enforcement)
4. [Pipeline Run Report Export](#4-pipeline-run-report-export)
5. [Prompt Version Tracking](#5-prompt-version-tracking)
6. [Phase Retry Budget](#6-phase-retry-budget)
7. [Structured Eligibility Rejection Reasons](#7-structured-eligibility-rejection-reasons)
8. [Cross-cutting wiring notes](#8-cross-cutting-wiring-notes)

---

## 1. Dry-run / Simulation Mode

### Motivation

Running the full pipeline to tune prompts, eligibility policy, or context materialisation currently risks side effects: GitHub mutations, PR creation, branch creation, label application. A dry-run flag suppresses every side-effecting call while still executing all LLM phases and writing full evidence to Postgres. This makes it safe to iterate without a test repo or a VPS.

Dry-run is also the canonical demo mode — the stack runs end-to-end, all evidence is written, but nothing touches the target repo.

### Architecture placement

- `packages/contracts` — `PipelineRunContext` type extension, `DryRunSkippedError`
- `packages/control-plane` — mutation guard wrapper, startup banner, config ingestion
- `packages/integrations` — guard applied at every GitHub/SCM adapter call
- `packages/evidence` — `dry_run` column on `pipeline_runs` and `task_manifests`
- `packages/policy` — approval requests written as `dry_run = true`, not suppressed

### Schema migration

```sql
-- migration: add dry_run flag to pipeline_runs
ALTER TABLE pipeline_runs
  ADD COLUMN dry_run BOOLEAN NOT NULL DEFAULT FALSE;

-- and to task_manifests so the eligibility gate can short-circuit cheaply
ALTER TABLE task_manifests
  ADD COLUMN dry_run BOOLEAN NOT NULL DEFAULT FALSE;

-- index for filtering operator API responses
CREATE INDEX idx_pipeline_runs_dry_run ON pipeline_runs (dry_run);
```

### Contracts (packages/contracts)

```typescript
// Extend PipelineRunContext with dry_run flag
export interface PipelineRunContext {
  runId:     string;
  taskId:    string;
  dryRun:    boolean; // ← new
  startedAt: Date;
  // ...existing fields
}

// Typed error for suppressed operations — caught in control-plane,
// logged as structured evidence, never treated as a pipeline failure.
export class DryRunSkippedError extends Error {
  readonly operation: string;
  constructor(operation: string) {
    super(`[dry-run] skipped: ${operation}`);
    this.operation = operation;
    this.name = 'DryRunSkippedError';
  }
}

// Evidence record shape for a skipped mutation
export interface DryRunSkippedEvidence {
  operation:    string;
  payload:      unknown;       // the full payload that would have been sent
  skippedAt:    Date;
  phase:        AgentPhase;
}
```

### Mutation guard pattern (packages/control-plane)

The guard is a thin wrapper applied at every call site that would produce a side effect. Favour wrapping the call site over adding guard logic deep inside adapters — keeps the adapter contracts clean and the suppression logic visible in control-plane where it belongs.

```typescript
import { DryRunSkippedError, DryRunSkippedEvidence } from '@reddwarf/contracts';

/**
 * Wraps any side-effecting operation.
 * In dry-run mode: archives the payload as evidence and returns the fallback.
 * In live mode: executes fn() and returns its result.
 */
export async function guardMutation<T>(
  ctx:      PipelineRunContext,
  operation: string,
  fn:        () => Promise<T>,
  fallback:  T,
  db:        DbClient,
): Promise<T> {
  if (!ctx.dryRun) {
    return fn();
  }
  const evidence: DryRunSkippedEvidence = {
    operation,
    payload:   null,   // caller can pass payload separately if needed
    skippedAt: new Date(),
    phase:     ctx.currentPhase,
  };
  await db.archiveDryRunEvidence(ctx.runId, evidence);
  return fallback;
}

// --- Usage examples in control-plane ---

// Branch creation
const branch = await guardMutation(
  ctx, 'scm:create_branch',
  () => githubAdapter.createBranch(branchPayload),
  { skipped: true, branchName: branchPayload.name },
  db,
);

// PR creation
const pr = await guardMutation(
  ctx, 'scm:open_pr',
  () => githubAdapter.openPullRequest(prPayload),
  { skipped: true, url: null },
  db,
);

// Issue label mutation
await guardMutation(
  ctx, 'github:apply_label',
  () => githubAdapter.applyLabel(issueId, 'ai-in-progress'),
  undefined,
  db,
);

// Workspace materialisation — still materialise in dry-run so the
// Developer phase has a real workspace to write into, but mark it dry_run.
// Only suppress the workspace *push* / SCM integration steps.
```

### Config and entry points

```typescript
// packages/control-plane/src/config.ts additions
export interface ReddwarfConfig {
  // ...existing fields
  dryRun: boolean;   // from REDDWARF_DRY_RUN env var or --dry-run CLI flag
}

export function loadConfig(): ReddwarfConfig {
  return {
    // ...
    dryRun: process.env.REDDWARF_DRY_RUN === 'true',
  };
}
```

```typescript
// packages/control-plane/src/start.ts — startup banner
if (config.dryRun) {
  log.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log.warn('[DRY RUN MODE] No GitHub mutations will be made.');
  log.warn('All LLM phases execute. Full evidence is written.');
  log.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}
```

`.env.example` addition:
```
# Set to true to run the full pipeline without GitHub side effects
REDDWARF_DRY_RUN=false
```

`pnpm start` / CLI:
```bash
REDDWARF_DRY_RUN=true corepack pnpm start
# or, once reddwarf submit CLI exists (feature 97):
reddwarf submit --issue 42 --dry-run
```

### Operator API changes

Add `dryRun: boolean` to all run summary responses. Mark dry-run entries visually in `/blocked` so reviewers aren't confused by approval requests that will never produce a PR.

```typescript
// GET /runs — include dry_run in run summaries
// GET /blocked — include dry_run flag alongside each pending approval
// GET /runs/:runId/report — emit prominent DRY RUN banner at top of report
```

### What still executes in dry-run mode

| Operation | Dry-run behaviour |
|---|---|
| GitHub issue polling | Normal — issues read and ingested |
| Eligibility gate | Normal — task evaluated against policy |
| Architect LLM call | Normal — full planning spec produced |
| Approval queue entry | Written to DB with `dry_run = true` |
| Workspace materialisation | Materialised locally, not pushed |
| Developer LLM call | Normal — code generated into workspace |
| Validator phase | Normal — lint/tests run in workspace |
| Branch creation | **Skipped** — evidence written |
| PR creation | **Skipped** — evidence written |
| Issue label mutations | **Skipped** — evidence written |
| Evidence archival | Normal — full evidence written |

---

## 2. Plan Confidence Gate

### Motivation

The Architect currently either produces a spec or fails. There is no signal indicating how certain it is about the spec's correctness or completeness. A structured confidence output lets policy automatically gate low-confidence plans for human review, regardless of other eligibility criteria. It also gives the human reviewer a concrete reason rather than having to read the entire spec to understand why it was flagged.

As prompt quality improves over time, confidence distributions shift — tracking this in evidence lets you measure improvement quantitatively.

### Architecture placement

- `packages/contracts` — `ConfidenceSignal` type, updated `architectOutputSchema`
- `prompts/architect/` — prompt instruction addition
- `packages/policy` — `deriveApprovalRequirement` updated to gate on `confidence.level`
- `packages/evidence` — columns on `planning_specs`
- `packages/control-plane` — parse and persist confidence alongside spec

### Schema migration

```sql
-- migration: confidence signal on planning_specs
ALTER TABLE planning_specs
  ADD COLUMN confidence_level   TEXT
    CHECK (confidence_level IN ('low', 'medium', 'high')),
  ADD COLUMN confidence_reason  TEXT,
  ADD COLUMN confidence_raw     JSONB;  -- raw model block for auditability

-- index for correlating confidence with outcomes
CREATE INDEX idx_planning_specs_confidence ON planning_specs (confidence_level);
```

### Contracts (packages/contracts)

```typescript
import { z } from 'zod';

export const confidenceLevelSchema = z.enum(['low', 'medium', 'high']);
export type ConfidenceLevel = z.infer<typeof confidenceLevelSchema>;

export const confidenceSignalSchema = z.object({
  level:  confidenceLevelSchema,
  reason: z.string().min(10).max(300),
});
export type ConfidenceSignal = z.infer<typeof confidenceSignalSchema>;

// Updated Architect output schema — wraps the existing planningSpecSchema
export const architectOutputSchema = z.object({
  spec:       planningSpecSchema,     // existing — no changes
  confidence: confidenceSignalSchema, // ← new
});
export type ArchitectOutput = z.infer<typeof architectOutputSchema>;
```

### Prompt instruction (prompts/architect/planning.md — append to existing)

Add this block at the end of the Architect system prompt, after all existing instructions:

```
---

## Confidence signal (required)

After your planning spec, output a fenced JSON block tagged `confidence`.
This block is parsed programmatically — output only valid JSON, no prose inside the block.

\`\`\`confidence
{
  "level": "low" | "medium" | "high",
  "reason": "<one sentence, maximum 200 characters>"
}
\`\`\`

### Scoring guide

**low** — use when any of the following are true:
- The issue lacks explicit acceptance criteria
- The affected code surface is unclear or not named
- The task touches authentication, authorisation, secrets, or data migrations
- You had to make significant assumptions to produce the spec
- There is genuine ambiguity about the desired behaviour

**medium** — use when:
- The spec is complete but depends on assumptions you have documented
- The blast radius is bounded but involves more than one package
- The task is routine but in an area you have limited context for

**high** — use only when:
- Requirements are fully specified with clear acceptance criteria
- Blast radius is clearly bounded to a named package or module
- No meaningful assumptions were required
- The spec is unambiguous end-to-end

When in doubt, prefer **low** over **medium**. A false low costs one human review.
A false high costs a failed run, a potential bad PR, and investigative time.
```

### Policy gate (packages/policy)

```typescript
import { ConfidenceSignal } from '@reddwarf/contracts';

export interface ApprovalDecision {
  required:        boolean;
  reason:          string;
  humanReadable:   string;
  confidenceLevel?: ConfidenceLevel;
}

export function deriveApprovalRequirement(
  task:       TaskManifest,
  spec:       PlanningSpec,
  confidence: ConfidenceSignal,
  policy:     PolicyConfig,
): ApprovalDecision {

  // Low confidence always forces approval, regardless of other policy.
  // This is intentionally unconditional — it cannot be overridden by
  // task-level policy or operator config.
  if (confidence.level === 'low') {
    return {
      required:        true,
      reason:          'architect-low-confidence',
      humanReadable:   `Architect flagged low confidence: ${confidence.reason}`,
      confidenceLevel: 'low',
    };
  }

  // Medium confidence: apply normal policy, but note the confidence level
  // in the approval entry for context if it does get queued.
  const baseDecision = evaluateBasePolicy(task, spec, policy);
  return {
    ...baseDecision,
    confidenceLevel: confidence.level,
    humanReadable: baseDecision.required
      ? `${baseDecision.humanReadable} (confidence: ${confidence.level})`
      : baseDecision.humanReadable,
  };
}

// High confidence + low-risk task = no approval required (existing behaviour).
// High confidence + high-risk task = existing risk policy applies.
```

### Control-plane wiring (packages/control-plane)

```typescript
// In the planning pipeline, after the Architect LLM call returns:

async function runArchitectPhase(
  ctx: PipelineRunContext,
  db:  DbClient,
): Promise<ArchitectOutput> {

  const raw = await openClawRuntime.runAgent('architect', ctx);

  // Parse the structured output — throws if the confidence block is missing
  // or malformed, which will trigger the phase retry budget.
  const parsed = architectOutputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PhaseOutputParseError('architect', parsed.error);
  }

  // Persist spec + confidence together atomically
  await db.savePlanningSpec({
    runId:            ctx.runId,
    spec:             parsed.data.spec,
    confidenceLevel:  parsed.data.confidence.level,
    confidenceReason: parsed.data.confidence.reason,
    confidenceRaw:    raw,  // full raw output preserved
  });

  return parsed.data;
}
```

### Operator API surface

```typescript
// GET /blocked — each pending approval now includes confidence signal:
{
  "approvalId": "uuid",
  "taskTitle":  "Add rate limiting to /api/upload",
  "reason":     "architect-low-confidence",
  "humanReadable": "Architect flagged low confidence: affected endpoints unclear, assumed /api/upload only",
  "confidence": {
    "level":  "low",
    "reason": "affected endpoints unclear, assumed /api/upload only"
  },
  "dryRun": false
}

// GET /runs/:runId/report — confidence section:
// ## Confidence
// Level: LOW
// Reason: affected endpoints unclear, assumed /api/upload only
// → This plan was automatically queued for human review.
```

---

## 3. Token Budget Enforcement

### Motivation

Context windows are large but not free. Without visibility into how many tokens are being consumed per phase, it is impossible to reason about cost, detect context bloat introduced by features 90–93 (role-scoped context, memory compression), or set sensible limits. A budget gate provides a feedback loop for context optimisation and a hard stop before a runaway context consumes an unexpectedly large token allocation.

### Architecture placement

- `packages/contracts` — `TokenBudgetResult`, `TokenBudgetConfig`
- `packages/control-plane` — `checkTokenBudget`, pre-phase gate
- `packages/policy` — `REDDWARF_TOKEN_BUDGET_OVERAGE_ACTION` controls behaviour
- `packages/evidence` — columns on `phase_evidence`

### Config vars

```
# .env.example additions

# Per-phase token budgets (approximate — uses char/4 heuristic pre-dispatch,
# then actual usage from model response post-dispatch).
# Set to 0 to disable budgeting for a phase.
REDDWARF_TOKEN_BUDGET_ARCHITECT=80000
REDDWARF_TOKEN_BUDGET_DEVELOPER=120000
REDDWARF_TOKEN_BUDGET_VALIDATOR=40000

# warn  = log overage and continue (default — safe for initial rollout)
# block = fail the phase and route to approval queue
REDDWARF_TOKEN_BUDGET_OVERAGE_ACTION=warn
```

### Schema migration

```sql
-- migration: attach token budget telemetry to phase_evidence rows
ALTER TABLE phase_evidence
  ADD COLUMN estimated_input_tokens   INTEGER,
  ADD COLUMN actual_input_tokens      INTEGER,   -- from model response usage field
  ADD COLUMN actual_output_tokens     INTEGER,
  ADD COLUMN token_budget_limit       INTEGER,
  ADD COLUMN token_budget_exceeded    BOOLEAN GENERATED ALWAYS AS
    (actual_input_tokens IS NOT NULL
     AND token_budget_limit IS NOT NULL
     AND actual_input_tokens > token_budget_limit) STORED;

-- useful for reporting: total token spend per run
CREATE VIEW run_token_summary AS
SELECT
  run_id,
  SUM(actual_input_tokens)  AS total_input_tokens,
  SUM(actual_output_tokens) AS total_output_tokens,
  SUM(actual_input_tokens + COALESCE(actual_output_tokens, 0)) AS total_tokens,
  BOOL_OR(token_budget_exceeded) AS any_phase_exceeded
FROM phase_evidence
GROUP BY run_id;
```

### Contracts (packages/contracts)

```typescript
export type AgentPhase = 'architect' | 'developer' | 'validator';

export interface TokenBudgetConfig {
  limits: Record<AgentPhase, number>;    // 0 = disabled for that phase
  overageAction: 'warn' | 'block';
}

export interface TokenBudgetResult {
  phase:            AgentPhase;
  estimatedTokens:  number;
  budgetLimit:      number;
  withinBudget:     boolean;
  overageAction:    'warn' | 'block';
  // Populated post-dispatch from model response
  actualInputTokens?:  number;
  actualOutputTokens?: number;
}

export class TokenBudgetExceededError extends Error {
  readonly result: TokenBudgetResult;
  constructor(result: TokenBudgetResult) {
    super(
      `Token budget exceeded for phase '${result.phase}': ` +
      `estimated ${result.estimatedTokens} > limit ${result.budgetLimit}`
    );
    this.result = result;
    this.name   = 'TokenBudgetExceededError';
  }
}
```

### Budget checker (packages/control-plane)

```typescript
import { createHash } from 'crypto';

/**
 * Pre-dispatch estimate.
 * Uses char/4 as a rough approximation — good enough for budget gating.
 * Replace with tiktoken if tighter accuracy is needed later.
 */
export function estimateTokens(context: MaterialisedContext): number {
  const serialised = JSON.stringify(context);
  return Math.ceil(serialised.length / 4);
}

export function checkTokenBudget(
  phase:   AgentPhase,
  context: MaterialisedContext,
  config:  TokenBudgetConfig,
): TokenBudgetResult {
  const limit     = config.limits[phase] ?? 0;
  const estimated = estimateTokens(context);

  return {
    phase,
    estimatedTokens: estimated,
    budgetLimit:     limit,
    withinBudget:    limit === 0 || estimated <= limit,
    overageAction:   config.overageAction,
  };
}

/**
 * Gate to call before dispatching any agent phase.
 * Throws TokenBudgetExceededError only if action=block.
 * Logs a structured warning in both cases.
 */
export async function enforceTokenBudget(
  phase:   AgentPhase,
  context: MaterialisedContext,
  config:  TokenBudgetConfig,
  log:     Logger,
  db:      DbClient,
  runId:   string,
): Promise<TokenBudgetResult> {
  const result = checkTokenBudget(phase, context, config);

  if (!result.withinBudget) {
    log.warn({
      msg:            'token budget exceeded',
      phase:          result.phase,
      estimatedTokens: result.estimatedTokens,
      budgetLimit:    result.budgetLimit,
      action:         result.overageAction,
    });
    await db.recordTokenBudgetOverage(runId, result);

    if (result.overageAction === 'block') {
      throw new TokenBudgetExceededError(result);
    }
  }

  return result;
}
```

### Post-dispatch usage capture

```typescript
// After each OpenClaw / API response, capture actual usage from the
// model response object and write it back to phase_evidence.

interface ModelUsage {
  input_tokens:  number;
  output_tokens: number;
}

async function recordPhaseTokenUsage(
  runId:  string,
  phase:  AgentPhase,
  usage:  ModelUsage,
  budget: TokenBudgetResult,
  db:     DbClient,
): Promise<void> {
  await db.updatePhaseTokenUsage(runId, phase, {
    actualInputTokens:  usage.input_tokens,
    actualOutputTokens: usage.output_tokens,
    tokenBudgetLimit:   budget.budgetLimit,
  });
}
```

### Operator API

```typescript
// GET /runs/:runId — include token summary in run detail:
{
  "runId": "uuid",
  "tokenUsage": {
    "architect":  { "estimated": 18400, "actual": 17230, "budget": 80000, "exceeded": false },
    "developer":  { "estimated": 41200, "actual": 38900, "budget": 120000, "exceeded": false },
    "validator":  { "estimated": 9800,  "actual": 8210,  "budget": 40000,  "exceeded": false },
    "totalActual": 64340
  }
}

// GET /runs — summary list can include totalTokens as a sortable field
// useful for identifying expensive runs:
// GET /runs?sort=totalTokens&order=desc&limit=20
```

---

## 4. Pipeline Run Report Export

### Motivation

The operator API provides a useful JSON surface for tooling, but there is no self-contained human-readable view of a complete pipeline run. A Markdown report lets a reviewer understand exactly what happened — from issue intake through to PR — without needing the operator API running, without digging through evidence tables directly, and without any external infrastructure.

The report is also the natural output for async handoffs: commit the report alongside the generated code, or drop it in a thread for review.

### Architecture placement

- `packages/control-plane` — `assembleRunReport`, report renderer
- `packages/evidence` — query helpers (no schema changes required)
- Operator API — `GET /runs/:runId/report`
- CLI — `reddwarf:report` script

### No schema changes required

The report queries existing evidence tables. Once prompt version tracking (feature 5) and token budget columns (feature 3) are in place, those enrich the report automatically — no additional migrations needed.

### Report assembler (packages/control-plane)

```typescript
export interface RunReportData {
  run:      PipelineRun;
  task:     TaskManifest;
  spec?:    PlanningSpec;        // null if planning failed
  approval?: ApprovalRequest;
  phases:   PhaseEvidence[];
  scm?:     ScmReport;
  tokens?:  RunTokenSummary;     // from feature 3
  prompts?: PromptSnapshot[];    // from feature 5
}

export async function assembleRunReport(
  runId: string,
  db:    DbClient,
): Promise<RunReportData> {
  const [run, task, spec, approval, phases, scm, tokens, prompts] =
    await Promise.all([
      db.getPipelineRun(runId),
      db.getTaskManifestByRunId(runId),
      db.getPlanningSpec(runId).catch(() => null),
      db.getApprovalRequest(runId).catch(() => null),
      db.getPhaseEvidence(runId),
      db.getScmReport(runId).catch(() => null),
      db.getRunTokenSummary(runId).catch(() => null),
      db.getPromptSnapshotsForRun(runId).catch(() => []),
    ]);

  return { run, task, spec, approval, phases, scm, tokens, prompts };
}

export function renderRunReportMarkdown(data: RunReportData): string {
  const lines: string[] = [];
  const fmt = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  // Header
  if (data.run.dryRun) {
    lines.push('> ⚠️  **DRY RUN** — No GitHub mutations were made.\n');
  }
  lines.push(`# Pipeline Run Report`);
  lines.push(`**Run ID:** \`${data.run.id}\``);
  lines.push(`**Status:** ${data.run.status}`);
  lines.push(`**Started:** ${fmt(data.run.startedAt)}`);
  if (data.run.completedAt) {
    lines.push(`**Completed:** ${fmt(data.run.completedAt)}`);
  }
  lines.push('');

  // Task
  lines.push('## Task');
  lines.push(`**Title:** ${data.task.title}`);
  if (data.task.sourceIssueUrl) {
    lines.push(`**Source issue:** ${data.task.sourceIssueUrl}`);
  }
  lines.push(`**Labels:** ${(data.task.labels ?? []).join(', ') || 'none'}`);
  lines.push('');

  // Planning spec
  if (data.spec) {
    lines.push('## Planning spec');
    if (data.spec.confidenceLevel) {
      const icon = { low: '🔴', medium: '🟡', high: '🟢' }[data.spec.confidenceLevel];
      lines.push(`**Confidence:** ${icon} ${data.spec.confidenceLevel.toUpperCase()}`);
      if (data.spec.confidenceReason) {
        lines.push(`**Reason:** ${data.spec.confidenceReason}`);
      }
      lines.push('');
    }
    lines.push('```');
    lines.push(data.spec.body);
    lines.push('```');
    lines.push('');
  }

  // Approval
  if (data.approval) {
    lines.push('## Approval');
    lines.push(`**Status:** ${data.approval.status}`);
    if (data.approval.decision) {
      lines.push(`**Decision:** ${data.approval.decision}`);
      lines.push(`**Decided by:** ${data.approval.decidedBy}`);
      lines.push(`**At:** ${fmt(data.approval.decidedAt!)}`);
      if (data.approval.decisionSummary) {
        lines.push(`**Summary:** ${data.approval.decisionSummary}`);
      }
    }
    lines.push('');
  }

  // Phase timeline
  if (data.phases.length > 0) {
    lines.push('## Phase timeline');
    lines.push('| Phase | Status | Started | Duration | Tokens |');
    lines.push('|-------|--------|---------|----------|--------|');
    for (const p of data.phases) {
      const duration = p.completedAt && p.startedAt
        ? `${Math.round((p.completedAt.getTime() - p.startedAt.getTime()) / 1000)}s`
        : '—';
      const tokens = p.actualInputTokens
        ? `${p.actualInputTokens.toLocaleString()} in`
        : '—';
      lines.push(
        `| ${p.phase} | ${p.status} | ${fmt(p.startedAt)} | ${duration} | ${tokens} |`
      );
    }
    lines.push('');
  }

  // Token summary (feature 3)
  if (data.tokens) {
    lines.push('## Token usage');
    lines.push(`**Total:** ${data.tokens.totalTokens.toLocaleString()} tokens`);
    if (data.tokens.anyPhaseExceeded) {
      lines.push('**⚠️ One or more phases exceeded their budget.**');
    }
    lines.push('');
  }

  // SCM
  if (data.scm) {
    lines.push('## SCM');
    if (data.scm.prUrl) {
      lines.push(`**Pull request:** ${data.scm.prUrl}`);
    }
    if (data.scm.branchName) {
      lines.push(`**Branch:** \`${data.scm.branchName}\``);
    }
    if (data.scm.diffSummary) {
      lines.push('');
      lines.push('**Diff summary:**');
      lines.push('```');
      lines.push(data.scm.diffSummary);
      lines.push('```');
    }
    lines.push('');
  }

  // Prompt versions (feature 5)
  if (data.prompts && data.prompts.length > 0) {
    lines.push('## Prompts used');
    lines.push('| Phase | Hash | Path |');
    lines.push('|-------|------|------|');
    for (const p of data.prompts) {
      lines.push(`| ${p.phase} | \`${p.promptHash}\` | \`${p.promptPath}\` |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
```

### CLI script (scripts/report.mjs)

```javascript
#!/usr/bin/env node
// Usage: node scripts/report.mjs --run-id <uuid>
//        node scripts/report.mjs --last
//        node scripts/report.mjs --run-id <uuid> --out ./reports/

import { parseArgs } from 'node:util';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const { values } = parseArgs({
  options: {
    'run-id': { type: 'string' },
    'last':   { type: 'boolean', default: false },
    'out':    { type: 'string',  default: '.' },
  },
});

// Resolve run ID
let runId = values['run-id'];
if (values.last) {
  runId = await db.getMostRecentCompletedRunId();
}
if (!runId) {
  console.error('Provide --run-id <uuid> or --last');
  process.exit(1);
}

const data     = await assembleRunReport(runId, db);
const markdown = renderRunReportMarkdown(data);
const filename = `run-${runId.slice(0, 8)}-${Date.now()}.md`;
const outPath  = join(values.out, filename);

mkdirSync(values.out, { recursive: true });
writeFileSync(outPath, markdown, 'utf8');
console.log(`Report written: ${outPath}`);
```

`package.json` script addition:
```json
"reddwarf:report": "node scripts/report.mjs"
```

### Operator API

```typescript
// GET /runs/:runId/report
// Accept: text/markdown → returns raw Markdown
// Accept: application/json → returns RunReportData

router.get('/runs/:runId/report', authMiddleware, async (req, res) => {
  const data = await assembleRunReport(req.params.runId, db);
  const accept = req.headers['accept'] ?? 'text/markdown';

  if (accept.includes('application/json')) {
    return res.json(data);
  }
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.send(renderRunReportMarkdown(data));
});
```

---

## 5. Prompt Version Tracking

### Motivation

Prompts in `prompts/` are the primary lever for improving pipeline output quality. Without tracking which prompt version produced which output, it is impossible to attribute quality changes to specific prompt edits, run A/B comparisons, or roll back a prompt that degraded performance.

Prompt version tracking adds a content hash of each prompt file to every phase evidence record. This costs almost nothing at runtime but makes the evidence tables the source of truth for prompt performance history.

### Architecture placement

- `packages/control-plane` — `PromptRegistry`, hash-on-startup, upsert logic
- `packages/evidence` — `prompt_snapshots` table, FK on `phase_evidence`
- `packages/contracts` — `PromptSnapshot` type

### Schema migration

```sql
-- migration: prompt_snapshots table
CREATE TABLE prompt_snapshots (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  phase        TEXT        NOT NULL,
  prompt_hash  TEXT        NOT NULL,   -- first 16 chars of sha256 hex
  prompt_path  TEXT        NOT NULL,   -- relative to repo root
  captured_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (phase, prompt_hash)           -- same content = same row
);

CREATE INDEX idx_prompt_snapshots_phase ON prompt_snapshots (phase);
CREATE INDEX idx_prompt_snapshots_hash  ON prompt_snapshots (prompt_hash);

-- FK on phase_evidence
ALTER TABLE phase_evidence
  ADD COLUMN prompt_snapshot_id UUID REFERENCES prompt_snapshots (id);
```

### Contracts (packages/contracts)

```typescript
export interface PromptSnapshot {
  id:          string;
  phase:       AgentPhase;
  promptHash:  string;  // 16-char sha256 prefix
  promptPath:  string;
  capturedAt:  Date;
}
```

### Prompt registry (packages/control-plane)

```typescript
import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

/**
 * Called once during startup for each agent phase.
 * Reads the prompt file, hashes it, upserts a snapshot row,
 * and caches the snapshot ID in memory for the lifetime of the process.
 * This means each process start = one DB write per phase, maximum.
 */
export class PromptRegistry {
  private cache: Map<AgentPhase, PromptSnapshot> = new Map();

  async register(
    phase:      AgentPhase,
    promptPath: string,
    db:         DbClient,
  ): Promise<PromptSnapshot> {
    const abs = resolve(promptPath);
    if (!existsSync(abs)) {
      throw new Error(`Prompt file not found: ${abs}`);
    }

    const content = readFileSync(abs, 'utf8');
    const hash    = createHash('sha256')
      .update(content)
      .digest('hex')
      .slice(0, 16);

    // Upsert: same phase + hash → reuse existing row
    const snapshot = await db.upsertPromptSnapshot({
      phase,
      promptHash: hash,
      promptPath: promptPath,
    });

    this.cache.set(phase, snapshot);
    return snapshot;
  }

  getSnapshotId(phase: AgentPhase): string | undefined {
    return this.cache.get(phase)?.id;
  }
}

// Initialise once in start.ts, after config is loaded:
const promptRegistry = new PromptRegistry();
await promptRegistry.register('architect', 'prompts/architect/planning.md', db);
await promptRegistry.register('developer', 'prompts/developer/codegen.md',  db);
await promptRegistry.register('validator', 'prompts/validator/review.md',   db);
```

### Wiring into phase evidence

```typescript
// When writing phase_evidence after each LLM call:
await db.savePhaseEvidence({
  runId:            ctx.runId,
  phase:            'architect',
  status:           'completed',
  output:           architectOutput,
  promptSnapshotId: promptRegistry.getSnapshotId('architect'), // ← new
  // ...other fields
});
```

### Querying prompt performance

```sql
-- Approval rate by architect prompt version
SELECT
  ps.prompt_hash,
  ps.captured_at::DATE AS deployed,
  COUNT(*) AS total_plans,
  SUM(CASE WHEN ar.decision = 'approve' THEN 1 ELSE 0 END) AS approved,
  ROUND(
    100.0 * SUM(CASE WHEN ar.decision = 'approve' THEN 1 ELSE 0 END)
    / COUNT(*), 1
  ) AS approval_pct,
  AVG(pl.confidence_level = 'high')::NUMERIC(4,2) AS high_confidence_rate
FROM phase_evidence pe
JOIN prompt_snapshots ps ON pe.prompt_snapshot_id = ps.id
LEFT JOIN planning_specs pl ON pe.run_id = pl.run_id
LEFT JOIN approval_requests ar ON pe.run_id = ar.run_id
WHERE ps.phase = 'architect'
GROUP BY ps.prompt_hash, ps.captured_at::DATE
ORDER BY ps.captured_at::DATE DESC;
```

---

## 6. Phase Retry Budget

### Motivation

Currently, a phase failure (parse error, LLM timeout, validation rejection) produces an unhandled error that stalls the pipeline run. There is no configured limit on retries and no automatic escalation path. A retry budget gives each phase a maximum number of attempts before the run is escalated to the operator approval queue with a clear reason — converting hard failures into human-reviewable states rather than silent crashes.

### Architecture placement

- `packages/contracts` — `RetryBudgetConfig`, `PhaseRetryExhaustedError`
- `packages/control-plane` — `dispatchPhaseWithRetry`
- `packages/evidence` — `attempt_number`, `retry_reason`, `retry_exhausted` on `phase_evidence`
- Operator API — retry-exhausted entries appear in `/blocked`

### Config vars

```
# .env.example additions
REDDWARF_MAX_RETRIES_ARCHITECT=2
REDDWARF_MAX_RETRIES_DEVELOPER=3
REDDWARF_MAX_RETRIES_VALIDATOR=2
```

### Schema migration

```sql
-- migration: retry tracking on phase_evidence
ALTER TABLE phase_evidence
  ADD COLUMN attempt_number    INTEGER  NOT NULL DEFAULT 1,
  ADD COLUMN retry_reason      TEXT,
  ADD COLUMN retry_exhausted   BOOLEAN  NOT NULL DEFAULT FALSE;

-- Partial index for fast operator API query of exhausted phases
CREATE INDEX idx_phase_evidence_retry_exhausted
  ON phase_evidence (run_id)
  WHERE retry_exhausted = TRUE;
```

### Contracts (packages/contracts)

```typescript
export interface RetryBudgetConfig {
  maxRetries: Record<AgentPhase, number>;
}

export class PhaseRetryExhaustedError extends Error {
  readonly phase:    AgentPhase;
  readonly attempts: number;
  readonly runId:    string;
  constructor(phase: AgentPhase, attempts: number, runId: string) {
    super(
      `Phase '${phase}' retry budget exhausted after ${attempts} attempts ` +
      `(run: ${runId})`
    );
    this.phase    = phase;
    this.attempts = attempts;
    this.runId    = runId;
    this.name     = 'PhaseRetryExhaustedError';
  }
}
```

### Retry dispatcher (packages/control-plane)

```typescript
/**
 * Wraps a phase dispatch with retry budget enforcement.
 *
 * On each failure:
 *   - Records attempt number and failure reason in phase_evidence
 *   - If attempts < maxRetries: re-throws for the caller to handle
 *     (immediate retry or re-queue on next polling cycle)
 *   - If attempts >= maxRetries: marks retry_exhausted = true,
 *     enqueues an approval request, returns 'escalated'.
 *
 * The caller decides whether to retry immediately or on the next cycle.
 * Prefer immediate retry for transient errors (timeout, parse error).
 * Prefer next-cycle retry for persistent errors (LLM refusal, bad spec).
 */
export async function dispatchPhaseWithRetry(
  phase:      AgentPhase,
  ctx:        PipelineRunContext,
  dispatch:   () => Promise<PhaseResult>,
  config:     RetryBudgetConfig,
  db:         DbClient,
  log:        Logger,
): Promise<PhaseResult | { status: 'escalated'; attempts: number }> {

  const maxAttempts = config.maxRetries[phase] ?? 1;
  const priorAttempts = await db.getPhaseAttemptCount(ctx.runId, phase);

  if (priorAttempts >= maxAttempts) {
    // Budget already exhausted in a previous cycle — do not retry.
    await db.markPhaseRetryExhausted(ctx.runId, phase);
    await db.enqueueApprovalRequest({
      runId:        ctx.runId,
      reason:       'retry-budget-exhausted',
      phase,
      humanReadable:
        `Phase '${phase}' failed ${priorAttempts}× and exceeded its ` +
        `retry budget (${maxAttempts}). Manual review required.`,
    });
    log.warn({
      msg: 'phase retry budget exhausted, escalating to approval queue',
      phase, priorAttempts, maxAttempts, runId: ctx.runId,
    });
    return { status: 'escalated', attempts: priorAttempts };
  }

  try {
    return await dispatch();
  } catch (err) {
    const attemptNumber = priorAttempts + 1;
    await db.recordPhaseAttempt(ctx.runId, phase, {
      attemptNumber,
      retryReason: String(err),
      retryExhausted: attemptNumber >= maxAttempts,
    });
    log.warn({
      msg:           'phase failed',
      phase,         attemptNumber, maxAttempts,
      retryReason:   String(err),
      runId:         ctx.runId,
    });
    throw err;  // re-throw for caller
  }
}
```

### Operator API

Retry-exhausted entries appear in `/blocked` alongside normal approval-required entries, distinguished by `reason`:

```typescript
// GET /blocked response includes retry-exhausted entries:
{
  "approvalId":    "uuid",
  "taskTitle":     "Refactor auth middleware",
  "reason":        "retry-budget-exhausted",
  "phase":         "architect",
  "attempts":      2,
  "humanReadable": "Phase 'architect' failed 2× and exceeded its retry budget (2). Manual review required.",
  "lastError":     "PhaseOutputParseError: confidence block missing from architect output",
  "dryRun":        false
}
```

To re-queue a retry-exhausted task after fixing the underlying issue, the operator uses the existing resolve endpoint with `decision: "approve"`:

```bash
curl -X POST http://localhost:8080/approvals/<id>/resolve \
  -H "Authorization: Bearer ${REDDWARF_OPERATOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"decision":"approve","decidedBy":"you","decisionSummary":"Fixed architect prompt — retrying"}'
```

---

## 7. Structured Eligibility Rejection Reasons

### Motivation

When the eligibility gate (feature 89) rejects a task, that rejection currently disappears into log output. There is no queryable record of *why* tasks were rejected, making it impossible to tune the gate or the GitHub issue template without manual log archaeology. Persisting structured rejection reasons makes the eligibility policy observable and iterable.

### Architecture placement

- `packages/evidence` — `eligibility_rejections` table
- `packages/policy` — rejection reason codes
- `packages/control-plane` — persist rejection on gate failure
- Operator API — `GET /rejected`

### Schema migration

```sql
CREATE TABLE eligibility_rejections (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id        UUID        NOT NULL REFERENCES task_manifests(id),
  rejected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason_code    TEXT        NOT NULL,
  reason_detail  TEXT,
  policy_version TEXT,       -- prompt_snapshot_id if pre-screener is running
  source_issue   JSONB,      -- snapshot of the originating GitHub issue body
  dry_run        BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_eligibility_rejections_task_id     ON eligibility_rejections (task_id);
CREATE INDEX idx_eligibility_rejections_rejected_at ON eligibility_rejections (rejected_at DESC);
CREATE INDEX idx_eligibility_rejections_reason_code ON eligibility_rejections (reason_code);
```

### Rejection reason codes (packages/policy)

```typescript
export const eligibilityRejectionReasonCodes = [
  'out-of-scope',         // task falls outside the configured policy perimeter
  'under-specified',      // missing acceptance criteria or affected areas
  'duplicate',            // a planning spec already exists for this source issue
  'label-missing',        // ai-eligible label not present
  'risk-too-high',        // risk score above policy threshold
  'concurrent-run',       // another run for the same task is already active
  'budget-exceeded',      // token budget would be exceeded before dispatch
] as const;

export type EligibilityRejectionReasonCode =
  typeof eligibilityRejectionReasonCodes[number];

export interface EligibilityRejectionRecord {
  taskId:        string;
  reasonCode:    EligibilityRejectionReasonCode;
  reasonDetail?: string;
  sourceIssue?:  unknown;
  dryRun:        boolean;
}
```

### Control-plane wiring

```typescript
// In the eligibility gate, instead of just returning false / throwing:
if (!eligible) {
  await db.recordEligibilityRejection({
    taskId:       task.id,
    reasonCode:   rejectionReason.code,
    reasonDetail: rejectionReason.detail,
    sourceIssue:  task.sourceIssue,
    dryRun:       ctx.dryRun,
  });
  log.info({
    msg: 'task rejected by eligibility gate',
    taskId: task.id, reason: rejectionReason.code,
  });
  return { eligible: false, reason: rejectionReason };
}
```

### Operator API

```typescript
// GET /rejected?limit=20&reason=under-specified&since=2026-03-01
{
  "items": [
    {
      "taskId":       "uuid",
      "rejectedAt":   "2026-03-31T14:22:10 UTC",
      "reasonCode":   "under-specified",
      "reasonDetail": "No acceptance criteria provided",
      "issueTitle":   "Add dark mode",
      "issueUrl":     "https://github.com/owner/repo/issues/42",
      "dryRun":       false
    }
  ],
  "total": 47,
  "byReason": {
    "under-specified": 31,
    "out-of-scope":    9,
    "duplicate":       4,
    "label-missing":   3
  }
}
```

The `byReason` breakdown in the response is the key operational signal: if `under-specified` dominates, invest in the GitHub issue template (feature 95 on the board). If `out-of-scope` dominates, review the eligibility policy criteria.

---

## 8. Cross-cutting wiring notes

### Recommended implementation order

1. **Dry-run** — enables all subsequent prompt/policy work to proceed without GitHub risk.
2. **Prompt version tracking** — cheap to add, starts accumulating data immediately.
3. **Phase retry budget** — turns crashes into reviewable states; improves operational stability.
4. **Confidence gate** — requires prompt change + schema + policy; test under dry-run first.
5. **Token budget** — add after confidence gate; use it to measure context reduction from feature 91 (spec distillation).
6. **Eligibility rejection reasons** — slot in alongside feature 89 when that is picked up.
7. **Pipeline run report** — slot in last; enriched automatically by 3, 4, 5 above.

### Shared migration strategy

All migrations in this document are additive (new columns with defaults, new tables, new indices). None require data backfills or `NOT NULL` constraints on existing rows without defaults. Apply in sequence via the existing `node scripts/apply-sql-migrations.mjs` flow.

### Evidence archival pattern

All new evidence writes follow the existing `archiveEvidence` pattern in `packages/control-plane`. Do not write directly to DB from policy or contracts packages — route through control-plane helpers to keep the evidence write path auditable and consistent.

### Operator token

All new operator API endpoints (`/rejected`, `/runs/:runId/report`) require `Authorization: Bearer ${REDDWARF_OPERATOR_TOKEN}` — same as existing routes. Do not add unauthenticated endpoints.

### Dry-run compatibility

Every feature in this document is dry-run compatible. Evidence is always written; side effects are always guarded. The confidence gate, token budget, and retry budget all operate identically in dry-run mode — the only difference is that any resulting approval queue entry is marked `dry_run = true`.
