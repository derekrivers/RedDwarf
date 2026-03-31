import { join } from "node:path";
import type {
  OpenClawAgentRoleDefinition,
  OpenClawModelProvider
} from "@reddwarf/contracts";
import {
  createOpenClawAgentRoleDefinitions,
  openClawAgentRoleDefinitions
} from "@reddwarf/execution-plane";

// -- OpenClaw config output types ---------------------------------------------

export type OpenClawSandboxConfig =
  | {
      mode: "off";
    }
  | {
      mode: "all";
      scope: "agent";
      workspaceAccess: "ro" | "rw";
    };

export interface OpenClawGatewayConfig {
  bind: "lan";
  auth: {
    mode: "token";
    token: string;
  };
  controlUi: {
    allowedOrigins: string[];
  };
}

export interface OpenClawHooksConfig {
  enabled: boolean;
  token: string;
  path: string;
  defaultSessionKey: string;
  allowedAgentIds: string[];
  allowRequestSessionKey: boolean;
  allowedSessionKeyPrefixes: string[];
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
  gateway: OpenClawGatewayConfig;
  hooks: OpenClawHooksConfig;
  agents: {
    defaults: {
      skipBootstrap: boolean;
    };
    list: OpenClawAgentConfig[];
  };
}

export interface GenerateOpenClawConfigOptions {
  /** Shared workspace root mounted into OpenClaw agents. */
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

  /**
   * Default model provider to use when role definitions are not supplied.
   * Existing callers can omit this to preserve Anthropic-backed defaults.
   */
  modelProvider?: OpenClawModelProvider;
}

/**
 * Build an OpenClaw config entry from a RedDwarf role definition.
 */
export function buildAgentConfig(
  role: OpenClawAgentRoleDefinition,
  workspaceRoot: string,
  _skipBootstrap: boolean
): OpenClawAgentConfig {
  const policy = role.runtimePolicy;
  const workspace = workspaceRoot.replace(/\\/g, "/");
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
 * The generated config also enables the webhook ingress RedDwarf uses for
 * developer dispatch and restricts explicit session keys to the
 * `github:issue:` namespace.
 *
 * The current Docker-hosted OpenClaw deployment already runs inside a dedicated
 * container with repo-mounted workspaces, so nested OpenClaw sandboxing stays
 * disabled here. This avoids a hard runtime dependency on an inner `docker`
 * binary while preserving per-agent tool restrictions and the outer container
 * boundary.
 */
export function generateOpenClawConfig(
  options: GenerateOpenClawConfigOptions
): OpenClawConfig {
  const roles =
    options.roles ??
    (options.modelProvider
      ? createOpenClawAgentRoleDefinitions(options.modelProvider)
      : openClawAgentRoleDefinitions);
  const skipBootstrap = options.skipBootstrap ?? true;

  const config: OpenClawConfig = {
    gateway: {
      bind: "lan",
      auth: {
        mode: "token",
        token: "${OPENCLAW_GATEWAY_TOKEN}"
      },
      controlUi: {
        allowedOrigins: [
          "http://127.0.0.1:3578",
          "http://localhost:3578"
        ]
      }
    },
    hooks: {
      enabled: true,
      token: "${OPENCLAW_HOOK_TOKEN}",
      path: "/hooks",
      defaultSessionKey: "hook:ingress",
      allowedAgentIds: roles.map((role) => role.agentId),
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:", "github:issue:"]
    },
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
  _sandboxMode: OpenClawAgentRoleDefinition["runtimePolicy"]["sandboxMode"]
): OpenClawSandboxConfig {
  return { mode: "off" };
}
