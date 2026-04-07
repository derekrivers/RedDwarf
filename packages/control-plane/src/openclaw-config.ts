import { join } from "node:path";
import type {
  OpenClawAgentRoleDefinition,
  OpenClawModelProvider
} from "@reddwarf/contracts";
import {
  MODEL_FAILOVER_MAP,
  createOpenClawAgentRoleDefinitions,
  openClawAgentRoleDefinitions,
  resolveOpenClawModelProvider
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

export interface OpenClawDiscordGuildConfig {
  enabled?: boolean;
  requireMention?: boolean;
  channels?: Record<
    string,
    {
      requireMention?: boolean;
    }
  >;
}

export interface OpenClawDiscordChannelConfig {
  enabled: boolean;
  token: string;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  groupPolicy?: "allowlist" | "open";
  allowFrom?: string[];
  streaming?: "partial" | "block";
  historyLimit?: number;
  autoPresence?: {
    enabled: boolean;
    intervalMs?: number;
    minUpdateIntervalMs?: number;
    healthyText?: string;
    degradedText?: string;
    exhaustedText?: string;
  };
  execApprovals?: {
    enabled: boolean;
    approvers: string[];
    target?: "dm" | "channel" | "both";
  };
  guilds?: Record<string, OpenClawDiscordGuildConfig>;
  commands?: {
    native?: boolean;
  };
  ui?: {
    components?: {
      accentColor?: string;
    };
  };
}

export interface OpenClawChannelsConfig {
  discord?: OpenClawDiscordChannelConfig;
}

export interface OpenClawBrowserConfig {
  enabled: boolean;
}

export interface OpenClawMcpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  workingDirectory?: string;
  url?: string;
}

export interface OpenClawAgentConfig {
  id: string;
  name: string;
  workspace: string;
  agentDir: string;
  model: string;
  /** Optional fallback model(s) to try when the primary provider returns a
   *  transient error (429/500/503). Set by enabling model failover. */
  modelFallback?: string[];
  tools: {
    profile: string;
    allow: string[];
    deny: string[];
  };
  sandbox: OpenClawSandboxConfig;
  default?: boolean;
}

/**
 * Gateway-level tool settings that control cross-agent session access.
 * These live at the top level of openclaw.json under `tools`, not inside
 * individual agent entries.
 */
export interface OpenClawGlobalToolsConfig {
  /** Controls cross-agent session messaging via sessions_send. */
  agentToAgent?: {
    /** Master switch for cross-agent session sends. Defaults to false in OpenClaw. */
    enabled: boolean;
    /** Allowlist of agent IDs that can be targeted by sessions_send / sessions_history. */
    allow?: string[];
  };
  /** Controls which sessions are visible to sessions_list/history/send tools. */
  sessions?: {
    /** "tree" (default) | "agent" | "all". Use "all" for cross-agent visibility. */
    visibility: "self" | "tree" | "agent" | "all";
  };
}

export interface OpenClawConfig {
  gateway: OpenClawGatewayConfig;
  hooks: OpenClawHooksConfig;
  commands?: {
    text?: boolean;
    native?: boolean | "auto";
  };
  /** Gateway-level tool settings, including cross-agent session access. */
  tools?: OpenClawGlobalToolsConfig;
  channels?: OpenClawChannelsConfig;
  browser?: OpenClawBrowserConfig;
  mcp?: {
    servers: Record<string, OpenClawMcpServerConfig>;
  };
  plugins?: {
    enabled: boolean;
    allow?: string[];
    load?: {
      paths: string[];
    };
    entries?: Record<
      string,
      {
        enabled: boolean;
        config?: Record<string, unknown>;
      }
    >;
  };
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

  /** Runtime-visible policy root mounted into the OpenClaw gateway. */
  policyRoot?: string;

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

  /**
   * Optional Discord channel surface. When provided, RedDwarf emits the
   * native OpenClaw `channels.discord` block instead of requiring operators
   * to hand-edit the runtime config.
   */
  discord?: OpenClawDiscordChannelConfig;

  /**
   * Optional browser control surface. Feature 101 enables this for Holly so
   * the architect phase can consult live docs and API references.
   */
  browser?: OpenClawBrowserConfig;

  /**
   * Optional gateway auth token for a fully resolved runtime config.
   * When omitted, the generated config keeps the template placeholder.
   */
  gatewayAuthToken?: string;

  /**
   * Optional hook ingress token for a fully resolved runtime config.
   * When omitted, the generated config keeps the template placeholder.
   */
  hookToken?: string;

  /**
   * Optional operator API token for the in-container MCP bridge.
   * When omitted, the generated config keeps the template placeholder.
   */
  operatorApiToken?: string;

  /**
   * Optional operator API base URL for in-container plugin and MCP access.
   * When omitted, the generated config keeps the template placeholder.
   */
  operatorApiBaseUrl?: string;

