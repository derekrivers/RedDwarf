You are working inside the RedDwarf monorepo — a TypeScript pnpm workspace project.
The repo has no frontend package yet. Your task is to create a new dashboard SPA
as a workspace package at packages/dashboard, powered by Tabler UI, that connects
to the existing operator API running on http://127.0.0.1:8080.

---

## REFERENCE DOCUMENTATION

Before writing any code, fetch and read the following documentation pages.
Use these as the authoritative source for all Tabler class names, component
markup, and JavaScript initialisation patterns. Do not rely on memory.

Core concepts:
  https://docs.tabler.io/ui/getting-started/installation/
  https://docs.tabler.io/ui/base/colors/
  https://docs.tabler.io/ui/base/typography/

Layout:
  https://docs.tabler.io/ui/layout/navbars/
  https://docs.tabler.io/ui/layout/page-headers/
  https://docs.tabler.io/ui/layout/page-layouts/

Components used in this project:
  https://docs.tabler.io/ui/components/cards/
  https://docs.tabler.io/ui/components/badges/
  https://docs.tabler.io/ui/components/alerts/
  https://docs.tabler.io/ui/components/modals/
  https://docs.tabler.io/ui/components/toasts/
  https://docs.tabler.io/ui/components/tables/
  https://docs.tabler.io/ui/components/timelines/
  https://docs.tabler.io/ui/components/spinners/
  https://docs.tabler.io/ui/components/empty/
  https://docs.tabler.io/ui/components/statuses/
  https://docs.tabler.io/ui/components/steps/
  https://docs.tabler.io/ui/components/tooltips/

Forms:
  https://docs.tabler.io/ui/forms/form-elements/
  https://docs.tabler.io/ui/forms/form-validation/

Icons:
  https://docs.tabler.io/icons/libraries/react/

---

## CODEBASE FAMILIARISATION

Before writing any code, read the following files to understand the domain:
  - README.md
  - packages/contracts/src (shared types and schemas)
  - packages/evidence/src (evidence and pipeline run shapes)
  - CLAUDE.md (any repo-level constraints)
  - .env.example (environment variable conventions)

---

## PREREQUISITE — CORS

Before scaffolding the dashboard, add CORS support to the operator API.

In scripts/start-operator-api.mjs (or wherever the Express/HTTP server is
initialised), install and configure the cors package:

  pnpm add cors
  pnpm add -D @types/cors

Apply it as the first middleware, before all routes:

  import cors from 'cors';

  app.use(cors({
    origin: process.env.REDDWARF_DASHBOARD_ORIGIN ?? 'http://localhost:5173',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  }));

Add REDDWARF_DASHBOARD_ORIGIN to .env.example with a comment:
  # Origin of the dashboard dev server (default: http://localhost:5173)
  # REDDWARF_DASHBOARD_ORIGIN=http://localhost:5173

---

## SCAFFOLD THE PACKAGE

Create packages/dashboard as a new pnpm workspace package:

- Framework: React 18 + TypeScript (strict mode)
- Bundler: Vite
- UI library: @tabler/core (CSS + JS) + @tabler/icons-react
- HTTP client: native fetch with a typed API client wrapper
- State: TanStack Query (react-query) for server state
- Routing: React Router v6
- Auth: The dashboard is accessed using REDDWARF_OPERATOR_TOKEN. Store the
  token in sessionStorage. On first load, if no token is present, show a
  login screen with a single password-type input labelled "Operator Token".
  On submit, store the token and proceed. There are no user accounts —
  "decidedBy" on all approval decisions is always the hardcoded string
  "operator". Do not expose a decidedBy field in the UI.
- Package name: @reddwarf/dashboard
- Register in pnpm-workspace.yaml

