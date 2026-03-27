import { join } from "node:path";
import type { OpenClawAgentRoleDefinition } from "@reddwarf/contracts";
import { openClawAgentRoleDefinitions } from "@reddwarf/execution-plane";

// -- OpenClaw config output types ---------------------------------------------

export interface OpenClawSandboxConfig {
  mode: "all";
  scope: "agent";
  workspaceAccess: "ro" | "rw";
}

export interface OpenClawAgentConfig {
  id: string;
  name: string;
  workspace: string;
  agentDir: string;
  model: string;
  tools: {
    profile: string;
    allow: string[];
    deny: string[];
  };
  sandbox: OpenClawSandboxConfig;
  default?: boolean;
}

export interface OpenClawConfig {
  agents: {
    defaults: {
      skipBootstrap: boolean;
    };
    list: OpenClawAgentConfig[];
  };
}

export interface GenerateOpenClawConfigOptions {
  /** Base directory where per-agent workspace directories are created. */
  workspaceRoot: string;

  /**
   * Role definitions to include. Defaults to all roles from the execution-plane.
   * Pass a subset to generate a config with fewer agents.
   */
  roles?: readonly OpenClawAgentRoleDefinition[];

  /**
   * Whether OpenClaw should skip auto-generating bootstrap files.
   * RedDwarf owns bootstrap content, so this defaults to true.
   */
  skipBootstrap?: boolean;
}

/**
 * Build a per-agent OpenClaw config entry from a RedDwarf role definition.
 */
export function buildAgentConfig(
  role: OpenClawAgentRoleDefinition,
  workspaceRoot: string,
  _skipBootstrap: boolean
): OpenClawAgentConfig {
  const policy = role.runtimePolicy;
  const workspace = join(workspaceRoot, role.agentId).replace(/\\/g, "/");
  const agentDir = join(workspaceRoot, ".agents", role.agentId, "agent").replace(
    /\\/g,
    "/"
  );

  return {
    id: role.agentId,
    name: role.displayName,
    workspace,
    agentDir,
    model: policy.model.model,
    tools: {
      profile: policy.toolProfile,
      allow: [...policy.allow],
      deny: [...policy.deny]
    },
    sandbox: mapSandboxConfig(policy.sandboxMode)
  };
}

/**
 * Generate a complete openclaw.json configuration from RedDwarf policy
 * definitions. The output is a plain object suitable for JSON.stringify.
 *
 * Each role definition in the execution-plane is mapped to an OpenClaw agent
 * entry under `agents.list`, with workspace paths, tool profiles, allow/deny
 * lists, sandbox policy, and model binding derived from the runtime policy.
 */
export function generateOpenClawConfig(
  options: GenerateOpenClawConfigOptions
): OpenClawConfig {
  const roles = options.roles ?? openClawAgentRoleDefinitions;
  const skipBootstrap = options.skipBootstrap ?? true;

  const config: OpenClawConfig = {
    agents: {
      defaults: { skipBootstrap },
      list: []
    }
  };

  for (const [index, role] of roles.entries()) {
    const agentEntry = buildAgentConfig(role, options.workspaceRoot, skipBootstrap);
    config.agents.list.push(
      index === 0 ? { ...agentEntry, default: true } : agentEntry
    );
  }

  return config;
}

/**
 * Serialize a generated OpenClaw config to a formatted JSON string.
 */
export function serializeOpenClawConfig(config: OpenClawConfig): string {
  return JSON.stringify(config, null, 2) + "\n";
}

function mapSandboxConfig(
  sandboxMode: OpenClawAgentRoleDefinition["runtimePolicy"]["sandboxMode"]
): OpenClawSandboxConfig {
  return {
    mode: "all",
    scope: "agent",
    workspaceAccess: sandboxMode === "workspace_write" ? "rw" : "ro"
  };
}
