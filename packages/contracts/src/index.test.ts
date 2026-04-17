import { describe, expect, it } from "vitest";
import {
  asIsoTimestamp,
  concurrencyDecisionSchema,
  preScreenAssessmentSchema,
  taskGroupInjectionRequestSchema,
  memoryContextSchema,
  memoryRecordSchema,
  pipelineRunSchema,
  pipelineRunQuerySchema,
  planningTaskInputSchema,
  directTaskInjectionRequestSchema,
  policyPackManifestSchema,
  runEventSchema,
  runSummarySchema,
  runtimeInstructionLayerSchema,
  taskManifestQuerySchema,
  workspaceContextBundleSchema,
  workspaceDescriptorSchema,
  approvalRequestSchema,
  approvalRequestQuerySchema,
  eligibilityRejectionRecordSchema,
  githubIssuePollingCursorSchema,
  phaseRetryBudgetStateSchema,
  promptSnapshotSchema,
  openClawAgentRoleDefinitionSchema,
  operatorConfigEntrySchema,
  operatorConfigSchemaResponseSchema,
  operatorRepoCreateRequestSchema,
  operatorRepoListResponseSchema,
  operatorSecretRotationRequestSchema,
  operatorSecretRotationResponseSchema,
  operatorUiBootstrapResponseSchema,
  parseOperatorConfigValue,
  buildOperatorConfigJsonSchema,
  serializeOperatorConfigValue
} from "@reddwarf/contracts";

const timestamp = asIsoTimestamp(new Date("2026-03-25T18:00:00.000Z"));

