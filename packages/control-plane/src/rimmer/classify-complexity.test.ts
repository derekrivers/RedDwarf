import { describe, expect, it } from "vitest";
import { classifyComplexity } from "./classify-complexity.js";

describe("classifyComplexity", () => {
  const baseInput = {
    summary: "Add a button to the settings page.",
    acceptanceCriteria: ["Button renders"],
    affectedPaths: ["packages/dashboard/src/settings.tsx"],
    requestedCapabilities: ["can_plan", "can_write_code"],
    labels: ["ai-eligible"],
    metadata: {}
  };

  it("classifies a single-package, low-criteria request as small", () => {
    const result = classifyComplexity(baseInput);
    expect(result.size).toBe("small");
    expect(result.signals).toEqual([]);
    expect(result.reasoning).toContain("small");
  });

  it("classifies a request touching 2-4 packages as medium", () => {
    const result = classifyComplexity({
      ...baseInput,
      summary: "Add a new integration adapter for Discord.",
      affectedPaths: [
        "packages/integrations/src/discord.ts",
        "packages/contracts/src/enums.ts",
        "packages/control-plane/src/polling.ts"
      ],
      acceptanceCriteria: [
        "Adapter implements sendMessage",
        "Adapter implements readThreadReplies",
        "V1MutationDisabledError guard",
        "Required env vars validated"
      ]
    });
    expect(result.size).toBe("medium");
    expect(result.signals.some((s) => s.includes("packages touched"))).toBe(true);
  });

  it("classifies a request spanning 5+ packages with schema changes as large", () => {
    const result = classifyComplexity({
      ...baseInput,
      summary: "Add project mode with new schema migration, cross-cutting refactor of the planning pipeline.",
      affectedPaths: [
        "packages/contracts/src/planning.ts",
        "packages/evidence/src/schema.ts",
        "packages/control-plane/src/pipeline/planning.ts",
        "packages/integrations/src/github.ts",
        "packages/execution-plane/src/architect.ts",
        "packages/policy/src/index.ts"
      ],
      acceptanceCriteria: [
        "ProjectSpec schema created",
        "TicketSpec schema created",
        "Repositories implemented",
        "Holly planning refactored",
        "Classifier added",
        "Operator API extended",
        "GitHub Issues adapter added",
        "Actions workflow added"
      ],
      requestedCapabilities: ["can_plan", "can_write_code", "can_modify_schema"],
      labels: ["project-mode"]
    });
    expect(result.size).toBe("large");
    expect(result.signals.length).toBeGreaterThanOrEqual(3);
  });

  it("classifies requests with sensitive capabilities as higher complexity", () => {
    const result = classifyComplexity({
      ...baseInput,
      summary: "Update the secrets adapter to support a new migration pattern.",
      requestedCapabilities: ["can_plan", "can_write_code", "can_modify_schema", "can_use_secrets"] as const
    });
    expect(result.size).not.toBe("small");
    expect(result.signals.some((s) => s.includes("sensitive capabilities"))).toBe(true);
  });

  it("respects project-mode labels", () => {
    const result = classifyComplexity({
      ...baseInput,
      labels: ["ai-eligible", "project-mode"]
    });
    expect(result.size).toBe("medium");
    expect(result.signals.some((s) => s.includes("project labels"))).toBe(true);
  });

  it("detects complexity keywords in the summary", () => {
    const result = classifyComplexity({
      ...baseInput,
      summary: "Add a new API endpoint with a breaking change to the schema migration."
    });
    expect(result.signals.some((s) => s.includes("complexity keywords"))).toBe(true);
  });

  it("routes small classifications through existing single-issue path unchanged", () => {
    const result = classifyComplexity({
      summary: "Fix a typo in the README file.",
      acceptanceCriteria: ["Typo fixed"],
      affectedPaths: ["README.md"],
      requestedCapabilities: ["can_plan"],
      labels: ["ai-eligible"],
      metadata: {}
    });
    expect(result.size).toBe("small");
  });
});
