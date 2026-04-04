# Next Session Prompt

Paste the block below as the opening message of the next session.

---

## Prompt

Work through the following tasks in order. Complete, verify, and commit each one before moving to the next. All tasks are from `FEATURE_BOARD.md`.

---

### Task 1 — Feature 137: Transcript-aware developer completion detection (M15)

**What:** The developer phase (Lister / `reddwarf-developer`) can currently terminate without producing `developer-handoff.md` — for example when the session hits the output token limit (`stopReason = length`), when the transcript stalls without progress, or when the agent enters a dead-end tool/error loop. RedDwarf does not currently detect these cases as failures. It should fail fast instead of treating a silent incomplete session as a success.

**Also in scope:** Tighten the developer prompt to discourage broad repo enumeration (e.g. walking the entire workspace with `list_files` before narrowing to relevant files). This burns output budget before any implementation starts and is a recurring cause of `length` terminations.

**Where to look:**
- `packages/control-plane/src/pipeline/development.ts` — developer phase dispatch and completion handling
- `packages/control-plane/src/pipeline/prompts.ts` — developer prompt construction
- `packages/contracts/src` — shared types if a new completion/failure shape is needed

Follow existing patterns for phase failure results (see how `buildPhaseFailureResult` is used elsewhere in `dispatch.ts`). Add or update tests. Run `pnpm test` and `pnpm typecheck` before committing.

---

### Task 2 — Feature 128: CORS support on the Operator API (M19 gate)

**What:** Add CORS support to the Operator API HTTP server so the dashboard SPA can call it from a browser. This is the gating dependency for the entire M19 dashboard milestone (features 129–136 all depend on it).

**Exactly what to do** (from `docs/Dashboard.md` §PREREQUISITE — CORS):

1. `pnpm add cors && pnpm add -D @types/cors` in the operator API package
2. Apply as the first middleware before all routes:
   ```typescript
   import cors from 'cors';
   app.use(cors({
     origin: process.env.REDDWARF_DASHBOARD_ORIGIN ?? 'http://localhost:5173',
     methods: ['GET', 'POST', 'OPTIONS'],
     allowedHeaders: ['Authorization', 'Content-Type'],
   }));
   ```
3. Add to `.env.example`:
   ```
   # Origin of the dashboard dev server (default: http://localhost:5173)
   # REDDWARF_DASHBOARD_ORIGIN=http://localhost:5173
   ```

Find the Express server initialisation file, read it first, make the change, run the test suite, commit.

---

### Task 3 — Feature 129: Scaffold `packages/dashboard` (M19)

**What:** Create the dashboard SPA workspace package. Read `docs/Dashboard.md` in full before writing any code — it is the authoritative spec for this milestone. Also fetch the Tabler docs pages listed at the top of that file before writing any markup; do not rely on memory for Tabler class names.

**Stack:** React 18 + TypeScript strict + Vite + `@tabler/core` + `@tabler/icons-react` + TanStack Query + React Router v6

**Deliverables for this task:**
- `packages/dashboard` registered in `pnpm-workspace.yaml` as `@reddwarf/dashboard`
- Tabler admin shell: collapsible left sidebar, top navbar with "RedDwarf Control" + stack health badge + logout, dark/light mode toggle, pending approvals count badge on the Approvals nav item
- Login screen: single password-type "Operator Token" input → stores to `sessionStorage`
- React Router v6 with placeholder routes for all five pages (Dashboard, Approvals, Pipeline, Evidence, Agents)
- Disabled "Logs" nav item with "Coming soon" Tabler tooltip

Full spec: `docs/Dashboard.md` §SCAFFOLD THE PACKAGE and §TABLER LAYOUT SHELL.

---

### Task 4 — Feature 130: Typed API client (M19)

**What:** `packages/dashboard/src/api/client.ts` — a typed wrapper around the Operator API.

**Deliverables:**
- `getHealth`, `getPipelineRuns(filters?)`, `getBlockedApprovals`, `getApproval(id)`, `getEvidenceForRun(runId)`, `resolveApproval(id, decision, decisionSummary)`
- Auto-attach `Authorization: Bearer <token>` from `sessionStorage`
- 401 clears token and redirects to login
- Non-2xx throws typed `ApiError` with status + message
- `decidedBy` hardcoded to `"operator"` inside `resolveApproval` — never accepted as a parameter, never exposed in the UI

Full spec: `docs/Dashboard.md` §TYPED API CLIENT.

---

### Task 5 — Feature 132: Approval detail and resolve page — `/approvals/:id` (M19, P1 critical)

**What:** The highest-value operator surface. Build this before the list page (131) and home page (133).

**Deliverables:**
- On mount: fire `getApproval(id)` and `getEvidenceForRun(id)` in parallel; single centred spinner until both resolve
- Two-column layout (60/40): left — planning spec in scrollable `<pre>` with syntax-highlighted JSON, task details, evidence timeline with expandable raw JSON per event; right sticky — Approve card (optional note, confirmation modal, success toast) and Reject card (required reason ≥10 chars, disabled until valid, same pattern)
- Both cards permanently disabled with info alert if status is not pending (prevents double-submission)
- Keyboard shortcuts: A → focus approve textarea, R → focus reject textarea, Escape → back

Full spec: `docs/Dashboard.md` §PRIORITY 1 — Route: /approvals/:id.

---

### Task 6 — Feature 131: Approval list page — `/approvals` (M19)

**What:** Full-page table of approval requests.

**Deliverables:** columns Request ID, Task Source, Risk Level, Phase, Created At, Status, Actions; status badge colouring (pending orange, approved green, rejected red); "Review" button on pending rows → `/approvals/:id`; auto-refresh every 10 s; Tabler toast when a new pending item appears.

Full spec: `docs/Dashboard.md` §PRIORITY 1 — Route: /approvals.

---

### After Task 6

If all six tasks are complete and verified, check `FEATURE_BOARD.md` for the next pending M19 items (133 — Dashboard home, 134 — Pipeline runs page) and continue in the same order. The full spec for each is in `docs/Dashboard.md`.

---

### Cross-cutting rules (apply to all tasks)

- Read `CLAUDE.md` before starting — it governs autonomy, commit requirements, and stop conditions
- Read `docs/agent/Documentation.md` and `docs/agent/TROUBLESHOOTING.md` for environment notes and known pitfalls
- Read files before editing them
- Run `pnpm test` and `pnpm typecheck` before each commit
- Commit each task separately with a descriptive message
- Do not start the next task until the current one is committed and clean
