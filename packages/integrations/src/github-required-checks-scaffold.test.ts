import { describe, expect, it } from "vitest";
import {
  buildRequiredChecksWorkflowYaml,
  detectScaffoldStack,
  ensureRequiredChecksWorkflow,
  REDDWARF_REQUIRED_CHECKS_WORKFLOW_PATH,
  SCAFFOLD_REQUIRED_CHECK_NAMES,
  type RequiredChecksScaffoldAdapter,
  type ScaffoldRepoFile
} from "./github-required-checks-scaffold.js";
import { parseWorkflowJobNames } from "./github-workflow-survey.js";

describe("M25 F-192 — detectScaffoldStack", () => {
  it("detects Node from package.json", () => {
    expect(detectScaffoldStack([{ path: "package.json" }, { path: "src" }])).toEqual({
      stack: "node",
      signals: ["package.json"]
    });
  });

  it("detects Python from pyproject.toml", () => {
    expect(detectScaffoldStack([{ path: "pyproject.toml" }, { path: "tests" }])).toEqual({
      stack: "python",
      signals: ["pyproject.toml"]
    });
  });

  it("detects Python from requirements.txt when pyproject.toml absent", () => {
    expect(detectScaffoldStack([{ path: "requirements.txt" }])).toEqual({
      stack: "python",
      signals: ["requirements.txt"]
    });
  });

  it("detects Rust from Cargo.toml", () => {
    expect(detectScaffoldStack([{ path: "Cargo.toml" }, { path: "src" }])).toEqual({
      stack: "rust",
      signals: ["Cargo.toml"]
    });
  });

  it("returns unknown when no recognized manifest is present", () => {
    expect(detectScaffoldStack([{ path: "Makefile" }, { path: "README.md" }])).toEqual({
      stack: "unknown",
      signals: []
    });
  });

  it("prefers Node over Python when both manifests exist (precedence)", () => {
    expect(
      detectScaffoldStack([{ path: "package.json" }, { path: "pyproject.toml" }])
    ).toEqual({ stack: "node", signals: ["package.json"] });
  });
});

describe("M25 F-192 — buildRequiredChecksWorkflowYaml", () => {
  it.each(["node", "python", "rust"] as const)(
    "produces lint, build, test job ids for stack=%s that the F-191 surveyor extracts",
    (stack) => {
      const yaml = buildRequiredChecksWorkflowYaml(stack);
      const jobs = parseWorkflowJobNames(yaml);
      expect(jobs.sort()).toEqual([...SCAFFOLD_REQUIRED_CHECK_NAMES].sort());
    }
  );

  it("throws when called with stack=unknown (caller must short-circuit)", () => {
    expect(() => buildRequiredChecksWorkflowYaml("unknown")).toThrow(
      /short-circuit/
    );
  });
});

describe("M25 F-192 — ensureRequiredChecksWorkflow", () => {
  function buildFixtureAdapter(opts: {
    files?: ScaffoldRepoFile[];
    alreadyPresent?: boolean;
  }): RequiredChecksScaffoldAdapter & {
    putCalls: { repo: string; yaml: string }[];
  } {
    const putCalls: { repo: string; yaml: string }[] = [];
    return {
      putCalls,
      async listRepoRootFiles() {
        return opts.files ?? [];
      },
      async hasRequiredChecksWorkflow() {
        return opts.alreadyPresent === true;
      },
      async putRequiredChecksWorkflow(repo, yaml) {
        putCalls.push({ repo, yaml });
      }
    };
  }

  it("installs the Node workflow when package.json exists", async () => {
    const adapter = buildFixtureAdapter({ files: [{ path: "package.json" }] });
    const result = await ensureRequiredChecksWorkflow(adapter, "acme/platform");
    expect(result.installed).toBe(true);
    expect(result.stack).toBe("node");
    expect(adapter.putCalls).toHaveLength(1);
    expect(adapter.putCalls[0]?.yaml).toContain("RedDwarf Required Checks");
    expect(parseWorkflowJobNames(adapter.putCalls[0]!.yaml).sort()).toEqual([
      "build",
      "lint",
      "test"
    ]);
  });

  it("skips with reason 'already_present' when the file exists (idempotency)", async () => {
    const adapter = buildFixtureAdapter({
      files: [{ path: "package.json" }],
      alreadyPresent: true
    });
    const result = await ensureRequiredChecksWorkflow(adapter, "acme/platform");
    expect(result).toEqual({
      installed: false,
      skipped: true,
      stack: "unknown",
      signals: [],
      reason: "already_present"
    });
    expect(adapter.putCalls).toHaveLength(0);
  });

  it("skips with reason 'no_recognized_manifest' on greenfield repos", async () => {
    const adapter = buildFixtureAdapter({ files: [{ path: "README.md" }] });
    const result = await ensureRequiredChecksWorkflow(adapter, "acme/platform");
    expect(result).toEqual({
      installed: false,
      skipped: true,
      stack: "unknown",
      signals: [],
      reason: "no_recognized_manifest"
    });
    expect(adapter.putCalls).toHaveLength(0);
  });

  it("uses the canonical workflow path", () => {
    expect(REDDWARF_REQUIRED_CHECKS_WORKFLOW_PATH).toBe(
      ".github/workflows/reddwarf-required-checks.yml"
    );
  });
});
