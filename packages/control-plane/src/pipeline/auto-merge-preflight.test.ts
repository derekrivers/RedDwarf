import { describe, expect, it } from "vitest";
import {
  buildPreflightCommentBody,
  evaluateAutoMergePreflight,
  type AutoMergePreflightInput
} from "./auto-merge-preflight.js";
import type { RequiredCheckContract } from "@reddwarf/contracts";

function buildContract(overrides: Partial<RequiredCheckContract> = {}): RequiredCheckContract {
  return {
    requiredCheckNames: ["build", "test"],
    minimumCheckCount: 2,
    forbidSkipCi: true,
    forbidEmptyTestDiff: true,
    ...overrides
  };
}

function baseInput(overrides: Partial<AutoMergePreflightInput> = {}): AutoMergePreflightInput {
  return {
    project: { autoMergeEnabled: true, requiredCheckContract: buildContract() },
    ticket: {
      ticketId: "project:p1:ticket:1",
      riskClass: "low",
      requiredCheckContract: null
    },
    surveyedCheckNames: ["build", "test"],
    prFiles: [{ path: "tests/foo.test.ts" }, { path: "src/foo.ts" }],
    commitMessages: ["feat: add foo"],
    prLabels: [],
    prBaseRef: "main",
    expectedBaseRef: "main",
    ...overrides
  };
}

describe("M25 F-195 — evaluateAutoMergePreflight", () => {
  it("skips entirely when the project did not opt into auto-merge", () => {
    const result = evaluateAutoMergePreflight(
      baseInput({ project: { autoMergeEnabled: false, requiredCheckContract: null } })
    );
    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("passes when every check is satisfied", () => {
    expect(evaluateAutoMergePreflight(baseInput())).toEqual({
      skipped: false,
      passed: true,
      violations: []
    });
  });

  it("violates 'empty_contract' and short-circuits when contract is null", () => {
    const result = evaluateAutoMergePreflight(
      baseInput({
        project: { autoMergeEnabled: true, requiredCheckContract: null }
      })
    );
    expect(result.passed).toBe(false);
    expect(result.violations.map((v) => v.kind)).toEqual(["empty_contract"]);
  });

  it("violates 'wrong_base_branch' when prBaseRef differs from expectedBaseRef", () => {
    const result = evaluateAutoMergePreflight(
      baseInput({ prBaseRef: "develop", expectedBaseRef: "main" })
    );
    expect(result.passed).toBe(false);
    expect(result.violations.map((v) => v.kind)).toContain("wrong_base_branch");
  });

  it("violates 'missing_required_check' when contract names a check the surveyor did not find", () => {
    const result = evaluateAutoMergePreflight(
      baseInput({
        project: {
          autoMergeEnabled: true,
          requiredCheckContract: buildContract({ requiredCheckNames: ["build", "deploy"] })
        }
      })
    );
    expect(result.passed).toBe(false);
    expect(result.violations.map((v) => v.kind)).toContain("missing_required_check");
    expect(result.violations[0]?.detail).toMatch(/deploy/);
  });

  it("violates 'skip_ci_commit' when forbidSkipCi and a commit contains [skip ci]", () => {
    const result = evaluateAutoMergePreflight(
      baseInput({ commitMessages: ["docs: fix typo [skip ci]"] })
    );
    expect(result.passed).toBe(false);
    expect(result.violations.map((v) => v.kind)).toContain("skip_ci_commit");
  });

  it("violates 'no_test_diff' when forbidEmptyTestDiff and PR has no test files", () => {
    const result = evaluateAutoMergePreflight(
      baseInput({ prFiles: [{ path: "src/foo.ts" }, { path: "README.md" }] })
    );
    expect(result.passed).toBe(false);
    expect(result.violations.map((v) => v.kind)).toContain("no_test_diff");
  });

  it("docs-only label suppresses no_test_diff violation", () => {
    const result = evaluateAutoMergePreflight(
      baseInput({
        prFiles: [{ path: "README.md" }],
        prLabels: ["docs-only"]
      })
    );
    expect(result.passed).toBe(true);
  });

  it("violates 'high_risk_ticket' when ticket riskClass=high", () => {
    const result = evaluateAutoMergePreflight(
      baseInput({
        ticket: { ticketId: "t-1", riskClass: "high", requiredCheckContract: null }
      })
    );
    expect(result.passed).toBe(false);
    expect(result.violations.map((v) => v.kind)).toContain("high_risk_ticket");
  });

  it("collects multiple violations in one pass when several gates fail", () => {
    const result = evaluateAutoMergePreflight(
      baseInput({
        prBaseRef: "develop",
        commitMessages: ["fix [skip ci]"],
        ticket: { ticketId: "t-1", riskClass: "high", requiredCheckContract: null }
      })
    );
    const kinds = result.violations.map((v) => v.kind);
    expect(kinds).toContain("wrong_base_branch");
    expect(kinds).toContain("skip_ci_commit");
    expect(kinds).toContain("high_risk_ticket");
  });
});

describe("M25 F-195 — buildPreflightCommentBody", () => {
  it("renders a single deduped comment with the marker and a needs-human-merge escape hatch hint", () => {
    const body = buildPreflightCommentBody({
      skipped: false,
      passed: false,
      violations: [
        { kind: "missing_required_check", detail: "test is missing" }
      ]
    });
    expect(body).toContain("<!-- reddwarf:auto-merge-preflight -->");
    expect(body).toContain("missing_required_check");
    expect(body).toContain("needs-human-merge");
  });
});
