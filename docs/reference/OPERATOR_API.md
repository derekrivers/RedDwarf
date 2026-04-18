# Operator API Reference

All routes below are implemented by [`packages/control-plane/src/operator-api.ts`](../../packages/control-plane/src/operator-api.ts) and served by `corepack pnpm operator:api` (or the single-process `corepack pnpm start`).

## Base URL

- Local: `http://127.0.0.1:8080`
- Dashboard dev proxy: `/api/*` maps to the above
- Behind Caddy: `https://your-domain/api/*` with the `/api` prefix stripped

## Authentication

Every route below requires `Authorization: Bearer $REDDWARF_OPERATOR_TOKEN` **except**:

- `GET /health` — unauthenticated (liveness probe).
- `GET /ui` — public shell; the bootstrap endpoint it fetches is still gated.
- `POST /webhooks/github` — HMAC-SHA256 verified via `X-Hub-Signature-256` using `REDDWARF_WEBHOOK_SECRET`; bearer token is neither required nor sufficient.

Unauthorized requests return `401`. `200 /health` with a valid body and `401` from another protected route together prove the API is up but your token is wrong.

## Common query parameters

`GET /runs`, `GET /tasks`, `GET /approvals`, `GET /projects`, `GET /rejected`, `GET /tool-approvals` share a similar filter model:

- `limit` — integer, 1–1000.
- `repo` — `owner/repo` format.
- `status` or `statuses` — repeatable; accepts the enum for each resource.

Unrecognized enum values are dropped silently rather than rejected.

## Routes at a glance

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness + readiness; aggregates DB, polling, dispatcher, downstream probes. |
| GET | `/ui` | Static legacy operator panel (HTML). |
| GET | `/ui/bootstrap` | Bootstrap metadata for the legacy panel. |
| GET | `/config` | List runtime-configurable settings with source, current value, default. |
| GET | `/config/schema` | JSON-schema-style metadata for runtime-configurable settings. |
| PUT | `/config` | Persist one or more runtime-configurable settings. |
| POST | `/secrets/:key/rotate` | Rotate a named secret (write-only; value never echoed back). |
| GET | `/repos` | List polled repos with per-repo cursor state. |
| POST | `/repos` | Add a repo to the polling roster. |
| DELETE | `/repos/:owner/:repo` | Remove a repo from the polling roster. |
| GET | `/repos/github` | List repos visible to the configured `GITHUB_TOKEN`. |
| GET | `/runs` | List pipeline runs with filters. |
| GET | `/runs/:id` | Full run detail, events, summary, token usage. |
| GET | `/runs/:id/evidence` | Evidence records scoped to a specific run. |
| GET | `/runs/:id/report` | Run report as JSON or markdown (`Accept`-negotiated). |
| POST | `/runs/:id/cancel` | Cancel a blocked / failed / stale run. |
| GET | `/tasks` | List task manifests with filters. |
| GET | `/tasks/:id` | Task detail: manifest, spec, policy, phases, approvals, runs, summaries. |
| GET | `/tasks/:id/evidence` | All evidence for a task across runs. |
| GET | `/tasks/:id/snapshot` | Full task snapshot (manifest + all child rows). |
| POST | `/tasks/:id/dispatch` | Manually dispatch a ready task. |
| POST | `/tasks/inject` | Inject a new task directly (planner path, no GitHub issue). |
| POST | `/issues/submit` | Create a GitHub issue and queue it. |
| POST | `/task-groups/inject` | Inject a grouped planning task (multiple sources, single plan). |
| GET | `/rejected` | List eligibility rejections. |
| GET | `/blocked` | Summary of blocked runs + pending approvals. |
| GET | `/approvals` | List approval requests with filters. |
| GET | `/approvals/:id` | Single approval request. |
| POST | `/approvals/:id/resolve` | Resolve an approval: `approve`, `reject`, or `rework`. |
| GET | `/projects` | List ProjectSpecs with ticket counts. |
| GET | `/projects/:id` | Project detail with TicketSpec children. |
| POST | `/projects/:id/approve` | Approve or amend a project plan. |
| POST | `/projects/advance` | Called by GitHub Actions on PR merge; advances a ticket. |
| GET | `/projects/:id/clarifications` | Pending clarification questions from Holly. |
| POST | `/projects/:id/clarify` | Feed answers back to Holly and re-plan. |
| GET | `/sessions/policy` | Policy snapshot keyed by OpenClaw session key. Used by the plugin hook. |
| GET | `/tool-approvals` | List tool-approval requests. |
| GET | `/tool-approvals/:id` | Single tool-approval request. |
| POST | `/tool-approvals` | Create a pending tool-approval request (OpenClaw plugin path). |
| POST | `/tool-approvals/:id/decide` | Decide a tool approval: `approve` or `deny`. |
| GET | `/openclaw/pairing-status` | State of the OpenClaw pairing handshake. |
| GET | `/openclaw/codex-status` | Codex OAuth status per agent. |
| POST | `/openclaw/model-provider` | Switch the active model provider at runtime. |
| GET | `/openclaw/codex-login/stream` | Server-sent stream of the interactive Codex login flow. |
| POST | `/openclaw/codex-login/input` | Submit input for the active Codex login flow. |
| POST | `/openclaw/fix-pairing` | Repair OpenClaw pairing state. |
| POST | `/openclaw/restart` | Restart the OpenClaw container. |
| POST | `/maintenance/reconcile-orphaned-state` | Reconcile orphaned dispatcher state. |
| POST | `/webhooks/github` | GitHub webhook receiver (HMAC-auth). |

