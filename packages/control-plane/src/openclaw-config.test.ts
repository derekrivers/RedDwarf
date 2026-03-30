import { describe, expect, it } from "vitest";
import {
  buildAgentConfig,
  generateOpenClawConfig,
  serializeOpenClawConfig
} from "@reddwarf/control-plane";

// -- OpenClaw config generation ---------------------------------------------

describe("generateOpenClawConfig", () => {
  it("generates config with webhook ingress and all four agent roles", () => {
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
        "reddwarf-validator",
        "reddwarf-developer"
      ],
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:", "github:issue:"]
    });
    expect(config.agents.defaults.skipBootstrap).toBe(true);

    const agentIds = config.agents.list.map((agent) => agent.id);
    expect(agentIds).toContain("reddwarf-coordinator");
    expect(agentIds).toContain("reddwarf-analyst");
    expect(agentIds).toContain("reddwarf-validator");
    expect(agentIds).toContain("reddwarf-developer");
    expect(agentIds).toHaveLength(4);
    expect(config.agents.list[0]?.default).toBe(true);
  });

  it("sets the shared workspace root and per-agent state paths under the provided root", () => {
    const config = generateOpenClawConfig({ workspaceRoot: "/data/workspaces" });

    const coordinator = config.agents.list.find((agent) => agent.id === "reddwarf-coordinator");
    const analyst = config.agents.list.find((agent) => agent.id === "reddwarf-analyst");
    const validator = config.agents.list.find((agent) => agent.id === "reddwarf-validator");
    const developer = config.agents.list.find((agent) => agent.id === "reddwarf-developer");

    expect(coordinator?.workspace).toBe("/data/workspaces");
    expect(analyst?.workspace).toBe("/data/workspaces");
    expect(validator?.workspace).toBe("/data/workspaces");
    expect(developer?.workspace).toBe("/data/workspaces");
    expect(coordinator?.agentDir).toBe("/data/workspaces/.agents/reddwarf-coordinator/agent");
  });

  it("maps tool profiles, allow or deny lists, and sandbox from runtime policy", () => {
    const config = generateOpenClawConfig({ workspaceRoot: "/ws" });

    const coordinator = config.agents.list.find((agent) => agent.id === "reddwarf-coordinator");

    expect(coordinator?.tools.profile).toBe("full");
    expect(coordinator?.tools.allow).toEqual([
      "group:fs",
      "group:sessions",
      "group:openclaw"
    ]);
    expect(coordinator?.tools.deny).toEqual([
      "group:automation",
      "group:messaging",
      "group:nodes"
    ]);
    expect(coordinator?.sandbox).toEqual({
      mode: "off"
    });
  });

  it("maps model binding from runtime policy", () => {
    const config = generateOpenClawConfig({ workspaceRoot: "/ws" });

    const analyst = config.agents.list.find((agent) => agent.id === "reddwarf-analyst");
    expect(analyst?.model).toBe("anthropic/claude-opus-4-6");

    const coordinator = config.agents.list.find((agent) => agent.id === "reddwarf-coordinator");
    expect(coordinator?.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("allows a subset of roles", () => {
    const { openClawAgentRoleDefinitions: roles } = require("@reddwarf/execution-plane");
    const analystOnly = roles.filter((r: { role: string }) => r.role === "analyst");

    const config = generateOpenClawConfig({ workspaceRoot: "/ws", roles: analystOnly });
    const agentIds = config.agents.list.map((agent) => agent.id);
    expect(agentIds).toEqual(["reddwarf-analyst"]);
  });

  it("serializes to valid JSON with trailing newline", () => {
    const config = generateOpenClawConfig({ workspaceRoot: "/ws" });
    const json = serializeOpenClawConfig(config);

    expect(json.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(json);
    expect(parsed.gateway.auth.token).toBe("${OPENCLAW_GATEWAY_TOKEN}");
    expect(parsed.hooks.token).toBe("${OPENCLAW_HOOK_TOKEN}");
    expect(parsed.agents.defaults.skipBootstrap).toBe(true);
    expect(parsed.agents.list.find((agent: { id: string }) => agent.id === "reddwarf-coordinator")).toBeDefined();
  });
});

describe("buildAgentConfig", () => {
  it("builds a single agent config entry", () => {
    const { openClawAgentRoleDefinitions: roles } = require("@reddwarf/execution-plane");
    const validator = roles.find((r: { role: string }) => r.role === "validator");

    const entry = buildAgentConfig(validator, "/runtime/ws", true);

    expect(entry.id).toBe("reddwarf-validator");
    expect(entry.name).toBe("RedDwarf Validator");
    expect(entry.workspace).toBe("/runtime/ws");
    expect(entry.agentDir).toBe("/runtime/ws/.agents/reddwarf-validator/agent");
    expect(entry.model).toBe("anthropic/claude-sonnet-4-6");
    expect(entry.tools.profile).toBe("full");
    expect(entry.sandbox).toEqual({
      mode: "off"
    });
  });
});
