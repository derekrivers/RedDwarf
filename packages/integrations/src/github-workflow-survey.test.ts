import { describe, expect, it } from "vitest";
import {
  buildRequiredCheckContractFromSurvey,
  FixtureWorkflowSurveyAdapter,
  parseWorkflowJobNames,
  surveyWorkflowFiles,
  type WorkflowFileContent
} from "./github-workflow-survey.js";

describe("M25 F-191 — parseWorkflowJobNames", () => {
  it("extracts job ids from a standard CI workflow", () => {
    const yaml = `
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run build
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;
    expect(parseWorkflowJobNames(yaml)).toEqual(["build", "test"]);
  });

  it("prefers the job's name override when present", () => {
    const yaml = `
jobs:
  unit:
    name: Unit tests
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
  lint:
    runs-on: ubuntu-latest
    name: "Lint code"
    steps:
      - run: eslint .
`;
    expect(parseWorkflowJobNames(yaml)).toEqual(["Lint code", "Unit tests"]);
  });

  it("returns an empty list for a YAML file with no jobs key", () => {
    const yaml = `
name: not-a-workflow
on: push
`;
    expect(parseWorkflowJobNames(yaml)).toEqual([]);
  });

  it("ignores commented-out jobs", () => {
    const yaml = `
jobs:
  build:
    runs-on: ubuntu-latest
  # disabled:
  #   runs-on: ubuntu-latest
`;
    expect(parseWorkflowJobNames(yaml)).toEqual(["build"]);
  });

  it("dedupes identical job ids across blocks (defensive)", () => {
    const yaml = `
jobs:
  build:
    runs-on: ubuntu-latest
jobs:
  build:
    runs-on: ubuntu-latest
`;
    // Tolerates a reset back into jobs: even though it's nonsensical YAML.
    expect(parseWorkflowJobNames(yaml)).toEqual(["build"]);
  });

  it("returns sorted, deduplicated names across multiple jobs blocks", () => {
    const yaml = `
jobs:
  zeta:
    runs-on: ubuntu-latest
  alpha:
    runs-on: ubuntu-latest
  beta:
    runs-on: ubuntu-latest
`;
    expect(parseWorkflowJobNames(yaml)).toEqual(["alpha", "beta", "zeta"]);
  });
});

describe("M25 F-191 — surveyWorkflowFiles", () => {
  // AC-1: fixture repo with build + test jobs → contract carries both names.
  it("returns a sorted union of check names across every workflow file", async () => {
    const files: WorkflowFileContent[] = [
      {
        path: ".github/workflows/ci.yml",
        content: "jobs:\n  build:\n    runs-on: ubuntu-latest\n  test:\n    runs-on: ubuntu-latest\n"
      },
      {
        path: ".github/workflows/lint.yml",
        content: "jobs:\n  lint:\n    name: Lint code\n    runs-on: ubuntu-latest\n"
      }
    ];
    const adapter = new FixtureWorkflowSurveyAdapter(
      new Map([["acme/platform", files]])
    );
    const survey = await surveyWorkflowFiles(adapter, "acme/platform");
    expect(survey.checkNames).toEqual(["Lint code", "build", "test"]);
    expect(survey.workflowFiles).toEqual([
      ".github/workflows/ci.yml",
      ".github/workflows/lint.yml"
    ]);
    expect(survey.hasNoWorkflows).toBe(false);
  });

  // AC-2: greenfield repo (no workflow files) → empty contract + flag.
  it("flags hasNoWorkflows when the adapter returns an empty list", async () => {
    const adapter = new FixtureWorkflowSurveyAdapter(
      new Map([["greenfield/repo", []]])
    );
    const survey = await surveyWorkflowFiles(adapter, "greenfield/repo");
    expect(survey.checkNames).toEqual([]);
    expect(survey.hasNoWorkflows).toBe(true);
  });

  it("treats adapter errors as 'no workflows' and never throws", async () => {
    const failing: import("./github-workflow-survey.js").WorkflowSurveyAdapter = {
      async listWorkflowYamlFiles() {
        throw new Error("simulated GitHub 500");
      }
    };
    const survey = await surveyWorkflowFiles(failing, "acme/platform");
    expect(survey.checkNames).toEqual([]);
    expect(survey.hasNoWorkflows).toBe(true);
  });
});

describe("M25 F-191 — buildRequiredCheckContractFromSurvey", () => {
  it("returns null when the survey has no check names (AC-2 greenfield)", () => {
    const contract = buildRequiredCheckContractFromSurvey({
      checkNames: [],
      workflowFiles: [],
      hasNoWorkflows: true
    });
    expect(contract).toBeNull();
  });

  // AC-1: contract built from a real survey carries every surveyed name and
  // defaults forbidSkipCi/forbidEmptyTestDiff to true.
  it("produces a strict contract from a non-empty survey", () => {
    const contract = buildRequiredCheckContractFromSurvey({
      checkNames: ["build", "test"],
      workflowFiles: [".github/workflows/ci.yml"],
      hasNoWorkflows: false
    });
    expect(contract).toEqual({
      requiredCheckNames: ["build", "test"],
      minimumCheckCount: 2,
      forbidSkipCi: true,
      forbidEmptyTestDiff: true,
      rationale: "Surveyed from 1 workflow file(s): .github/workflows/ci.yml"
    });
  });

  // AC-3: the surveyor is the only source of truth for check names.
  // Names that aren't in the surveyed list cannot enter the contract,
  // because the contract is BUILT from the survey rather than parsed
  // from a model handoff.
  it("never returns check names that were not in the surveyed YAML", () => {
    const contract = buildRequiredCheckContractFromSurvey({
      checkNames: ["build"],
      workflowFiles: [".github/workflows/ci.yml"],
      hasNoWorkflows: false
    });
    expect(contract?.requiredCheckNames).toEqual(["build"]);
    // Hypothetical malicious model output ("deploy", "secret-leak-check")
    // never makes it into the contract — the function only reads the
    // survey's checkNames as input. This is the deterministic guarantee.
  });
});
