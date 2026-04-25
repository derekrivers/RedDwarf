# Configuration Reference

Every environment variable RedDwarf reads, grouped by class. [.env.example](../../.env.example) is the canonical source of truth with inline comments; this document is the scannable table-of-contents view with cross-references to related docs.

## How configuration is layered

At startup:

1. `.env` is loaded from the repo root.
2. `.secrets` (the rotated-credentials companion file, created automatically) overlays `.env`.
3. For each runtime-configurable key, a matching row in the Postgres `operator_config` table overrides both. If the table is missing or empty, file values apply.

Secret keys, boot-time keys, and dev/E2E keys are **never** sourced from `operator_config`. Only the runtime-configurable class is safe to mutate at runtime.

## Classes

- **Boot-time** — resolved before process startup; changing requires a restart. Mostly paths, ports, and container images.
- **Runtime-configurable** — candidates for the operator config UX (`PUT /config`). Feature flags, tuning knobs, and dispatch budgets.
- **Secrets** — kept out of plaintext UIs; a subset is rotatable via `POST /secrets/:key/rotate`.
- **Dev / E2E** — local verification helpers. Not used in production.

## Required at first boot

Five values must be set before `corepack pnpm start` works end-to-end:

| Variable | Class | Notes |
|---|---|---|
| `GITHUB_TOKEN` | Secret | `repo` scope. |
| `ANTHROPIC_API_KEY` **or** `OPENAI_API_KEY` | Secret | Match `REDDWARF_MODEL_PROVIDER`. `openai-codex` provider uses OAuth instead — no API key. |
| `OPENCLAW_HOOK_TOKEN` | Secret | Long random. |
| `OPENCLAW_GATEWAY_TOKEN` | Secret | Long random. |
| `REDDWARF_OPERATOR_TOKEN` | Secret | Long random. |

Everything else has a sensible default.

---

## Boot-time

Changing any of these requires a stack restart.

### Container images and ports

| Variable | Default | Purpose |
|---|---|---|
| `OPENCLAW_IMAGE` | `ghcr.io/openclaw/openclaw:2026.4.23` | OpenClaw container image. Pin to an explicit tag for reproducibility. |
| `OPENCLAW_HOST_PORT` | `3578` | Host port for the OpenClaw Control UI. |
| `POSTGRES_HOST_PORT` | `55532` | Host port for Docker-managed Postgres (non-standard to avoid collisions). |

### Database

| Variable | Default | Purpose |
|---|---|---|
| `POSTGRES_DB` | `reddwarf` | Database name. |
| `POSTGRES_USER` | `reddwarf` | Database user. |
| `POSTGRES_PASSWORD` | `reddwarf` | Database password. |
| `DATABASE_URL` | `postgresql://reddwarf:reddwarf@postgres:5432/reddwarf` | In-container connection string used by services under Compose. |
| `HOST_DATABASE_URL` | `postgresql://reddwarf:reddwarf@127.0.0.1:55532/reddwarf` | Host-side connection string for local scripts. On Windows/WSL, keep `127.0.0.1` — not `localhost`. |

### Paths

`REDDWARF_POLICY_*` and `REDDWARF_*_ROOT` split into two families: in-container paths (seen by the OpenClaw gateway) and host paths (used by scripts and the operator API).

| Variable | Default | Purpose |
|---|---|---|
| `REDDWARF_POLICY_SOURCE_ROOT` | `../../` | Source tree root used when packaging the policy pack. |
| `REDDWARF_POLICY_ROOT` | `/opt/reddwarf` | In-container policy-pack root. |
| `REDDWARF_WORKSPACE_ROOT` | `/var/lib/reddwarf/workspaces` | In-container managed workspace root. |
| `REDDWARF_EVIDENCE_ROOT` | `/var/lib/reddwarf/evidence` | In-container evidence archive root. |
| `REDDWARF_HOST_WORKSPACE_ROOT` | `runtime-data/workspaces` | Host-side workspace root. |
| `REDDWARF_HOST_EVIDENCE_ROOT` | `runtime-data/evidence` | Host-side evidence root. |
| `REDDWARF_POLICY_PACKAGE_OUTPUT_ROOT` | `artifacts/policy-packs` | Output directory for `pnpm package:policy-pack`. |
| `REDDWARF_OPENCLAW_WORKSPACE_ROOT` | `runtime-data/openclaw-workspaces` | Host-mounted OpenClaw session workspace root. |
| `REDDWARF_OPENCLAW_CONFIG_PATH` | `runtime-data/openclaw-home/openclaw.json` | Live OpenClaw config written by `generate:openclaw-config`, `setup`, and `start`. |

