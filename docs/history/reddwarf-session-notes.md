# RedDwarf — Session Notes
> Full planning session covering OpenClaw tooling, token optimisation, task intake, remote access, Discord integration, cloud hosting, and commercial viability.

---

## 1. Project Overview

**RedDwarf** is a TypeScript policy-pack monorepo for an OpenClaw-powered AI Dev Squad.

- Planning-first, human-gated, durable and auditable
- Full pipeline: GitHub issue intake → planning → developer code generation (via OpenClaw) → validation → SCM branch/PR creation
- Five architectural planes: Control, Execution, Knowledge & Policy, Integration, Evidence
- Postgres stores task manifests, planning specs, policy decisions, evidence metadata, and observability events
- Repo: https://github.com/derekrivers/RedDwarf

### Package Structure
| Package | Responsibility |
|---|---|
| `packages/contracts` | Shared domain schemas and types |
| `packages/policy` | Eligibility, risk, approval, and guardrail logic |
| `packages/control-plane` | Lifecycle, planning, orchestration, evidence archival, workspace lifecycle |
| `packages/execution-plane` | Agent definitions |
| `packages/evidence` | Persistence schema, SQL migrations, Postgres-backed repositories |
| `packages/integrations` | GitHub, CI, and secrets adapter contracts |
| `agents/`, `prompts/`, `schemas/`, `standards/` | Mounted runtime assets consumed by OpenClaw |
| `infra/docker` | Local stack topology for OpenClaw and Postgres |

---

## 2. OpenClaw Tools to Add

Four high-value OpenClaw capabilities identified that fit naturally into the existing architecture.

### 2.1 Discord Notification Adapter
**File:** `packages/integrations/src/notifications/discord-adapter.ts`

Closes the loop on the notification adapter already defined in the architecture. Called from existing observability hooks in `control-plane` — fire-and-forget, never blocks pipeline state.

**Key events to notify:**
- `plan_ready_for_approval` 🟡
- `task_approved` ✅
- `task_failed` ❌
- `pr_opened` 🔵
- `validation_failed` 🟠

**New env vars:**
```bash
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/your_webhook_here
DISCORD_NOTIFICATIONS_ENABLED=true
```

**Integration point:** After every Postgres event insert in the control-plane observability hook, call `sendDiscordNotification()` non-blocking.

---

### 2.2 Web Search for the Architect Agent
**File:** `agents/reddwarf-architect/TOOLS.md` (new file in policy-pack tree)

Gives the Architect Agent access to `web_fetch` and `web_search` during the planning phase only — for vendor docs, framework guides, public RFCs.

**Key rules to encode in TOOLS.md:**
- Only publicly accessible URLs
- Prefer stable official docs over blogs/forums
- Do not search for internal or proprietary information
- Results are unverified — prefer official sources over aggregators

**Integration point:** Context materializer in `control-plane` writes a different `TOOLS.md` per agent role. Architect gets web tools; developer gets filesystem + shell; validator gets shell (read-only).

---

### 2.3 CI Adapter
**File:** `packages/integrations/src/ci/github-ci-adapter.ts`

Polls GitHub check suites after the SCM agent opens a PR. Feeds result back into the evidence plane. Optionally fires a Discord notification on failure.

**Flow:**
1. SCM agent opens PR
2. Control-plane polls `fetchPrCiStatus()` with exponential backoff
3. Result archived to evidence plane alongside diff summaries
4. Discord notification fired if CI fails

**Data shape returned:** `PrCiSummary { prNumber, overallStatus, checks[], fetchedAt }`

---

### 2.4 Architecture Reviewer Agent
**File:** `agents/reddwarf-arch-reviewer/SOUL.md`

Runs as a lightweight OpenClaw pass after the Developer Agent, before Validation. Checks architectural conformance only — does not fix or rewrite code. Returns a structured JSON verdict.

**What it checks:**
- Layer boundary violations (contracts → policy → control-plane → evidence, never reversed)
- Integration adapter bypass (external calls going around the integration plane)
- Evidence archival compliance
- V1MutationDisabledError guard preservation
- Secrets hygiene outside the scoped lease injection path

