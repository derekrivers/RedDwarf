import type {
  ApprovalMode,
  Capability,
  PlanningTaskInput,
  PolicySnapshot,
  RiskClass,
  TaskPhase
} from "@reddwarf/contracts";

const V1_POLICY_VERSION = "reddwarf-v1";

const lowRiskPatterns = [/^docs\//i, /^tests?\//i, /\.md$/i, /^README/i];
const highRiskPatterns = [
  /auth/i,
  /billing/i,
  /secret/i,
  /infra/i,
  /deploy/i,
  /migration/i
];
const disabledPhases: TaskPhase[] = ["review"];
const planningCapabilities: Capability[] = ["can_plan", "can_archive_evidence"];
const developmentCapabilities: Capability[] = [
  "can_archive_evidence",
  "can_use_secrets"
];
const validationCapabilities: Capability[] = [
  "can_run_tests",
  "can_archive_evidence",
  "can_use_secrets"
];
const scmCapabilities: Capability[] = ["can_open_pr", "can_archive_evidence"];

export interface EligibilityAssessment {
  eligible: boolean;
  reasons: string[];
}

export interface ApprovalResolutionInput {
  phase: TaskPhase;
  riskClass: RiskClass;
  requestedCapabilities: Capability[];
}

export function assessEligibility(
  input: PlanningTaskInput
): EligibilityAssessment {
  const reasons: string[] = [];
  const labels = new Set(input.labels.map((label) => label.toLowerCase()));

  if (!labels.has("ai-eligible") && !labels.has("ai-ready")) {
    reasons.push("Task is missing the ai-eligible or ai-ready label.");
  }

  if (input.acceptanceCriteria.length === 0) {
    reasons.push("Task requires at least one acceptance criterion.");
  }

  if (input.summary.trim().length < 40) {
    reasons.push("Task summary is too short for deterministic planning.");
  }

  return {
    eligible: reasons.length === 0,
    reasons
  };
}

export function classifyRisk(input: PlanningTaskInput): RiskClass {
  const touchesHighRiskPath = input.affectedPaths.some((path) =>
    highRiskPatterns.some((pattern) => pattern.test(path))
  );
  const touchesLowRiskOnly =
    input.affectedPaths.length > 0 &&
    input.affectedPaths.every((path) =>
      lowRiskPatterns.some((pattern) => pattern.test(path))
    );
  const requestsSensitiveCapability = input.requestedCapabilities.some(
    (capability) =>
      ["can_open_pr", "can_touch_sensitive_paths", "can_modify_schema"].includes(
        capability
      )
  );

  if (touchesHighRiskPath || requestsSensitiveCapability) {
    return "high";
  }

  if (touchesLowRiskOnly) {
    return "low";
  }

  return "medium";
}

export function resolveApprovalMode(
  input: ApprovalResolutionInput
): ApprovalMode {
  if (
    ["intake", "eligibility", "planning", "policy_gate", "archive"].includes(
      input.phase
    ) &&
    input.requestedCapabilities.every((capability) =>
      planningCapabilities.includes(capability)
    )
  ) {
    return "auto";
  }

  if (
    input.requestedCapabilities.some((capability) =>
      [
        "can_write_code",
        "can_use_secrets",
        "can_open_pr",
        "can_touch_sensitive_paths"
      ].includes(capability)
    )
  ) {
    return "human_signoff_required";
  }

  if (input.riskClass === "high") {
    return "human_signoff_required";
  }

  if (input.riskClass === "medium") {
    return "review_required";
  }

  return "auto";
}

export function capabilitiesAllowedForPhase(
  phase: TaskPhase,
  requestedCapabilities: Capability[]
): boolean {
  if (phase === "planning") {
    return requestedCapabilities.every((capability) =>
      planningCapabilities.includes(capability)
    );
  }

  if (phase === "development") {
    return requestedCapabilities.every((capability) =>
      developmentCapabilities.includes(capability)
    );
  }

  if (phase === "validation") {
    return requestedCapabilities.every((capability) =>
      validationCapabilities.includes(capability)
    );
  }

  if (phase === "scm") {
    return requestedCapabilities.every((capability) =>
      scmCapabilities.includes(capability)
    );
  }

  return true;
}

export function createAllowedPaths(
  input: PlanningTaskInput,
  riskClass: RiskClass
): string[] {
  if (input.affectedPaths.length > 0) {
    return [...new Set(input.affectedPaths)];
  }

  if (riskClass === "low") {
    return ["docs/**", "tests/**", "*.md"];
  }

  if (riskClass === "medium") {
    return ["src/**", "docs/**", "tests/**"];
  }

  return [];
}

export function buildPolicySnapshot(
  input: PlanningTaskInput,
  riskClass: RiskClass,
  approvalMode: ApprovalMode
): PolicySnapshot {
  const allowedSecretScopes = createAllowedSecretScopes(input, riskClass);
  const allowedCapabilities = [
    ...planningCapabilities,
    ...(allowedSecretScopes.length > 0
      ? (["can_use_secrets"] as Capability[])
      : [])
  ];
  const reasons =
    approvalMode === "auto"
      ? ["Planning phase is approved for autonomous execution in v1."]
      : [
          "Developer orchestration may continue after human intervention, validation can run read-only checks, SCM can open an approved branch and pull request after validation, and review remains blocked in v1."
        ];

  if (
    input.requestedCapabilities.includes("can_use_secrets") &&
    allowedSecretScopes.length > 0
  ) {
    reasons.push(
      `Scoped credentials are limited to ${allowedSecretScopes.join(", ")} after approval.`
    );
  } else if (input.requestedCapabilities.includes("can_use_secrets")) {
    reasons.push(
      riskClass === "high"
        ? "High-risk tasks do not receive secrets in RedDwarf v1."
        : "No approved secret scopes were supplied, so no credentials can be injected."
    );
  }

  return {
    policyVersion: V1_POLICY_VERSION,
    approvalMode,
    allowedCapabilities,
    allowedPaths: createAllowedPaths(input, riskClass),
    allowedSecretScopes,
    blockedPhases: disabledPhases,
    reasons
  };
}

function createAllowedSecretScopes(
  input: PlanningTaskInput,
  riskClass: RiskClass
): string[] {
  if (
    !input.requestedCapabilities.includes("can_use_secrets") ||
    riskClass === "high"
  ) {
    return [];
  }

  const configured = input.metadata.secretScopes;

  if (!Array.isArray(configured)) {
    return [];
  }

  return [
    ...new Set(
      configured
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  ];
}

export function phaseEnabledInV1(phase: TaskPhase): boolean {
  return !disabledPhases.includes(phase);
}

export function getPolicyVersion(): string {
  return V1_POLICY_VERSION;
}