### OpenClaw bridging

| Variable | Default | Purpose |
|---|---|---|
| `REDDWARF_OPENCLAW_OPERATOR_API_URL` | `http://host.docker.internal:8080` | Container-reachable Operator API base URL. Used by the OpenClaw plugin and MCP bridge. |
| `REDDWARF_OPENCLAW_TRUSTED_AUTOMATION` | `false` | When `true`, seeds `exec-approvals.json` so unattended OpenClaw cron runs can execute trusted automation without interactive exec prompts. |

---

## Runtime-configurable

Mutable via `PUT /config` or the dashboard's config page.

### Model provider

| Variable | Default | Purpose |
|---|---|---|
| `REDDWARF_MODEL_PROVIDER` | `anthropic` | `anthropic`, `openai`, or `openai-codex`. Drives agent model binding in the generated OpenClaw config. |
| `REDDWARF_MODEL_FAILOVER_ENABLED` | `false` | When `true`, each agent gets a `modelFallback` pointing to the alternate provider. Requires both provider keys. |

See [GETTING_STARTED.md §2](../GETTING_STARTED.md#choosing-a-model-provider) for the Codex OAuth path.

### Intake (polling + webhooks)

| Variable | Default | Purpose |
|---|---|---|
| `REDDWARF_WEBHOOK_SECRET` | _(unset)_ | When set, activates the `/webhooks/github` receiver and HMAC verification. |
| `REDDWARF_WEBHOOK_PATH` | `/webhooks/github` | Webhook route override. |
| `REDDWARF_POLL_MODE` | `auto` | `auto` (poll when no webhook secret) \| `always` \| `never`. |
| `REDDWARF_POLL_REPOS` | _(unset)_ | Comma-separated bootstrap seed for the polled repo roster. Prefer `POST /repos` after first boot. |
| `REDDWARF_POLL_INTERVAL_MS` | `30000` | Polling cycle interval. |
| `REDDWARF_POLL_PER_REPO_TIMEOUT_MS` | `60000` | Per-repo polling timeout, so a slow repo cannot starve the others. |

See [WEBHOOK_SETUP.md](../WEBHOOK_SETUP.md).

### Operator API and dashboard

| Variable | Default | Purpose |
|---|---|---|
| `REDDWARF_API_PORT` | `8080` | Operator API port. |
| `REDDWARF_API_HOST` | `127.0.0.1` | Bind interface. **Linux VPS** deploys need `0.0.0.0` so `host.docker.internal` resolves; see [VPS_DEPLOYMENT.md §5](../VPS_DEPLOYMENT.md#5-clone-and-configure-reddwarf). |
| `REDDWARF_API_URL` | `http://127.0.0.1:8080` | Base URL used by the CLI when not overridden by `--api-url`. |
| `REDDWARF_DASHBOARD_PORT` | `5173` | Dashboard dev server port. |
| `REDDWARF_DASHBOARD_ORIGIN` | `http://localhost:5173` | CORS origin allowed by the operator API for dashboard requests. |
| `REDDWARF_SKIP_DASHBOARD` | `false` | Skip launching the dashboard under `pnpm start`. |
| `REDDWARF_SKIP_OPENCLAW` | `false` | Skip OpenClaw startup. |
| `REDDWARF_DRY_RUN` | `false` | Suppress SCM and follow-up GitHub mutations while still exercising the pipeline. |
| `REDDWARF_LOG_LEVEL` | `info` | Structured log level for poller, dispatcher, and pipeline logs. |

### Dispatcher and periodic sweeps

| Variable | Default | Purpose |
|---|---|---|
| `REDDWARF_DISPATCH_INTERVAL_MS` | `15000` | Ready-task dispatch loop interval. |
| `REDDWARF_PERIODIC_SWEEP_ENABLED` | `true` | Enable the periodic stale-run sweep. |
| `REDDWARF_PERIODIC_SWEEP_INTERVAL_MS` | `300000` | Sweep interval (5 min). |

### Boot-time cleanup thresholds

| Variable | Default | Purpose |
|---|---|---|
| `REDDWARF_OPENCLAW_BACKUP_CLEANUP_ENABLED` | `true` | Prune stale `openclaw.json.bak*` / `.clobbered.*` / `openclaw-home.backup.*` artifacts. |
| `REDDWARF_OPENCLAW_BACKUP_MAX_AGE_DAYS` | `14` | Backup retention threshold. |
| `REDDWARF_EVIDENCE_BOOT_CLEANUP_ENABLED` | `true` | Enforce retention on `runtime-data/evidence/`. |
| `REDDWARF_EVIDENCE_MAX_AGE_DAYS` | `14` | Evidence directory retention. Increase for audit needs (e.g. `90`, `365`). |
| `REDDWARF_MIN_DISK_FREE_MB` | `500` | Minimum free disk space before workspace/evidence writes. |

### Database pool

| Variable | Default | Purpose |
|---|---|---|
| `REDDWARF_DB_POOL_MAX` | `10` | Max Postgres connections in the shared `pg.Pool`. |
| `REDDWARF_DB_POOL_CONNECTION_TIMEOUT_MS` | `5000` | Fail connection attempts after N ms. |
| `REDDWARF_DB_POOL_IDLE_TIMEOUT_MS` | `30000` | Evict idle clients after N ms. |
| `REDDWARF_DB_POOL_QUERY_TIMEOUT_MS` | `15000` | Fail queries after N ms. |
| `REDDWARF_DB_POOL_STATEMENT_TIMEOUT_MS` | `15000` | Ask Postgres to cancel long statements. |
| `REDDWARF_DB_POOL_MAX_LIFETIME_SECONDS` | `300` | Recycle clients after N seconds. |

### Retry budgets

| Variable | Default | Purpose |
|---|---|---|
| `REDDWARF_MAX_RETRIES_ARCHITECT` | `2` | Planning retry budget. |
| `REDDWARF_MAX_RETRIES_DEVELOPER` | `1` | Development retry budget. |
| `REDDWARF_MAX_RETRIES_VALIDATOR` | `1` | Validation retry budget. |
| `REDDWARF_MAX_RETRIES_REVIEWER` | `1` | Architecture-review retry budget. |
| `REDDWARF_MAX_RETRIES_SCM` | `1` | SCM retry budget. |

### Token budgets

| Variable | Default | Purpose |
|---|---|---|
| `REDDWARF_TOKEN_BUDGET_ARCHITECT` | `80000` | Planning token budget. |
| `REDDWARF_TOKEN_BUDGET_DEVELOPER` | `120000` | Development token budget. |
| `REDDWARF_TOKEN_BUDGET_VALIDATOR` | `40000` | Validation token budget. |
| `REDDWARF_TOKEN_BUDGET_REVIEWER` | `60000` | Architecture-review token budget. |
| `REDDWARF_TOKEN_BUDGET_SCM` | `40000` | SCM token budget. |
| `REDDWARF_TOKEN_BUDGET_OVERAGE_ACTION` | `warn` | `warn` or `block` when a budget is exceeded. |

### OpenClaw feature flags

Gated behind flags because each requires a minimum OpenClaw version or has operational risk. All default `false` unless noted.

| Variable | Default | Feature | Min OpenClaw |
|---|---|---|---|
| `REDDWARF_OPENCLAW_BROWSER_ENABLED` | `true` | OpenClaw built-in browser for Holly during planning. | any |
| `REDDWARF_OPENCLAW_LOOP_DETECTION_ENABLED` | `false` | Gateway-level watchdog for repeated tool calls and ping-pong responses. | any |
| `REDDWARF_EXECUTION_ITEMS_ENABLED` | `false` | Structured execution items → `AGENT_PROGRESS_ITEM` run events + dashboard crew feed (M21 F-151). | ≥ v2026.4.5 |
| `REDDWARF_PLUGIN_APPROVAL_HOOK_ENABLED` | `false` | `before_tool_call` hook routing file writes through tool-approval API (M21 F-152). | ≥ v2026.3.28 |
| `REDDWARF_OPENCLAW_AGENT_TO_AGENT_ENABLED` | `false` | Enable `sessions_send` between agents (M22 F-162 defaulted off). | any |
| `REDDWARF_TASKFLOW_ENABLED` | `false` | Task Flow mirrored mode for project tickets (M21 F-150). | ≥ v2026.4.2 |
| `REDDWARF_ACPX_DISPATCH_ENABLED` | `false` | ACPX embedded dispatch instead of HTTP hooks (M21 F-154). | ≥ v2026.4.5 |
| `REDDWARF_CLAWHUB_ENABLED` | `false` | ClawHub skill discovery/publishing during planning (M21 F-155). | ≥ v2026.4.5 |
| `REDDWARF_CLAWHUB_ALLOWED_PUBLISHERS` | `reddwarf/*,anthropic/*` | Comma-separated glob allowlist for ClawHub skill install (M22 F-170). | — |
| `REDDWARF_DREAMING_MEMORY_ENABLED` | `false` | Persist OpenClaw `dreams.md` as `memory_records` (M21 F-156). | ≥ v2026.4.5 |

### OpenClaw compaction / context (commented in `.env.example`)

Emit `agents.defaults.compaction` and `agents.defaults.contextLimits` into the generated config. Recommended posture for long-running RedDwarf sessions: `mode=safeguard` with `identifier_policy=strict` so Project Mode TicketSpec IDs survive summarisation.

| Variable | Default | Purpose |
|---|---|---|
| `REDDWARF_OPENCLAW_COMPACTION_MODE` | _(unset)_ | `default` \| `safeguard`. |
| `REDDWARF_OPENCLAW_COMPACTION_IDENTIFIER_POLICY` | _(unset)_ | `strict` \| `custom` \| `off`. |
| `REDDWARF_OPENCLAW_COMPACTION_TIMEOUT_SECONDS` | _(unset)_ | Compaction timeout. |
| `REDDWARF_OPENCLAW_COMPACTION_NOTIFY_USER` | _(unset)_ | Emit a compaction notice. |
| `REDDWARF_OPENCLAW_COMPACTION_MEMORY_FLUSH_ENABLED` | _(unset)_ | Flush memory records during compaction. |
| `REDDWARF_OPENCLAW_COMPACTION_MEMORY_FLUSH_SOFT_THRESHOLD_TOKENS` | _(unset)_ | Soft threshold for memory flush. |
| `REDDWARF_OPENCLAW_CONTEXT_MEMORY_GET_MAX_CHARS` | `12000` | Memory-read cap. |
| `REDDWARF_OPENCLAW_CONTEXT_TOOL_RESULT_MAX_CHARS` | `16000` | Tool-result cap. |
| `REDDWARF_OPENCLAW_CONTEXT_POST_COMPACTION_MAX_CHARS` | `1800` | Post-compaction cap. |
| `REDDWARF_OPENCLAW_BOOTSTRAP_MAX_CHARS` | `20000` | Gateway-side bootstrap truncation warning threshold. |
| `REDDWARF_OPENCLAW_BOOTSTRAP_TOTAL_MAX_CHARS` | `150000` | Total bootstrap cap. |
| `REDDWARF_OPENCLAW_BOOTSTRAP_PROMPT_TRUNCATION_WARNING` | `once` | `off` \| `once` \| `always`. |

### OpenClaw loop detection (commented)

| Variable | Default | Purpose |
|---|---|---|
| `REDDWARF_OPENCLAW_LOOP_DETECTION_WARNING_THRESHOLD` | `10` | Warning threshold. |
| `REDDWARF_OPENCLAW_LOOP_DETECTION_CRITICAL_THRESHOLD` | `20` | Critical (abort) threshold. |
| `REDDWARF_OPENCLAW_LOOP_DETECTION_GENERIC_REPEAT` | `true` | Flag repeated identical tool calls. |
| `REDDWARF_OPENCLAW_LOOP_DETECTION_KNOWN_POLL_NO_PROGRESS` | `true` | Flag poll loops with no progress. |
| `REDDWARF_OPENCLAW_LOOP_DETECTION_PING_PONG` | `true` | Flag two-response ping-pong. |

### Discord (native OpenClaw channel)

| Variable | Default | Purpose |
|---|---|---|
| `REDDWARF_OPENCLAW_DISCORD_ENABLED` | `false` | Emit the `channels.discord` block. Requires `OPENCLAW_DISCORD_BOT_TOKEN`. |
| `REDDWARF_OPENCLAW_DISCORD_DM_POLICY` | `pairing` | DM policy. |
| `REDDWARF_OPENCLAW_DISCORD_GROUP_POLICY` | `allowlist` | Server policy. |
| `REDDWARF_OPENCLAW_DISCORD_GUILD_IDS` | _(empty)_ | Comma-separated guild IDs to allow. |
| `REDDWARF_OPENCLAW_DISCORD_REQUIRE_MENTION` | `true` | Require `@` mentions in allowed guilds. |
| `REDDWARF_OPENCLAW_DISCORD_NOTIFICATIONS_ENABLED` | `false` | Enable streaming, history, component styling, presence. |
| `REDDWARF_OPENCLAW_DISCORD_STREAMING` | `partial` | Discord streaming mode. |
| `REDDWARF_OPENCLAW_DISCORD_HISTORY_LIMIT` | `24` | Recent message history count. |
| `REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_ENABLED` | `true` | Turn on auto-presence updates. |
| `REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_INTERVAL_MS` | _(unset)_ | Presence refresh cadence. |
| `REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_MIN_UPDATE_INTERVAL_MS` | _(unset)_ | Minimum interval between presence updates. |
| `REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_HEALTHY_TEXT` | _(unset)_ | Healthy-status presence text. |
| `REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_DEGRADED_TEXT` | _(unset)_ | Degraded-status presence text. |
| `REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_EXHAUSTED_TEXT` | _(unset)_ | Exhausted-status presence text. |
| `REDDWARF_OPENCLAW_DISCORD_EXEC_APPROVALS_ENABLED` | `false` | Enable native OpenClaw approval prompts in Discord. |
| `REDDWARF_OPENCLAW_DISCORD_APPROVER_IDS` | _(empty)_ | Comma-separated Discord user IDs allowed to resolve approval prompts. |
| `REDDWARF_OPENCLAW_DISCORD_EXEC_APPROVAL_TARGET` | `channel` | `dm` \| `channel` \| `both`. |
| `REDDWARF_OPENCLAW_DISCORD_ACCENT_COLOR` | `#d7263d` | Accent color for Discord components. |

### USD cost attribution + daily autonomy budget (M24 F-180, F-183)

Closes the dollar-cost half of the token-budget loop. When set, the per-task
cap fires `COST_BUDGET_EXCEEDED` as soon as a task's accumulated cost passes
it; the org-level daily cap pauses new dispatches until the next 00:00 UTC
boundary. Already-running phases are not cancelled.

| Variable | Default | Purpose |
|---|---|---|
| `REDDWARF_COST_BUDGET_PER_TASK_USD` | _(unset)_ | Per-task USD cap. Omit for unlimited. |
| `REDDWARF_MODEL_PRICING_JSON` | _(uses defaults)_ | JSON override of the per-model pricing table. Same shape as `DEFAULT_MODEL_PRICING`. |
| `REDDWARF_DAILY_TOKEN_BUDGET` | _(unset)_ | Daily token cap across all tasks. |
| `REDDWARF_DAILY_COST_BUDGET_USD` | _(unset)_ | Daily USD cap across all tasks. |
| `REDDWARF_BUDGET_RESET_TZ` | `UTC` | Reset boundary timezone. v1 always resets at 00:00 UTC; the env var is read for forward compat. |

The current burn-down is exposed at `GET /api/budget/daily` and rendered as a
card on the dashboard home page when either daily cap is configured.

### Discord `/rdsubmit` command (M23 F-174)

Plugin command on the existing `reddwarf-operator` OpenClaw plugin that
creates a real GitHub issue (which the polling daemon then picks up). Lives
alongside the existing `/submit` command (which uses the direct-injection
path); the difference is that `/rdsubmit` leaves a permanent issue tracker
entry the way operators expect for human-initiated work.

Format:

```
/rdsubmit owner/repo | <title> | <summary> | <criterion 1>; <criterion 2>; ...
```

The repo segment may be omitted when only one repo is managed. Title is
5-200 characters, summary at least 20 characters, at least one
acceptance criterion required (semicolon-separated).

**v1 scope note.** The original board entry described a `StringSelectMenu` →
`Modal` flow. The OpenClaw plugin surface (`registerCommand` returning a
text reply) does not expose Discord's modal/select-menu component APIs in
v1; implementing the rich UI would need either an OpenClaw plugin
extension or a separate Discord bot. The pipe-format text command
preserves the same workflow without the rich UI. Requires
`REDDWARF_OPENCLAW_DISCORD_ENABLED=true`.

### Intake Adapter Contract (M24 F-188)

Provider-agnostic seam between the polling/webhook intake loop and whatever
upstream system is producing tasks. The `IntakeAdapter` interface in
`@reddwarf/integrations` exposes four methods:

- `discoverCandidates(query)` — list new candidate tasks.
- `fetchCanonicalTask(id)` — fetch one task by id (used by webhook flows).
- `toPlanningTaskInput(candidate)` — translate to the planning input shape.
- `markProcessed(id, outcome)` — record the pipeline outcome upstream.

Two implementations ship:

- **`GitHubIntakeAdapter`** — thin wrapper over the existing `GitHubAdapter`.
  Provider id `"github"`. `markProcessed` is a no-op in v1; the polling
  cursor in `github_issue_polling_cursors` is the persistence point.
- **`FixtureIntakeAdapter`** — in-process double for tests and as a
  reference shape for non-GitHub adapters.

No env vars in v1. The polling daemon still calls the legacy `GitHubAdapter`
methods directly; the migration to thread `IntakeAdapter` through the
daemon is a small follow-up.

### Task playbooks (M24 F-187)

Reusable task-shape bundles that intake matches against an issue's labels and
stamps onto `PlanningTaskInput.metadata.playbook` so the architect (Holly)
sees them as additional context.

Playbooks live as JSON files under [`playbooks/`](../../playbooks/) at the
repo root. Each file conforms to `playbookSchema` in `@reddwarf/contracts`
and can specify `matchLabels`, `riskClass`, `allowedPaths`,
`requiredCapabilities`, `architectHints`, `validatorRules`, and
`reviewerRubric`. The catalogue loads at boot; load errors are logged but
do not block startup.

Four starter playbooks ship in v1: `dependency-bump`, `new-endpoint`,
`docs-update`, `feature-flag-add`. Add a new playbook by dropping a JSON
file in the directory and restarting the stack.

No env vars; the catalogue location is auto-discovered from the repo root.

### Pre-flight contract checks (M24 F-184)

Deterministic gate that runs over the workspace diff at SCM time, before the
branch is published. Catches obvious bad-diffs without spending tokens on the
Validator. Failures emit a `contract_violation` failure class and skip
straight to operator triage.

The check itself is not env-tunable in v1 — capabilities (`can_modify_schema`,
`can_modify_dependencies`) and the policy snapshot's `deniedPaths` are the
only inputs. A new capability `can_modify_dependencies` was added to the
contracts enum: grant it on tasks that legitimately need to mutate
`package.json` / lock files; absence trips a `dependency_mutation` violation.

### Operator triage verbs (M24 F-186)

Three operator-facing verbs against the manifest / pipeline-run state that
were previously only achievable by editing Postgres by hand.

| Method | Path                                  | Purpose |
|-------:|---------------------------------------|---------|
| POST   | `/api/tasks/:taskId/quarantine`       | Sets `lifecycleStatus = quarantined`. Required body: `{ "reason": "…" }`. The dispatcher skips quarantined tasks until released. |
| POST   | `/api/tasks/:taskId/release`          | `quarantined` → `ready`. Optional `{ "reason": "…" }`. |
| POST   | `/api/tasks/:taskId/notes`            | Appends a `memory_record` with `provenance: "operator_provided"`. Required body: `{ "note": "…", "author"?: "…" }`. |
| POST   | `/api/runs/:runId/heartbeat-kick`     | Refreshes `lastHeartbeatAt` so the dispatcher reconsiders a stuck `active`/`blocked` run without a full cancel-and-retry. Optional `{ "reason": "…" }`. |

Each verb emits a distinct audit-trail run event (`TASK_QUARANTINED`,
`TASK_RELEASED`, `OPERATOR_NOTE_ADDED`, `HEARTBEAT_KICKED`). The dashboard's
new **Triage** page lists every quarantined task with a one-click release
button; the other verbs are reachable via curl in v1.

### Discord outbound notifications (M23 F-177)

Independent of the native OpenClaw Discord bridge. Posts embed messages to an incoming Discord webhook when a new approval is created (plan, phase, project, or tool) or when a developer-phase session opens a PR. Delivery is best-effort — webhook failures log a warning and never fail the pipeline. Embeds deep-link to the dashboard when `REDDWARF_DASHBOARD_ORIGIN` is set and reuse `REDDWARF_OPENCLAW_DISCORD_ACCENT_COLOR` for embed colour.

| Variable | Default | Purpose |
|---|---|---|
| `REDDWARF_DISCORD_NOTIFY_ENABLED` | `false` | Master switch for outbound notifications. |
| `REDDWARF_DISCORD_NOTIFY_WEBHOOK_URL` | _(unset)_ | Discord incoming webhook URL. Required when enabled. Treated as a credential. |
| `REDDWARF_DISCORD_NOTIFY_APPROVALS` | `true` | Notify on new approval creation. |
| `REDDWARF_DISCORD_NOTIFY_PR_CREATED` | `true` | Notify on PR creation. |

---

## Secrets

Kept out of plaintext UIs. A subset is rotatable at runtime via `POST /secrets/:key/rotate` (see [OPERATOR_API.md](OPERATOR_API.md#post-secretskeyrotate)).

| Variable | Required | Rotatable | Purpose |
|---|---|---|---|
| `GITHUB_TOKEN` | Yes | Yes | GitHub PAT for issue intake, branch publishing, PR creation. |
| `ANTHROPIC_API_KEY` | When `provider=anthropic` or failover includes Anthropic | Yes | Planning and agent execution. |
| `OPENAI_API_KEY` | When `provider=openai` or failover includes OpenAI | Yes | Planning and agent execution. |
| `OPENCLAW_HOOK_TOKEN` | Yes | Yes | RedDwarf → OpenClaw dispatch authentication. |
| `OPENCLAW_BASE_URL` | No (default provided) | No | OpenClaw gateway base URL. Default `http://localhost:3578`. |
| `OPENCLAW_GATEWAY_TOKEN` | Yes | Yes | OpenClaw Control UI authentication. |
| `OPENCLAW_DISCORD_BOT_TOKEN` | When Discord enabled | Yes | Discord bot token for native channel support. |
| `REDDWARF_OPERATOR_TOKEN` | Yes | Yes | Bearer token for operator API and dashboard. |
| `REDDWARF_WEBHOOK_SECRET` | No (enables webhooks when set) | Yes | GitHub webhook HMAC secret. |

Under Docker Compose, only the keys needed by the active provider are injected into the OpenClaw container's environment — F-157 in [OPENCLAW_AUDIT.md](../openclaw/OPENCLAW_AUDIT.md). The full set remains available to the host-side Operator API.

---

## Project Mode (M20)

| Variable | Default | Purpose |
|---|---|---|
| `REDDWARF_GITHUB_ISSUES_ENABLED` | `false` | Enable the GitHub Issues sub-issue writer. When `false`, the adapter throws `V1MutationDisabledError`. |
| `GITHUB_REPO` | _(unset)_ | Optional default `owner/repo` for direct adapter calls that don't pass a repo. Normally unused — approval supplies the target. |
| `REDDWARF_OPERATOR_API_URL` | _(unset)_ | Public URL of the operator API, used by the `reddwarf-advance.yml` GitHub Actions workflow on PR merge. With Tailscale Funnel, typically `https://<machine>.<tailnet>.ts.net:<port>`. |
| `REDDWARF_CLARIFICATION_TIMEOUT_MS` | `1800000` (30 min) | Escalate to operator API when Holly's clarification loop times out. |

See [reddwarf_project_mode_spec.md](../reddwarf_project_mode_spec.md) and [tailscale-funnel-setup.md](../tailscale-funnel-setup.md).

---

## Dev / E2E

Used only by `corepack pnpm e2e`. See [DEMO_RUNBOOK.md](../DEMO_RUNBOOK.md).

| Variable | Default | Purpose |
|---|---|---|
| `E2E_TARGET_REPO` | _(unset)_ | Target repo in `owner/repo` format. Required for E2E. |
| `E2E_USE_OPENCLAW` | `false` | Dispatch developer phase through live OpenClaw. |
| `E2E_CLEANUP` | `false` | Close/delete created GitHub resources after E2E finishes. |

---

## See also

- [.env.example](../../.env.example) — canonical source with inline comments.
- [OPERATOR_API.md](OPERATOR_API.md#post-config) — the `PUT /config` and `POST /secrets/:key/rotate` endpoints.
- [ARCHITECTURE.md §12](../ARCHITECTURE.md) — how the configuration layers interact with operator_config.
- [DEMO_RUNBOOK.md](../DEMO_RUNBOOK.md) — how E2E vars are used.
- [WEBHOOK_SETUP.md](../WEBHOOK_SETUP.md) — webhook configuration.
- [VPS_DEPLOYMENT.md](../VPS_DEPLOYMENT.md) — `REDDWARF_API_HOST` on Linux VPS.