**Verdict options:** `pass` / `fail` / `escalate`

**Integration point:** Invoked by the dispatcher after developer handoff, via existing `OPENCLAW_BASE_URL` HTTP dispatch. Report archived to evidence before Validation phase begins.

### Recommended delivery order
1. Discord notifications (one file, no schema changes)
2. Web search for Architect (TOOLS.md update + materialisation branch)
3. CI adapter (needs polling loop in control-plane)
4. Architecture Reviewer (needs Zod schema + new phase slot in lifecycle)

---

## 3. Token Optimisation

Roughly **47% reduction** in per-task token cost achievable without touching agent capability.

### 3.1 Role-Scoped Context Materialisation
Each agent role only receives the context files it actually needs.

| Context file | Architect | Developer | Validator | Reviewer | SCM |
|---|---|---|---|---|---|
| `SOUL.md` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `TOOLS.md` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `spec.md` | ❌ | ✅ | ❌ | ✅ | ❌ |
| `policy_snapshot.json` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `allowed_paths.json` | ❌ | ✅ | ❌ | ❌ | ❌ |
| `acceptance_criteria.json` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `projectMemory` | ✅ | ❌ | ❌ | ❌ | ❌ |

SCM agent barely needs anything — just branch name, PR template, and task ID.

---

### 3.2 Spec Distillation Before Developer Handoff
Architect produces a full prose spec (~1,500 tokens). Before handing to the Developer Agent, a distillation step strips narrative and keeps only actionable directives (~400 tokens). Full spec still archived to evidence plane for auditability.

**File:** `packages/control-plane/src/planning/spec-distiller.ts`

`DistilledSpec` contains: `acceptanceCriteria[]`, `filesToChange[]`, `constraints[]`, `testExpectations[]` — no rationale, no background, no alternatives considered.

---

### 3.3 Aggressive SOUL.md Compression
Target: **under 300 tokens** per SOUL.md. Replace prose identity descriptions with terse operational directives.

```markdown
# Developer Agent
Role: implement the spec. Write TypeScript. Follow repo conventions.
Scope: files listed in allowed_paths.json only.
Output: working code + tests in scratch/. No prose explanations.
Stop if: destructive action, missing credential, genuine ambiguity.
```

---

### 3.4 Deterministic Eligibility Gate (zero LLM tokens)
Eligibility check must be **pure TypeScript logic** — no LLM involvement. Checks: label presence, issue body length, path ownership against restricted paths, deduplication against persisted planning specs.

**File:** `packages/policy/src/eligibility.ts`

---

### 3.5 Structured JSON Output from All Agents
Prompt every agent to return structured JSON only — no preamble, no markdown fences. Eliminates tokens that the parser immediately discards, and eliminates costly retry loops from malformed output.

Add to each agent's skill file:
```markdown
Respond with a single JSON object only. No preamble, no explanation, no markdown fences.
```

---

### 3.6 Project Memory Cache (Postgres-backed, 4-hour TTL)
Project memory is currently re-derived from scratch per task. Cache it in Postgres with a TTL so busy repos derive it once every few hours rather than once per task.

**File:** `packages/evidence/src/memory/project-memory-cache.ts`

**Table:** `project_memory_cache (repo_key, content, token_estimate, generated_at, expires_at)`

---

### Token Saving Summary
| Phase | Naive | Optimised | Saving |
|---|---|---|---|
| Eligibility | ~800 (LLM) | ~0 (deterministic) | 100% |
| Architect | ~4,000 | ~2,500 | 38% |
| Spec → Developer handoff | ~1,500 | ~400 | 73% |
| Developer session | ~8,000 | ~5,500 | 31% |
| Validator | ~3,000 | ~1,200 | 60% |
| SCM | ~2,000 | ~600 | 70% |
| **Total** | **~19,300** | **~10,200** | **~47%** |

---

## 4. Task Intake Optimisation

### 4.1 Structured GitHub Issue Template
**File:** `.github/ISSUE_TEMPLATE/ai-task.yml`

