import type { OpenClawAgentRoleDefinition } from "@reddwarf/contracts";

// Browser-safe subset of the canonical OpenClaw role definitions used by the
// operator dashboard. Keep this file aligned with createOpenClawAgentRoleDefinitions
// in src/index.ts so UI surfaces can reuse the same agent metadata without
// importing Node-only execution helpers.
export const dashboardAgentRoleDefinitions: Pick<
  OpenClawAgentRoleDefinition,
  "agentId" | "role" | "displayName" | "purpose" | "runtimePolicy"
>[] = [
  {
    agentId: "reddwarf-coordinator",
    role: "coordinator",
    displayName: "RedDwarf Coordinator",
    purpose:
      "Frames RedDwarf-approved work inside OpenClaw, preserves task boundaries, and delegates bounded analysis or validation work.",
    runtimePolicy: {
      toolProfile: "full",
      allow: ["group:fs", "group:sessions", "group:openclaw"],
      deny: ["group:automation", "group:messaging", "group:nodes"],
      sandboxMode: "read_only",
      model: {
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4-6"
      }
    }
  },
  {
    agentId: "reddwarf-analyst",
    role: "analyst",
    displayName: "RedDwarf Analyst",
    purpose:
      "Performs read-only codebase analysis, planning support, and evidence-friendly synthesis inside the approved task boundary.",
    runtimePolicy: {
      toolProfile: "full",
      allow: ["group:fs", "group:web", "group:openclaw"],
      deny: ["group:automation", "group:messaging"],
      sandboxMode: "read_only",
      model: {
        provider: "anthropic",
        model: "anthropic/claude-opus-4-6"
      }
    }
  },
  {
    agentId: "reddwarf-arch-reviewer",
    role: "reviewer",
    displayName: "RedDwarf Architecture Reviewer",
    purpose:
      "Checks implementation against the approved planning spec, flags structural drift, and emits a structured conformance verdict without rewriting code.",
    runtimePolicy: {
      toolProfile: "full",
      allow: ["group:fs", "group:openclaw"],
      deny: ["group:automation", "group:messaging", "group:runtime"],
      sandboxMode: "workspace_write",
      model: {
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4-6"
      }
    }
  },
  {
    agentId: "reddwarf-validator",
    role: "validator",
    displayName: "RedDwarf Validator",
    purpose:
      "Runs bounded checks, reviews evidence, and reports findings without expanding scope or mutating product code.",
    runtimePolicy: {
      toolProfile: "full",
      allow: ["group:fs", "group:runtime", "group:openclaw"],
      deny: ["group:automation", "group:messaging"],
      sandboxMode: "workspace_write",
      model: {
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4-6"
      }
    }
  },
  {
    agentId: "reddwarf-developer",
    role: "developer",
    displayName: "RedDwarf Developer",
    purpose:
      "Implements approved architecture plans safely and within scope, producing code changes, test updates, and a clear review handoff.",
    runtimePolicy: {
      toolProfile: "full",
      allow: ["group:fs", "group:runtime", "group:openclaw"],
      deny: ["group:automation", "group:messaging"],
      sandboxMode: "workspace_write",
      model: {
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4-6"
      }
    }
  }
];
