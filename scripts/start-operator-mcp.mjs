#!/usr/bin/env node

import { runOperatorMcpStdioServer } from "../packages/control-plane/dist/index.js";
import { loadRepoEnv } from "./lib/repo-env.mjs";

await loadRepoEnv();
await runOperatorMcpStdioServer();