Enforces required fields at creation time so the Architect Agent receives pre-structured input rather than raw prose.

**Required fields:**
- Summary (one sentence)
- Risk Class (dropdown: low / medium / high)
- Acceptance Criteria (textarea, one per line)

**Optional fields:**
- Affected Paths
- Constraints

Label `ai-eligible` applied automatically.

---

### 4.2 Direct Task Injection Endpoint
For tasks raised programmatically or locally — bypasses GitHub entirely.

**Route:** `POST /tasks/inject` (operator API, requires `REDDWARF_OPERATOR_TOKEN`)

**File:** `packages/control-plane/src/operator/inject-task.ts`

```json
{
  "summary": "Add rate limiting to the operator API",
  "riskClass": "medium",
  "acceptanceCriteria": [
    "requests exceeding 100/min per token return 429",
    "existing authenticated routes unaffected"
  ],
  "affectedPaths": ["packages/control-plane/src/operator/"],
  "sourceRepo": "owner/repo",
  "createGithubIssue": false
}
```

Optionally back-creates a GitHub issue for audit trail only.

---

### 4.3 Task Grouping
Related tasks tagged with a `groupId`. Dispatcher serializes tasks within a group and carries forward diff context from previous task rather than starting cold. Project memory derived once per group rather than once per task.

**File:** `packages/control-plane/src/dispatcher/task-grouping.ts`

---

### 4.4 Pre-Screener (cheap Haiku call)
~200 token call to `claude-haiku-4-5-20251001` that validates a raw idea before it enters the queue. Returns: `{ suitable, missingFields, suggestedRiskClass, suggestedAcceptanceCriteria }`. Saves a 4,000 token planning cycle on tasks that aren't ready.

**File:** `packages/control-plane/src/intake/pre-screener.ts`

---

### Optimised Intake Flow
```
Raw idea
  → preScreenIdea()           [~200 tokens, Haiku]
  → POST /tasks/inject        [zero tokens — direct manifest write]
  → dispatcher picks it up    [skips polling, skips intake parsing]
  → Architect Agent           [receives pre-structured context]
```

---

## 5. Local CLI

**File:** `scripts/create-task.mts`

Interactive terminal form that POSTs directly to `localhost:8080/tasks/inject`. Supports both interactive and flag-based usage.

**pnpm scripts:**
```json
"task:create":  "node --import tsx/esm scripts/create-task.mts",
"task:list":    "node --import tsx/esm scripts/list-tasks.mts",
"task:approve": "node --import tsx/esm scripts/approve-task.mts"
```

**Flag-based (for scripting batches):**
```bash
pnpm task:create \
  --summary "Add rate limiting to operator API" \
  --risk medium \
  --criteria "returns 429 above 100 req/min" \
  --criteria "existing routes unaffected" \
  --paths "packages/control-plane/src/operator/"
```

---

## 6. Remote Access

### The Problem
The operator API runs on `localhost:8080` — unreachable from outside the home machine.

### Option 1 — Cloudflare Tunnel (recommended for localhost setup)
Exposes `localhost:8080` to the internet securely without opening ports. No router config needed.

```bash
winget install Cloudflare.cloudflared
cloudflared tunnel login
cloudflared tunnel create reddwarf
```

Config (`%APPDATA%\cloudflared\config.yml`):
```yaml
tunnel: reddwarf
ingress:
  - hostname: reddwarf.yourdomain.com
    service: http://localhost:8080
  - service: http_status:404
```

New env var: `REDDWARF_API_BASE=https://reddwarf.yourdomain.com`

Protected by existing `REDDWARF_OPERATOR_TOKEN`. Machine must be on and tunnel running.

---

### Option 2 — GitHub as the Remote Intake Path (lowest friction)
Keep GitHub issue polling as the **remote path**, direct CLI as the **local path**. Both feed the same pipeline. Structured issue template (section 4.1) makes the remote path nearly as efficient as the direct injection path.

```
At home  → pnpm task:create → localhost:8080/tasks/inject
Away     → GitHub issue with ai-task template
```

---

