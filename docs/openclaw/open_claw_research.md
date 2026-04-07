# OpenClaw Reference for RedDwarf

## Purpose

This document captures the key OpenClaw concepts, constraints, and official reference points that matter most for building the next phase of RedDwarf. It is written as a working reference for implementation, architecture, and policy decisions. ([docs.openclaw.ai](https://docs.openclaw.ai/?utm_source=chatgpt.com))

---

## 1. What OpenClaw is

OpenClaw is a self-hosted gateway for AI agents. It runs on your own machine or server and connects models, tools, sessions, and chat channels through a single gateway process. It is agent-native rather than just chat-native, meaning it is designed around tool use, sessions, memory, and multi-agent routing. ([docs.openclaw.ai](https://docs.openclaw.ai/?utm_source=chatgpt.com))

For RedDwarf, the important takeaway is that OpenClaw is best treated as the **runtime substrate** for agent execution, not the full governance layer. RedDwarf should remain the place where intake, policy, risk, approvals, evidence, and orchestration decisions are made. That separation fits OpenClaw’s documented role very well. ([docs.openclaw.ai](https://docs.openclaw.ai/?utm_source=chatgpt.com))

---

## 2. Core runtime model

### Gateway

OpenClaw revolves around a single Gateway process. That Gateway handles model access, tool execution, session flow, channel connections, and automation features such as hooks and cron-style behaviors configured in `~/.openclaw/openclaw.json`. ([docs.openclaw.ai](https://docs.openclaw.ai/gateway/configuration?utm_source=chatgpt.com))

### Agent

An OpenClaw agent is a fully scoped unit. Each agent has its own workspace, state directory, auth profiles, and session store. In multi-agent mode, auth is per-agent, and sessions are stored under `~/.openclaw/agents/<agentId>/sessions`. ([docs.openclaw.ai](https://docs.openclaw.ai/concepts/multi-agent?utm_source=chatgpt.com))

### Agent loop

An OpenClaw run is an agentic loop: intake, context assembly, model inference, tool execution, streaming replies, and persistence. The docs describe this as the authoritative serialized path for a session. ([docs.openclaw.ai](https://docs.openclaw.ai/concepts/agent-loop?utm_source=chatgpt.com))

---

## 3. Workspace model

The workspace is the agent’s home. It is the default working directory for tools and the source of workspace context. OpenClaw treats it as the agent’s memory surface. This is separate from `~/.openclaw/`, which stores config, credentials, and sessions. ([docs.openclaw.ai](https://docs.openclaw.ai/concepts/agent-workspace?utm_source=chatgpt.com))

This is one of the most important implementation details for RedDwarf: the workspace is **not** a hard sandbox by itself. Relative paths resolve against the workspace, but absolute paths can still reach elsewhere on the host unless sandboxing is enabled. That means workspace scoping and true isolation are different things. ([docs.openclaw.ai](https://docs.openclaw.ai/concepts/agent-workspace?utm_source=chatgpt.com))

For RedDwarf, this means you should not assume “agent workspace” equals “safe containment.” If you need containment, you must explicitly configure sandboxing. ([docs.openclaw.ai](https://docs.openclaw.ai/concepts/agent-workspace?utm_source=chatgpt.com))

---

## 4. Bootstrap files and workspace context

OpenClaw can automatically create and inject workspace bootstrap files, including:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` ([docs.openclaw.ai](https://docs.openclaw.ai/gateway/configuration-reference?utm_source=chatgpt.com))

The docs expose config for this under `agents.defaults.skipBootstrap`, `agents.defaults.bootstrapMaxChars`, and `agents.defaults.bootstrapTotalMaxChars`. That means OpenClaw can either generate bootstrap structure for you, or you can disable that and ship your own files from RedDwarf. ([docs.openclaw.ai](https://docs.openclaw.ai/gateway/configuration-reference?utm_source=chatgpt.com))

For RedDwarf, this is a strong fit because your repo already wants to own policy, identity, instructions, and role definitions. A good pattern is to let RedDwarf provide the agent bootstrap files deliberately rather than relying on default-generated content. ([docs.openclaw.ai](https://docs.openclaw.ai/gateway/configuration-reference?utm_source=chatgpt.com))

---

## 5. Identity files

Each agent workspace can include an `IDENTITY.md` file at the workspace root. The CLI supports reading identity from this file via `set-identity --from-identity`. Avatar paths also resolve relative to the workspace root. ([docs.openclaw.ai](https://docs.openclaw.ai/cli/agents?utm_source=chatgpt.com))

For RedDwarf, this gives you a natural place to anchor persona, role framing, and presentation rules at the agent level without mixing those concerns into policy logic. ([docs.openclaw.ai](https://docs.openclaw.ai/cli/agents?utm_source=chatgpt.com))

---

## 6. Tools and tool policy

OpenClaw’s tool model is a major part of how RedDwarf should integrate with it. Tool access is controlled through:

- `tools.profile`
- `tools.allow`
- `tools.deny` ([docs.openclaw.ai](https://docs.openclaw.ai/tools?utm_source=chatgpt.com))

The docs state that deny always wins over allow. Tool profiles establish a base allowlist, and then allow/deny rules refine it. Available built-in profiles include:

- `full`
- `coding`
- `messaging`
- `minimal` ([docs.openclaw.ai](https://docs.openclaw.ai/tools?utm_source=chatgpt.com))

The docs also define tool groups such as:

- `group:runtime`
- `group:fs`
- `group:sessions`
- `group:memory`
- `group:web`
- `group:ui`
- `group:automation`
- `group:messaging`
- `group:nodes`
- `group:openclaw` ([docs.openclaw.ai](https://docs.openclaw.ai/tools?utm_source=chatgpt.com))

For RedDwarf, this matters because the safe handoff model should be: RedDwarf decides the allowed phase and builds a constrained execution envelope, and OpenClaw enforces that envelope through tool profile plus allow/deny rules. ([docs.openclaw.ai](https://docs.openclaw.ai/tools?utm_source=chatgpt.com))

---

## 7. Sandboxing

The docs are explicit that sandboxing is off by default. They also note that if sandboxing is off and `host=sandbox` is explicitly requested for `exec`, OpenClaw now fails closed rather than silently running on the gateway host. ([docs.openclaw.ai](https://docs.openclaw.ai/tools/exec?utm_source=chatgpt.com))

The multi-agent sandbox docs state that each agent in a multi-agent setup can override the global sandbox and tool policy. That means global defaults are not the whole story; per-agent config can narrow or widen behavior. ([docs.openclaw.ai](https://docs.openclaw.ai/tools/multi-agent-sandbox-tools?utm_source=chatgpt.com))

This is critical for RedDwarf. You should assume:

- workspace alone is not enough
- tool deny rules alone are not enough
- sandbox mode must be a deliberate part of each execution phase
- per-agent overrides must be controlled carefully ([docs.openclaw.ai](https://docs.openclaw.ai/concepts/agent-workspace?utm_source=chatgpt.com))

---

## 8. Multi-agent model

OpenClaw supports multiple agents with isolated workspaces, auth profiles, config, and session stores. Each agent is effectively its own scoped brain. ([docs.openclaw.ai](https://docs.openclaw.ai/concepts/multi-agent?utm_source=chatgpt.com))

That said, the docs frame multi-agent as a real isolation boundary in terms of workspace/state/auth separation, but not as a substitute for broader trust and security architecture. For RedDwarf, this supports a model where you define a small number of specialized agents with narrow roles. ([docs.openclaw.ai](https://docs.openclaw.ai/concepts/multi-agent?utm_source=chatgpt.com))

A practical RedDwarf mapping is:

- coordinator agent
- planner/analyst agent
- validator/evidence agent
- optional later SCM mutation agent

That aligns well with OpenClaw’s per-agent scoping model. ([docs.openclaw.ai](https://docs.openclaw.ai/concepts/multi-agent?utm_source=chatgpt.com))

---

## 9. Sub-agents

OpenClaw includes sub-agent support and exposes a `/subagents` command surface to inspect, spawn, log, steer, and kill sub-agent runs. The docs show commands like `/subagents spawn <agentId> <task>` with optional model and thinking parameters. ([docs.openclaw.ai](https://docs.openclaw.ai/tools/subagents?utm_source=chatgpt.com))

For RedDwarf, sub-agents should be treated as an optional execution tool rather than the default architecture. Use them for bounded delegated work, not as a replacement for clear orchestration. ([docs.openclaw.ai](https://docs.openclaw.ai/tools/subagents?utm_source=chatgpt.com))

---

## 10. Skills

OpenClaw uses AgentSkills-compatible skill folders. Each skill is a directory containing a `SKILL.md` with YAML frontmatter and instructions. Skills can come from bundled install content, `~/.openclaw/skills`, or `<workspace>/skills`. Workspace skills have the highest precedence, then managed/local skills, then bundled skills. ([docs.openclaw.ai](https://docs.openclaw.ai/tools/skills?utm_source=chatgpt.com))

In multi-agent setups, workspace skills are per-agent because each agent has its own workspace. Shared skills can live in `~/.openclaw/skills` or in extra directories configured under `skills.load.extraDirs`. ([docs.openclaw.ai](https://docs.openclaw.ai/tools/skills?utm_source=chatgpt.com))

For RedDwarf, this is useful if you want reusable agent operating procedures or common role guidance without overloading bootstrap files. Shared cross-agent guidance can live in managed skills, while role-specific instructions can live in per-agent workspace skills. ([docs.openclaw.ai](https://docs.openclaw.ai/tools/skills?utm_source=chatgpt.com))

---

## 11. Hooks

OpenClaw includes a hooks system for event-driven automation. The docs describe hooks as an extensible system that reacts to agent commands and events, with discovery from directories and management via CLI. Hook-pack installation and updates now go through `openclaw plugins`. ([docs.openclaw.ai](https://docs.openclaw.ai/automation/hooks?utm_source=chatgpt.com))

The CLI docs also note that hooks from `<workspace>/hooks/` require an enable step before the Gateway loads them, and a gateway restart afterward so hooks reload. ([docs.openclaw.ai](https://docs.openclaw.ai/cli/hooks?utm_source=chatgpt.com))

For RedDwarf, hooks matter if you want OpenClaw-side automation around lifecycle events, but they should complement your control-plane rather than replace it. RedDwarf should still own intake, policy, and approval decisions. ([docs.openclaw.ai](https://docs.openclaw.ai/automation/hooks?utm_source=chatgpt.com))

---

## 12. Webhook ingress

OpenClaw has a webhook surface with token-based authentication. The docs state that every request must include the hook token, preferably via `Authorization: Bearer <token>` or `x-openclaw-token`, and that query-string tokens are rejected. They also warn that holders of the hook token should be treated as full-trust callers for the hook ingress surface on that gateway. ([docs.openclaw.ai](https://docs.openclaw.ai/automation/webhook?utm_source=chatgpt.com))

For RedDwarf, this is relevant if you later move from polling to event-driven integration. A webhook handoff into OpenClaw is possible, but it must be treated as a trusted integration path, not a lightweight public entrypoint. ([docs.openclaw.ai](https://docs.openclaw.ai/automation/webhook?utm_source=chatgpt.com))

---

## 13. Model providers

OpenClaw supports many providers and expects models to be configured as `provider/model`. The provider docs list OpenAI, Anthropic, OpenAI Code/Codex, OpenCode, Gemini, Vertex, Z.AI, Vercel AI Gateway, and others. ([docs.openclaw.ai](https://docs.openclaw.ai/concepts/model-providers?utm_source=chatgpt.com))

For OpenAI specifically, the docs say OpenAI provides developer APIs for GPT models, and Codex supports ChatGPT sign-in for subscription access or API key sign-in for usage-based access. They also state that Codex cloud requires ChatGPT sign-in. ([docs.openclaw.ai](https://docs.openclaw.ai/providers/openai?utm_source=chatgpt.com))

The OAuth docs add that OpenClaw supports subscription auth via OAuth for providers that offer it, notably OpenAI Codex via ChatGPT OAuth, and that OpenAI Codex OAuth is explicitly supported for external tools like OpenClaw. The FAQ reinforces that OpenClaw fully supports OpenAI Code subscription OAuth. ([docs.openclaw.ai](https://docs.openclaw.ai/concepts/oauth?utm_source=chatgpt.com))

**For RedDwarf, the provider is now selected by config.** `REDDWARF_MODEL_PROVIDER` accepts `anthropic` or `openai`, and generated `openclaw.json` models use OpenClaw's `provider/model` format. The current team assignments are:

- Rimmer (coordinator): provider-selected coordinator model
- Holly (architect): provider-selected analyst model
- Kryten (reviewer/validator): provider-selected reviewer or validator model
- Lister (developer): provider-selected developer model

The `openClawModelBindingSchema` provider contract is enum-backed for both Anthropic and OpenAI. Provider selection is validated config; `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` remain secrets.

The Anthropic and OpenAI provider pages are the primary references for auth and key configuration. ([docs.openclaw.ai](https://docs.openclaw.ai/providers/anthropic?utm_source=chatgpt.com), [docs.openclaw.ai](https://docs.openclaw.ai/providers/openai?utm_source=chatgpt.com))

---

## 14. Configuration file and examples

OpenClaw reads an optional JSON5 config from `~/.openclaw/openclaw.json`. The docs say common reasons to add config are channel connections, model selection, tools, sandboxing, cron, hooks, sessions, networking, and UI tuning. ([docs.openclaw.ai](https://docs.openclaw.ai/gateway/configuration?utm_source=chatgpt.com))

The examples page shows a minimal config shape and confirms that OpenClaw expects agent workspace and channel configuration in that file. ([docs.openclaw.ai](https://docs.openclaw.ai/gateway/configuration-examples?utm_source=chatgpt.com))

For RedDwarf, this config file becomes the runtime contract surface between your app and OpenClaw. It is where global defaults, per-agent behavior, tool policy, and automation hooks are grounded. ([docs.openclaw.ai](https://docs.openclaw.ai/gateway/configuration?utm_source=chatgpt.com))

---

## 15. Optional OpenAI-compatible HTTP surface

OpenClaw can expose a small OpenAI-compatible HTTP API, but the docs say this endpoint is disabled by default. When enabled, it serves `POST /v1/chat/completions` and also model, embeddings, and responses endpoints on the gateway port. ([docs.openclaw.ai](https://docs.openclaw.ai/gateway/openai-http-api?utm_source=chatgpt.com))

This may be useful for RedDwarf if you ever want to route internal calls through OpenClaw over HTTP rather than only through direct session/channel flows, but it should be treated as optional rather than foundational for the current phase. ([docs.openclaw.ai](https://docs.openclaw.ai/gateway/openai-http-api?utm_source=chatgpt.com))

---

## 16. Plugin extension model

OpenClaw supports plugins for channels, providers, tools, hooks, commands, HTTP routes, and CLI extensions. The plugin docs show that you can register typed tools with `api.registerTool(...)`, and optional tools must be enabled in the config allowlist before the agent can use them. ([docs.openclaw.ai](https://docs.openclaw.ai/plugins/agent-tools?utm_source=chatgpt.com))

For RedDwarf, this is the cleanest path if you eventually want OpenClaw-native tools for interacting with your own orchestration layer, evidence system, or policy services instead of relying only on generic repo and shell tools. ([docs.openclaw.ai](https://docs.openclaw.ai/plugins/agent-tools?utm_source=chatgpt.com))

---

## 17. Platform and Windows guidance

The install docs recommend the installer scripts and note support across macOS, Linux, WSL2, and Windows PowerShell installers. The getting-started docs say Node 24 is recommended, Node 22.14+ is also supported, and that WSL2 is more stable and recommended for the full Windows experience. ([docs.openclaw.ai](https://docs.openclaw.ai/install?utm_source=chatgpt.com))

The Windows page is more specific: WSL2 with Ubuntu is the recommended setup, and enabling systemd is required for gateway install in that environment. The broader platforms page also says Bun is not recommended for the Gateway and that the Gateway is recommended via WSL2 on Windows. ([docs.openclaw.ai](https://docs.openclaw.ai/platforms/windows?utm_source=chatgpt.com))

For RedDwarf on your home PC, this matters because local Docker plus WSL2 is likely the least painful OpenClaw host arrangement if you want something close to the documented path. ([docs.openclaw.ai](https://docs.openclaw.ai/platforms/windows?utm_source=chatgpt.com))

---

## 18. Security boundary assumptions

This is one of the most important pages for RedDwarf.

The security docs state that the supported security posture is **one user/trust boundary per gateway**. They explicitly say a shared gateway or shared agent should not be treated as a supported boundary for mutually untrusted or adversarial users, and that adversarial isolation should be split across separate gateways and ideally separate OS users or hosts. ([docs.openclaw.ai](https://docs.openclaw.ai/gateway/security?utm_source=chatgpt.com))

They also warn that if multiple untrusted users can message one tool-enabled agent, those users should be treated as sharing the same delegated tool authority for that agent. ([docs.openclaw.ai](https://docs.openclaw.ai/gateway/security?utm_source=chatgpt.com))

For RedDwarf, this means OpenClaw is suitable as the execution runtime inside your own trusted automation environment, but not as the primary security wall between unrelated trust domains. RedDwarf should continue to enforce the real governance decisions before any OpenClaw run begins. ([docs.openclaw.ai](https://docs.openclaw.ai/gateway/security?utm_source=chatgpt.com))

---

## 19. What this means for RedDwarf

The most sensible integration pattern is:

- RedDwarf handles GitHub intake
- RedDwarf performs deterministic policy and risk checks
- RedDwarf decides whether human approval is required
- RedDwarf builds a constrained task manifest
- OpenClaw executes the allowed work inside that bounded envelope
- RedDwarf captures evidence and final governance state ([docs.openclaw.ai](https://docs.openclaw.ai/concepts/agent-loop?utm_source=chatgpt.com))

In practical terms, RedDwarf should use OpenClaw for:

- agent runtime
- workspace/bootstrap loading
- tool enforcement
- sandboxed execution
- model/provider routing
- agent specialization

RedDwarf should keep ownership of:

- issue polling or webhook intake
- risk classification
- approval queues
- policy decisions
- evidence requirements
- SCM mutation approval rules ([docs.openclaw.ai](https://docs.openclaw.ai/gateway/configuration?utm_source=chatgpt.com))

---

## 20. Key implementation rules to keep in mind

1. **Do not assume workspace equals sandbox.** The docs explicitly say it does not. ([docs.openclaw.ai](https://docs.openclaw.ai/concepts/agent-workspace?utm_source=chatgpt.com))

2. **Do not let OpenClaw become your policy engine.** Use it as the runtime after RedDwarf has decided a task is eligible. ([docs.openclaw.ai](https://docs.openclaw.ai/concepts/agent-loop?utm_source=chatgpt.com))

3. **Use narrow tool profiles and deny lists by default.** Deny wins over allow. ([docs.openclaw.ai](https://docs.openclaw.ai/tools?utm_source=chatgpt.com))

4. **Be careful with per-agent overrides.** Multi-agent configs can override global sandbox and tool policy. ([docs.openclaw.ai](https://docs.openclaw.ai/tools/multi-agent-sandbox-tools?utm_source=chatgpt.com))

5. **Keep the agent set small at first.** The multi-agent model is powerful, but clean boundaries matter more than agent count. ([docs.openclaw.ai](https://docs.openclaw.ai/concepts/multi-agent?utm_source=chatgpt.com))

6. **Treat webhook or hook tokens as trusted secrets.** The docs treat holders as full-trust callers for that ingress surface. ([docs.openclaw.ai](https://docs.openclaw.ai/automation/webhook?utm_source=chatgpt.com))

7. **Prefer WSL2 on Windows-hosted setups.** That is the documented stable path. ([docs.openclaw.ai](https://docs.openclaw.ai/platforms/windows?utm_source=chatgpt.com))

---

## 21. Official pages worth bookmarking

### Core concepts

- OpenClaw home: official product overview. ([docs.openclaw.ai](https://docs.openclaw.ai/?utm_source=chatgpt.com))
- Agent runtime: agent working-directory model and runtime behavior. ([docs.openclaw.ai](https://docs.openclaw.ai/concepts/agent?utm_source=chatgpt.com))
- Agent workspace: workspace rules and sandbox warning. ([docs.openclaw.ai](https://docs.openclaw.ai/concepts/agent-workspace?utm_source=chatgpt.com))
- Agent loop: intake to persistence lifecycle. ([docs.openclaw.ai](https://docs.openclaw.ai/concepts/agent-loop?utm_source=chatgpt.com))
- Multi-agent: per-agent isolation model. ([docs.openclaw.ai](https://docs.openclaw.ai/concepts/multi-agent?utm_source=chatgpt.com))

### Control and policy

- Configuration: why and where to configure OpenClaw. ([docs.openclaw.ai](https://docs.openclaw.ai/gateway/configuration?utm_source=chatgpt.com))
- Configuration reference: exact fields like skipBootstrap, allow, deny, limits. ([docs.openclaw.ai](https://docs.openclaw.ai/gateway/configuration-reference?utm_source=chatgpt.com))
- Tools and plugins: profiles, groups, allow/deny behavior. ([docs.openclaw.ai](https://docs.openclaw.ai/tools?utm_source=chatgpt.com))
- Multi-agent sandbox/tools: per-agent override behavior. ([docs.openclaw.ai](https://docs.openclaw.ai/tools/multi-agent-sandbox-tools?utm_source=chatgpt.com))
- Security: trust-boundary assumptions. ([docs.openclaw.ai](https://docs.openclaw.ai/gateway/security?utm_source=chatgpt.com))

### Automation and extension

- Hooks: event-driven automation model. ([docs.openclaw.ai](https://docs.openclaw.ai/automation/hooks?utm_source=chatgpt.com))
- Webhook: authenticated ingress surface. ([docs.openclaw.ai](https://docs.openclaw.ai/automation/webhook?utm_source=chatgpt.com))
- Skills: shared and per-agent skill loading. ([docs.openclaw.ai](https://docs.openclaw.ai/tools/skills?utm_source=chatgpt.com))
- Plugin tools: how to register native tools/plugins. ([docs.openclaw.ai](https://docs.openclaw.ai/plugins/agent-tools?utm_source=chatgpt.com))

### Providers and platform

- Providers directory: available model providers. ([docs.openclaw.ai](https://docs.openclaw.ai/providers?utm_source=chatgpt.com))
- Anthropic provider page: API key configuration for Anthropic mode. ([docs.openclaw.ai](https://docs.openclaw.ai/providers/anthropic?utm_source=chatgpt.com))
- OpenAI provider page: API key and Codex auth guidance for OpenAI mode. ([docs.openclaw.ai](https://docs.openclaw.ai/providers/openai?utm_source=chatgpt.com))
- OAuth concepts: subscription auth and Codex OAuth. ([docs.openclaw.ai](https://docs.openclaw.ai/concepts/oauth?utm_source=chatgpt.com))
- Install: installer path. ([docs.openclaw.ai](https://docs.openclaw.ai/install?utm_source=chatgpt.com))
- Getting started: Node version and setup notes. ([docs.openclaw.ai](https://docs.openclaw.ai/start/getting-started?utm_source=chatgpt.com))
- Windows: WSL2 guidance and systemd requirement. ([docs.openclaw.ai](https://docs.openclaw.ai/platforms/windows?utm_source=chatgpt.com))
- Platforms: WSL2 recommended, Bun not recommended for Gateway. ([docs.openclaw.ai](https://docs.openclaw.ai/platforms?utm_source=chatgpt.com))

---

## 22. Recommended RedDwarf reading order

For building RedDwarf against OpenClaw, the best reading order is:

1. Agent workspace
2. Configuration reference
3. Tools and plugins
4. Multi-agent sandbox/tools
5. Security
6. Anthropic provider (`REDDWARF_MODEL_PROVIDER=anthropic`)
7. OpenAI provider (`REDDWARF_MODEL_PROVIDER=openai`)
8. Hooks and webhook
9. Skills
10. Windows / platform docs if running from your current home-PC stack ([docs.openclaw.ai](https://docs.openclaw.ai/concepts/agent-workspace?utm_source=chatgpt.com))
