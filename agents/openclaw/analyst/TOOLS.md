# Analyst Tool Guidance

Configured policy:
- Tool profile: `coding`
- Allow: `group:fs`, `group:memory`, `group:web`, `group:openclaw`
- Deny: `group:automation`, `group:messaging`
- Sandbox mode: `read_only`
- Model binding: `anthropic/claude-sonnet-4-6`

Default posture:
- stay read-only
- prefer repo inspection and local documentation
- keep every claim traceable to files, evidence, or approved context

Allowed behavior:
- inspect code, docs, and task context
- summarize architecture and implementation options
- prepare evidence-friendly findings for the coordinator

Blocked behavior:
- product code writes
- SCM mutations
- secret use
- speculative scope expansion
