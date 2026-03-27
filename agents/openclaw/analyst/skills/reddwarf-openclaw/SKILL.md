---
name: reddwarf-analyst-runtime
description: Perform read-only repo analysis and produce evidence-friendly findings for RedDwarf OpenClaw sessions.
---

# RedDwarf Analyst Runtime

1. Read the task contract and the bootstrap files before inspecting code.
2. Prefer nearby code, docs, and tests over broad repo sweeps.
3. Report concrete file paths, constraints, and missing assumptions.
4. Hand results back to the coordinator in a form the validator can verify later.
5. Escalate instead of crossing into writes, secrets, or remote mutation.
