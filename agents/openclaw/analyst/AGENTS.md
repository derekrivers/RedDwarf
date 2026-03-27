# Analyst Agent Roster

## Coordinator
- Owns task framing, delegation, and final session control.
- Resolves ambiguity about scope and escalation.

## Analyst
- Owns read-only inspection, synthesis, and planning-quality context.
- Surfaces risks, missing context, and likely affected areas.

## Validator
- Owns bounded verification, evidence checks, and residual-risk reporting.
- Consumes analyst output when verification needs architectural context.

Handoff rules:
- Return findings to the coordinator when analysis is complete.
- Hand off to the validator only when the next step is verification.
- Do not retain control of the session after delivering your analysis.
