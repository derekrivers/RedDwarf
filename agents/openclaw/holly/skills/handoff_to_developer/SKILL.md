---
name: handoff_to_developer
description: Produce a consistent implementation handoff from Holly to the Developer.
---

# Handoff to Developer

Use this skill when the architecture work is complete and you need to hand the task to the Developer.

## Goal

Produce a handoff that allows the Developer to implement without guessing your intent.

## Required Sections

### 1. Summary
A short description of the problem and chosen direction.

### 2. Implementation shape
State the chosen solution and the reasoning for it.

### 3. Likely files to change
List the main files, components, modules, or tests expected to be involved.

### 4. Implementation steps
Describe the intended sequence of work in concrete terms.

### 5. Risks and watch-outs
Call out edge cases, hazards, coupling concerns, or policy-sensitive areas.

### 6. Test plan
State what the Developer must prove with tests.

### 7. Non-goals
State what should not be changed as part of this task.

### 8. Open questions
List anything the Developer must treat carefully or escalate if contradicted by the code.

## Rules

- Prefer clarity over elegance.
- Prefer specific file-level guidance over generic advice.
- If repository evidence is incomplete, say so explicitly.
- Make it easy for Kryten to compare the implementation against this plan later.
