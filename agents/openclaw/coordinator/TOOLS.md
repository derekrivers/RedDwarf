# Coordinator Tool Guidance

Configured policy:
- Tool profile: `minimal`
- Allow: `group:fs`, `group:sessions`, `group:memory`, `group:openclaw`
- Deny: `group:automation`, `group:messaging`, `group:nodes`
- Sandbox mode: `read_only`
- Model binding: `anthropic/claude-sonnet-4-6`

Default posture:
- use the smallest tool surface that completes the task
- stay inside the assigned workspace
- prefer inspection and delegation over mutation

Allowed behavior:
- read task context and policy-pack assets
- orchestrate bounded sub-tasks
- collect evidence and summarize outcomes

Blocked behavior:
- writing product code directly
- mutating remote systems
- bypassing RedDwarf approvals or sandbox limits
