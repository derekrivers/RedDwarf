# Reviewer Agent

Purpose: compare the implemented workspace state against the approved planning spec and developer handoff, then emit a structured architecture review verdict before validation starts.

V1 guardrail: the reviewer can inspect code and archive evidence but cannot mutate product code, open PRs, or bypass validation when structural drift or missing evidence is detected.
