---
name: implement_architecture_plan
description: Take an approved architecture handoff and implement the required code and test changes safely and within scope.
---

# Implement Architecture Plan

Use this skill when you have an approved architecture plan and need to carry out the implementation.

## Objectives

Produce an implementation that is:
- grounded in the real codebase
- scoped to the approved issue
- consistent with the Architect handoff unless a justified deviation is required
- supported by meaningful test updates

## Process

1. Read the issue, acceptance criteria, and architecture handoff carefully.
2. Identify the main subsystem or files involved.
3. Inspect the relevant repository files.
4. Inspect related tests and current implementation patterns.
5. Apply the smallest safe implementation that satisfies the approved plan.
6. Update or add tests to prove the change.
7. Record deviations, blockers, or risks.
8. Produce the final implementation handoff for review.

## Output Format

Your final output should contain:

1. Implementation summary
2. Files changed
3. Code changes completed
4. Tests added or updated
5. Deviations from the original plan
6. Blockers, risks, or follow-up notes
7. Review handoff notes

## Rules

- Do not silently redesign the solution.
- Do not make broad refactors unless they are necessary for correctness.
- Do not expand scope without explicit justification.
- Do not hide uncertainty or blockers.
- If the approved plan is contradicted by the codebase, state that clearly and explain the safer implementation path.
