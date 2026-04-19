import { describe, expect, it } from "vitest";
import {
  evaluateContractViolations,
  summariseContractViolations
} from "./contract-check.js";

const baseSnapshot = { deniedPaths: [".git/**", ".env", "**/.env"] };

describe("evaluateContractViolations", () => {
  it("returns no violations for an empty diff", () => {
    expect(
      evaluateContractViolations({
        changedFiles: [],
        requestedCapabilities: [],
        policySnapshot: baseSnapshot
      })
    ).toEqual([]);
  });

  it("flags a denied path", () => {
    const violations = evaluateContractViolations({
      changedFiles: [".env", "src/app.ts"],
      requestedCapabilities: ["can_write_code"],
      policySnapshot: baseSnapshot
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      kind: "denied_path",
      file: ".env"
    });
  });

  it("flags package.json mutation when can_modify_dependencies is missing", () => {
    const violations = evaluateContractViolations({
      changedFiles: ["package.json", "pnpm-lock.yaml", "src/app.ts"],
      requestedCapabilities: ["can_write_code"],
      policySnapshot: baseSnapshot
    });
    expect(violations.map((v) => v.file).sort()).toEqual([
      "package.json",
      "pnpm-lock.yaml"
    ]);
    expect(violations.every((v) => v.kind === "dependency_mutation")).toBe(true);
  });

  it("does not flag dependency files when capability is granted", () => {
    const violations = evaluateContractViolations({
      changedFiles: ["package.json"],
      requestedCapabilities: ["can_modify_dependencies"],
      policySnapshot: baseSnapshot
    });
    expect(violations).toEqual([]);
  });

  it("flags schema drift in drizzle/migrations/schema files", () => {
    const violations = evaluateContractViolations({
      changedFiles: [
        "packages/evidence/drizzle/0099_add_thing.sql",
        "src/db/schema.ts",
        "migrations/2025_01_01.sql",
        "src/unrelated.ts"
      ],
      requestedCapabilities: ["can_write_code"],
      policySnapshot: baseSnapshot
    });
    expect(violations.length).toBe(3);
    expect(violations.every((v) => v.kind === "schema_drift")).toBe(true);
  });

  it("does not flag schema files when can_modify_schema is granted", () => {
    const violations = evaluateContractViolations({
      changedFiles: ["packages/evidence/drizzle/0099_add_thing.sql"],
      requestedCapabilities: ["can_modify_schema"],
      policySnapshot: baseSnapshot
    });
    expect(violations).toEqual([]);
  });

  it("flags large files using the configured threshold", () => {
    const violations = evaluateContractViolations({
      changedFiles: ["src/big.ts", "src/small.ts"],
      requestedCapabilities: ["can_write_code"],
      policySnapshot: baseSnapshot,
      fileSizes: new Map([
        ["src/big.ts", 2_000_000],
        ["src/small.ts", 1024]
      ]),
      largeFileBytes: 1_500_000
    });
    expect(violations).toEqual([
      expect.objectContaining({ kind: "large_file", file: "src/big.ts" })
    ]);
  });

  it("flags binary file extensions and explicit binary entries", () => {
    const violations = evaluateContractViolations({
      changedFiles: ["assets/logo.png", "src/app.ts", "data/bundle.bin"],
      requestedCapabilities: ["can_write_code"],
      policySnapshot: baseSnapshot,
      binaryFiles: ["data/bundle.bin"]
    });
    const files = violations.map((v) => v.file).sort();
    expect(files).toEqual(["assets/logo.png", "data/bundle.bin"]);
    expect(violations.every((v) => v.kind === "binary_file")).toBe(true);
  });

  it("does not double-count when a file matches multiple kinds", () => {
    // .env hits denied_path; ensure the same file isn't also added as binary
    // or anything else.
    const violations = evaluateContractViolations({
      changedFiles: [".env"],
      requestedCapabilities: [],
      policySnapshot: baseSnapshot
    });
    expect(violations).toHaveLength(1);
  });
});

describe("summariseContractViolations", () => {
  it("returns the no-violations message when empty", () => {
    expect(summariseContractViolations([])).toBe("No contract violations.");
  });

  it("aggregates counts by kind sorted by frequency", () => {
    const summary = summariseContractViolations([
      { kind: "dependency_mutation", file: "package.json", reason: "" },
      { kind: "dependency_mutation", file: "pnpm-lock.yaml", reason: "" },
      { kind: "denied_path", file: ".env", reason: "" }
    ]);
    expect(summary).toBe(
      "3 contract violation(s): 2 dependency_mutation, 1 denied_path."
    );
  });
});