---

## Health

### `GET /health`

Unauthenticated. Aggregates DB, polling daemon, dispatcher, and any configured downstream probes.

```json
{
  "status": "ok",
  "timestamp": "2026-04-18T12:00:00.000Z",
  "repository": { "status": "ok", "migrations": "applied" },
  "polling": { "mode": "auto", "cursors": [] },
  "dispatcher": { "status": "idle", "lastDispatchOutcome": "completed", ... },
  "intakeMode": "webhook+polling",
  "downstream": [ { "name": "openclaw", "status": "ok", ... } ],
  "readiness": "ok",
  "circuitBreakers": { ... }
}
```

`readiness` summarises the downstream probes — `"ok"` if all pass, `"degraded"` if any return a non-OK state, `"unreachable"` if any fail to respond.

---

## UI

### `GET /ui`

Returns a single-page HTML shell for the legacy operator panel. Public; the shell then fetches authenticated endpoints.

### `GET /ui/bootstrap`

Returns metadata used to paint the legacy panel's initial state: paths, masked secret presence flags, stack version, uptime, OpenClaw reachability. **Auth required.**

---

## Configuration

### `GET /config`

Returns every runtime-configurable entry (see [.env.example](../../.env.example) *Runtime-configurable* section for the full set), with current value, default, source (`env`, `operator_config`, `default`), and description.

### `GET /config/schema`

JSON-schema-style metadata (type, enum, description, default) for each runtime-configurable key. Used by the dashboard's config page to render typed controls.

### `PUT /config`

Body:

```json
{ "entries": [ { "key": "REDDWARF_LOG_LEVEL", "value": "debug" } ] }
```

Writes each entry to the `operator_config` Postgres table and updates `process.env`. Boot-time and secret keys are rejected — use `.env` or `/secrets/:key/rotate` respectively.

---

## Secrets

### `POST /secrets/:key/rotate`

Body:

```json
{ "value": "ghp_new_token" }
```

The `key` must be on the allowlist (`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENCLAW_HOOK_TOKEN`, `OPENCLAW_GATEWAY_TOKEN`, `REDDWARF_OPERATOR_TOKEN`, `OPENCLAW_DISCORD_BOT_TOKEN`, `REDDWARF_WEBHOOK_SECRET`). Values are persisted to `.secrets`, not returned in the response. OpenClaw-consumed secrets require a container restart before the gateway sees the new value.

