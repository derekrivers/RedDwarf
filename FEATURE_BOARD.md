# RedDwarf Feature Board

The board is ordered by implementation priority.

This active board only lists pending work. Completed items are archived in [features_archive/COMPLETED_FEATURES.md](/home/derek/code/RedDwarf/features_archive/COMPLETED_FEATURES.md).

---

## M23 — Dashboard & Operator UX

### Phase 1 — Discord Issue Submission

| # | Feature | Status | Depends On | Notes |
| - | ------- | ------ | ---------- | ----- |
| 174 | **Discord `/rdsubmit` command with modal form for issue creation** — Add a `/rdsubmit` slash command to the Discord operator plugin. The command first presents a `StringSelectMenu` populated from `GET /repos` for repo selection. On repo selection, open a Discord Modal form with fields: title (short text, required), summary (paragraph, required), acceptance criteria (paragraph, required, one per line). On modal submit, call the existing `POST /issues/submit` operator API endpoint with the collected fields and sensible defaults for capabilities and risk class. Reply with a confirmation embed containing the created issue number, link, and repo. Handle validation errors (missing fields, API failures) with user-friendly error messages. Requires `REDDWARF_OPENCLAW_DISCORD_ENABLED=true`. | pending | — | Uses existing `POST /issues/submit` and `GET /repos` operator API endpoints; no new backend work required. Discord Modals support up to 5 `TextInput` components but no native dropdowns, so the repo selector uses a `StringSelectMenu` message before opening the modal. |

### Phase 2 — Outbound Discord Notifications

| # | Feature | Status | Depends On | Notes |
| - | ------- | ------ | ---------- | ----- |
| 177 | **Discord outbound notifications for approvals and PR-created events** — Add a lightweight Discord webhook notifier in the control plane that posts embed messages for two events: (a) a new approval request is created (plan, phase, project, or tool approval), with a deep link to the dashboard approval detail page; (b) a developer-phase session opens a GitHub PR, with a link to the PR. Configuration: `REDDWARF_DISCORD_NOTIFY_ENABLED` (boolean, default false), `REDDWARF_DISCORD_NOTIFY_WEBHOOK_URL` (required when enabled), and per-event toggles `REDDWARF_DISCORD_NOTIFY_APPROVALS` and `REDDWARF_DISCORD_NOTIFY_PR_CREATED` (default true when notifier enabled). Must: (1) fire on the same control-plane path that creates the approval / records the PR URL, but best-effort — Discord failures must not fail the pipeline; (2) include repo, task id, and a deep link in the embed; (3) reuse the existing `REDDWARF_OPENCLAW_DISCORD_ACCENT_COLOR` for embed colour when set; (4) emit structured run events on send success and failure. Uses Discord's native incoming webhook URL — no bot token or extra OpenClaw scopes required, so it coexists with the existing OpenClaw Discord bridge. | complete | — | Notifier module at `packages/control-plane/src/notifications/discord-notifier.ts`, wired into planning, architecture-review, failure automation, orphan sweep, project planning, SCM PR creation, and tool-approval creation. 15 unit tests cover config parsing, embed builders, delivery gating, and best-effort error handling. |

### Non-functional requirements (apply to all M23 features)

- All new Discord commands must respect the existing `REDDWARF_OPENCLAW_DISCORD_ENABLED` gate and approver ID allowlist.
- No new required env vars added without a corresponding entry in `.env.example` with a comment.
- TypeScript strict mode must pass across all modified packages after each feature merge.
- `verify:all` must pass after every feature.
