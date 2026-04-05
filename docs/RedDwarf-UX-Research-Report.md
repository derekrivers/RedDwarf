# RedDwarf — UX & Feature Expansion Research Report

> **Repository:** [derekrivers/RedDwarf](https://github.com/derekrivers/RedDwarf)
> **Stack:** TypeScript / Node.js · pnpm monorepo · Drizzle + Postgres · Docker Compose · OpenClaw runtime
> **Date:** April 2026
> **Scope:** UI Configuration, Operator API Extension, Feature Board Overhaul, OpenClaw Feature Expansion (Local + VPS)

---

## Executive Summary

RedDwarf is a TypeScript policy-pack monorepo that wraps OpenClaw into a governed, human-gated AI Dev Squad. The system is production-solid in its pipeline semantics — durable Postgres evidence, approval gating, concurrency control, scoped secrets, and workspace isolation are all in good shape. The friction is almost entirely at the **operator experience** layer.

As of the March 2026 hardening audit the `.env.example` file has grown to **51 variables** across seven logical groups. The only interface for approving tasks, inspecting pipeline state, and managing the stack is a raw `curl`-against-the-Operator-API workflow. The Feature Board, while well-structured, is focused exclusively on pipeline internals and does not yet account for the UX and configuration surface improvements that are rapidly becoming the biggest blockers to onboarding new operators.

This report addresses four strategic improvements in priority order:

1. Replacing `.env` bloat with a UI-based configuration panel
2. Extending the Operator API to support that panel
3. Overhauling the Feature Board to reflect the full product roadmap
4. Expanding OpenClaw feature utilisation — separately for local and VPS environments

---

## Section 1 — UI-Based Configuration

### 1.1 The Problem in Detail

The current `.env.example` spans 51 variables across seven logical groups:

| Group | Variables | Example Keys |
|---|---|---|
| OpenClaw container | 2 | `OPENCLAW_IMAGE`, `OPENCLAW_HOST_PORT` |
| Postgres credentials | 4 | `POSTGRES_DB`, `POSTGRES_PASSWORD`, `DATABASE_URL` |
| DB pool tuning | 6 | `REDDWARF_DB_POOL_MAX`, `*_TIMEOUT_MS` (×4), `*_LIFETIME_SECONDS` |
| Path config | 8 | `REDDWARF_POLICY_SOURCE_ROOT`, `*_WORKSPACE_ROOT` (×3), `*_EVIDENCE_ROOT` (×2) |
| Runtime config | 5 | `REDDWARF_POLL_REPOS`, `*_POLL_INTERVAL_MS`, `*_API_PORT`, `*_SKIP_OPENCLAW` |
| Secrets | 5 | `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_HOOK_TOKEN`, `REDDWARF_OPERATOR_TOKEN` |
| E2E / dev | 3 | `E2E_TARGET_REPO`, `E2E_USE_OPENCLAW`, `E2E_CLEANUP` |

This is a significant cognitive burden for a new operator. There is no validation, no grouping, no inline documentation at the point of entry, and no way to change values at runtime without restarting the process.

### 1.2 Recommended Variable Classification

Before building a UI, the variables should be split into three classes:

**Class A — Boot-time only (stay in `.env`)**
Variables that must be resolved before the process starts and cannot safely change at runtime. These include `DATABASE_URL`, `HOST_DATABASE_URL`, `OPENCLAW_IMAGE`, and Postgres credentials. These should remain in `.env` but be documented with clear comments and grouped into sections using comment headers.

**Class B — Runtime-configurable (move to DB-backed UI)**
Variables that change the behaviour of a running system without requiring a restart. These include `REDDWARF_POLL_REPOS`, `REDDWARF_POLL_INTERVAL_MS`, `REDDWARF_DISPATCH_INTERVAL_MS`, `REDDWARF_LOG_LEVEL`, `REDDWARF_API_PORT`, `REDDWARF_SKIP_OPENCLAW`, and the DB pool tuning values. These are the primary candidates for a configuration UI.

**Class C — Secrets (separate secrets management)**
`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_HOOK_TOKEN`, and `REDDWARF_OPERATOR_TOKEN` should never appear in a UI as plaintext. See the secrets handling note in Section 1.4.

### 1.3 Recommended UI Approach

The most pragmatic approach given RedDwarf's architecture is to extend the existing Operator API with configuration endpoints and serve a lightweight single-file UI from the same Express server on port 8080. This avoids introducing a separate frontend build pipeline and keeps all operator tooling at a single address.

The configuration panel should be organised into the same logical groups as the `.env` file:

**Polling & Dispatch** — target repos (as a multi-value list, not a comma string), poll interval, dispatch interval, skip flag. Repo entries should be validated against the `owner/repo` pattern before acceptance.

**Database Pool** — pool max connections, connection timeout, idle timeout, query timeout, statement timeout, client lifetime. These should be rendered as labelled number inputs with their current value, the `.env.example` default, and a brief description of the impact of changing each value.

**Logging** — log level as a select (debug / info / warn / error).

**Paths** — read-only display of the path variables since these are set at boot, but showing them visually helps operators understand where workspaces and evidence are being written.

**About / Status** — current version, uptime, Postgres connectivity, OpenClaw gateway reachability, polling daemon status, dispatcher status.

### 1.4 Secrets Handling

Secrets must never be displayed, edited, or transmitted via the configuration UI. The recommended pattern is to show each secret as a masked indicator (e.g., `sk-ant-••••••••••••••••...`) alongside a "Rotate" button that opens a modal accepting a new value. The new value is written to an encrypted secrets store or injected into a secrets manager rather than back to the `.env` file. For the initial implementation, writing to a `.secrets` file with tightly restricted filesystem permissions is acceptable, but a migration path toward a proper secrets backend (such as a local Vault instance or environment-level secret injection) should be documented.

### 1.5 Configuration Persistence

Operator-facing runtime config (Class B) should be persisted to a `operator_config` table in the existing Postgres instance using Drizzle, following the same pattern already established for `pipeline_runs`, `approval_requests`, and `evidence`. This gives the config layer the same durability guarantees as the rest of the system. On startup, the process reads this table after loading `.env`, and table values take precedence over `.env` for any key that appears in both. This ensures a clean migration path: existing deployments continue to work from `.env` until an operator explicitly migrates a value into the UI.

---

## Section 2 — Operator API Extension

### 2.1 Current API Surface

The existing Operator API on `:8080` exposes a set of endpoints designed for `curl`-based operation:

| Method | Route | Purpose |
|---|---|---|
| GET | `/health` | Stack health check (unauthenticated) |
| GET | `/blocked` | List tasks awaiting approval |
| POST | `/approvals/:id/resolve` | Approve or reject a pending task |
| GET | `/runs` | (inferred) Pipeline run listing |
| GET | `/snapshot` | (inferred) System state snapshot |
| POST | `/dispatch` | Manual task dispatch |

All routes except `/health` require a `Bearer` token matching `REDDWARF_OPERATOR_TOKEN`.

### 2.2 Recommended New Endpoints

The following endpoints should be added to support the configuration UI and improve the operator experience:

**Configuration endpoints**

```
GET  /config            — return all runtime-configurable values with types, defaults, and descriptions
PUT  /config            — update one or more runtime-configurable values
GET  /config/schema     — return the JSON schema for the config object (used by the UI for validation)
```

**Repository management**

```
GET  /repos             — list currently polled repos with their per-repo status
POST /repos             — add a repo to the poll list
DELETE /repos/:owner/:repo — remove a repo from the poll list
```

**Pipeline observability**

```
GET  /runs              — list pipeline runs with filter support (?status=active&limit=20)
GET  /runs/:id          — full detail for a single run including phase history
GET  /runs/:id/evidence — list evidence artifacts for a run
GET  /tasks             — list tasks across all states
GET  /tasks/:id         — task detail including current phase, history, and approval status
```

**Secrets rotation (write-only, no read)**

```
POST /secrets/:key/rotate — accept a new secret value, write to secure store, return confirmation only
```

**UI serving**

```
GET  /ui                — serve the operator configuration panel HTML
GET  /ui/*              — serve static assets (if any)
```

### 2.3 Authentication Considerations

The current single `REDDWARF_OPERATOR_TOKEN` model is appropriate for a single-operator local setup, but as the API surface grows it becomes worth distinguishing between read-only access and write access. A pragmatic approach is to support two token tiers:

- **Read token** — allows GET on all routes, returned in health responses masked to last four characters
- **Operator token** — allows GET and mutating operations (PUT, POST, DELETE)

Both can be declared in the secrets store. The UI should display which tier the current session holds.

### 2.4 API Contract and Schema

Given that the rest of the RedDwarf codebase uses Zod for schema definition and Drizzle for the DB layer, both the request and response shapes for new endpoints should be defined as Zod schemas in `packages/contracts` alongside the existing domain schemas. This keeps the API contract versioned and typesafe, consistent with the existing pattern for task manifests, planning specs, and approval decisions.

---

## Section 3 — Feature Board Overhaul

### 3.1 Assessment of the Current Board

The current `FEATURE_BOARD.md` is well-structured with clear priorities, milestone groupings, architecture plane traces, and an archive for completed work. The post-audit priority reset (features 89–103 ordered by blast radius) reflects sound engineering judgement.

However the board has three gaps that should be addressed:

**Gap 1 — UX and operator surface work is missing entirely.**
The board tracks only pipeline internals. None of the configuration UI work, API extension work, or operator experience improvements described in Sections 1 and 2 appear anywhere. These are now significant enough to warrant their own milestone.

**Gap 2 — The board does not distinguish between local and VPS deployment targets.**
Several pending features (Discord bot, web search for Architect, CI adapter) have meaningfully different implementation implications depending on whether the system is locally hosted or VPS-hosted. The board should either add a "Deployment Context" column or group features into deployment-aware milestones.

**Gap 3 — The board format does not surface blocked dependencies.**
Feature 96 (direct task injection) is a prerequisite for Feature 97 (CLI task submission). Feature 99 (Discord approval bot) depends on Feature 100 (Discord notification tool). These relationships are implicit in the text but not machine-readable or visually obvious.

### 3.2 Recommended Board Structure

The overhauled `FEATURE_BOARD.md` should be restructured as follows:

**New milestone: M14 — Operator UX (insert before M15)**
This milestone captures the work from Sections 1 and 2 and should be treated as the highest current priority since it unblocks operator onboarding.

| Priority | Feature | Milestone | Depends On | Deployment |
|---|---|---|---|---|
| OUX-1 | Classify `.env` variables into boot-time, runtime, and secret tiers | M14 | — | Both |
| OUX-2 | Add `operator_config` Drizzle table and startup merge logic | M14 | OUX-1 | Both |
| OUX-3 | Add `/config` GET and PUT endpoints with Zod schema | M14 | OUX-2 | Both |
| OUX-4 | Add `/repos` management endpoints | M14 | OUX-3 | Both |
| OUX-5 | Add `/runs` and `/tasks` observability endpoints | M14 | — | Both |
| OUX-6 | Add `/secrets/:key/rotate` write-only endpoint | M14 | OUX-2 | Both |
| OUX-7 | Build and serve operator configuration panel UI from `/ui` | M14 | OUX-3, OUX-4, OUX-5 | Both |

**Retain M15 (pipeline hardening) but add Deployment Context column**

The existing features 89–103 should have a Deployment Context column added: `Local`, `VPS`, or `Both`. This signals to contributors which features require a hosted environment to test fully.

**New milestone: M18 — VPS Expansion**
This milestone captures OpenClaw features that only become practical or desirable when the stack is hosted on a VPS. See Section 5 for the full feature list.

**Format changes**

- Add a `Depends On` column to make feature dependencies explicit
- Add a `Deployment` column (`Local` / `VPS` / `Both`)
- Add a brief legend at the top of the file explaining the columns
- Convert the table to use milestone sub-headings (`## M14 — Operator UX`) so the file is navigable with anchor links

---

## Section 4 — OpenClaw Feature Expansion: Local Machine

### 4.1 Context

RedDwarf currently uses OpenClaw in a deliberately conservative way. The OpenClaw container runs on port 3578, the Control UI is accessible from the host, and the Operator API dispatches tasks to OpenClaw via HTTP. Many OpenClaw capabilities that are bundled in the standard image are either unused or disabled behind `V1MutationDisabledError` guards.

This section covers features that can be activated on a local machine without infrastructure changes.

### 4.2 WebChat as an Operator Interface

OpenClaw ships a built-in WebChat UI served directly from the gateway. In the current setup, operators interact with RedDwarf entirely through `curl` or scripts. WebChat can serve as a conversational interface for querying pipeline state, approving tasks, and submitting new work — without building a custom chat UI.

To leverage this, a RedDwarf-specific skill should be registered with OpenClaw's gateway that exposes a set of natural language command handlers:

- `status` — returns current pipeline health, pending approvals, and active runs
- `approve <task-id>` — wraps the `/approvals/:id/resolve` endpoint
- `reject <task-id> <reason>` — same, with a rejection reason
- `submit <description>` — wraps the planned `/tasks/inject` endpoint (Feature 96)
- `runs` — lists recent pipeline runs with status

This is achievable now using OpenClaw's `api.registerCommand()` pattern (seen in the compound-engineering plugin) and does not require any changes to the pipeline itself.

### 4.3 MCP Integration via mcporter

OpenClaw supports the Model Context Protocol via the `mcporter` bridge, which keeps the core gateway lean while allowing any MCP-compatible tool server to be registered. RedDwarf's Operator API is already a well-structured HTTP API. An MCP server wrapper around the Operator API would allow OpenClaw's Architect and Validator agents to query RedDwarf state (task history, project memory, evidence) as part of their context window construction.

The practical impact: the Architect agent could check whether a similar task has been attempted before, retrieve the evidence from that prior run, and incorporate lessons learned into the planning spec — without any changes to the Architect agent's system prompt.

This is achievable locally by running `mcporter` alongside the existing Docker Compose stack.

### 4.4 Browser Control for Validation

OpenClaw includes a managed Chromium instance with CDP control available to agent skills. The Validation Agent currently runs deterministic workspace-local lint and test checks. Browser control opens a path to extending validation to include:

- rendering the TypeScript type errors in a browser-based viewer
- capturing screenshots of any UI component changes generated by the Developer Agent
- running against the OpenClaw Control UI itself to verify that gateway config is intact after a pipeline run

These are low-risk additions in a local environment since the browser is isolated to the host machine.

### 4.5 Canvas for Evidence Visualisation

OpenClaw's Canvas feature allows agents to push structured visual output to a live panel visible to the operator. Rather than reading raw JSON evidence files, the operator could receive a Canvas-rendered summary of each pipeline run: phase status, token usage, approval decision, and diff summary. This is particularly useful during development and debugging of new features.

### 4.6 Voice Wake and Talk Mode (macOS)

If the development machine is macOS, OpenClaw's Voice Wake and Talk Mode allow the operator to interact with the gateway by voice. Combined with the WebChat command handlers described in 4.2, this enables a hands-free approval workflow: the operator hears a notification that a task is awaiting approval, reviews the plan on screen, and approves or rejects by voice.

### 4.7 Tailscale Integration for Remote Local Access

OpenClaw has built-in Tailscale Serve/Funnel support that can expose the gateway dashboard over a private tailnet without opening public ports. For a developer working across multiple machines (e.g., a laptop and a desktop development machine), this allows the Control UI at `127.0.0.1:3578` and the Operator API at `127.0.0.1:8080` to be accessed from any machine on the tailnet. This is a local-machine feature because the network never leaves the private tailnet — no VPS required.

---

## Section 5 — OpenClaw Feature Expansion: VPS Environment

### 5.1 What Changes on a VPS

Moving from a local machine to a VPS changes three things that matter to RedDwarf:

1. The gateway is publicly reachable (or reachable over a wider network) rather than localhost-only
2. The process runs continuously without depending on a developer's machine being on
3. The stack can be scaled horizontally if needed (though RedDwarf's concurrency model is currently conservative by design)

The following features become practical or desirable specifically in this context.

### 5.2 Always-On Polling Daemon

The most immediate benefit of a VPS deployment is that `REDDWARF_POLL_REPOS` can be configured to watch one or more GitHub repositories continuously without the developer's machine being awake. GitHub issue intake, plan generation, and approval gating all happen autonomously. The operator checks in via the UI or Discord (see 5.4) rather than keeping a terminal session open.

The polling daemon's exponential backoff on GitHub unreachability (already implemented) makes this robust to transient connectivity issues on the VPS.

### 5.3 Tailscale Funnel for Authenticated External Access

On a VPS, Tailscale Funnel can expose the OpenClaw gateway and the RedDwarf Operator API to the public internet over HTTPS, authenticated by the gateway token and operator token respectively. This removes the need for any custom reverse proxy configuration. The operator accesses the Control UI and configuration panel from any browser, authenticated with the `OPENCLAW_GATEWAY_TOKEN`. Webhook ingress (e.g., GitHub webhooks for real-time issue events rather than polling) also becomes straightforward through Funnel.

### 5.4 Discord Approval Bot (Feature 99 + 100)

Features 99 and 100 on the current board become significantly more valuable on a VPS because the system is running while the developer is away from their machine. The Discord approval bot surfaces pending approval requests as interactive messages, allowing the operator to approve or reject from a phone. The Discord notification tool gives agents a channel to push mid-run status updates.

On a local machine these features are nice-to-have. On a VPS where the pipeline may complete a planning phase at 2am, they become the primary human interface.

The implementation should wire Feature 100 (send\_discord\_notification tool) first, as it is a prerequisite for Feature 99 and is simpler. Feature 100 can be implemented as an OpenClaw skill that wraps the Discord webhook API. Feature 99 (the full interactive bot with approve/reject buttons) requires a Discord application with slash command support and a webhook endpoint reachable by Discord's servers — which requires the VPS context.

### 5.5 GitHub Webhook Intake (replacing polling)

In a VPS environment with a public endpoint, GitHub can push issue and PR events via webhook rather than RedDwarf polling GitHub on an interval. This eliminates the `REDDWARF_POLL_INTERVAL_MS` delay (currently defaulting to 30 seconds) and allows the pipeline to start within seconds of an issue being labeled `ai-eligible`. The direct task injection endpoint (Feature 96) and the webhook intake path share the same intake logic, so Feature 96 should be implemented first.

### 5.6 Persistent Memory at Scale

On a local machine, project memory and organisation memory are written to Postgres in the single local instance. On a VPS, the same Postgres instance is always available, which means project memory accumulates correctly across all pipeline runs regardless of which machine the operator uses to review output. The project memory compression feature (Feature 92) and the per-run memory cache (Feature 93) become more important on a VPS because the memory store will grow faster with continuous polling and execution.

### 5.7 OpenAI Provider Support (Feature 103)

On a VPS with stable uptime, multi-provider model failover (Feature 103 — OpenAI provider support alongside Anthropic) becomes operationally meaningful. If the Anthropic API is experiencing elevated latency or errors, the pipeline can fall back to an OpenAI-equivalent model for non-sensitive phases (pre-screening, documentation generation) while keeping Anthropic for security-sensitive planning and validation phases. This is less valuable on a local machine where a developer can intervene manually.

### 5.8 CI Adapter (Feature 102) Over a Persistent Connection

The CI adapter tool (Feature 102) allows Developer and Validator agents to trigger CI runs and query their results. On a local machine this works but requires the CI provider to be able to reach back to the running instance. On a VPS with a stable public endpoint, the CI adapter can receive webhook events from GitHub Actions or equivalent CI systems, enabling the Validation Agent to wait for real CI results before marking a task ready for review rather than relying only on local lint and test execution.

### 5.9 Docker and Compose Simplification for VPS

The current `infra/docker` setup is designed for local development (Postgres on a non-standard port 55532, host-side scripts using `127.0.0.1` to avoid WSL2 relay issues). A VPS deployment should have a separate `infra/docker/vps` compose configuration with:

- Postgres exposed only on the internal Docker network (not to the host)
- `DATABASE_URL` used consistently without the `HOST_DATABASE_URL` workaround
- An optional nginx or Caddy reverse proxy container in the compose stack for TLS termination
- `REDDWARF_SKIP_OPENCLAW=false` enforced since the always-on OpenClaw container is the primary value proposition

---

## Section 6 — Recommendations Summary

### Immediate (M14 — Operator UX)

The highest-leverage work right now is reducing the barrier to operating RedDwarf. The `.env` classification (Section 1.2), the `operator_config` Drizzle table (Section 1.5), and the first three Operator API endpoints (Section 2.2) can be done in parallel with the ongoing M15 pipeline hardening work since they touch different parts of the codebase.

The configuration UI (Section 1.3) should be built as a single HTML file served from the Express process — no separate build step, no framework dependency, consistent with the existing "conservative v1" philosophy.

### Near-term (M15 pipeline hardening + OpenClaw local features)

Features 89–93 (deterministic eligibility gate, role-scoped context, spec distillation, memory compression, memory cache) are well-defined and correctly prioritised. Alongside these, the OpenClaw local integrations in Section 4 — particularly the WebChat command handlers and the MCP bridge over the Operator API — should be prototyped. These have a very high signal-to-effort ratio: they reuse existing infrastructure and dramatically improve the development-time operator experience.

### Medium-term (M16 intake + Discord)

Features 94–102 should be sequenced as follows based on dependencies:

1. Feature 96 (direct task injection endpoint) — enables everything else
2. Feature 97 (CLI submit command) — trivial wrapper over 96
3. Feature 100 (Discord notification tool) — prerequisite for 99
4. Feature 95 (GitHub issue template) — reduces Architect token burn
5. Feature 94 (pre-screener agent) — reduces full planning pass waste
6. Feature 99 (Discord approval bot) — high value, requires VPS or Funnel
7. Features 98, 101, 102 in parallel

### VPS Migration (M18)

Before migrating to a VPS, the following should be complete: the Operator UI (so management doesn't require SSH + curl), Discord notification (so approvals don't require an open browser tab), and the VPS-specific Docker Compose configuration (Section 5.9). The migration itself should be treated as a deployment feature rather than a code feature — a runbook in `docs/` with a VPS-specific `.env.example.vps` template.

---

## Section 7 — Proposed Feature Board Additions

The following table lists the net-new features this report recommends adding to `FEATURE_BOARD.md`. They should be inserted as **Milestone M14** before the existing M15 block, and a new **Milestone M18** block at the end.

### M14 — Operator UX

| Priority | Feature | Depends On | Deployment | Status |
|---|---|---|---|---|
| OUX-1 | Classify `.env` into boot-time, runtime, and secret tiers; refactor `.env.example` with grouped comment headers | — | Both | pending |
| OUX-2 | Add `operator_config` Drizzle table; merge runtime config from DB on startup, DB values take precedence over `.env` | OUX-1 | Both | pending |
| OUX-3 | Add `GET /config` and `PUT /config` Operator API endpoints with Zod request/response schemas in `packages/contracts` | OUX-2 | Both | pending |
| OUX-4 | Add `GET /repos`, `POST /repos`, `DELETE /repos/:owner/:repo` endpoints; replace comma-string `REDDWARF_POLL_REPOS` with DB-backed repo list | OUX-3 | Both | pending |
| OUX-5 | Expand `GET /runs` with filter support; add `GET /runs/:id`, `GET /runs/:id/evidence`, `GET /tasks`, `GET /tasks/:id` | — | Both | pending |
| OUX-6 | Add `POST /secrets/:key/rotate` write-only endpoint; write to permissions-restricted `.secrets` file | OUX-2 | Both | pending |
| OUX-7 | Build and serve single-file operator configuration panel from `GET /ui`; panels: Polling, DB Pool, Logging, Paths (read-only), Status, Secrets rotation | OUX-3, OUX-4, OUX-5, OUX-6 | Both | pending |
| OUX-8 | Register WebChat command skill with OpenClaw gateway: `status`, `approve`, `reject`, `submit`, `runs` commands wrapping Operator API | OUX-5 | Both | pending |
| OUX-9 | Add MCP bridge (mcporter) over the Operator API so OpenClaw agents can query RedDwarf task history and evidence during context materialisation | OUX-5 | Both | pending |

### M18 — VPS Expansion

| Priority | Feature | Depends On | Deployment | Status |
|---|---|---|---|---|
| VPS-1 | VPS-specific Docker Compose config: Postgres internal-only, remove `HOST_DATABASE_URL` workaround, add optional TLS reverse proxy service | — | VPS | pending |
| VPS-2 | GitHub webhook intake endpoint to replace polling; shares intake logic with Feature 96 (direct task injection) | 96 | VPS | pending |
| VPS-3 | Tailscale Funnel configuration guide and optional `funnel` compose profile that exposes gateway (3578) and Operator API (8080) via Funnel | VPS-1 | VPS | pending |
| VPS-4 | CI adapter webhook receiver: accept inbound GitHub Actions status webhook events so Validation Agent can await real CI results | 102 | VPS | pending |
| VPS-5 | Multi-provider model failover configuration: allow per-phase model provider override (Anthropic / OpenAI) so VPS stack degrades gracefully during provider outages | 103 | VPS | pending |

---

## Appendix — Current `.env` Variable Reference

For convenience, the full classified variable list from `.env.example`:

**Boot-time only (stay in `.env`)**
`OPENCLAW_IMAGE`, `OPENCLAW_HOST_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_HOST_PORT`, `DATABASE_URL`, `HOST_DATABASE_URL`, `REDDWARF_POLICY_SOURCE_ROOT`, `REDDWARF_POLICY_ROOT`, `REDDWARF_WORKSPACE_ROOT`, `REDDWARF_EVIDENCE_ROOT`, `REDDWARF_HOST_WORKSPACE_ROOT`, `REDDWARF_HOST_EVIDENCE_ROOT`, `REDDWARF_POLICY_PACKAGE_OUTPUT_ROOT`, `REDDWARF_OPENCLAW_WORKSPACE_ROOT`, `REDDWARF_OPENCLAW_CONFIG_PATH`

**Runtime-configurable (migrate to DB-backed UI)**
`REDDWARF_DB_POOL_MAX`, `REDDWARF_DB_POOL_CONNECTION_TIMEOUT_MS`, `REDDWARF_DB_POOL_IDLE_TIMEOUT_MS`, `REDDWARF_DB_POOL_QUERY_TIMEOUT_MS`, `REDDWARF_DB_POOL_STATEMENT_TIMEOUT_MS`, `REDDWARF_DB_POOL_MAX_LIFETIME_SECONDS`, `REDDWARF_LOG_LEVEL`, `REDDWARF_POLL_REPOS`, `REDDWARF_POLL_INTERVAL_MS`, `REDDWARF_DISPATCH_INTERVAL_MS`, `REDDWARF_API_PORT`, `REDDWARF_SKIP_OPENCLAW`

**Secrets (secrets store only, never in UI plaintext)**
`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `OPENCLAW_HOOK_TOKEN`, `OPENCLAW_BASE_URL`, `OPENCLAW_GATEWAY_TOKEN`, `REDDWARF_OPERATOR_TOKEN`

**E2E / dev only (not relevant to production)**
`E2E_TARGET_REPO`, `E2E_USE_OPENCLAW`, `E2E_CLEANUP`
