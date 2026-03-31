import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { generateOpenClawConfig, serializeOpenClawConfig } from "../packages/control-plane/dist/index.js";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const workspaceRoot = args[0] ?? process.env.REDDWARF_OPENCLAW_WORKSPACE_ROOT ?? "runtime-data/openclaw-workspaces";
const outputPath = args[1] ?? process.env.REDDWARF_OPENCLAW_CONFIG_PATH ?? "runtime-data/openclaw.json";
const modelProvider = args[2] ?? process.env.REDDWARF_OPENCLAW_MODEL_PROVIDER;

const resolvedWorkspaceRoot = resolve(workspaceRoot);
const resolvedOutputPath = resolve(outputPath);

const config = generateOpenClawConfig({
  workspaceRoot: resolvedWorkspaceRoot,
  ...(modelProvider ? { modelProvider } : {})
});
const json = serializeOpenClawConfig(config);

writeFileSync(resolvedOutputPath, json, "utf8");
console.log(`Generated openclaw.json at ${resolvedOutputPath}`);
console.log(`  Workspace root: ${resolvedWorkspaceRoot}`);
if (modelProvider) {
  console.log(`  Model provider: ${modelProvider}`);
}
console.log(`  Agents: ${config.agents.list.map((agent) => agent.id).join(", ")}`);