Response:

```json
{ "key": "GITHUB_TOKEN", "rotated": true, "restartRequired": false }
```

---

## Repositories

### `GET /repos`

Returns every repo on the polling roster with its per-repo cursor (last seen issue number, last poll status, last polled timestamp).

### `POST /repos`

Body:

```json
{ "repo": "owner/name" }
```

Adds the repo to `github_issue_polling_cursors`. Idempotent.

### `DELETE /repos/:owner/:repo`

Removes the repo from the roster.

### `GET /repos/github`

Returns the repos your `GITHUB_TOKEN` can see (for the dashboard's repo picker). Not a polling roster operation.

---

## Runs

### `GET /runs`

Query: `repo`, `taskId`, `limit` (≤ 1000), `status` or `statuses` (repeatable). Returns `{ runs: [...], total }`.

### `GET /runs/:id`

Returns `{ run, summary, events, totalEvents, tokenUsage }`. `events` is the full event stream for the run.

### `GET /runs/:id/evidence`

Returns evidence records associated with the run.

### `GET /runs/:id/report`

`Accept: text/markdown` (default) returns a formatted report. `Accept: application/json` returns the underlying data.

### `POST /runs/:id/cancel`

Cancels a run that is not already `active`, `completed`, or `cancelled`. An active run cannot be cancelled from the dashboard — wait for it to block, fail, or become stale. Conflict cases return `409`.

---

## Tasks

### `GET /tasks`

Query: `repo`, `limit`, `status`/`statuses` (lifecycle enum), `phase`/`phases` (phase enum). Returns `{ tasks, total }`.

### `GET /tasks/:id`

Returns a rich snapshot:

```json
{
  "manifest": { ... },
  "spec": { ... },
  "policySnapshot": { ... },
  "phaseRecords": [...],
  "approvalRequests": [...],
  "pipelineRuns": [...],
  "runSummaries": [...],
  "evidenceTotal": 12,
  "memoryRecords": [...]
}
```

### `GET /tasks/:id/evidence`

All evidence records for a task across runs.

### `GET /tasks/:id/snapshot`

Full `TaskSnapshot` as the repository returns it. Richer than `GET /tasks/:id` — includes every row the repository can join. Mostly for debugging.

### `POST /tasks/:id/dispatch`

Body (optional):

```json
{ "targetRoot": "/custom/workspace/root", "evidenceRoot": "/custom/evidence/root" }
```

Paths must be under the configured managed roots. Normally you don't pass a body — the defaults are what you want.

### `POST /tasks/inject`

Direct planning intake that bypasses GitHub. Body matches `DirectTaskInjectionRequestSchema`:

```json
{
  "repo": "owner/name",
  "title": "Short title",
  "summary": "One-paragraph summary.",
  "priority": 3,
  "acceptanceCriteria": ["Criterion 1", "Criterion 2"],
  "affectedPaths": [],
  "constraints": [],
  "requestedCapabilities": [],
  "labels": [],
  "riskClassHint": "low",
  "issueNumber": null,
  "issueUrl": null
}
```

Returns `201` with `{ runId, nextAction, manifest, complexityClassification, spec?, policySnapshot?, approvalRequest? }`. The CLI `reddwarf submit` calls this route.

### `POST /issues/submit`

Creates a GitHub issue on `repo` with a structured markdown body (Summary, Acceptance Criteria, Affected Paths, Constraints, Requested Capabilities, Risk Hint) and the `ai-eligible` label, then returns the created issue metadata. Used by the dashboard's **Submit Issue** page and the Discord `/rdsubmit` command (M23 feature 174).

Returns `503` if no `GITHUB_TOKEN`-backed writer is configured.

### `POST /task-groups/inject`

Inject multiple source issues under a single planning pass. Grouped variant of `/tasks/inject`.

### `GET /rejected`

Query: `limit`, `reason`, `since` (ISO-8601). Returns tasks that failed eligibility checks (wrong label, path restrictions, risk-class, etc.).

### `GET /blocked`

Summary of runs currently blocked (stale, failed-with-retries-exhausted) and approval requests currently pending. Useful as an operator dashboard for "what needs me."

---

## Approvals

### `GET /approvals`

Query: `taskId`, `runId`, `limit`, `statuses` (repeatable: `pending`, `approved`, `rejected`, `rework`, ...). Returns `{ approvals, total }`.

### `GET /approvals/:id`

Single approval request detail.

### `POST /approvals/:id/resolve`

Body (all three first fields required):

```json
{
  "decision": "approve",
  "decidedBy": "you",
  "decisionSummary": "LGTM",
  "comment": "Optional longer note"
}
```

`decision` is one of `approve`, `reject`, or (when the approval is a rework escalation) `rework`. Note: the enum value is `"approve"`, not `"approved"`.

Returns `{ approval, manifest }`. If the approval belongs to a project rather than a standalone task, the response is `409 Conflict` with an `approvalRoute` pointing at `/projects/:id/approve`.

---

## Projects (Project Mode, M20)

### `GET /projects`

Query: `repo`, `status`. Returns projects with nested `ticketCounts` (`pending`, `dispatched`, `in_progress`, `pr_open`, `merged`, `failed`, `total`).

### `GET /projects/:id`

Returns `{ project, tickets, ticketCounts }`.

### `POST /projects/:id/approve`

Body:

```json
{
  "decision": "approve",
  "decidedBy": "you",
  "decisionSummary": "Project plan looks sound.",
  "amendments": null
}
```

`decision` is `approve` or `amend`. On `amend`, the `amendments` string is appended to Holly's planning context and the project returns to draft. Projects in `pending_approval` can always be decided. Already-approved and executing projects can be approved again only under specific resumability / backfill conditions (see the `409` error messages for details).

### `POST /projects/advance`

Called by the GitHub Actions workflow `.github/workflows/reddwarf-advance.yml` when a PR merges. Body:

```json
{
  "ticket_id": "tk_abc123",
  "github_pr_number": 42
}
```

Sets the ticket's status to `merged`, closes the linked sub-issue, and dispatches the next ready ticket in dependency order. Idempotent — re-running on an already-merged ticket returns `200` with `outcome: "already_merged"` and no state change.

Response:

```json
{
  "outcome": "next_dispatched",
  "ticket": { ... },
  "project": { ... },
  "nextDispatchedTicket": { ... },
  "nextDispatchedTaskId": "owner-repo-tk_def456",
  "nextDispatchedTaskCreated": true,
  "message": "Ticket tk_abc123 merged. Next ticket tk_def456 dispatched."
}
```

### `GET /projects/:id/clarifications`

Pending clarification questions from Holly's planning phase, when Holly flagged missing context rather than producing a partial plan.

### `POST /projects/:id/clarify`

Body:

```json
{ "answers": { "question_id_1": "Answer text", ... } }
```

Feeds answers into Holly's planning context and re-runs the planning phase.

---

## Tool approvals (plugin hook, M21 feature 152)

The OpenClaw `reddwarf-operator` plugin creates these when an agent tries to do something outside the policy snapshot's allowed paths. Operators decide them from the dashboard; agents poll for the decision.

### `GET /tool-approvals`

Query: `status`. Returns `{ toolApprovals, total }`.

### `GET /tool-approvals/:id`

Single approval. Plugin polling uses this (M22 feature 164/168 consolidated the two-call pattern).

### `POST /tool-approvals`

Plugin-only. Body:

```json
{
  "sessionKey": "github:issue:owner:repo:42",
  "toolName": "write_file",
  "targetPath": "packages/control-plane/src/foo.ts",
  "reason": "outside allowed paths",
  "taskId": "owner-repo-42"
}
```

Returns `201` with the created request. `sessionKey` and `toolName` are required.

### `POST /tool-approvals/:id/decide`

Body:

```json
{ "decision": "approve", "decidedBy": "you" }
```

`decision` is `approve` (anything not literally `"deny"`) or `deny`. Returns `200` with the decided approval. Conflict (`409`) if the approval has already been decided.

---

## Sessions

### `GET /sessions/policy`

Query: `sessionKey` (required). Returns the policy snapshot for the active task whose OpenClaw session key normalises to the requested value:

```json
{
  "taskId": "owner-repo-42",
  "sessionKey": "github:issue:owner:repo:42",
  "policySnapshot": { "allowedPaths": [...], "deniedPaths": [...], ... }
}
```

Used by the plugin `before_tool_call` hook for in-session path checks.

---

## OpenClaw

These routes support the dashboard's **OpenClaw Settings** page. They manage the Codex OAuth flow, pairing state, and container lifecycle.

### `GET /openclaw/pairing-status`

Returns the OpenClaw pairing handshake state.

### `GET /openclaw/codex-status`

Returns Codex OAuth status per agent role (`reddwarf-analyst`, `reddwarf-developer`, etc.) — expiry, seat assignment, refresh state. Used to flag upcoming expirations.

### `POST /openclaw/model-provider`

Body:

```json
{ "provider": "anthropic" }
```

Switches the runtime model provider (`anthropic`, `openai`, or `openai-codex`). Regenerates `runtime-data/openclaw-home/openclaw.json`. Requires an OpenClaw restart (see below) before fully taking effect.

### `GET /openclaw/codex-login/stream`

Server-Sent Events stream of the interactive Codex login flow. The dashboard consumes this to render the OAuth walk-through.

### `POST /openclaw/codex-login/input`

Body varies by flow step. Used to submit user input (device codes, prompts) back into the streaming login flow.

### `POST /openclaw/fix-pairing`

Repair OpenClaw pairing state when it drifts.

### `POST /openclaw/restart`

Restarts the OpenClaw container via `docker compose`. Used after provider switches.

---

## Maintenance

### `POST /maintenance/reconcile-orphaned-state`

Body (optional):

```json
{ "scanLimit": 100 }
```

Scans dispatcher state for orphans and reconciles. Returns the sweep result. Usually automatic (see `REDDWARF_PERIODIC_SWEEP_*`) — this is the manual escape hatch.

---

## Webhooks

### `POST /webhooks/github`

HMAC-SHA256 authenticated using `REDDWARF_WEBHOOK_SECRET`; bearer token is not used. See [WEBHOOK_SETUP.md](../WEBHOOK_SETUP.md) for configuration.

Path is configurable via `REDDWARF_WEBHOOK_PATH` (default `/webhooks/github`).

Handles two GitHub event types:

- `issues` with `action: opened` — queues the issue if it has the `ai-eligible` label.
- `pull_request` with `action: closed` and `merged: true` — calls the same logic as `POST /projects/advance` (M23 feature 176).

Other events return `200` and are ignored.

Invalid or missing `X-Hub-Signature-256` returns `401`.

---

## Errors

Consistent shape:

```json
{ "error": "bad_request", "message": "decision, decidedBy, and decisionSummary are required." }
```

Common codes: `bad_request` (400), `unauthorized` (401), `not_found` (404), `conflict` (409), `service_unavailable` (503). `/approvals/:id/resolve` additionally returns `409` with `approvalRoute` when the approval belongs to a project. `/tasks/:id/dispatch`, `/tasks/inject`, and `/issues/submit` return `503` if the corresponding dependency (dispatcher, planner, GitHub writer) is not configured on this server.

## See also

- [WEBHOOK_SETUP.md](../WEBHOOK_SETUP.md) — GitHub webhook configuration.
- [ARCHITECTURE.md §7](../ARCHITECTURE.md) — how the API fits into the operator surfaces model.
- [.env.example](../../.env.example) — every environment variable and what it controls.