### Option 3 — Remote Queue
Hosted queue (e.g. Supabase table or small Railway endpoint) that the home machine polls. Decouples task submission from machine availability — queue from anywhere, process when home.

---

## 7. Discord Bot

Full loop from Discord — raise tasks, approve plans, check status — from phone or desktop, anywhere.

**New package:** `packages/discord-bot/`

### Commands
| Command | Action |
|---|---|
| `/task submit` | Opens a modal form with 4 fields |
| `/task approve <id>` | Resolves approval in Postgres |
| `/task list` | Lists pending and active tasks |
| `/task status <id>` | Shows current phase and lifecycle status |

### Modal fields (from `/task submit`)
- Summary (short text)
- Acceptance Criteria (paragraph, one per line)
- Risk Class (short text, default: low)
- Affected Paths (paragraph, optional)

### Environment variables
```bash
DISCORD_BOT_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_client_id
DISCORD_GUILD_ID=your_server_id
DEFAULT_SOURCE_REPO=owner/repo
```

### Full remote loop
```
/task submit (phone)
  → bot POSTs to operator API via Cloudflare Tunnel
  → pipeline runs
  → Discord notification: "Plan ready for approval"
  → /task approve <id> (phone)
  → pipeline continues
  → Discord notification: "PR opened"
```

### Hosting the bot
Tiny stateless relay — free tier on Railway or Render is sufficient. The bot is hosted remotely; your API stays local; the tunnel bridges them.

---

## 8. Cloud Hosting Costs

### What needs hosting
| Component | Weight |
|---|---|
| OpenClaw container | Heavy — RAM-hungry, dictates server size |
| Postgres | Moderate — evidence/manifest data stays small |
| RedDwarf operator API | Light — small Node.js process |
| Discord bot | Trivial |

---

### Tier 1 — Hetzner CX32 (~£6/month)
**4 vCPU, 8GB RAM, 80GB NVMe SSD**

Everything on one machine. Includes 20TB traffic, DDoS protection, and firewall — no extras. Has an official OpenClaw deployment guide.

Important nuance for RedDwarf: moving to a Linux VPS removes the local Windows/WSL friction, but it does not automatically unblock Docker sandboxing for the Developer phase if we simply copy the current infra/docker/docker-compose.yml topology onto the server. Feature 105 only unblocks cleanly if OpenClaw runs directly on the Linux host with access to host Docker, or if the VPS deployment is rebuilt around OpenClaw's upstream sandbox-enabled Docker flow rather than the current custom container wrapper.

| Component | RAM used |
|---|---|
| OpenClaw | ~3–4GB |
| Postgres | ~256MB |
| Operator API | ~128MB |
| Discord bot | ~64MB |
| **Total** | **~4.5GB — fits comfortably** |

---

### Tier 2 — Hetzner CX32 + Managed Postgres (~£6–18/month)
Same VPS for OpenClaw and the API. Postgres moves to a managed instance (Supabase free tier up to 500MB, or Hetzner managed DB). Protects evidence plane — task manifests, approval decisions, pipeline history — with automated backups and point-in-time recovery.

---

### Tier 3 — DigitalOcean (~£40/month)
More polished managed experience with stronger default security hardening (1-Click Marketplace image includes authenticated gateway tokens, non-root execution, Docker sandboxing, fail2ban, firewall-level rate limiting). Worth it for a team deployment.

---

### The real cost driver: Anthropic API tokens

| Tasks/month | Approx token cost (optimised) |
|---|---|
| 10 tasks | ~£3–5 |
| 50 tasks | ~£15–25 |
| 100 tasks | ~£30–50 |

**Realistic all-in for personal use (~20–30 tasks/month):**
```
Hetzner CX32        £6
Anthropic API       £8–15
Domain (optional)   £1
─────────────────────────
Total               ~£15–22/month
```

---

### Recommended deployment tool: Coolify
Self-hosted Heroku-like UI that runs on the VPS. Handles SSL, container restarts, environment variables, and deployment management without SSHing in every time. Migration from local Docker Compose is straightforward — copy `docker-compose.yml`, populate `.env`, point Discord bot at the new public IP.

