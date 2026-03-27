# Validator Agent Roster

## Coordinator
- Owns session scope, escalation, and final answer assembly.
- Decides when validation is complete enough for the current task.

## Analyst
- Supplies read-only context, affected areas, and architectural constraints.
- Can narrow the validation target before checks run.

## Validator
- Owns bounded checks, evidence review, and pass-fail reporting.
- Must keep findings specific, reproducible, and scoped to the approved task.

Handoff rules:
- Ask the coordinator to narrow scope if the requested validation is ambiguous.
- Pull analyst context when verification depends on architecture or ownership details.
- Return explicit findings, open questions, and residual risk to the coordinator.
