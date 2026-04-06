import { describe, expect, it } from "vitest";
import {
  buildAgentConfig,
  generateOpenClawConfig,
  serializeOpenClawConfig
} from "@reddwarf/control-plane";

// -- OpenClaw config generation ---------------------------------------------

describe("generateOpenClawConfig", () => {
  it("generates config with webhook ingress and all five agent roles", () => {
    const config = generateOpenClawConfig({ workspaceRoot: "/workspaces" });

    expect(config.gateway.auth.token).toBe("${OPENCLAW_GATEWAY_TOKEN}");
    expect(config.hooks).toEqual({
      enabled: true,
      token: "${OPENCLAW_HOOK_TOKEN}",
      path: "/hooks",
      defaultSessionKey: "hook:ingress",
      allowedAgentIds: [
        "reddwarf-coordinator",
        "reddwarf-analyst",
        "reddwarf-arch-reviewer",
        "reddwarf-validator",
        "reddwarf-developer",
        "reddwarf-developer-opus"
      ],
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:", "github:issue:"]
    });
    expect(config.commands).toEqual({
      text: true,
      native: "auto"
    });
    expect(config.plugins).toEqual({
      enabled: true,
      allow: ["reddwarf-operator"],
      load: {
        paths: ["/opt/reddwarf/agents/openclaw/plugins/reddwarf-operator"]
      },
      entries: {
        "reddwarf-operator": {
          enabled: true,
          config: {
            operatorApiBaseUrl: "${REDDWARF_OPENCLAW_OPERATOR_API_URL}"
          }
        }
      }
    });
    expect(config.mcp).toEqual({
      servers: {
        reddwarf: {
          command: "node",
          args: ["/opt/reddwarf/scripts/start-operator-mcp.mjs"],
          env: {
            REDDWARF_API_URL: "${REDDWARF_OPENCLAW_OPERATOR_API_URL}",
            REDDWARF_OPERATOR_TOKEN: "${REDDWARF_OPERATOR_TOKEN}"
          }
        }
      }
    });
    expect(config.agents.defaults.skipBootstrap).toBe(true);

    const agentIds = config.agents.list.map((agent) => agent.id);
    expect(agentIds).toContain("reddwarf-coordinator");
    expect(agentIds).toContain("reddwarf-analyst");
    expect(agentIds).toContain("reddwarf-arch-reviewer");
    expect(agentIds).toContain("reddwarf-validator");
    expect(agentIds).toContain("reddwarf-developer");
    expect(agentIds).toContain("reddwarf-developer-opus");
    expect(agentIds).toHaveLength(6);
    expect(config.agents.list[0]?.default).toBe(true);
  });

  it("uses explicit runtime tokens when provided", () => {
    const config = generateOpenClawConfig({
      workspaceRoot: "/workspaces",
      gatewayAuthToken: "gateway-token-live",
      hookToken: "hook-token-live",
      operatorApiToken: "operator-token-live",
      operatorApiBaseUrl: "http://host.docker.internal:8080"
    });

    expect(config.gateway.auth.token).toBe("gateway-token-live");
    expect(config.hooks.token).toBe("hook-token-live");
    expect(config.mcp?.servers.reddwarf?.env?.REDDWARF_API_URL).toBe(
      "http://host.docker.internal:8080"
    );
    expect(config.mcp?.servers.reddwarf?.env?.REDDWARF_OPERATOR_TOKEN).toBe(
      "operator-token-live"
    );
    expect(config.plugins?.entries?.["reddwarf-operator"]?.config).toEqual({
      operatorApiBaseUrl: "http://host.docker.internal:8080"
    });
  });

  it("sets the shared workspace root and per-agent state paths under the provided root", () => {
    const config = generateOpenClawConfig({ workspaceRoot: "/data/workspaces" });

    const coordinator = config.agents.list.find((agent) => agent.id === "reddwarf-coordinator");
    const analyst = config.agents.list.find((agent) => agent.id === "reddwarf-analyst");
    const reviewer = config.agents.list.find((agent) => agent.id === "reddwarf-arch-reviewer");
    const validator = config.agents.list.find((agent) => agent.id === "reddwarf-validator");
    const developer = config.agents.list.find((agent) => agent.id === "reddwarf-developer");

    expect(coordinator?.workspace).toBe("/data/workspaces");
    expect(analyst?.workspace).toBe("/data/workspaces");
    expect(reviewer?.workspace).toBe("/data/workspaces");
    expect(validator?.workspace).toBe("/data/workspaces");
    expect(developer?.workspace).toBe("/data/workspaces");
    expect(coordinator?.agentDir).toBe("/data/workspaces/.agents/reddwarf-coordinator/agent");
  });

  it("maps tool profiles, allow or deny lists, and sandbox from runtime policy", () => {
    const config = generateOpenClawConfig({ workspaceRoot: "/ws" });

    const reviewer = config.agents.list.find((agent) => agent.id === "reddwarf-arch-reviewer");

    expect(reviewer?.tools.profile).toBe("full");
    expect(reviewer?.tools.allow).toEqual([
      "group:fs",
      "group:sessions",
      "group:openclaw"
    ]);
    expect(reviewer?.tools.deny).toEqual([
      "group:automation",
      "group:messaging",
      "group:runtime",
      "sessions_spawn",
      "sessions_yield",
      "subagents"
    ]);
    expect(reviewer?.sandbox).toEqual({
      mode: "off"
    });
  });

  it("emits agentToAgent and sessions visibility in the global tools block by default", () => {
    const config = generateOpenClawConfig({ workspaceRoot: "/ws" });

    expect(config.tools?.agentToAgent?.enabled).toBe(true);
    expect(config.tools?.sessions?.visibility).toBe("all");
    // All agent IDs must be in the agentToAgent allow list
    const agentIds = config.agents.list.map((a) => a.id);
    for (const id of agentIds) {
      expect(config.tools?.agentToAgent?.allow).toContain(id);
    }
  });

  it("omits the agentToAgent tools block when enableAgentToAgent is false", () => {
    const config = generateOpenClawConfig({
      workspaceRoot: "/ws",
      enableAgentToAgent: false
    });

    expect(config.tools).toBeUndefined();
  });

  it("includes group:sessions in allow for analyst, developer, and arch-reviewer", () => {
    const config = generateOpenClawConfig({ workspaceRoot: "/ws" });

    const analyst = config.agents.list.find((a) => a.id === "reddwarf-analyst");
    const developer = config.agents.list.find((a) => a.id === "reddwarf-developer");
    const reviewer = config.agents.list.find((a) => a.id === "reddwarf-arch-reviewer");

    expect(analyst?.tools.allow).toContain("group:sessions");
    expect(developer?.tools.allow).toContain("group:sessions");
    expect(reviewer?.tools.allow).toContain("group:sessions");

    // Developer and reviewer must not be able to spawn sub-agents
    expect(developer?.tools.deny).toContain("sessions_spawn");
    expect(reviewer?.tools.deny).toContain("sessions_spawn");
  });

  it("maps model binding from runtime policy", () => {
    const config = generateOpenClawConfig({ workspaceRoot: "/ws" });

    const analyst = config.agents.list.find((agent) => agent.id === "reddwarf-analyst");
    expect(analyst?.model).toBe("anthropic/claude-opus-4-6");

    const reviewer = config.agents.list.find((agent) => agent.id === "reddwarf-arch-reviewer");
    expect(reviewer?.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("can generate the default agent roster with OpenAI model bindings", () => {
    const config = generateOpenClawConfig({
      workspaceRoot: "/ws",
      modelProvider: "openai"
    });

    const analyst = config.agents.list.find((agent) => agent.id === "reddwarf-analyst");
    const developer = config.agents.list.find((agent) => agent.id === "reddwarf-developer");

    expect(analyst?.model).toBe("openai/gpt-5");
    expect(developer?.model).toBe("openai/gpt-5");
  });

  it("can include a Discord channel config for operator approvals", () => {
    const config = generateOpenClawConfig({
      workspaceRoot: "/ws",
      discord: {
        enabled: true,
        token: "${OPENCLAW_DISCORD_BOT_TOKEN}",
        dmPolicy: "pairing",
        groupPolicy: "allowlist",
        guilds: {
          "1234567890": {
            enabled: true,
            requireMention: true
          }
        },
        commands: {
          native: true
        }
      }
    });

    expect(config.channels?.discord).toEqual({
      enabled: true,
      token: "${OPENCLAW_DISCORD_BOT_TOKEN}",
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      guilds: {
        "1234567890": {
          enabled: true,
          requireMention: true
        }
      },
      commands: {
        native: true
      }
    });
  });

  it("can include Discord notifications and approval prompts", () => {
    const config = generateOpenClawConfig({
      workspaceRoot: "/ws",
      discord: {
        enabled: true,
        token: "${OPENCLAW_DISCORD_BOT_TOKEN}",
        dmPolicy: "pairing",
        groupPolicy: "allowlist",
        streaming: "partial",
        historyLimit: 24,
        autoPresence: {
          enabled: true,
          intervalMs: 60_000,
          minUpdateIntervalMs: 15_000,
          healthyText: "RedDwarf healthy",
          degradedText: "RedDwarf degraded",
          exhaustedText: "RedDwarf approvals waiting"
        },
        execApprovals: {
          enabled: true,
          approvers: ["111", "222"],
          target: "channel"
        },
        ui: {
          components: {
            accentColor: "#d7263d"
          }
        }
      }
    });

    expect(config.channels?.discord).toMatchObject({
      streaming: "partial",
      historyLimit: 24,
      autoPresence: {
        enabled: true,
        intervalMs: 60_000,
        minUpdateIntervalMs: 15_000,
        healthyText: "RedDwarf healthy",
        degradedText: "RedDwarf degraded",
        exhaustedText: "RedDwarf approvals waiting"
      },
      execApprovals: {
        enabled: true,
        approvers: ["111", "222"],
        target: "channel"
      },
      ui: {
        components: {
          accentColor: "#d7263d"
        }
      }
    });
  });

  it("can enable the OpenClaw browser for architect web research", () => {
    const config = generateOpenClawConfig({
      workspaceRoot: "/ws",
      browser: {
        enabled: true
      }
    });

    expect(config.browser).toEqual({
      enabled: true
    });
  });

  it("allows a subset of roles", () => {
    const { openClawAgentRoleDefinitions: roles } = require("@reddwarf/execution-plane");
    const reviewerOnly = roles.filter((r: { role: string }) => r.role === "reviewer");

    const config = generateOpenClawConfig({ workspaceRoot: "/ws", roles: reviewerOnly });
    const agentIds = config.agents.list.map((agent) => agent.id);
    expect(agentIds).toEqual(["reddwarf-arch-reviewer"]);
  });

  it("can target a custom runtime policy root for plugin loading", () => {
    const config = generateOpenClawConfig({
      workspaceRoot: "/ws",
      policyRoot: "/srv/reddwarf"
    });

    expect(config.plugins?.load?.paths).toEqual([
      "/srv/reddwarf/agents/openclaw/plugins/reddwarf-operator"
    ]);
    expect(config.mcp?.servers.reddwarf?.args).toEqual([
      "/srv/reddwarf/scripts/start-operator-mcp.mjs"
    ]);
  });

  it("serializes to valid JSON with trailing newline", () => {
    const config = generateOpenClawConfig({ workspaceRoot: "/ws" });
    const json = serializeOpenClawConfig(config);

    expect(json.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(json);
    expect(parsed.gateway.auth.token).toBe("${OPENCLAW_GATEWAY_TOKEN}");
    expect(parsed.hooks.token).toBe("${OPENCLAW_HOOK_TOKEN}");
    expect(parsed.agents.defaults.skipBootstrap).toBe(true);
    expect(parsed.agents.list.find((agent: { id: string }) => agent.id === "reddwarf-arch-reviewer")).toBeDefined();
  });
});

describe("buildAgentConfig", () => {
  it("builds a single reviewer agent config entry", () => {
    const { openClawAgentRoleDefinitions: roles } = require("@reddwarf/execution-plane");
    const reviewer = roles.find((r: { role: string }) => r.role === "reviewer");

    const entry = buildAgentConfig(reviewer, "/runtime/ws", true);

    expect(entry.id).toBe("reddwarf-arch-reviewer");
    expect(entry.name).toBe("RedDwarf Architecture Reviewer");
    expect(entry.workspace).toBe("/runtime/ws");
    expect(entry.agentDir).toBe("/runtime/ws/.agents/reddwarf-arch-reviewer/agent");
    expect(entry.model).toBe("anthropic/claude-sonnet-4-6");
    expect(entry.tools.profile).toBe("full");
    expect(entry.sandbox).toEqual({
      mode: "off"
    });
  });
});