That migration path is fine for the current gateway-plus-outer-container isolation model, but it should not be treated as sufficient to deliver feature 105 by itself. If Developer-phase Docker sandboxing is a hard requirement, the VPS deployment plan needs an explicit OpenClaw sandbox-backend design instead of a straight compose lift-and-shift.

---

## 9. Commercial Viability

### What's genuinely compelling
- **Autonomous pipeline, not a coding assistant** — categorically different from Copilot/Cursor, much less crowded market
- **Planning-first, human-gated** — the approval checkpoint is a trust story you can tell to cautious engineering teams
- **Self-hosted, policy-driven, auditable** — unlike Devin and SWE-agent (SaaS, your code on their servers), RedDwarf running on a customer's own VPS is a completely different conversation for security-conscious teams

### Natural buyer
Small-to-medium engineering teams with a backlog of well-defined, lower-risk tasks — dependency updates, test coverage gaps, small feature additions, docs — that senior developers never get to.

### Honest challenges
- **OpenClaw dependency** — licensing terms for commercial use need to be understood; need a view on what happens if they change pricing or deprecate features
- **Setup complexity** — currently requires Docker, Postgres, multiple env vars, GitHub token, Anthropic key; needs to be dramatically simpler for a commercial audience
- **Trust takes time** — first AI-generated PR in a production repo is a moment of genuine anxiety; go-to-market needs to account for a slow trust-building ramp
- **Token cost model** — if hosted SaaS, you absorb and mark up Anthropic API costs; if self-hosted, customers bring their own keys; pricing must be modelled carefully

### Most realistic path to market
**Start with a polished self-hosted product with a one-command install** (Coolify/Plausible model). Flat licence fee or small monthly fee for updates and support. Customers bring their own API keys. Sidesteps the token cost problem, compliance problem, and most of the trust problem simultaneously.

Hosted SaaS with usage-based billing is a later chapter, after real users have validated what they actually need.

### The right first use case
**Dependency updates** — scoped narrowly enough that teams trust it, common enough to save meaningful time every week. Lower risk than arbitrary issue handling. Every team has a backlog of them. A pipeline that opens a PR with CI green and ready to merge is immediately valuable, with no trust-building required.

Then expand task scope from there as confidence builds.

---

## 10. Feature Board Items (Suggested)

In recommended delivery order:

### Epic: OpenClaw Tool Expansion
1. Discord notification adapter (`packages/integrations`)
2. Web search for Architect Agent (`agents/reddwarf-architect/TOOLS.md` + materialisation update)
3. CI adapter with polling loop (`packages/integrations` + `control-plane`)
4. Architecture Reviewer Agent (`agents/reddwarf-arch-reviewer/` + new Zod schema + phase slot)

### Epic: Token Efficiency
1. Deterministic eligibility gate (remove any LLM calls from eligibility)
2. Role-scoped context materialisation (per-agent `TOOLS.md` + context manifest)
3. Spec distillation step (`packages/control-plane/src/planning/spec-distiller.ts`)
4. SOUL.md compression (audit and rewrite all agent identity files)
5. Project memory Postgres cache (`packages/evidence/src/memory/project-memory-cache.ts`)

### Epic: Task Intake
1. Structured GitHub issue template (`.github/ISSUE_TEMPLATE/ai-task.yml`)
2. Direct injection endpoint (`POST /tasks/inject` in operator API)
3. Local CLI scripts (`scripts/create-task.mts`, `list-tasks.mts`, `approve-task.mts`)
4. Task grouping (`packages/control-plane/src/dispatcher/task-grouping.ts`)
5. Pre-screener (`packages/control-plane/src/intake/pre-screener.ts`)

### Epic: Remote Access & Discord
1. Cloudflare Tunnel setup (`infra/` + docs)
2. Discord bot package (`packages/discord-bot/`)
3. Discord approval flow (wires `/task approve` to existing `/approvals/:id/resolve`)

### Epic: Cloud Deployment
1. `docker-compose.prod.yml` for VPS deployment
2. Coolify setup guide (`docs/deployment/VPS.md`)
3. Managed Postgres migration guide


