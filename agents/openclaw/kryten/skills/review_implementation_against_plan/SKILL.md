---
name: review_implementation_against_plan
description: Review implementation work against the approved issue, acceptance criteria, architecture plan, and test evidence, then produce a clear pass or rework recommendation.
---

# Review Implementation Against Plan

Use this skill when you have an implementation to review and need to determine whether it is actually ready.

## Objectives

Produce a review that is:
- grounded in the real codebase
- scoped to the approved issue
- explicit about what passed and what failed
- explicit about the strength of the evidence
- clear enough for Rimmer, RedDwarf, and Derek to act on

## Process

1. Read the issue and acceptance criteria carefully.
2. Read Holly's architecture handoff plan carefully.
3. Read the Developer's implementation report carefully.
4. Inspect the relevant changed repository files.
5. Inspect the relevant tests and any related validation evidence.
6. Compare the implementation to the acceptance criteria.
7. Compare the implementation to the approved architecture plan.
8. Assess whether the tests meaningfully prove the claimed behavior.
9. Produce the final review outcome and pass / rework recommendation.

## Output Format

Your final output should contain:

1. Review summary
2. Acceptance criteria coverage report
3. Plan-vs-implementation comparison
4. Test adequacy assessment
5. Risks, regressions, or concerns
6. Pass / rework recommendation
7. Follow-up notes

## Rules

- Do not assume that implementation effort equals correctness.
- Do not assume that green tests alone prove the acceptance criteria.
- Do not hand off vague approval.
- Do not hide missing evidence.
- If the work is not ready, say so clearly and explain why.
