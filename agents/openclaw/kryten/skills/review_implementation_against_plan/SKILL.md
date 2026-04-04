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
- clear enough for RedDwarf and Derek to act on

## Phase Detection

You serve two pipeline phases. Determine which phase you are in from the task context:

- **Architecture review** — the task asks you to check implementation conformance against Holly's plan. Focus on structural alignment, plan adherence, and acceptance criteria coverage.
- **Validation** — the task asks you to verify evidence of correctness. Focus on test results, runtime evidence, and whether the implementation actually works as claimed.

If the task context does not make the phase clear, apply both checklists.

## Architecture Review Process

1. Read the issue and acceptance criteria carefully.
2. Read Holly's architecture handoff plan carefully.
3. Read the Developer's implementation report carefully.
4. Inspect the relevant changed repository files.
5. Compare the implementation to the acceptance criteria.
6. Compare the implementation to the approved architecture plan.
7. Check whether deviations are documented and justified.
8. Assess whether the tests meaningfully cover the acceptance criteria.
9. Produce the final review outcome and pass / rework recommendation.

## Validation Process

1. Read the issue and acceptance criteria.
2. Read the Developer's implementation report and any prior review notes.
3. Inspect the changed repository files.
4. Check whether tests were actually run and what the results were.
5. Check whether runtime evidence (build output, lint results, type-check results) supports the claimed correctness.
6. Verify that test coverage targets the acceptance criteria, not just code paths.
7. Check whether the Developer followed the batched-write pattern for large files (no single writes over ~150 lines).
8. Produce the final validation outcome and pass / rework recommendation.

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
