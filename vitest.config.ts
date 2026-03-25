import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@reddwarf/contracts": resolve("packages/contracts/src/index.ts"),
      "@reddwarf/policy": resolve("packages/policy/src/index.ts"),
      "@reddwarf/control-plane": resolve("packages/control-plane/src/index.ts"),
      "@reddwarf/execution-plane": resolve("packages/execution-plane/src/index.ts"),
      "@reddwarf/evidence": resolve("packages/evidence/src/index.ts"),
      "@reddwarf/integrations": resolve("packages/integrations/src/index.ts")
    }
  },
  test: {
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"],
      include: ["packages/*/src/**/*.ts"]
    }
  }
});
