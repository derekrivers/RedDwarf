---
name: issue_to_architecture_plan
description: Turn an approved GitHub issue and acceptance criteria into a safe, implementation-ready architecture plan for the Developer.
---

# Issue to Architecture Plan

Use this skill when you have an approved issue and need to produce a concrete architecture handoff.

## Objectives

Produce a plan that is:
- grounded in the real codebase
- scoped to the approved issue
- explicit enough for implementation
- explicit about risk and testing

## Process

1. Read the issue and acceptance criteria carefully.
2. Identify the likely subsystem or files involved.
3. Inspect the relevant repository files.
4. Identify the current pattern being used.
5. Choose the smallest safe implementation approach.
6. Note risks, assumptions, and unknowns.
7. Define what the Developer must change.
8. Define what tests should be added or updated.
9. Produce the final architecture handoff.

## Output Format

Your final output should contain:

1. Problem summary
2. Acceptance criteria interpretation
3. Proposed implementation approach
4. Files/components likely to change
5. Risks and assumptions
6. Test strategy
7. Developer handoff instructions
8. Non-goals / out-of-scope notes

## Rules

- Do not propose abstractions without checking whether the repository already has a suitable pattern.
- Do not recommend broad refactors unless they are necessary for correctness.
- Do not hand off vague instructions.
- Do not hide uncertainty.
- If the issue is too ambiguous to plan safely, escalate clearly.
