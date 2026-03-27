import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { generateOpenClawConfig, serializeOpenClawConfig } from "../packages/control-plane/dist/index.js";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const workspaceRoot = args[0] ?? process.env.REDDWARF_OPENCLAW_WORKSPACE_ROOT ?? "runtime-data/openclaw-workspaces";
const outputPath = args[1] ?? process.env.REDDWARF_OPENCLAW_CONFIG_PATH ?? "runtime-data/openclaw.json";

const resolvedWorkspaceRoot = resolve(workspaceRoot);
const resolvedOutputPath = resolve(outputPath);

const config = generateOpenClawConfig({ workspaceRoot: resolvedWorkspaceRoot });
const json = serializeOpenClawConfig(config);

writeFileSync(resolvedOutputPath, json, "utf8");
console.log(`Generated openclaw.json at ${resolvedOutputPath}`);
console.log(`  Workspace root: ${resolvedWorkspaceRoot}`);
console.log(`  Agents: ${Object.keys(config.agents).filter((k) => k !== "defaults").join(", ")}`);
