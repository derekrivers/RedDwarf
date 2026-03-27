import { join } from "node:path";
import type { OpenClawAgentRoleDefinition } from "@reddwarf/contracts";
import { openClawAgentRoleDefinitions } from "@reddwarf/execution-plane";

// ── OpenClaw config output types ─────────────────────────────────────────────

export interface OpenClawAgentConfig {
  workspace: string;
  model: string;
  tools: {
    profile: string;
    allow: string[];
    deny: string[];
  };
  sandbox: string;
  skipBootstrap: boolean;
}

export interface OpenClawConfig {
  agents: {
    defaults: {
      skipBootstrap: boolean;
    };
    [agentId: string]: OpenClawAgentConfig | { skipBootstrap: boolean };
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
  skipBootstrap: boolean
): OpenClawAgentConfig {
  const policy = role.runtimePolicy;

  return {
    workspace: join(workspaceRoot, role.agentId).replace(/\\/g, "/"),
    model: policy.model.model,
    tools: {
      profile: policy.toolProfile,
      allow: [...policy.allow],
      deny: [...policy.deny]
    },
    sandbox: policy.sandboxMode,
    skipBootstrap
  };
}

/**
 * Generate a complete openclaw.json configuration from RedDwarf policy
 * definitions. The output is a plain object suitable for JSON.stringify.
 *
 * Each role definition in the execution-plane is mapped to an OpenClaw agent
 * entry keyed by `agentId`, with workspace paths, tool profiles, allow/deny
 * lists, sandbox mode, and model binding derived from the runtime policy.
 */
export function generateOpenClawConfig(
  options: GenerateOpenClawConfigOptions
): OpenClawConfig {
  const roles = options.roles ?? openClawAgentRoleDefinitions;
  const skipBootstrap = options.skipBootstrap ?? true;

  const config: OpenClawConfig = {
    agents: {
      defaults: { skipBootstrap }
    }
  };

  for (const role of roles) {
    const agentEntry = buildAgentConfig(role, options.workspaceRoot, skipBootstrap);
    (config.agents as Record<string, unknown>)[role.agentId] = agentEntry;
  }

  return config;
}

/**
 * Serialize a generated OpenClaw config to a formatted JSON string.
 */
export function serializeOpenClawConfig(config: OpenClawConfig): string {
  return JSON.stringify(config, null, 2) + "\n";
}
