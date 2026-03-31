import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { generateOpenClawConfig, serializeOpenClawConfig } from "../packages/control-plane/dist/index.js";

function readBooleanEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function readListEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const workspaceRoot = args[0] ?? process.env.REDDWARF_OPENCLAW_WORKSPACE_ROOT ?? "runtime-data/openclaw-workspaces";
const outputPath = args[1] ?? process.env.REDDWARF_OPENCLAW_CONFIG_PATH ?? "runtime-data/openclaw.json";
const modelProvider = args[2] ?? process.env.REDDWARF_OPENCLAW_MODEL_PROVIDER;
const discordEnabled = readBooleanEnv("REDDWARF_OPENCLAW_DISCORD_ENABLED");
const discordGuildIds = readListEnv("REDDWARF_OPENCLAW_DISCORD_GUILD_IDS");
const discordRequireMention = readBooleanEnv(
  "REDDWARF_OPENCLAW_DISCORD_REQUIRE_MENTION",
  true
);

const resolvedWorkspaceRoot = resolve(workspaceRoot);
const resolvedOutputPath = resolve(outputPath);

const config = generateOpenClawConfig({
  workspaceRoot: resolvedWorkspaceRoot,
  ...(modelProvider ? { modelProvider } : {}),
  ...(discordEnabled
    ? {
        discord: {
          enabled: true,
          token:
            process.env.OPENCLAW_DISCORD_BOT_TOKEN ??
            process.env.DISCORD_BOT_TOKEN ??
            "",
          dmPolicy: process.env.REDDWARF_OPENCLAW_DISCORD_DM_POLICY ?? "pairing",
          groupPolicy:
            process.env.REDDWARF_OPENCLAW_DISCORD_GROUP_POLICY ?? "allowlist",
          ...(discordGuildIds.length > 0
            ? {
                guilds: Object.fromEntries(
                  discordGuildIds.map((guildId) => [
                    guildId,
                    {
                      enabled: true,
                      requireMention: discordRequireMention
                    }
                  ])
                )
              }
            : {}),
          commands: {
            native: true
          }
        }
      }
    : {})
});
const json = serializeOpenClawConfig(config);

writeFileSync(resolvedOutputPath, json, "utf8");
console.log(`Generated openclaw.json at ${resolvedOutputPath}`);
console.log(`  Workspace root: ${resolvedWorkspaceRoot}`);
if (modelProvider) {
  console.log(`  Model provider: ${modelProvider}`);
}
if (config.channels?.discord) {
  console.log("  Discord: enabled");
}
console.log(`  Agents: ${config.agents.list.map((agent) => agent.id).join(", ")}`);
