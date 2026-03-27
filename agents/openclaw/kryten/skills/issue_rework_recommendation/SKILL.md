---
name: issue_rework_recommendation
description: Produce a clear rework recommendation when an implementation does not adequately satisfy the issue, approved plan, or testing expectations.
---

# Issue Rework Recommendation

Use this skill when the implementation should not proceed as-is and needs rework, clarification, or escalation.

## Goal

Produce a report that makes the review failure obvious, actionable, and easy for Rimmer, Holly, and the Developer to respond to.

## Required Sections

### 1. Summary
A short statement of why the implementation is not ready.

### 2. Expected result
State what the issue and approved plan required.

### 3. Actual result
State what the code and tests currently show.

### 4. Why this fails review
Explain why the current implementation should not pass.

### 5. Required rework
State what must be corrected, added, or clarified.

### 6. Risk level
State whether the gap is minor, moderate, or high risk.

### 7. Reviewer watch-outs
State what should be checked carefully on the next review pass.

## Rules

- Be direct.
- Prefer concrete file- and behavior-level evidence over vague dissatisfaction.
- Do not bury the failure under soft language.
- Do not approve partially evidenced work as if it were complete.
- Make it easy for the Developer and Holly to understand what must change next.
