import { describe, expect, it } from "vitest";
import {
  assessEligibility,
  buildPolicySnapshot,
  capabilitiesAllowedForPhase,
  classifyRisk,
  resolveApprovalMode
} from "@reddwarf/policy";
import type { PlanningTaskInput } from "@reddwarf/contracts";

const baseInput: PlanningTaskInput = {
  source: {
    provider: "github",
    repo: "acme/platform",
    issueNumber: 7,
    issueUrl: "https://github.com/acme/platform/issues/7"
  },
  title: "Prepare planning artifacts",
  summary:
    "Prepare deterministic planning artifacts for the docs-only task in the platform repository.",
  priority: 1,
  labels: ["ai-eligible"],
  acceptanceCriteria: ["A planning spec exists"],
  affectedPaths: ["docs/guide.md"],
  requestedCapabilities: ["can_plan", "can_archive_evidence"],
  metadata: {}
};

describe("policy", () => {
  it("marks docs-only work as low risk", () => {
    expect(classifyRisk(baseInput)).toBe("low");
  });

  it("requires human signoff for code writing", () => {
    expect(
      resolveApprovalMode({
        phase: "development",
        riskClass: "medium",
        requestedCapabilities: ["can_write_code"]
      })
    ).toBe("human_signoff_required");
  });

  it("keeps code writing disabled by default in the development phase", () => {
    expect(capabilitiesAllowedForPhase("development", ["can_write_code"])).toBe(
      false
    );
    expect(
      capabilitiesAllowedForPhase("development", [
        "can_archive_evidence",
        "can_use_secrets"
      ])
    ).toBe(true);
  });

  it("allows review-only capabilities during the architecture review phase", () => {
    expect(
      capabilitiesAllowedForPhase("architecture_review", [
        "can_review",
        "can_archive_evidence"
      ])
    ).toBe(true);
    expect(
      capabilitiesAllowedForPhase("architecture_review", ["can_run_tests"])
    ).toBe(false);
    expect(
      capabilitiesAllowedForPhase("architecture_review", ["can_write_code"])
    ).toBe(false);
  });

  it("allows read-only validation capabilities during the validation phase", () => {
    expect(
      capabilitiesAllowedForPhase("validation", [
        "can_run_tests",
        "can_archive_evidence",
        "can_use_secrets"
      ])
    ).toBe(true);
    expect(capabilitiesAllowedForPhase("validation", ["can_write_code"])).toBe(
      false
    );
  });

  it("allows SCM capabilities only during the scm phase", () => {
    expect(
      capabilitiesAllowedForPhase("scm", [
        "can_open_pr",
        "can_archive_evidence"
      ])
    ).toBe(true);
    expect(capabilitiesAllowedForPhase("scm", ["can_use_secrets"])).toBe(
      false
    );
  });

  it("builds a policy snapshot with only the post-validation review phase still blocked", () => {
    const snapshot = buildPolicySnapshot(baseInput, "low", "auto");
    expect(snapshot.blockedPhases).toEqual(["review"]);
  });

  it("describes architecture review in the human-approval policy reason", () => {
    const snapshot = buildPolicySnapshot(
      {
        ...baseInput,
        affectedPaths: ["src/feature.ts"],
        requestedCapabilities: ["can_write_code"]
      },
      "medium",
      "human_signoff_required"
    );

    expect(snapshot.reasons[0]).toContain("architecture review now runs before validation");
  });

  it("grants scoped secrets only to non-high-risk tasks with explicit scopes", () => {
    const snapshot = buildPolicySnapshot(
      {
        ...baseInput,
        affectedPaths: ["src/integrations/secrets.ts"],
        requestedCapabilities: ["can_use_secrets"],
        metadata: {
          secretScopes: ["github_readonly", "npm_readonly"]
        }
      },
      "medium",
      "human_signoff_required"
    );

    expect(snapshot.allowedCapabilities).toContain("can_use_secrets");
    expect(snapshot.allowedSecretScopes).toEqual([
      "github_readonly",
      "npm_readonly"
    ]);
  });

  it("blocks tasks without the AI eligibility label", () => {
    const result = assessEligibility({
      ...baseInput,
      labels: []
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons[0]).toContain("ai-eligible");
  });
});
