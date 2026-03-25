import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

/** @type {import("eslint").Linter.FlatConfig[]} */
export default [
  {
    ignores: [
      ".corepack/**",
      "node_modules/**",
      "coverage/**",
      "packages/**/dist/**",
      "packages/**/src/**/*.d.ts"
    ]
  },
  {
    files: ["packages/**/*.ts", "tests/**/*.ts", "vitest.config.ts", "drizzle.config.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: false,
        sourceType: "module"
      }
    },
    plugins: {
      "@typescript-eslint": tsPlugin
    },
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "off"
    }
  }
];