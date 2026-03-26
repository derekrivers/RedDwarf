import { describe, expect, it } from "vitest";
import {
  assessEligibility,
  buildPolicySnapshot,
  classifyRisk,
  resolveApprovalMode,
  capabilitiesAllowedForPhase
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
      capabilitiesAllowedForPhase("development", ["can_archive_evidence"])
    ).toBe(true);
  });

  it("builds a policy snapshot with blocked future phases", () => {
    const snapshot = buildPolicySnapshot(baseInput, "low", "auto");
    expect(snapshot.blockedPhases).toEqual(["validation", "review", "scm"]);
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