describe("contracts", () => {
  it("parses a valid planning input", () => {
    const parsed = planningTaskInputSchema.parse({
      source: {
        provider: "github",
        repo: "acme/platform",
        issueNumber: 42,
        issueUrl: "https://github.com/acme/platform/issues/42"
      },
      title: "Plan the docs-only backlog",
      summary:
        "Create a deterministic planning package for the docs-only backlog in the platform repo.",
      priority: 1,
      labels: ["ai-eligible"],
      acceptanceCriteria: ["Spec is produced"],
      affectedPaths: ["docs/architecture.md"],
      requestedCapabilities: ["can_plan", "can_archive_evidence"]
    });

    expect(parsed.source.repo).toBe("acme/platform");
  });

  it("parses a direct task injection request", () => {
    const parsed = directTaskInjectionRequestSchema.parse({
      repo: "acme/platform",
      title: "Inject a structured task",
      summary: "Push a structured task directly into the planning pipeline.",
      acceptanceCriteria: ["Planning runs immediately."],
      affectedPaths: ["packages/control-plane/src/operator-api.ts"]
    });

    expect(parsed.repo).toBe("acme/platform");
    expect(parsed.labels).toEqual(["ai-eligible"]);
    expect(parsed.priority).toBe(3);
  });

  it("parses a structured pre-screen rejection assessment", () => {
    const parsed = preScreenAssessmentSchema.parse({
      accepted: false,
      summary: "Pre-screen rejected the task.",
      findings: [
        {
          kind: "under_specified",
          summary: "Missing implementation boundary.",
          detail: "The task needs concrete affected paths."
        }
      ],
      recommendedActions: ["Add affected paths and retry."]
    });

    expect(parsed.findings[0]?.kind).toBe("under_specified");
    expect(parsed.recommendedActions).toEqual(["Add affected paths and retry."]);
  });

  it("parses a grouped task injection request", () => {
    const parsed = taskGroupInjectionRequestSchema.parse({
      groupId: "docs-rollout",
      executionMode: "sequential",
      tasks: [
        {
          taskKey: "draft-plan",
          repo: "acme/platform",
          title: "Draft the rollout plan",
          summary: "Produce the first part of the grouped rollout plan.",
          acceptanceCriteria: ["A first planning task exists."]
        },
        {
          taskKey: "publish-follow-up",
          dependsOn: ["draft-plan"],
          repo: "acme/platform",
          title: "Publish the follow-up task",
          summary: "Queue the second grouped task after the first completes.",
          acceptanceCriteria: ["The second planning task exists."]
        }
      ]
    });

    expect(parsed.executionMode).toBe("sequential");
    expect(parsed.tasks[1]?.dependsOn).toEqual(["draft-plan"]);
  });

  it("parses a workspace context bundle", () => {
    const bundle = workspaceContextBundleSchema.parse({
      manifest: {
        taskId: "acme-platform-42",
        source: {
          provider: "github",
          repo: "acme/platform",
          issueNumber: 42,
          issueUrl: "https://github.com/acme/platform/issues/42"
        },
        title: "Plan the docs-only backlog",
        summary:
          "Create a deterministic planning package for the docs-only backlog in the platform repo.",
        priority: 1,
        riskClass: "low",
        approvalMode: "auto",
        currentPhase: "archive",
        lifecycleStatus: "completed",
        assignedAgentType: "architect",
        requestedCapabilities: ["can_plan", "can_archive_evidence"],
        retryCount: 0,
        evidenceLinks: ["db://manifest/acme-platform-42"],
        workspaceId: null,
        branchName: null,
        prNumber: null,
        policyVersion: "reddwarf-v1",
        createdAt: timestamp,
        updatedAt: timestamp
      },
      spec: {
        specId: "spec-1",
        taskId: "acme-platform-42",
        summary: "Plan the work.",
        assumptions: ["Issue is ready."],
        affectedAreas: ["docs/architecture.md"],
        constraints: ["No code writing."],
        acceptanceCriteria: ["Spec is produced"],
        testExpectations: ["Schemas validate."],
        recommendedAgentType: "architect",
        riskClass: "low",
        confidenceLevel: "high",
        confidenceReason: "The fixture plan is fully specified and docs-scoped.",
        createdAt: timestamp
      },
      policySnapshot: {
        policyVersion: "reddwarf-v1",
        approvalMode: "auto",
        allowedCapabilities: ["can_plan", "can_archive_evidence"],
        allowedPaths: ["docs/**"],
        deniedPaths: [".git/**", ".env", "runtime-data/**"],
        allowedSecretScopes: [],
        blockedPhases: ["review"],
        reasons: ["Planning phase is approved for autonomous execution in v1."]
      },
      acceptanceCriteria: ["Spec is produced"],
      allowedPaths: ["docs/**"],
      deniedPaths: [".git/**", ".env", "runtime-data/**"]
    });

    expect(bundle.policySnapshot.blockedPhases).toEqual(["review"]);
  });


  it("parses a GitHub issue polling cursor", () => {
    const cursor = githubIssuePollingCursorSchema.parse({
      repo: "acme/platform",
      lastSeenIssueNumber: 88,
      lastSeenUpdatedAt: timestamp,
      lastPollStartedAt: timestamp,
      lastPollCompletedAt: timestamp,
      lastPollStatus: "succeeded",
      lastPollError: null,
      updatedAt: timestamp
    });

    expect(cursor.lastSeenIssueNumber).toBe(88);
    expect(cursor.lastPollStatus).toBe("succeeded");
  });

  it("parses operator secret rotation payloads", () => {
    const request = operatorSecretRotationRequestSchema.parse({
      value: "secret-value-123"
    });
    const response = operatorSecretRotationResponseSchema.parse({
      key: "OPENAI_API_KEY",
      rotatedAt: timestamp,
      restartRequired: false,
      notes: ["OpenAI key rotated."]
    });

    expect(request.value).toBe("secret-value-123");
    expect(response.key).toBe("OPENAI_API_KEY");
    expect(response.restartRequired).toBe(false);
  });

  it("parses operator UI bootstrap metadata", () => {
    const parsed = operatorUiBootstrapResponseSchema.parse({
      appVersion: "0.1.0",
      uptimeSeconds: 12,
      sessionTier: "operator",
      paths: [
        {
          key: "REDDWARF_HOST_WORKSPACE_ROOT",
          value: "runtime-data/workspaces",
          description: "Host-side workspace root used by local scripts and E2E runs.",
          source: "default"
        }
      ],
      secrets: [
        {
          key: "GITHUB_TOKEN",
          description: "GitHub personal access token used for polling, intake, publishing, and cleanup.",
          restartRequired: false,
          present: true,
          maskedValue: "ghp_...1234"
        }
      ],
      openClaw: {
        baseUrl: "http://127.0.0.1:3578",
        reachable: true,
        checkedAt: timestamp,
        statusCode: 200,
        message: "ok"
      }
    });

    expect(parsed.sessionTier).toBe("operator");
    expect(parsed.paths[0]?.key).toBe("REDDWARF_HOST_WORKSPACE_ROOT");
    expect(parsed.secrets[0]?.key).toBe("GITHUB_TOKEN");
  });

  it("parses a prompt snapshot", () => {
    const snapshot = promptSnapshotSchema.parse({
      snapshotId: "prompt-snapshot-1",
      phase: "planning",
      promptHash: "0123456789abcdef",
      promptPath: "packages/control-plane/src/pipeline/prompts.ts#buildOpenClawArchitectPrompt",
      capturedAt: timestamp
    });

    expect(snapshot.phase).toBe("planning");
    expect(snapshot.promptHash).toBe("0123456789abcdef");
  });

  it("parses a phase retry budget state", () => {
    const retryBudget = phaseRetryBudgetStateSchema.parse({
      phase: "architecture_review",
      attempts: 2,
      retryLimit: 1,
      retryExhausted: true,
      lastError: "Architecture review output for acme-platform-42 was not valid JSON.",
      lastFailureCode: "ARCHITECTURE_REVIEW_OUTPUT_INVALID",
      lastFailureClass: "review_failure",
      lastRunId: "run-architecture-review-fail-2",
      updatedAt: timestamp
    });

    expect(retryBudget.retryExhausted).toBe(true);
    expect(retryBudget.attempts).toBe(2);
  });

  it("parses an operator config entry", () => {
    const entry = operatorConfigEntrySchema.parse({
      key: "REDDWARF_POLL_INTERVAL_MS",
      value: 45000,
      updatedAt: timestamp
    });

    expect(entry.key).toBe("REDDWARF_POLL_INTERVAL_MS");
    expect(entry.value).toBe(45000);
  });

  it("serializes typed operator config values back to env strings", () => {
    expect(
      serializeOperatorConfigValue("REDDWARF_SKIP_OPENCLAW", true)
    ).toBe("true");
    expect(
      serializeOperatorConfigValue(
        "REDDWARF_POLL_INTERVAL_MS",
        45000
      )
    ).toBe("45000");
    expect(
      serializeOperatorConfigValue(
        "REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_HEALTHY_TEXT",
        null
      )
    ).toBe("");
    expect(parseOperatorConfigValue("REDDWARF_API_PORT", 8080)).toBe(8080);
    expect(parseOperatorConfigValue("REDDWARF_MODEL_PROVIDER", "openai")).toBe(
      "openai"
    );
    expect(() =>
      parseOperatorConfigValue("REDDWARF_MODEL_PROVIDER", "bedrock")
    ).toThrow();
  });

  it("builds a JSON-schema-style operator config schema response", () => {
    const response = operatorConfigSchemaResponseSchema.parse({
      schema: buildOperatorConfigJsonSchema()
    });

    expect(response.schema.type).toBe("object");
    expect(
      (response.schema.properties["REDDWARF_POLL_INTERVAL_MS"] as Record<string, unknown>)[
        "type"
      ]
    ).toBe("integer");
    expect(response.schema.defaults["REDDWARF_LOG_LEVEL"]).toBe("info");
    expect(response.schema.defaults["REDDWARF_MODEL_PROVIDER"]).toBe(
      "anthropic"
    );
    expect(
      (response.schema.properties["REDDWARF_MODEL_PROVIDER"] as Record<
        string,
        unknown
      >)["enum"]
    ).toEqual(["anthropic", "openai", "openai-codex"]);
    expect(response.schema.descriptions["REDDWARF_SKIP_OPENCLAW"]).toContain(
      "OpenClaw"
    );
  });

  it("parses operator repo management contracts", () => {
    const request = operatorRepoCreateRequestSchema.parse({
      repo: "acme/platform"
    });
    const response = operatorRepoListResponseSchema.parse({
      repos: [
        {
          repo: "acme/platform",
          lastSeenIssueNumber: 72,
          lastSeenUpdatedAt: timestamp,
          lastPollStartedAt: timestamp,
          lastPollCompletedAt: timestamp,
          lastPollStatus: "succeeded",
          lastPollError: null,
          updatedAt: timestamp
        }
      ],
      total: 1
    });

    expect(request.repo).toBe("acme/platform");
    expect(response.repos[0]?.repo).toBe("acme/platform");
  });

  it("parses task and run query contracts used by operator observability", () => {
    const runQuery = pipelineRunQuerySchema.parse({
      repo: "acme/platform",
      statuses: ["blocked"],
      limit: 10
    });
    const taskQuery = taskManifestQuerySchema.parse({
      repo: "acme/platform",
      lifecycleStatuses: ["blocked"],
      phases: ["policy_gate"],
      limit: 10
    });

    expect(runQuery.repo).toBe("acme/platform");
    expect(taskQuery.lifecycleStatuses).toEqual(["blocked"]);
    expect(taskQuery.phases).toEqual(["policy_gate"]);
  });

  it("parses an eligibility rejection record", () => {
    const rejection = eligibilityRejectionRecordSchema.parse({
      rejectionId: "reject-1",
      taskId: "acme-platform-42",
      rejectedAt: timestamp,
      reasonCode: "under-specified",
      reasonDetail: "No acceptance criteria provided",
      policyVersion: "reddwarf-v1",
      sourceIssue: {
        title: "Add dark mode",
        source: {
          issueUrl: "https://github.com/acme/platform/issues/42"
        }
      },
      dryRun: false
    });

    expect(rejection.reasonCode).toBe("under-specified");
    expect(rejection.dryRun).toBe(false);
  });

  it("parses an OpenClaw agent role definition", () => {
    const definition = openClawAgentRoleDefinitionSchema.parse({
      agentId: "reddwarf-coordinator",
      role: "coordinator",
      displayName: "RedDwarf Coordinator",
      purpose: "Keep OpenClaw sessions aligned with RedDwarf task scope and delegation boundaries.",
      runtimePolicy: {
        toolProfile: "full",
        allow: ["group:fs", "group:sessions", "group:openclaw"],
        deny: ["group:automation", "group:messaging", "group:nodes"],
        sandboxMode: "read_only",
        model: { provider: "anthropic", model: "anthropic/claude-sonnet-4-6" }
      },
      bootstrapFiles: [
        { kind: "identity", relativePath: "agents/openclaw/coordinator/IDENTITY.md", description: "Identity and persona." },
        { kind: "soul", relativePath: "agents/openclaw/coordinator/SOUL.md", description: "Operating posture." },
        { kind: "agents", relativePath: "agents/openclaw/coordinator/AGENTS.md", description: "Agent roster." },
        { kind: "tools", relativePath: "agents/openclaw/coordinator/TOOLS.md", description: "Tool guidance." },
        { kind: "user", relativePath: "agents/openclaw/coordinator/USER.md", description: "Operator profile." },
        { kind: "skill", relativePath: "agents/openclaw/coordinator/skills/reddwarf-openclaw/SKILL.md", description: "Runtime skill." }
      ],
      canonicalSources: ["docs/open_claw_research.md", "openclaw_ai_dev_team_v_2_architecture.md"]
    });

    expect(definition.role).toBe("coordinator");
    expect(definition.runtimePolicy.toolProfile).toBe("full");
    expect(definition.runtimePolicy.model.provider).toBe("anthropic");
    expect(definition.bootstrapFiles).toHaveLength(6);
  });

  it("parses a runtime instruction layer", () => {
    const layer = runtimeInstructionLayerSchema.parse({
      taskId: "acme-platform-42",
      assignedAgentType: "architect",
      recommendedAgentType: "architect",
      approvalMode: "auto",
      allowedCapabilities: ["can_plan", "can_archive_evidence"],
      blockedPhases: ["review"],
      canonicalSources: [
        "standards/engineering.md",
        "prompts/planning-system.md"
      ],
      contextFiles: [".context/task.json", ".context/spec.md"],
      files: [
        {
          relativePath: "SOUL.md",
          description: "Workspace operating posture and source hierarchy.",
          content: "# RedDwarf Runtime Soul"
        },
        {
          relativePath: "skills/reddwarf-task/SKILL.md",
          description: "Task skill",
          content: "# RedDwarf Task Runtime Skill"
        }
      ]
    });

    expect(layer.files.map((file) => file.relativePath)).toContain("SOUL.md");
  });

  it("parses a workspace descriptor", () => {
    const descriptor = workspaceDescriptorSchema.parse({
      workspaceId: "workspace-42",
      taskId: "acme-platform-42",
      workspaceRoot: "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42",
      contextDir:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42/.context",
      stateFile:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42/.workspace/workspace.json",
      scratchDir:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42/scratch",
      artifactsDir:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42/artifacts",
      status: "provisioned",
      assignedAgentType: "architect",
      recommendedAgentType: "architect",
      allowedCapabilities: ["can_plan", "can_archive_evidence"],
      allowedPaths: ["docs/**"],
      deniedPaths: [".git/**", ".env", "runtime-data/**"],
      blockedPhases: ["review"],
      canonicalSources: ["standards/engineering.md"],
      taskContractFiles: [
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42/.context/task.json"
      ],
      instructionFiles: {
        soulMd: "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42/SOUL.md",
        agentsMd:
          "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42/AGENTS.md",
        toolsMd:
          "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42/TOOLS.md",
        taskSkillMd:
          "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42/skills/reddwarf-task/SKILL.md"
      },
      toolPolicy: {
        mode: "planning_only",
        codeWriteEnabled: false,
        allowedCapabilities: ["can_plan", "can_archive_evidence"],
        blockedPhases: ["review"],
        notes: ["Planning-only workspace."]
      },
      credentialPolicy: {
        mode: "none",
        allowedSecretScopes: [],
        injectedSecretKeys: [],
        secretEnvFile: null,
        leaseIssuedAt: null,
        leaseExpiresAt: null,
        notes: ["Secrets adapter is not implemented in v1."]
      },
      createdAt: timestamp,
      updatedAt: timestamp,
      destroyedAt: null
    });

    expect(descriptor.status).toBe("provisioned");
    expect(descriptor.toolPolicy.mode).toBe("planning_only");
    expect(descriptor.toolPolicy.codeWriteEnabled).toBe(false);
  });

  it("parses a validation workspace descriptor", () => {
    const descriptor = workspaceDescriptorSchema.parse({
      workspaceId: "workspace-42-validation",
      taskId: "acme-platform-42",
      workspaceRoot:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-validation",
      contextDir:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-validation/.context",
      stateFile:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-validation/.workspace/workspace.json",
      scratchDir:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-validation/scratch",
      artifactsDir:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-validation/artifacts",
      status: "provisioned",
      assignedAgentType: "validation",
      recommendedAgentType: "developer",
      allowedCapabilities: ["can_run_tests", "can_archive_evidence"],
      allowedPaths: ["src/**"],
      deniedPaths: [".git/**", ".env", "runtime-data/**"],
      blockedPhases: ["review"],
      canonicalSources: ["agents/validation.md"],
      taskContractFiles: [
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-validation/.context/task.json"
      ],
      instructionFiles: {
        soulMd:
          "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-validation/SOUL.md",
        agentsMd:
          "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-validation/AGENTS.md",
        toolsMd:
          "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-validation/TOOLS.md",
        taskSkillMd:
          "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-validation/skills/reddwarf-task/SKILL.md"
      },
      toolPolicy: {
        mode: "validation_only",
        codeWriteEnabled: false,
        allowedCapabilities: ["can_run_tests", "can_archive_evidence"],
        blockedPhases: ["review"],
        notes: ["Validation-only workspace."]
      },
      credentialPolicy: {
        mode: "none",
        allowedSecretScopes: [],
        injectedSecretKeys: [],
        secretEnvFile: null,
        leaseIssuedAt: null,
        leaseExpiresAt: null,
        notes: ["Secrets adapter is not implemented in v1."]
      },
      createdAt: timestamp,
      updatedAt: timestamp,
      destroyedAt: null
    });

    expect(descriptor.assignedAgentType).toBe("validation");
    expect(descriptor.toolPolicy.mode).toBe("validation_only");
    expect(descriptor.toolPolicy.allowedCapabilities).toContain(
      "can_run_tests"
    );
  });

  it("parses an scm workspace descriptor", () => {
    const descriptor = workspaceDescriptorSchema.parse({
      workspaceId: "workspace-42-scm",
      taskId: "acme-platform-42",
      workspaceRoot:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-scm",
      contextDir:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-scm/.context",
      stateFile:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-scm/.workspace/workspace.json",
      scratchDir:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-scm/scratch",
      artifactsDir:
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-scm/artifacts",
      status: "provisioned",
      assignedAgentType: "scm",
      recommendedAgentType: "developer",
      allowedCapabilities: ["can_open_pr", "can_archive_evidence"],
      allowedPaths: ["src/**"],
      deniedPaths: [".git/**", ".env", "runtime-data/**"],
      blockedPhases: ["review"],
      canonicalSources: ["docs/implementation-map.md"],
      taskContractFiles: [
        "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-scm/.context/task.json"
      ],
      instructionFiles: {
        soulMd:
          "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-scm/SOUL.md",
        agentsMd:
          "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-scm/AGENTS.md",
        toolsMd:
          "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-scm/TOOLS.md",
        taskSkillMd:
          "C:/Dev/RedDwarf/runtime-data/workspaces/workspace-42-scm/skills/reddwarf-task/SKILL.md"
      },
      toolPolicy: {
        mode: "scm_only",
        codeWriteEnabled: false,
        allowedCapabilities: ["can_open_pr", "can_archive_evidence"],
        blockedPhases: ["review"],
        notes: ["SCM-only workspace."]
      },
      credentialPolicy: {
        mode: "none",
        allowedSecretScopes: [],
        injectedSecretKeys: [],
        secretEnvFile: null,
        leaseIssuedAt: null,
        leaseExpiresAt: null,
        notes: ["Secrets are not injected during SCM."]
      },
      createdAt: timestamp,
      updatedAt: timestamp,
      destroyedAt: null
    });

    expect(descriptor.assignedAgentType).toBe("scm");
    expect(descriptor.toolPolicy.mode).toBe("scm_only");
    expect(descriptor.toolPolicy.allowedCapabilities).toContain("can_open_pr");
  });

  it("parses a policy snapshot with allowed secret scopes", () => {
    const bundle = workspaceContextBundleSchema.parse({
      manifest: {
        taskId: "acme-platform-42",
        source: {
          provider: "github",
          repo: "acme/platform",
          issueNumber: 42,
          issueUrl: "https://github.com/acme/platform/issues/42"
        },
        title: "Plan the docs-only backlog",
        summary:
          "Create a deterministic planning package for the docs-only backlog in the platform repo.",
        priority: 1,
        riskClass: "medium",
        approvalMode: "human_signoff_required",
        currentPhase: "development",
        lifecycleStatus: "blocked",
        assignedAgentType: "developer",
        requestedCapabilities: ["can_write_code", "can_use_secrets"],
        retryCount: 0,
        evidenceLinks: ["db://manifest/acme-platform-42"],
        workspaceId: "workspace-42",
        branchName: null,
        prNumber: null,
        policyVersion: "reddwarf-v1",
        createdAt: timestamp,
        updatedAt: timestamp
      },
      spec: {
        specId: "spec-2",
        taskId: "acme-platform-42",
        summary: "Plan the work.",
        assumptions: ["Issue is ready."],
        affectedAreas: ["src/credential-flow.ts"],
        constraints: ["No uncontrolled secret access."],
        acceptanceCriteria: ["Secret scopes are explicit"],
        testExpectations: ["Schemas validate."],
        recommendedAgentType: "developer",
        riskClass: "medium",
        confidenceLevel: "medium",
        confidenceReason: "The fixture crosses more than one policy concern.",
        createdAt: timestamp
      },
      policySnapshot: {
        policyVersion: "reddwarf-v1",
        approvalMode: "human_signoff_required",
        allowedCapabilities: ["can_plan", "can_archive_evidence", "can_use_secrets"],
        allowedPaths: ["src/**"],
        deniedPaths: [".git/**", ".env", "runtime-data/**"],
        allowedSecretScopes: ["github_readonly"],
        blockedPhases: ["review"],
        reasons: ["Scoped secrets are allowed after approval."]
      },
      acceptanceCriteria: ["Secret scopes are explicit"],
      allowedPaths: ["src/**"],
      deniedPaths: [".git/**", ".env", "runtime-data/**"]
    });

    expect(bundle.policySnapshot.allowedSecretScopes).toEqual([
      "github_readonly"
    ]);
  });

  it("parses approval requests and queue queries", () => {
    const request = approvalRequestSchema.parse({
      requestId: "approval-1",
      taskId: "acme-platform-42",
      runId: "run-1",
      phase: "policy_gate",
      approvalMode: "human_signoff_required",
      status: "pending",
      riskClass: "high",
      summary: "Human approval is required before downstream execution.",
      requestedCapabilities: ["can_write_code"],
      allowedPaths: ["src/**"],
      blockedPhases: ["review"],
      policyReasons: [
        "Developer orchestration may continue after human intervention, but code writing remains disabled by default in v1."
      ],
      requestedBy: "policy",
      decidedBy: null,
      decision: null,
      decisionSummary: null,
      comment: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      resolvedAt: null
    });
    const query = approvalRequestQuerySchema.parse({
      taskId: "acme-platform-42",
      statuses: ["pending"],
      limit: 10
    });

    expect(request.status).toBe("pending");
    expect(query.statuses).toEqual(["pending"]);
  });

  it("parses run events and summaries with failure metadata", () => {
    const event = runEventSchema.parse({
      eventId: "run-1:event-1",
      taskId: "acme-platform-42",
      runId: "run-1",
      phase: "planning",
      level: "error",
      code: "PHASE_FAILED",
      message: "Planning failed.",
      failureClass: "planning_failure",
      durationMs: 12,
      data: {
        causeCode: "PLANNING_FAILED"
      },
      createdAt: timestamp
    });
    const summary = runSummarySchema.parse({
      taskId: "acme-platform-42",
      runId: "run-1",
      status: "failed",
      totalDurationMs: 12,
      phaseDurations: {
        planning: 12
      },
      eventCounts: {
        info: 0,
        warn: 0,
        error: 1
      },
      latestPhase: "planning",
      failureClass: "planning_failure",
      failureCodes: ["PHASE_FAILED"],
      firstEventAt: timestamp,
      lastEventAt: timestamp
    });

    expect(event.failureClass).toBe("planning_failure");
    expect(summary.phaseDurations.planning).toBe(12);
  });

  it("parses partitioned memory records and memory contexts", () => {
    const taskMemory = memoryRecordSchema.parse({
      memoryId: "memory-1",
      taskId: "acme-platform-42",
      scope: "task",
      provenance: "pipeline_derived",
      key: "planning.brief",
      title: "Planning brief",
      value: {
        summary: "Plan the docs-only backlog."
      },
      repo: "acme/platform",
      organizationId: "acme",
      sourceUri: null,
      tags: ["planning", "task"],
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const context = memoryContextSchema.parse({
      taskId: "acme-platform-42",
      repo: "acme/platform",
      organizationId: "acme",
      taskMemory: [taskMemory],
      projectMemory: [],
      organizationMemory: [],
      externalMemory: []
    });

    expect(taskMemory.scope).toBe("task");
    expect(context.taskMemory).toHaveLength(1);
  });

  it("parses policy-pack package manifests", () => {
    const manifest = policyPackManifestSchema.parse({
      policyPackId: "reddwarf-policy-pack",
      policyPackVersion: "0.1.0+20260325t210000z",
      rootPackageVersion: "0.1.0",
      createdAt: timestamp,
      sourceRoot: "C:/Dev/RedDwarf",
      packageRoot:
        "C:/Dev/RedDwarf/artifacts/policy-packs/reddwarf-policy-pack-0.1.0+20260325t210000z/policy-root",
      composePolicySourceRoot:
        "C:/Dev/RedDwarf/artifacts/policy-packs/reddwarf-policy-pack-0.1.0+20260325t210000z/policy-root",
      contentHash:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      runtimeDependenciesBundled: true,
      includedEntries: [
        {
          path: "agents",
          kind: "directory",
          requiredAtRuntime: true
        },
        {
          path: "packages/control-plane/dist/index.js",
          kind: "file",
          requiredAtRuntime: true
        }
      ],
      notes: ["Packaged for immutable Docker mounts."]
    });

    expect(manifest.runtimeDependenciesBundled).toBe(true);
    expect(manifest.includedEntries).toHaveLength(2);
  });

  it("parses pipeline runs and overlap decisions", () => {
    const run = pipelineRunSchema.parse({
      runId: "run-1",
      taskId: "acme-platform-42",
      concurrencyKey: "github:acme/platform:42",
      strategy: "serialize",
      status: "active",
      blockedByRunId: null,
      overlapReason: null,
      startedAt: timestamp,
      lastHeartbeatAt: timestamp,
      completedAt: null,
      staleAt: null,
      metadata: {
        sourceRepo: "acme/platform"
      }
    });
    const decision = concurrencyDecisionSchema.parse({
      action: "block",
      strategy: "serialize",
      blockedByRunId: "run-0",
      staleRunIds: ["run-stale"],
      reason:
        "Active overlapping run run-0 already owns github:acme/platform:42."
    });

    expect(run.status).toBe("active");
    expect(decision.action).toBe("block");
  });

  it("accepts an OpenAI OpenClaw model binding", () => {
    const parsed = openClawAgentRoleDefinitionSchema.parse({
      agentId: "reddwarf-developer",
      role: "developer",
      displayName: "RedDwarf Developer",
      purpose: "Implements approved plans.",
      runtimePolicy: {
        toolProfile: "full",
        allow: ["group:fs"],
        deny: ["group:messaging"],
        sandboxMode: "workspace_write",
        model: { provider: "openai", model: "openai/gpt-5" }
      },
      bootstrapFiles: [
        {
          kind: "identity",
          relativePath: "agents/openclaw/lister/IDENTITY.md",
          description: "identity"
        },
        {
          kind: "soul",
          relativePath: "agents/openclaw/lister/SOUL.md",
          description: "soul"
        },
        {
          kind: "agents",
          relativePath: "agents/openclaw/lister/AGENTS.md",
          description: "agents"
        },
        {
          kind: "tools",
          relativePath: "agents/openclaw/lister/TOOLS.md",
          description: "tools"
        },
        {
          kind: "user",
          relativePath: "agents/openclaw/lister/USER.md",
          description: "user"
        },
        {
          kind: "skill",
          relativePath:
            "agents/openclaw/lister/skills/implement_architecture_plan/SKILL.md",
          description: "skill"
        }
      ],
      canonicalSources: ["agents/developer.md"]
    });

    expect(parsed.runtimePolicy.model.provider).toBe("openai");
  });
});