Vite dev server should proxy /api/* → http://127.0.0.1:8080 so the
Authorization header is forwarded and CORS is not an issue in development.

---

## TYPED API CLIENT

Create src/api/client.ts — a typed wrapper around the operator API.

All requests automatically attach Authorization: Bearer <token>.
401 → clear token and redirect to login.
Non-2xx → throw typed ApiError with status + message.

The /approvals/:id endpoint does NOT include evidence. Evidence must be
fetched separately via GET /evidence?runId=<id>. The approval detail page
must make both calls in parallel using Promise.all and merge the results
before rendering.

Exported typed functions:
  getHealth()
  getPipelineRuns(filters?)
  getBlockedApprovals()
  getApproval(id)                        // approval data only
  getEvidenceForRun(runId: string)       // separate call, fetches by runId
  resolveApproval(id, decision, decisionSummary)
    // decidedBy is always "operator" — hardcoded in this function,
    // never accepted as a parameter

---

## TABLER LAYOUT SHELL

Standard Tabler admin shell:
  - Left sidebar navigation (collapsible on mobile)
  - Top navbar: app name "RedDwarf Control", stack health badge, logout button
  - Dark/light mode toggle
  - Pending approval count badge on the Approvals nav item — updates on
    every poll cycle so outstanding work is always visible at a glance

---

## ===== PRIORITY 1: APPROVAL WORKFLOW =====

This is the most critical feature. Build it first and get it right before
moving on to anything else.

### Route: /approvals

Full-page table of all approval requests.

Columns: Request ID, Task Source, Risk Level, Phase, Created At, Status, Actions

Status badge colouring:
  pending  → orange
  approved → green
  rejected → red

For pending rows only, show a "Review" button that navigates to /approvals/:id.

Auto-refresh every 10 seconds (refetchInterval). When a new pending item
appears, show a Tabler toast: "New approval request received."

### Route: /approvals/:id

This is the primary operator action surface. Build it to be clear, safe,
and hard to misuse.

On mount, fire both API calls in parallel:
  - getApproval(id)
  - getEvidenceForRun(id)

Show a single centred Tabler spinner until both resolve. If either call
fails, show a full-page Tabler alert with a Retry button.

Layout once data is loaded:

Left column (60%):
  - Section: "Planning Specification"
    Full planning spec in a styled, scrollable <pre> block.
    Syntax highlight JSON if possible (use highlight.js or prism-react-renderer).
  - Section: "Task Details"
    Key/value list: task source, phase, created at, policy snapshot ID.
  - Section: "Evidence Trail"
    Ordered timeline (Tabler timeline component) of all evidence events
    returned by getEvidenceForRun. Each event shows: phase, type,
    recorded at, and an expandable raw JSON block. If no evidence is
    returned, show Tabler empty state: "No evidence recorded yet."

Right column (40%) — sticky on scroll:

  APPROVE card (green Tabler card):
    - Optional "Decision note" textarea (placeholder: "Add a note…")
    - Large green "Approve Run" button
    - On click → Tabler confirmation modal:
        "Are you sure you want to approve this run?
         This will allow the developer phase to proceed in OpenClaw."
    - On confirm → POST resolveApproval(id, "approve", noteValue)
        decidedBy is always "operator" — set inside the API client,
        never in the UI layer
    - On success → success toast, navigate to /approvals
    - On error → inline Tabler alert (do not navigate away)

  REJECT card (red Tabler card, below approve card):
    - Required "Rejection reason" textarea (min 10 characters)
    - Validate client-side — keep the submit button disabled until valid
    - Large red "Reject Run" button
    - On click → same confirmation modal pattern, rejection-flavoured
    - On confirm → POST resolveApproval(id, "reject", rejectionReason)
    - On success → success toast, navigate to /approvals
    - On error → inline Tabler alert

  Safety rules for both cards:
    - Both cards must be disabled with a "Processing…" spinner while any
      request is in-flight
    - On mount, if the approval status is not "pending", render both cards
      in a permanently disabled read-only state with a Tabler info alert:
        "This request has already been resolved."
      This prevents double-submission if the operator has two tabs open.

  Keyboard shortcuts:
    - A → focus the Approve note textarea
    - R → focus the Reject reason textarea
    - Escape → navigate back to /approvals

---

## PRIORITY 2: DASHBOARD HOME (/dashboard)

Stat cards row:
  - Total pipeline runs
  - Active runs (status = running)
  - Pending approvals (count, links to /approvals)
  - Failed runs (last 24h)

Two columns below stats:
  - Left: Recent pipeline runs (last 10), status badge coloured
  - Right: Pending approvals list with "Review" buttons linking to /approvals/:id

---

## PRIORITY 3: PIPELINE RUNS (/pipeline)

Full-page table:
  Columns: Run ID, Task Source, Status, Phase, Started At, Duration, Actions
  - Filter by status (dropdown)
  - Sortable by started_at
  - Pagination (page size 25)
  - Expandable row detail panel
  - Auto-refresh every 15 seconds

---

## PRIORITY 4: EVIDENCE BROWSER (/evidence)

Table: Run ID, Phase, Type, Recorded At, Size
  - Search/filter by run ID (client-side)
  - Expandable row → raw JSON in <pre>
  - Export row as .json file

---

## PRIORITY 5: AGENT STATUS (/agents)

Card grid (3 columns, responsive):
  - One card per agent definition in /agents/*.json
  - Shows: name, role, permission scopes as Tabler badges, last seen timestamp
    derived from evidence records
  - Healthy / unconfigured status indicator per card

---

## DEFERRED — DO NOT IMPLEMENT NOW: Container Logs Panel

A future /logs page will stream live OpenClaw container logs via an SSE or
WebSocket proxy in the operator API. Do NOT implement this now.

Reserve the slot: add a disabled "Logs" nav item in the sidebar with a
"Coming soon" Tabler tooltip. Leave a commented placeholder route in the
router so the slot is visible without breaking anything.

---

## QUALITY STANDARDS

- Functional React components, explicit TypeScript props, no `any`
- Derive types from packages/contracts where possible; define local interfaces
  for anything not covered
- No inline styles — Tabler utility classes only
- Every API call: loading state (Tabler spinner) + error state (Tabler alert)
- Empty states: Tabler empty state component with icon and helpful message
- Tabler JS interactive components (dropdowns, modals) initialised in
  useEffect with proper cleanup
- The app must be fully usable with no token set — login screen shown first

---

## BUILD SCRIPTS

packages/dashboard/package.json:
  "dev": "vite",
  "build": "tsc && vite build",
  "previe