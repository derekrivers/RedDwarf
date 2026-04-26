import { describe, expect, it } from "vitest";
import type { ProjectSpec } from "@reddwarf/contracts";
import {
  FixtureWorkflowSurveyAdapter,
  type RequiredChecksScaffoldAdapter,
  type WorkflowFileContent,
  type WorkflowSurveyAdapter
} from "@reddwarf/integrations";
import { ensureProjectAutoMergeReady } from "./project-auto-merge-readiness.js";

const NOW = "2026-04-26T17:00:00.000Z";

function buildProject(overrides: Partial<ProjectSpec> = {}): ProjectSpec {
  return {
    projectId: "project:p1",
    sourceIssueId: null,
    sourceRepo: "acme/platform",
    title: "Test",
    summary: "Test project for readiness helper.",
    projectSize: "small",
    status: "approved",
    complexityClassification: null,
    approvalDecision: "approve",
    decidedBy: "operator",
    decisionSummary: null,
    amendments: null,
    clarificationQuestions: null,
    clarificationAnswers: null,
    clarificationRequestedAt: null,
    autoMergeEnabled: true,
    autoMergePolicy: null,
    requiredCheckContract: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function buildScaffoldAdapter(opts: {
  rootFiles?: { path: string }[];
  alreadyPresent?: boolean;
}): RequiredChecksScaffoldAdapter & { putCalls: { repo: string; yaml: string }[] } {
  const putCalls: { repo: string; yaml: string }[] = [];
  return {
    putCalls,
    async listRepoRootFiles() {
      return opts.rootFiles ?? [];
    },
    async hasRequiredChecksWorkflow() {
      return opts.alreadyPresent === true;
    },
    async putRequiredChecksWorkflow(repo, yaml) {
      putCalls.push({ repo, yaml });
    }
  };
}

describe("M25 readiness — ensureProjectAutoMergeReady", () => {
  it("is a no-op when the project already carries a non-empty contract", async () => {
    const project = buildProject({
      requiredCheckContract: {
        requiredCheckNames: ["build", "test"],
        minimumCheckCount: 2,
        forbidSkipCi: true,
        forbidEmptyTestDiff: true
      }
    });
    const result = await ensureProjectAutoMergeReady(project, {
      workflowSurveyAdapter: new FixtureWorkflowSurveyAdapter(new Map()),
      scaffoldAdapter: buildScaffoldAdapter({})
    });
    expect(result.outcome).toBe("already_ready");
    expect(result.forceDisableAutoMerge).toBe(false);
    expect(result.project.requiredCheckContract).toEqual(
      project.requiredCheckContract
    );
  });

  it("populates contract from survey when target repo has CI workflows", async () => {
    const files: WorkflowFileContent[] = [
      {
        path: ".github/workflows/ci.yml",
        content:
          "on:\n  pull_request:\njobs:\n  build:\n    runs-on: ubuntu-latest\n  test:\n    runs-on: ubuntu-latest\n"
      }
    ];
    const surveyAdapter = new FixtureWorkflowSurveyAdapter(
      new Map([["acme/platform", files]])
    );
    const result = await ensureProjectAutoMergeReady(buildProject(), {
      workflowSurveyAdapter: surveyAdapter,
      scaffoldAdapter: buildScaffoldAdapter({})
    });
    expect(result.outcome).toBe("populated_from_survey");
    expect(result.project.requiredCheckContract?.requiredCheckNames).toEqual([
      "build",
      "test"
    ]);
    expect(result.forceDisableAutoMerge).toBe(false);
  });

  it("installs scaffold AND populates contract on greenfield Node repo", async () => {
    const surveyAdapter = new FixtureWorkflowSurveyAdapter(
      new Map([["acme/platform", []]])
    );
    const scaffoldAdapter = buildScaffoldAdapter({
      rootFiles: [{ path: "package.json" }]
    });
    const result = await ensureProjectAutoMergeReady(buildProject(), {
      workflowSurveyAdapter: surveyAdapter,
      scaffoldAdapter
    });
    expect(result.outcome).toBe("scaffolded_and_populated");
    expect(scaffoldAdapter.putCalls).toHaveLength(1);
    expect(result.project.requiredCheckContract?.requiredCheckNames).toEqual([
      "build",
      "lint",
      "test"
    ]);
    expect(result.forceDisableAutoMerge).toBe(false);
  });

  it("force-disables auto-merge when stack is unrecognised on greenfield repo", async () => {
    const surveyAdapter = new FixtureWorkflowSurveyAdapter(
      new Map([["acme/platform", []]])
    );
    const scaffoldAdapter = buildScaffoldAdapter({
      rootFiles: [{ path: "Makefile" }]
    });
    const result = await ensureProjectAutoMergeReady(buildProject(), {
      workflowSurveyAdapter: surveyAdapter,
      scaffoldAdapter
    });
    expect(result.outcome).toBe("scaffold_unsupported_stack");
    expect(result.forceDisableAutoMerge).toBe(true);
    expect(result.project.requiredCheckContract).toBeNull();
  });

  it("force-disables auto-merge when scaffold install throws", async () => {
    const surveyAdapter = new FixtureWorkflowSurveyAdapter(
      new Map([["acme/platform", []]])
    );
    const failing: RequiredChecksScaffoldAdapter = {
      async listRepoRootFiles() {
        return [{ path: "package.json" }];
      },
      async hasRequiredChecksWorkflow() {
        return false;
      },
      async putRequiredChecksWorkflow() {
        throw new Error("simulated 401 from GitHub");
      }
    };
    const result = await ensureProjectAutoMergeReady(buildProject(), {
      workflowSurveyAdapter: surveyAdapter,
      scaffoldAdapter: failing
    });
    expect(result.outcome).toBe("scaffold_failed");
    expect(result.forceDisableAutoMerge).toBe(true);
  });

  it("falls back to scaffold path when the survey throws", async () => {
    const failingSurvey: WorkflowSurveyAdapter = {
      async listWorkflowYamlFiles() {
        throw new Error("simulated 503");
      }
    };
    const scaffoldAdapter = buildScaffoldAdapter({
      rootFiles: [{ path: "package.json" }]
    });
    const result = await ensureProjectAutoMergeReady(buildProject(), {
      workflowSurveyAdapter: failingSurvey,
      scaffoldAdapter
    });
    // Surveyor returns hasNoWorkflows=true on error; scaffolds.
    expect(result.outcome).toBe("scaffolded_and_populated");
  });

  it("returns no_adapters when neither survey nor scaffold adapters supplied", async () => {
    const result = await ensureProjectAutoMergeReady(buildProject(), {});
    expect(result.outcome).toBe("no_adapters");
  });
});
