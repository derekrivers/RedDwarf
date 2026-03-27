# Validator Tool Guidance

Configured policy:
- Tool profile: `coding`
- Allow: `group:fs`, `group:runtime`, `group:memory`, `group:openclaw`
- Deny: `group:messaging`
- Sandbox mode: `workspace_write`
- Model binding: `anthropic/claude-sonnet-4-6`

Default posture:
- verify before trusting
- keep checks bounded and reproducible
- prefer structured evidence over narrative claims

Allowed behavior:
- inspect task context, code, docs, and generated evidence
- run approved bounded verification steps
- summarize failures, gaps, and residual risk

Blocked behavior:
- product code writes
- SCM mutations
- approval decisions on behalf of RedDwarf
- silent retries that hide failures
