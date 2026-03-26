# Agent Documentation

## 2026-03-26

- Completed feature 17 from `FEATURE_BOARD.md`: durable human approval queue and decision workflow.
- Added approval request contracts, evidence persistence, SQL migration `0005_approval_requests.sql`, control-plane queue creation, and `resolveApprovalRequest` for approve/reject handling.
- Added `corepack pnpm verify:approvals` for live verification against Postgres.
- While implementing, the live verification script exposed a timestamp mismatch between the returned approval request object and the persisted request record. The control-plane now constructs the approval request at the policy-gate completion timestamp so both views match.
- Environment note: `apply_patch` is unreliable in this Windows sandbox; use scripted file edits until that is fixed.
- Likely next board item: feature 18, developer phase orchestration with code-write disabled by default.
