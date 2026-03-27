import assert from "node:assert/strict";
import {
  openClawAgentRoleDefinitions,
  validateAllBootstrapAlignment,
  expectedBootstrapFileNames
} from "../packages/execution-plane/dist/index.js";
import { repoRoot, createScriptLogger, formatError } from "./lib/config.mjs";

const { log, logError } = createScriptLogger("verify-bootstrap-alignment");

try {
  log("Validating bootstrap file alignment for all OpenClaw agents...");

  const result = await validateAllBootstrapAlignment(
    openClawAgentRoleDefinitions,
    repoRoot
  );

  for (const agent of result.agents) {
    if (agent.valid) {
      log(`  ${agent.agentId}: ${agent.filesChecked} files OK`);
    } else {
      logError(`  ${agent.agentId}: ${agent.violations.length} violation(s)`);
      for (const v of agent.violations) {
        logError(`    [${v.kind}] ${v.relativePath}: ${v.message}`);
      }
    }
  }

  assert.equal(
    result.valid,
    true,
    `Bootstrap alignment failed with ${result.totalViolations} violation(s).`
  );

  // Verify expected file name mapping covers all kinds
  const expectedKinds = ["identity", "soul", "agents", "tools", "skill"];
  for (const kind of expectedKinds) {
    assert.ok(
      expectedBootstrapFileNames[kind],
      `Missing expected file name for bootstrap kind "${kind}".`
    );
  }

  log(
    `All ${result.agents.length} agents pass bootstrap alignment (${result.agents.reduce((s, a) => s + a.filesChecked, 0)} files checked).`
  );
} catch (err) {
  logError(formatError(err));
  process.exitCode = 1;
}
