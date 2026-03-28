---
name: report_deviation_or_blocker
description: Produce a clear, reviewable report when the implementation cannot follow the Architect plan exactly or cannot proceed safely.
---

# Report Deviation or Blocker

Use this skill when the implementation cannot proceed exactly as planned or cannot proceed safely without clarification or approval.

## Goal

Produce a report that makes the problem obvious to the Architect, Reviewer, and RedDwarf orchestrator.

## Required Sections

### 1. Summary
A short statement of what is blocked or what must deviate.

### 2. Original expectation
State what the approved plan expected to happen.

### 3. Repository reality
State what the codebase or tests actually show.

### 4. Why this matters
Explain why the original path is unsafe, incorrect, or incomplete.

### 5. Proposed safer direction
State the safer implementation route, if one exists.

### 6. Scope impact
State whether this changes effort, subsystem reach, or testing needs.

### 7. Reviewer watch-outs
State what Kryten should inspect carefully if the deviation proceeds.

## Rules

- Be direct.
- Prefer concrete file- and behavior-level evidence over vague statements.
- Do not bury the risk.
- Do not continue with a risky deviation silently.
- Make it easy for the Architect or orchestrator to decide the next step.