  /**
   * Whether to enable cross-agent session messaging via sessions_send /
   * sessions_history. When true, the generated config emits a top-level
   * `tools.agentToAgent` block that allows any agent in the roster to
   * target any other, and sets `tools.sessions.visibility: "all"` so
   * sessions are discoverable across agent boundaries.
   *
   * Defaults to true — this is the intended RedDwarf production posture.
   * The gateway-level allow list is automatically scoped to the generated
   * agent roster so cross-agent sends cannot target agents outside the
   * RedDwarf set.
   */
  enableAgentToAgent?: boolean;

  /**
   * Whether to emit cross-provider model failover chains for each agent.
   * When true and both ANTHROPIC_API_KEY and OPENAI_API_KEY are available,
   * OpenClaw will automatically rotate to the fallback provider on transient
   * errors (429/500/503). Defaults to false.
   *
   * Set via REDDWARF_MODEL_FAILOVER_ENABLED env var.
   */
  enableModelFailover?: boolean;
}

/**
 * Build an OpenClaw config entry from a RedDwarf role definition.
 */
export function buildAgentConfig(
  role: OpenClawAgentRoleDefinition,
  workspaceRoot: string,
  _skipBootstrap: boolean,
  options?: { enableModelFailover?: boolean }
): OpenClawAgentConfig {
  const policy = role.runtimePolicy;
  const workspace = workspaceRoot.replace(/\\/g, "/");
  const agentDir = join(workspaceRoot, ".agents", role.agentId, "agent").replace(
    /\\/g,
    "/"
  );

  const fallbackModel = options?.enableModelFailover
    ? MODEL_FAILOVER_MAP[policy.model.provider]?.[role.role]
    : undefined;

  return {
    id: role.agentId,
    name: role.displayName,
    workspace,
    agentDir,
    model: policy.model.model,
    ...(fallbackModel ? { modelFallback: [fallbackModel] } : {}),
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
      ? createOpenClawAgentRoleDefinitions(
          resolveOpenClawModelProvider(options.modelProvider)
        )
      : openClawAgentRoleDefinitions);
  const skipBootstrap = options.skipBootstrap ?? true;
  const policyRoot = options.policyRoot ?? "/opt/reddwarf";
  const reddwarfOperatorPluginPath = join(
    policyRoot,
    "agents",
    "openclaw",
    "plugins",
    "reddwarf-operator"
  ).replace(/\\/g, "/");
  const reddwarfOperatorMcpScriptPath = join(
    policyRoot,
    "scripts",
    "start-operator-mcp.mjs"
  ).replace(/\\/g, "/");
  const gatewayAuthToken =
    options.gatewayAuthToken ?? "${OPENCLAW_GATEWAY_TOKEN}";
  const hookToken = options.hookToken ?? "${OPENCLAW_HOOK_TOKEN}";
  const operatorApiToken =
    options.operatorApiToken ?? "${REDDWARF_OPERATOR_TOKEN}";
  const operatorApiBaseUrl =
    options.operatorApiBaseUrl ?? "${REDDWARF_OPENCLAW_OPERATOR_API_URL}";

  const enableAgentToAgent = options.enableAgentToAgent ?? true;
  const agentIds = roles.map((role) => role.agentId);

  const config: OpenClawConfig = {
    gateway: {
      bind: "lan",
      auth: {
        mode: "token",
        token: gatewayAuthToken
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
      token: hookToken,
      path: "/hooks",
      defaultSessionKey: "hook:ingress",
      allowedAgentIds: agentIds,
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:", "github:issue:"]
    },
    commands: {
      text: true,
      native: "auto"
    },
    ...(enableAgentToAgent
      ? {
          tools: {
            agentToAgent: {
              enabled: true,
              allow: [...agentIds]
            },
            sessions: {
              visibility: "all"
            }
          }
        }
      : {}),
    ...(options.discord
      ? {
          channels: {
            discord: {
              enabled: options.discord.enabled,
              token: options.discord.token,
              ...(options.discord.dmPolicy
                ? { dmPolicy: options.discord.dmPolicy }
                : {}),
              ...(options.discord.groupPolicy
                ? { groupPolicy: options.discord.groupPolicy }
                : {}),
              ...(options.discord.allowFrom
                ? { allowFrom: [...options.discord.allowFrom] }
                : {}),
              ...(options.discord.streaming
                ? { streaming: options.discord.streaming }
                : {}),
              ...(options.discord.historyLimit !== undefined
                ? { historyLimit: options.discord.historyLimit }
                : {}),
              ...(options.discord.autoPresence
                ? {
                    autoPresence: {
                      enabled: options.discord.autoPresence.enabled,
                      ...(options.discord.autoPresence.intervalMs !== undefined
                        ? {
                            intervalMs: options.discord.autoPresence.intervalMs
                          }
                        : {}),
                      ...(options.discord.autoPresence.minUpdateIntervalMs !==
                      undefined
                        ? {
                            minUpdateIntervalMs:
                              options.discord.autoPresence.minUpdateIntervalMs
                          }
                        : {}),
                      ...(options.discord.autoPresence.healthyText
                        ? {
                            healthyText:
                              options.discord.autoPresence.healthyText
                          }
                        : {}),
                      ...(options.discord.autoPresence.degradedText
                        ? {
                            degradedText:
                              options.discord.autoPresence.degradedText
                          }
                        : {}),
                      ...(options.discord.autoPresence.exhaustedText
                        ? {
                            exhaustedText:
                              options.discord.autoPresence.exhaustedText
                          }
                        : {})
                    }
                  }
                : {}),
              ...(options.discord.execApprovals
                ? {
                    execApprovals: {
                      enabled: options.discord.execApprovals.enabled,
                      approvers: [...options.discord.execApprovals.approvers],
                      ...(options.discord.execApprovals.target
                        ? { target: options.discord.execApprovals.target }
                        : {})
                    }
                  }
                : {}),
              ...(options.discord.guilds
                ? {
                    guilds: Object.fromEntries(
                      Object.entries(options.discord.guilds).map(([guildId, guild]) => [
                        guildId,
                        {
                          ...(guild.enabled !== undefined
                            ? { enabled: guild.enabled }
                            : {}),
                          ...(guild.requireMention !== undefined
                            ? { requireMention: guild.requireMention }
                            : {}),
                          ...(guild.channels
                            ? {
                                channels: Object.fromEntries(
                                  Object.entries(guild.channels).map(
                                    ([channelId, channel]) => [
                                      channelId,
                                      {
                                        ...(channel.requireMention !== undefined
                                          ? {
                                              requireMention:
                                                channel.requireMention
                                            }
                                          : {})
                                      }
                                    ]
                                  )
                                )
                              }
                            : {})
                        }
                      ])
                    )
                  }
                : {}),
              ...(options.discord.commands
                ? {
                    commands: {
                      ...(options.discord.commands.native !== undefined
                        ? { native: options.discord.commands.native }
                        : {})
                    }
                  }
                : {}),
              ...(options.discord.ui
                ? {
                    ui: {
                      ...(options.discord.ui.components
                        ? {
                            components: {
                              ...(options.discord.ui.components.accentColor
                                ? {
                                    accentColor:
                                      options.discord.ui.components.accentColor
                                  }
                                : {})
                            }
                          }
                        : {})
                    }
                  }
                : {})
            }
          }
        }
      : {}),
    ...(options.browser ? { browser: { enabled: options.browser.enabled } } : {}),
    mcp: {
      servers: {
        reddwarf: {
          command: "node",
          args: [reddwarfOperatorMcpScriptPath],
          env: {
            REDDWARF_API_URL: operatorApiBaseUrl,
            REDDWARF_OPERATOR_TOKEN: operatorApiToken
          }
        }
      }
    },
    plugins: {
      enabled: true,
      allow: ["reddwarf-operator"],
      load: {
        paths: [reddwarfOperatorPluginPath]
      },
      entries: {
        "reddwarf-operator": {
          enabled: true,
          config: {
            operatorApiBaseUrl
          }
        }
      }
    },
    agents: {
      defaults: { skipBootstrap },
      list: []
    }
  };

  const enableModelFailover = options.enableModelFailover ?? false;
  for (const [index, role] of roles.entries()) {
    const agentEntry = buildAgentConfig(role, options.workspaceRoot, skipBootstrap, {
      enableModelFailover
    });
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

/**
 * Map a RedDwarf sandboxMode declaration to an OpenClaw sandbox config entry.
 *
 * IMPORTANT — sandbox is currently disabled (`mode: "off"`) for all agents.
 * The design decision: RedDwarf runs inside a dedicated Docker container whose
 * outer boundary provides the workspace isolation layer. Enabling nested OpenClaw
 * sandboxing requires an inner `docker` binary inside the container, which is not
 * available in the standard deployment.
 *
 * Consequence: the `sandboxMode` fields in agent role definitions (`read_only`,
 * `workspace_write`) express security intent but are NOT currently enforced by
 * OpenClaw at runtime. Enforcement relies entirely on the Docker container
 * boundary and the per-agent tool allow/deny groups.
 *
 * When moving to a VPS or sandbox-capable host (FEATURE_BOARD Feature 105),
 * replace this function with a real mapping so the role definitions take effect.
 */
function mapSandboxConfig(
  _sandboxMode: OpenClawAgentRoleDefinition["runtimePolicy"]["sandboxMode"]
): OpenClawSandboxConfig {
  // sandboxMode is intentionally not forwarded until Feature 105 (Docker
  // sandboxing) is unblocked. See function comment above.
  return { mode: "off" };
}
