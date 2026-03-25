import { resolve } from "node:path";
import { validatePolicyPackRoot } from "./lib/policy-packaging.mjs";

const targetRoot = resolve(process.argv[2] ?? process.cwd());
await validatePolicyPackRoot(targetRoot);
