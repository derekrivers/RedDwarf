import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve
} from "node:path";
import {
  asIsoTimestamp,
  capabilities,
  memoryContextSchema,
  runtimeInstructionLayerSchema,
  workspaceContextBundleSchema,
  workspaceDescriptorSchema,
  workspaceToolModes,
  type Capability,
  type MaterializedManagedWorkspace,
  type PlanningSpec,
  type PolicySnapshot,
  type RuntimeInstructionLayer,
  type TaskManifest,
  type WorkspaceContextBundle,
  type WorkspaceDescriptor,
  type WorkspaceRuntimeConfig
} from "@reddwarf/contracts";

export type { MaterializedManagedWorkspace };
import {
  createEvidenceRecord,
  type PersistedTaskSnapshot,
  type PlanningRepository
} from "@reddwarf/evidence";
import { type SecretLease } from "@reddwarf/integrations";
import { agentDefinitions } from "@reddwarf/execution-plane";
import {
  planningCapabilities as planningWorkspaceCapabilities,
  developmentCapabilities as developmentWorkspaceCapabilities,
  validationCapabilities as validationWorkspaceCapabilities,
  scmCapabilities as scmWorkspaceCapabilities
} from "@reddwarf/policy";

// ============================================================
// Workspace interfaces
// ============================================================

const [
  TOOL_MODE_PLANNING,
  TOOL_MODE_DEVELOPMENT_READONLY,
  ,
  TOOL_MODE_ARCHITECTURE_REVIEW,
  TOOL_MODE_VALIDATION,
  TOOL_MODE_SCM
] = workspaceToolModes;

export interface WorkspaceContextArtifacts {
  taskJson: string;
  specMarkdown: string;
  projectMemoryJson: string;
  policySnapshotJson: string;
  allowedPathsJson: string;
  acceptanceCriteriaJson: string;
}

export interface RuntimeInstructionArtifacts {
  soulMd: string;
  agentsMd: string;
  toolsMd: string;
  taskSkillMd: string;
}

export interface MaterializedRuntimeInstructionFiles {
  soulMd: string;
  agentsMd: string;
  toolsMd: string;
  taskSkillMd: string;
}

export interface MaterializedWorkspaceContext {
  workspaceId: string;
  workspaceRoot: string;
  contextDir: string;
  files: {
    taskJson: string;
    specMarkdown: string;
    projectMemoryJson: string;
    policySnapshotJson: string;
    allowedPathsJson: string;
    acceptanceCriteriaJson: string;
  };
  instructions: {
    canonicalSources: string[];
    taskContractFiles: string[];
    files: MaterializedRuntimeInstructionFiles;
  };
}

export interface DestroyedManagedWorkspace {
  workspaceId: string;
  workspaceRoot: string;
  removed: boolean;
  descriptor: WorkspaceDescriptor | null;
}

export interface ProvisionWorkspaceResult {
  manifest: TaskManifest;
  workspace: MaterializedManagedWorkspace;
}

export interface DestroyWorkspaceResult {
  manifest: TaskManifest;
  workspace: DestroyedManagedWorkspace;
}

export interface ScrubbedWorkspaceSecretsResult {
  workspaceId: string;
  scrubbed: boolean;
  removed: boolean;
  secretEnvFile: string | null;
  scrubbedAt: string;
  descriptor: WorkspaceDescriptor;
}

export type ArchivedArtifactClass =
  | "handoff"
  | "log"
  | "test_result"
  | "report"
  | "diff"
  | "review_output";

export interface ArchivedEvidenceArtifact {
  evidenceRoot: string;
  archivePath: string;
  relativePath: string;
  location: string;
  byteSize: number;
  sha256: string;
}

// ============================================================
// Workspace constants
// ============================================================

export const workspaceStateDirName = ".workspace";
export const workspaceStateFileName = "workspace.json";
export const workspaceScratchDirName = "scratch";
export const workspaceArtifactsDirName = "artifacts";
export const workspaceCredentialsDirName = "credentials";
export const workspaceSecretEnvFileName = "secret-env.json";
export const workspaceLocationPrefix = "workspace://";
export const evidenceLocationPrefix = "evidence://";
const defaultEvidenceDirName = "evidence";
const evidenceTasksDirName = "tasks";

const taskContractFileMetadata = {
  taskJson: {
    relativePath: ".context/task.json"
  },
  specMarkdown: {
    relativePath: ".context/spec.md"
  },
  projectMemoryJson: {
    relativePath: ".context/project_memory.json"
  },
  policySnapshotJson: {
    relativePath: ".context/policy_snapshot.json"
  },
  allowedPathsJson: {
    relativePath: ".context/allowed_paths.json"
  },
  acceptanceCriteriaJson: {
    relativePath: ".context/acceptance_criteria.json"
  }
} as const;

type WorkspaceContextArtifactKey = keyof typeof taskContractFileMetadata;

const runtimeInstructionRelativePaths = {
  soulMd: "SOUL.md",
  agentsMd: "AGENTS.md",
  toolsMd: "TOOLS.md",
  taskSkillMd: "skills/reddwarf-task/SKILL.md"
} as const;

const agentInstructionPathByType: Partial<
  Record<TaskManifest["assignedAgentType"], string>
> = {
  architect: "agents/architect.md",
  developer: "agents/developer.md",
  reviewer: "agents/reviewer.md",
  validation: "agents/validation.md"
};

const capabilityGuidance: Record<Capability, string> = {
  can_plan:
    "Inspect task context, policy inputs, and mounted standards to produce deterministic planning output.",
  can_write_code:
    "Write or modify product code only after the development phase is enabled and policy grants it.",
  can_run_tests:
    "Run validation commands only when the validation phase and policy both allow test execution.",
  can_open_pr:
    "Create branches, commits, or pull requests only behind explicit SCM approval gates.",
  can_modify_schema:
    "Change schemas or migrations only with explicit approval for sensitive surfaces.",
  can_touch_sensitive_paths:
    "Touch restricted repo areas only after path-level approval is granted.",
  can_use_secrets:
    "Use scoped credentials only when a secrets adapter has injected them for this task.",
  can_review:
    "Review generated work and compare it to requirements when the review phase is enabled.",
  can_archive_evidence:
    "Persist structured logs, specs, diffs, and verification output as durable evidence."
};

const planningWorkspaceToolPolicyNotes = [
  "Workspace execution is constrained to planning-only capabilities in RedDwarf v1.",
  "Filesystem access should stay inside the isolated workspace plus policy-approved product paths."
] as const;

const developmentWorkspaceToolPolicyNotes = [
  "Developer orchestration is enabled in RedDwarf v1, but product code writes remain disabled by default.",
  "Use the isolated workspace for inspection, handoff artifacts, and evidence capture before validation checks run.",
  "When provisioned, inspect CI state with `.workspace/tools/reddwarf-ci.mjs latest` and queue workflow triggers with `.workspace/tools/reddwarf-ci.mjs trigger --workflow <name>`."
] as const;

const architectureReviewWorkspaceToolPolicyNotes = [
  "Architecture review runs after developer handoff and before validation to compare the implementation against the approved plan.",
  "Review output must stay evidence-friendly, keep product code writes disabled, and stop validation when structural drift is detected."
] as const;

const validationWorkspaceToolPolicyNotes = [
  "Validation orchestration is enabled in RedDwarf v1 for deterministic workspace-local checks.",
  "Run lint, test, and contract validation commands inside the isolated workspace while product code writes remain disabled.",
  "When provisioned, inspect CI state with `.workspace/tools/reddwarf-ci.mjs latest` and queue workflow triggers with `.workspace/tools/reddwarf-ci.mjs trigger --workflow <name>`."
] as const;

const scmWorkspaceToolPolicyNotes = [
  "SCM orchestration is enabled in RedDwarf v1 only for approved branch and pull-request creation after validation.",
  "Remote mutations are limited to the GitHub adapter while product code writes remain disabled in the managed workspace."
] as const;

const defaultWorkspaceCredentialPolicyNotes = [
  "Scoped secrets are disabled unless a task is approved for can_use_secrets and a secrets adapter issues a lease.",
  "No credentials are injected into provisioned workspaces by default."
] as const;

// ============================================================
// Workspace context bundle creation
// ============================================================

export function createWorkspaceContextBundle(input: {
  manifest: TaskManifest;
  spec: PlanningSpec;
  policySnapshot: PolicySnapshot;
  memoryContext?: import("@reddwarf/contracts").MemoryContext | null;
}): WorkspaceContextBundle {
  const allowedPaths = [...new Set([
    ...input.policySnapshot.allowedPaths,
    ...input.spec.affectedAreas
  ])];

  return workspaceContextBundleSchema.parse({
    manifest: input.manifest,
    spec: input.spec,
    policySnapshot: input.policySnapshot,
    ...(input.memoryContext !== undefined
      ? { memoryContext: input.memoryContext }
      : {}),
    acceptanceCriteria: input.spec.acceptanceCriteria,
    allowedPaths
  });
}

export function createWorkspaceContextBundleFromSnapshot(
  snapshot: PersistedTaskSnapshot
): WorkspaceContextBundle {
  if (!snapshot.manifest) {
    throw new Error(
      "Cannot materialize workspace context without a task manifest."
    );
  }

  if (!snapshot.spec) {
    throw new Error(
      `Cannot materialize workspace context for ${snapshot.manifest.taskId} without a planning spec.`
    );
  }

  if (!snapshot.policySnapshot) {
    throw new Error(
      `Cannot materialize workspace context for ${snapshot.manifest.taskId} without a persisted policy snapshot.`
    );
  }

  return createWorkspaceContextBundle({
    manifest: snapshot.manifest,
    spec: snapshot.spec,
    policySnapshot: snapshot.policySnapshot
  });
}

export function renderPlanningSpecMarkdown(
  bundle: WorkspaceContextBundle
): string {
  return [
    "# Planning Spec",
    "",
    `- Task ID: ${bundle.manifest.taskId}`,
    `- Source Repo: ${bundle.manifest.source.repo}`,
    `- Risk Class: ${bundle.manifest.riskClass}`,
    `- Approval Mode: ${bundle.policySnapshot.approvalMode}`,
    "",
    "## Summary",
    "",
    bundle.spec.summary,
    "",
    "## Assumptions",
    "",
    ...bundle.spec.assumptions.map((item) => `- ${item}`),
    "",
    "## Affected Areas",
    "",
    ...bundle.spec.affectedAreas.map((item) => `- ${item}`),
    "",
    "## Constraints",
    "",
    ...bundle.spec.constraints.map((item) => `- ${item}`),
    "",
    "## Acceptance Criteria",
    "",
    ...bundle.spec.acceptanceCriteria.map((item) => `- ${item}`),
    "",
    "## Test Expectations",
    "",
    ...bundle.spec.testExpectations.map((item) => `- ${item}`),
    "",
    "## Policy Reasons",
    "",
    ...bundle.policySnapshot.reasons.map((item) => `- ${item}`),
    ""
  ].join("\n");
}

export function createWorkspaceContextArtifacts(
  bundle: WorkspaceContextBundle
): WorkspaceContextArtifacts {
  const cachedProjectMemory = bundle.memoryContext
    ? memoryContextSchema.parse({
        ...bundle.memoryContext,
        taskMemory: []
      })
    : null;
  return {
    taskJson: `${JSON.stringify(bundle.manifest, null, 2)}\n`,
    specMarkdown: renderPlanningSpecMarkdown(bundle),
    projectMemoryJson: `${JSON.stringify(cachedProjectMemory, null, 2)}\n`,
    policySnapshotJson: `${JSON.stringify(bundle.policySnapshot, null, 2)}\n`,
    allowedPathsJson: `${JSON.stringify(bundle.allowedPaths, null, 2)}\n`,
    acceptanceCriteriaJson: `${JSON.stringify(bundle.acceptanceCriteria, null, 2)}\n`
  };
}

export function createRuntimeInstructionLayer(
  bundle: WorkspaceContextBundle
): RuntimeInstructionLayer {
  const canonicalSources = buildCanonicalSources(bundle);
  const toolPolicy = createWorkspaceToolPolicy(bundle);
  const contextFiles = getRoleScopedContextFiles(bundle);

  return runtimeInstructionLayerSchema.parse({
    taskId: bundle.manifest.taskId,
    assignedAgentType: bundle.manifest.assignedAgentType,
    recommendedAgentType: bundle.spec.recommendedAgentType,
    approvalMode: bundle.policySnapshot.approvalMode,
    allowedCapabilities: toolPolicy.allowedCapabilities,
    blockedPhases: toolPolicy.blockedPhases,
    canonicalSources,
    contextFiles,
    files: [
      {
        relativePath: runtimeInstructionRelativePaths.soulMd,
        description: "Workspace operating posture and source hierarchy.",
        content: renderRuntimeSoulMarkdown(bundle, canonicalSources, contextFiles)
      },
      {
        relativePath: runtimeInstructionRelativePaths.agentsMd,
        description: "Runtime agent roster and task routing guidance.",
        content: renderRuntimeAgentsMarkdown(bundle)
      },
      {
        relativePath: runtimeInstructionRelativePaths.toolsMd,
        description:
          "Capability, path, and escalation guardrails for the workspace.",
        content: renderRuntimeToolsMarkdown(bundle)
      },
      {
        relativePath: runtimeInstructionRelativePaths.taskSkillMd,
        description:
          "Task-scoped skill that tells agents how to use the context bundle and policy pack.",
        content: renderRuntimeTaskSkillMarkdown(bundle, canonicalSources, contextFiles)
      }
    ]
  });
}

export function createRuntimeInstructionArtifacts(
  layer: RuntimeInstructionLayer
): RuntimeInstructionArtifacts {
  return {
    soulMd: getRuntimeInstructionContent(
      layer,
      runtimeInstructionRelativePaths.soulMd
    ),
    agentsMd: getRuntimeInstructionContent(
      layer,
      runtimeInstructionRelativePaths.agentsMd
    ),
    toolsMd: getRuntimeInstructionContent(
      layer,
      runtimeInstructionRelativePaths.toolsMd
    ),
    taskSkillMd: getRuntimeInstructionContent(
      layer,
      runtimeInstructionRelativePaths.taskSkillMd
    )
  };
}

export async function materializeWorkspaceContext(input: {
  bundle: WorkspaceContextBundle;
  targetRoot: string;
  workspaceId?: string;
}): Promise<MaterializedWorkspaceContext> {
  const bundle = input.bundle;
  const workspaceId =
    input.workspaceId ?? bundle.manifest.workspaceId ?? bundle.manifest.taskId;
  const workspaceRoot = resolve(input.targetRoot, workspaceId);
  const contextDir = join(workspaceRoot, ".context");
  const files = {
    taskJson: join(contextDir, "task.json"),
    specMarkdown: join(contextDir, "spec.md"),
    projectMemoryJson: join(contextDir, "project_memory.json"),
    policySnapshotJson: join(contextDir, "policy_snapshot.json"),
    allowedPathsJson: join(contextDir, "allowed_paths.json"),
    acceptanceCriteriaJson: join(contextDir, "acceptance_criteria.json")
  };
  const materializedBundle = workspaceContextBundleSchema.parse({
    ...bundle,
    manifest: {
      ...bundle.manifest,
      workspaceId
    }
  });
  const artifacts = createWorkspaceContextArtifacts(materializedBundle);
  const runtimeInstructionLayer =
    createRuntimeInstructionLayer(materializedBundle);
  const runtimeInstructionArtifacts = createRuntimeInstructionArtifacts(
    runtimeInstructionLayer
  );
  const scopedArtifactKeys = getRoleScopedContextArtifactKeys(materializedBundle);
  const instructionFiles = {
    soulMd: join(workspaceRoot, runtimeInstructionRelativePaths.soulMd),
    agentsMd: join(workspaceRoot, runtimeInstructionRelativePaths.agentsMd),
    toolsMd: join(workspaceRoot, runtimeInstructionRelativePaths.toolsMd),
    taskSkillMd: join(
      workspaceRoot,
      ...runtimeInstructionRelativePaths.taskSkillMd.split("/")
    )
  };

  await mkdir(contextDir, { recursive: true });
  await mkdir(join(workspaceRoot, "skills", "reddwarf-task"), {
    recursive: true
  });
  await Promise.all([
    ...scopedArtifactKeys.map((key) =>
      writeFile(files[key], artifacts[key], "utf8")
    ),
    writeFile(
      instructionFiles.soulMd,
      runtimeInstructionArtifacts.soulMd,
      "utf8"
    ),
    writeFile(
      instructionFiles.agentsMd,
      runtimeInstructionArtifacts.agentsMd,
      "utf8"
    ),
    writeFile(
      instructionFiles.toolsMd,
      runtimeInstructionArtifacts.toolsMd,
      "utf8"
    ),
    writeFile(
      instructionFiles.taskSkillMd,
      runtimeInstructionArtifacts.taskSkillMd,
      "utf8"
    )
  ]);

  return {
    workspaceId,
    workspaceRoot,
    contextDir,
    files,
    instructions: {
      canonicalSources: runtimeInstructionLayer.canonicalSources,
      taskContractFiles: scopedArtifactKeys.map((key) => files[key]),
      files: instructionFiles
    }
  };
}

export function createWorkspaceDescriptor(input: {
  bundle: WorkspaceContextBundle;
  materialized: MaterializedWorkspaceContext;
  createdAt?: string;
  updatedAt?: string;
  status?: WorkspaceDescriptor["status"];
  destroyedAt?: string | null;
  secretLease?: SecretLease | null;
  secretEnvFile?: string | null;
}): WorkspaceDescriptor {
  const bundle = input.bundle;
  const workspaceId = input.materialized.workspaceId;
  const createdAt = input.createdAt ?? asIsoTimestamp();
  const updatedAt = input.updatedAt ?? createdAt;
  const stateDir = join(
    input.materialized.workspaceRoot,
    workspaceStateDirName
  );
  const stateFile = join(stateDir, workspaceStateFileName);
  const scratchDir = join(
    input.materialized.workspaceRoot,
    workspaceScratchDirName
  );
  const artifactsDir = join(
    input.materialized.workspaceRoot,
    workspaceArtifactsDirName
  );
  const toolPolicy = createWorkspaceToolPolicy(bundle);
  const credentialPolicy = createWorkspaceCredentialPolicy({
    bundle,
    secretLease: input.secretLease ?? null,
    secretEnvFile: input.secretEnvFile ?? null
  });

  return workspaceDescriptorSchema.parse({
    workspaceId,
    taskId: bundle.manifest.taskId,
    workspaceRoot: input.materialized.workspaceRoot,
    contextDir: input.materialized.contextDir,
    stateFile,
    scratchDir,
    artifactsDir,
    status: input.status ?? "provisioned",
    assignedAgentType: bundle.manifest.assignedAgentType,
    recommendedAgentType: bundle.spec.recommendedAgentType,
    allowedCapabilities: toolPolicy.allowedCapabilities,
    allowedPaths: bundle.allowedPaths,
    blockedPhases: toolPolicy.blockedPhases,
    canonicalSources: input.materialized.instructions.canonicalSources,
    taskContractFiles: input.materialized.instructions.taskContractFiles,
    instructionFiles: input.materialized.instructions.files,
    toolPolicy,
    credentialPolicy,
    createdAt,
    updatedAt,
    destroyedAt: input.destroyedAt ?? null
  });
}

export async function materializeManagedWorkspace(input: {
  bundle: WorkspaceContextBundle;
  targetRoot: string;
  workspaceId?: string;
  createdAt?: string;
  secretLease?: SecretLease | null;
}): Promise<MaterializedManagedWorkspace> {
  const materializedBundle = workspaceContextBundleSchema.parse({
    ...input.bundle,
    manifest: {
      ...input.bundle.manifest,
      workspaceId:
        input.workspaceId ??
        input.bundle.manifest.workspaceId ??
        `${input.bundle.manifest.taskId}-workspace`
    }
  });
  const materialized = await materializeWorkspaceContext({
    bundle: materializedBundle,
    targetRoot: input.targetRoot,
    ...(materializedBundle.manifest.workspaceId
      ? { workspaceId: materializedBundle.manifest.workspaceId }
      : {})
  });
  const stateDir = join(materialized.workspaceRoot, workspaceStateDirName);
  const stateFile = join(stateDir, workspaceStateFileName);
  const scratchDir = join(materialized.workspaceRoot, workspaceScratchDirName);
  const artifactsDir = join(
    materialized.workspaceRoot,
    workspaceArtifactsDirName
  );
  const credentialsDir = join(stateDir, workspaceCredentialsDirName);
  const secretLease = input.secretLease ?? null;
  const secretEnvFile = secretLease
    ? join(credentialsDir, workspaceSecretEnvFileName)
    : null;
  const descriptor = createWorkspaceDescriptor({
    bundle: materializedBundle,
    materialized,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    secretLease,
    secretEnvFile
  });

  await Promise.all([
    mkdir(stateDir, { recursive: true }),
    mkdir(scratchDir, { recursive: true }),
    mkdir(artifactsDir, { recursive: true }),
    ...(secretEnvFile ? [mkdir(credentialsDir, { recursive: true })] : [])
  ]);

  if (secretLease && secretEnvFile) {
    await writeFile(
      secretEnvFile,
      `${JSON.stringify(
        {
          leaseId: secretLease.leaseId,
          mode: secretLease.mode,
          secretScopes: secretLease.secretScopes,
          injectedSecretKeys: secretLease.injectedSecretKeys,
          issuedAt: secretLease.issuedAt,
          expiresAt: secretLease.expiresAt,
          environmentVariables: secretLease.environmentVariables,
          notes: secretLease.notes
        },
        null,
        2
      )}
`,
      "utf8"
    );
  }

  await writeFile(
    stateFile,
    `${JSON.stringify(descriptor, null, 2)}
`,
    "utf8"
  );

  return {
    ...materialized,
    stateDir,
    stateFile,
    scratchDir,
    artifactsDir,
    repoRoot: null,
    descriptor
  };
}

export async function scrubManagedWorkspaceSecrets(input: {
  workspace: MaterializedManagedWorkspace;
  scrubbedAt?: string;
}): Promise<ScrubbedWorkspaceSecretsResult> {
  const scrubbedAt = input.scrubbedAt ?? asIsoTimestamp();
  const secretEnvFile = input.workspace.descriptor.credentialPolicy.secretEnvFile;

  if (
    input.workspace.descriptor.credentialPolicy.mode !== "scoped_env" ||
    !secretEnvFile
  ) {
    return {
      workspaceId: input.workspace.workspaceId,
      scrubbed: false,
      removed: false,
      secretEnvFile: null,
      scrubbedAt,
      descriptor: input.workspace.descriptor
    };
  }

  const resolvedSecretEnvFile = resolve(secretEnvFile);
  assertWorkspacePathWithinRoot(input.workspace.workspaceRoot, resolvedSecretEnvFile);
  const removed = await pathExists(resolvedSecretEnvFile);
  await rm(resolvedSecretEnvFile, { force: true });

  const scrubNote = "Workspace credential lease file was scrubbed after phase exit.";
  const notes = input.workspace.descriptor.credentialPolicy.notes.includes(scrubNote)
    ? input.workspace.descriptor.credentialPolicy.notes
    : [...input.workspace.descriptor.credentialPolicy.notes, scrubNote];
  const descriptor = workspaceDescriptorSchema.parse({
    ...input.workspace.descriptor,
    updatedAt: scrubbedAt,
    credentialPolicy: {
      ...input.workspace.descriptor.credentialPolicy,
      secretEnvFile: null,
      notes
    }
  });

  input.workspace.descriptor = descriptor;
  await writeFile(
    input.workspace.stateFile,
    `${JSON.stringify(descriptor, null, 2)}
`,
    "utf8"
  );

  return {
    workspaceId: input.workspace.workspaceId,
    scrubbed: true,
    removed,
    secretEnvFile: resolvedSecretEnvFile,
    scrubbedAt,
    descriptor
  };
}

export async function provisionTaskWorkspace(input: {
  snapshot: PersistedTaskSnapshot;
  repository: PlanningRepository;
  targetRoot: string;
  workspaceId?: string;
  clock?: () => Date;
}): Promise<ProvisionWorkspaceResult> {
  const bundle = createWorkspaceContextBundleFromSnapshot(input.snapshot);
  const now = asIsoTimestamp((input.clock ?? (() => new Date()))());
  const workspace = await materializeManagedWorkspace({
    bundle,
    targetRoot: input.targetRoot,
    createdAt: now,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {})
  });
  const manifest = {
    ...bundle.manifest,
    workspaceId: workspace.workspaceId,
    updatedAt: now,
    evidenceLinks: [
      ...new Set([
        ...bundle.manifest.evidenceLinks,
        `${workspaceLocationPrefix}${workspace.workspaceId}`
      ])
    ]
  } as TaskManifest;

  await input.repository.updateManifest(manifest);
  await input.repository.saveEvidenceRecord(
    createEvidenceRecord({
      recordId: `${bundle.manifest.taskId}:workspace:${workspace.workspaceId}:provisioned`,
      taskId: bundle.manifest.taskId,
      kind: "file_artifact",
      title: "Managed workspace provisioned",
      location: `${workspaceLocationPrefix}${workspace.workspaceId}`,
      metadata: {
        status: workspace.descriptor.status,
        workspaceRoot: workspace.workspaceRoot,
        stateFile: workspace.stateFile,
        descriptor: workspace.descriptor
      },
      createdAt: now
    })
  );

  return {
    manifest,
    workspace
  };
}

export async function destroyManagedWorkspace(input: {
  targetRoot: string;
  workspaceId: string;
  destroyedAt?: string;
}): Promise<DestroyedManagedWorkspace> {
  const destroyedAt = input.destroyedAt ?? asIsoTimestamp();
  const workspaceRoot = resolve(input.targetRoot, input.workspaceId);

  assertWorkspacePathWithinRoot(input.targetRoot, workspaceRoot);

  const stateFile = join(
    workspaceRoot,
    workspaceStateDirName,
    workspaceStateFileName
  );
  const descriptor = await readWorkspaceDescriptorForDestroy(
    stateFile,
    destroyedAt
  );
  const removed = await pathExists(workspaceRoot);

  if (removed) {
    await rm(workspaceRoot, { recursive: true, force: true });
  }

  return {
    workspaceId: input.workspaceId,
    workspaceRoot,
    removed,
    descriptor
  };
}

export async function destroyTaskWorkspace(input: {
  manifest: TaskManifest;
  repository: PlanningRepository;
  targetRoot: string;
  workspaceId?: string;
  evidenceRoot?: string | undefined;
  clock?: () => Date;
}): Promise<DestroyWorkspaceResult> {
  const workspaceId = input.workspaceId ?? input.manifest.workspaceId;

  if (!workspaceId) {
    throw new Error(
      `Cannot destroy workspace for ${input.manifest.taskId} without a workspaceId.`
    );
  }

  const destroyedAt = asIsoTimestamp((input.clock ?? (() => new Date()))());
  const workspace = await destroyManagedWorkspace({
    targetRoot: input.targetRoot,
    workspaceId,
    destroyedAt
  });
  const manifest = {
    ...input.manifest,
    workspaceId: null,
    updatedAt: destroyedAt,
    evidenceLinks: [
      ...new Set([
        ...input.manifest.evidenceLinks,
        `${workspaceLocationPrefix}${workspaceId}`
      ])
    ]
  } as TaskManifest;

  await input.repository.updateManifest(manifest);
  await input.repository.saveEvidenceRecord(
    createEvidenceRecord({
      recordId: `${input.manifest.taskId}:workspace:${workspaceId}:destroyed`,
      taskId: input.manifest.taskId,
      kind: "file_artifact",
      title: "Managed workspace destroyed",
      location: `${workspaceLocationPrefix}${workspaceId}`,
      metadata: {
        status: workspace.descriptor?.status ?? "destroyed",
        workspaceRoot: workspace.workspaceRoot,
        removed: workspace.removed,
        descriptor: workspace.descriptor,
        destroyedAt
      },
      createdAt: destroyedAt
    })
  );

  return {
    manifest,
    workspace
  };
}

// ============================================================
// Evidence archival helpers (used by pipeline.ts)
// ============================================================

export function resolveEvidenceRoot(
  targetRoot: string,
  evidenceRoot?: string,
  runtimeConfig?: WorkspaceRuntimeConfig
): string {
  return resolve(
    evidenceRoot ??
      runtimeConfig?.hostEvidenceRoot ??
      process.env.REDDWARF_HOST_EVIDENCE_ROOT ??
      join(targetRoot, "..", defaultEvidenceDirName)
  );
}

function sanitizeEvidencePathSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  return sanitized.length > 0 ? sanitized : "artifact";
}

export async function archiveEvidenceArtifact(input: {
  taskId: string;
  runId: string;
  phase: string;
  sourcePath: string;
  targetRoot: string;
  evidenceRoot?: string | undefined;
  fileName?: string;
}): Promise<ArchivedEvidenceArtifact> {
  const evidenceRoot = resolveEvidenceRoot(input.targetRoot, input.evidenceRoot);
  const relativePath = [
    evidenceTasksDirName,
    sanitizeEvidencePathSegment(input.taskId),
    sanitizeEvidencePathSegment(input.phase),
    sanitizeEvidencePathSegment(input.runId),
    input.fileName ?? basename(input.sourcePath)
  ].join("/");
  const archivePath = resolve(evidenceRoot, ...relativePath.split("/"));

  await mkdir(dirname(archivePath), { recursive: true });
  await copyFile(input.sourcePath, archivePath);

  const archiveStats = await stat(archivePath);
  const sha256 = await streamFileHash(archivePath);

  return {
    evidenceRoot,
    archivePath,
    relativePath,
    location: `${evidenceLocationPrefix}${relativePath}`,
    byteSize: archiveStats.size,
    sha256
  };
}

function streamFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

export function buildArchivedArtifactMetadata(input: {
  archivedArtifact: ArchivedEvidenceArtifact;
  artifactClass: ArchivedArtifactClass;
  sourceLocation: string;
  sourcePath: string;
}): Record<string, unknown> {
  return {
    artifactClass: input.artifactClass,
    sourceLocation: input.sourceLocation,
    sourcePath: input.sourcePath,
    evidenceRoot: input.archivedArtifact.evidenceRoot,
    archivePath: input.archivedArtifact.archivePath,
    archiveRelativePath: input.archivedArtifact.relativePath,
    byteSize: input.archivedArtifact.byteSize,
    sha256: input.archivedArtifact.sha256
  };
}

// ============================================================
// Workspace tool and credential policy
// ============================================================

export function createWorkspaceToolPolicy(
  bundle: WorkspaceContextBundle
): WorkspaceDescriptor["toolPolicy"] {
  const secretsCapability =
    bundle.policySnapshot.allowedCapabilities.includes("can_use_secrets") &&
    bundle.policySnapshot.allowedSecretScopes.length > 0
      ? (["can_use_secrets"] as Capability[])
      : [];

  if (
    bundle.manifest.currentPhase === "architecture_review" ||
    bundle.manifest.assignedAgentType === "reviewer"
  ) {
    return {
      mode: TOOL_MODE_ARCHITECTURE_REVIEW,
      codeWriteEnabled: false,
      allowedCapabilities: ["can_review", "can_archive_evidence"],
      blockedPhases: bundle.policySnapshot.blockedPhases,
      notes: [...architectureReviewWorkspaceToolPolicyNotes]
    };
  }

  if (
    bundle.manifest.currentPhase === "validation" ||
    bundle.manifest.assignedAgentType === "validation"
  ) {
    return {
      mode: TOOL_MODE_VALIDATION,
      codeWriteEnabled: false,
      allowedCapabilities: [
        ...validationWorkspaceCapabilities.filter(
          (capability) => capability !== "can_use_secrets"
        ),
        ...secretsCapability
      ],
      blockedPhases: bundle.policySnapshot.blockedPhases,
      notes: [...validationWorkspaceToolPolicyNotes]
    };
  }

  if (
    bundle.manifest.currentPhase === "development" ||
    bundle.manifest.assignedAgentType === "developer"
  ) {
    return {
      mode: TOOL_MODE_DEVELOPMENT_READONLY,
      codeWriteEnabled: false,
      allowedCapabilities: [
        ...developmentWorkspaceCapabilities.filter(
          (capability) => capability !== "can_use_secrets"
        ),
        ...secretsCapability
      ],
      blockedPhases: bundle.policySnapshot.blockedPhases,
      notes: [...developmentWorkspaceToolPolicyNotes]
    };
  }

  if (
    bundle.manifest.currentPhase === "scm" ||
    bundle.manifest.assignedAgentType === "scm"
  ) {
    return {
      mode: TOOL_MODE_SCM,
      codeWriteEnabled: false,
      allowedCapabilities: [...scmWorkspaceCapabilities],
      blockedPhases: bundle.policySnapshot.blockedPhases,
      notes: [...scmWorkspaceToolPolicyNotes]
    };
  }

  return {
    mode: TOOL_MODE_PLANNING,
    codeWriteEnabled: false,
    allowedCapabilities: [...planningWorkspaceCapabilities],
    blockedPhases: bundle.policySnapshot.blockedPhases,
    notes: [...planningWorkspaceToolPolicyNotes]
  };
}

export function createWorkspaceCredentialPolicy(input: {
  bundle: WorkspaceContextBundle;
  secretLease?: SecretLease | null;
  secretEnvFile?: string | null;
}): WorkspaceDescriptor["credentialPolicy"] {
  const bundle = input.bundle;
  const allowedSecretScopes = [...new Set(bundle.policySnapshot.allowedSecretScopes)];
  const secretsAllowedByPolicy =
    bundle.manifest.requestedCapabilities.includes("can_use_secrets") &&
    bundle.policySnapshot.allowedCapabilities.includes("can_use_secrets") &&
    allowedSecretScopes.length > 0;

  if (!secretsAllowedByPolicy) {
    return {
      mode: "none",
      allowedSecretScopes,
      injectedSecretKeys: [],
      secretEnvFile: null,
      leaseIssuedAt: null,
      leaseExpiresAt: null,
      notes: [...defaultWorkspaceCredentialPolicyNotes]
    };
  }

  const secretLease = input.secretLease ?? null;

  if (!secretLease) {
    return {
      mode: "none",
      allowedSecretScopes,
      injectedSecretKeys: [],
      secretEnvFile: null,
      leaseIssuedAt: null,
      leaseExpiresAt: null,
      notes: [
        `Task is approved for scoped credentials (${allowedSecretScopes.join(", ")}), but no lease has been materialized for this workspace.`
      ]
    };
  }

  if (secretLease.mode !== "scoped_env") {
    throw new Error(
      `Unsupported secret lease mode ${secretLease.mode} for workspace credential policy.`
    );
  }

  const disallowedScopes = secretLease.secretScopes.filter(
    (scope) => !allowedSecretScopes.includes(scope)
  );

  if (disallowedScopes.length > 0) {
    throw new Error(
      `Secret lease requested scopes outside policy approval: ${disallowedScopes.join(", ")}.`
    );
  }

  if (!input.secretEnvFile) {
    throw new Error(
      "A scoped secret lease requires a workspace-local credential file path."
    );
  }

  return {
    mode: "scoped_env",
    allowedSecretScopes,
    injectedSecretKeys: [...secretLease.injectedSecretKeys].sort(),
    secretEnvFile: input.secretEnvFile,
    leaseIssuedAt: secretLease.issuedAt,
    leaseExpiresAt: secretLease.expiresAt,
    notes: [
      ...secretLease.notes,
      "Scoped credentials are materialized into a workspace-local lease file and never persisted in evidence metadata."
    ]
  };
}

// ============================================================
// Internal workspace helpers
// ============================================================

function toolPolicyRequiresScmEscalation(
  bundle: WorkspaceContextBundle
): boolean {
  return !createWorkspaceToolPolicy(bundle).allowedCapabilities.includes(
    "can_open_pr"
  );
}

function buildCanonicalSources(bundle: WorkspaceContextBundle): string[] {
  const agentType = bundle.manifest.assignedAgentType;
  const canonicalSources = new Set<string>();

  // Architecture overview and implementation map: relevant to agents that
  // create or review code, not needed by execution-only phases (validation, scm).
  if (agentType === "architect" || agentType === "developer" || agentType === "reviewer") {
    canonicalSources.add("openclaw_ai_dev_team_v_2_architecture.md");
    canonicalSources.add("docs/implementation-map.md");
  }

  // Engineering standards: all code-touching phases need this.
  canonicalSources.add("standards/engineering.md");

  // Planning prompt: only relevant to agents that produce or review specs.
  if (agentType === "architect" || agentType === "reviewer") {
    canonicalSources.add("prompts/planning-system.md");
  }

  const assignedAgentSource =
    agentInstructionPathByType[agentType];
  const recommendedAgentSource =
    agentInstructionPathByType[bundle.spec.recommendedAgentType];

  if (assignedAgentSource) {
    canonicalSources.add(assignedAgentSource);
  }

  if (recommendedAgentSource) {
    canonicalSources.add(recommendedAgentSource);
  }

  return [...canonicalSources];
}

function getRoleScopedContextArtifactKeys(
  bundle: WorkspaceContextBundle
): WorkspaceContextArtifactKey[] {
  switch (bundle.manifest.assignedAgentType) {
    case "developer":
      return ["taskJson", "specMarkdown", "projectMemoryJson", "acceptanceCriteriaJson"];
    case "validation":
      return ["taskJson", "specMarkdown", "acceptanceCriteriaJson"];
    case "scm":
      return ["taskJson", "specMarkdown"];
    default:
      return [
        "taskJson",
        "specMarkdown",
        "projectMemoryJson",
        "policySnapshotJson",
        "allowedPathsJson",
        "acceptanceCriteriaJson"
      ];
  }
}

function getRoleScopedContextFiles(bundle: WorkspaceContextBundle): string[] {
  return getRoleScopedContextArtifactKeys(bundle).map(
    (key) => taskContractFileMetadata[key].relativePath
  );
}

function getRuntimeInstructionContent(
  layer: RuntimeInstructionLayer,
  relativePath: string
): string {
  const file = layer.files.find((entry) => entry.relativePath === relativePath);

  if (!file) {
    throw new Error(`Missing runtime instruction file ${relativePath}.`);
  }

  return file.content.endsWith("\n") ? file.content : `${file.content}\n`;
}

export function formatLiteralList(items: readonly string[]): string {
  if (items.length === 0) {
    return "none";
  }

  return items.map((item) => `\`${item}\``).join(", ");
}

function renderRuntimeSoulMarkdown(
  bundle: WorkspaceContextBundle,
  canonicalSources: string[],
  contextFiles: string[]
): string {
  const toolPolicy = createWorkspaceToolPolicy(bundle);

  return [
    "# RedDwarf Runtime Soul",
    "",
    `This workspace is provisioned for task \`${bundle.manifest.taskId}\` under policy \`${bundle.policySnapshot.policyVersion}\`.`,
    "",
    "## Task Frame",
    "",
    `- Assigned agent: \`${bundle.manifest.assignedAgentType}\``,
    `- Recommended agent: \`${bundle.spec.recommendedAgentType}\``,
    `- Workspace ID: \`${bundle.manifest.workspaceId ?? bundle.manifest.taskId}\``,
    `- Current phase in manifest: \`${bundle.manifest.currentPhase}\``,
    `- Risk class: \`${bundle.manifest.riskClass}\``,
    `- Approval mode: \`${bundle.policySnapshot.approvalMode}\``,
    "",
    "## First Reads",
    "",
    ...contextFiles.map((path) => `- \`${path}\``),
    "",
    "## Canonical Sources",
    "",
    ...canonicalSources.map((path) => `- \`${path}\``),
    "",
    "## Guardrails",
    "",
    `- Allowed capabilities: ${formatLiteralList(toolPolicy.allowedCapabilities)}`,
    `- Allowed paths: ${formatLiteralList(bundle.allowedPaths)}`,
    `- Blocked phases in v1: ${formatLiteralList(toolPolicy.blockedPhases)}`,
    "- Product code writes remain disabled; stay inside the approved workspace and path scope.",
    toolPolicy.allowedCapabilities.includes("can_open_pr")
      ? "- Remote mutations are limited to approved branch and pull-request creation for this task."
      : "- Remote mutations remain blocked; escalate before opening branches, pull requests, or mutating external systems.",
    "- Treat `.context/` as the task contract and the policy-pack docs as the canonical source of engineering rules.",
    ""
  ].join("\n");
}

function renderRuntimeAgentsMarkdown(bundle: WorkspaceContextBundle): string {
  const enabledAgents = agentDefinitions
    .filter((agent) => agent.enabled)
    .map((agent) => agent.type);

  return [
    "# Agent Instructions",
    "",
    `- Assigned agent for this task: \`${bundle.manifest.assignedAgentType}\``,
    `- Recommended agent from planning: \`${bundle.spec.recommendedAgentType}\``,
    `- Enabled autonomous agents in v1: ${formatLiteralList(enabledAgents)}`,
    "",
    ...agentDefinitions.flatMap((agent) => {
      const instructionPath = agentInstructionPathByType[agent.type];

      return [
        `## ${agent.displayName}`,
        "",
        `- Type: \`${agent.type}\``,
        `- Enabled: ${agent.enabled ? "yes" : "no"}`,
        `- Active phases: ${formatLiteralList(agent.activePhases)}`,
        `- Capabilities: ${formatLiteralList(agent.capabilities)}`,
        `- Description: ${agent.description}`,
        instructionPath
          ? `- Canonical role file: \`${instructionPath}\``
          : "- Canonical role file: no dedicated markdown asset is versioned yet; use this roster entry.",
        ""
      ];
    })
  ].join("\n");
}

function renderRuntimeToolsMarkdown(bundle: WorkspaceContextBundle): string {
  const toolPolicy = createWorkspaceToolPolicy(bundle);
  const deniedCapabilities = capabilities.filter(
    (capability) => !toolPolicy.allowedCapabilities.includes(capability)
  );
  const requestedButDenied = bundle.manifest.requestedCapabilities.filter(
    (capability) => !toolPolicy.allowedCapabilities.includes(capability)
  );

  return [
    "# Tool Contract",
    "",
    `- Tool policy mode: \`${toolPolicy.mode}\``,
    `- Code writing enabled: ${toolPolicy.codeWriteEnabled ? "yes" : "no"}`,
    `- Requested capabilities: ${formatLiteralList(bundle.manifest.requestedCapabilities)}`,
    `- Allowed capabilities now: ${formatLiteralList(toolPolicy.allowedCapabilities)}`,
    `- Currently denied capabilities: ${formatLiteralList(deniedCapabilities)}`,
    `- Requested but denied: ${formatLiteralList(requestedButDenied)}`,
    `- Allowed secret scopes: ${formatLiteralList(bundle.policySnapshot.allowedSecretScopes)}`,
    "",
    "## Tool Policy Notes",
    "",
    ...toolPolicy.notes.map((note) => `- ${note}`),
    "",
    "## Allowed Capability Guidance",
    "",
    ...toolPolicy.allowedCapabilities.flatMap((capability) => [
      `### \`${capability}\``,
      "",
      capabilityGuidance[capability],
      ""
    ]),
    "## Credential Guardrails",
    "",
    ...(bundle.policySnapshot.allowedSecretScopes.length > 0
      ? [
          `- Approved secret scopes: ${formatLiteralList(bundle.policySnapshot.allowedSecretScopes)}`,
          `- When a secrets adapter issues a lease, credentials are mounted at \`${workspaceStateDirName}/${workspaceCredentialsDirName}/${workspaceSecretEnvFileName}\` and only the key names are persisted in metadata.`
        ]
      : ["- No secret scopes are approved for this task."]),
    "",
    "## Path Guardrails",
    "",
    ...(bundle.allowedPaths.length > 0
      ? bundle.allowedPaths.map((path) => `- \`${path}\``)
      : [
          "- No product-repo paths are pre-authorized. Escalate before modifying any surface."
        ]),
    "",
    "## Blocked Phases",
    "",
    ...toolPolicy.blockedPhases.map((phase) => `- \`${phase}\``),
    "",
    "## Escalate Instead Of",
    "",
    "- writing product code",
    ...(toolPolicy.allowedCapabilities.includes("can_open_pr")
      ? ["- mutating remote systems outside approved branch and pull-request creation"]
      : ["- opening pull requests or mutating remote systems"]),
    "- using secrets outside approved scopes or without an injected lease",
    "- touching paths outside the allowed scope",
    ""
  ].join("\n");
}

function roleContextReadingInstruction(bundle: WorkspaceContextBundle): string {
  switch (bundle.manifest.assignedAgentType) {
    case "developer":
      return "1. Read `.context/task.json`, `.context/spec.md`, `.context/project_memory.json`, and `.context/acceptance_criteria.json` before writing code.";
    case "validation":
      return "1. Read `.context/task.json`, `.context/spec.md`, and `.context/acceptance_criteria.json` before running validation.";
    case "scm":
      return "1. Read `.context/task.json` and `.context/spec.md` before creating branches or PRs.";
    default:
      return "1. Read `.context/task.json`, `.context/spec.md`, `.context/project_memory.json`, and `.context/policy_snapshot.json` before proposing or executing work.";
  }
}

function renderRuntimeTaskSkillMarkdown(
  bundle: WorkspaceContextBundle,
  canonicalSources: string[],
  contextFiles: string[]
): string {
  return [
    "# RedDwarf Task Runtime Skill",
    "",
    `Use this skill before taking action on task \`${bundle.manifest.taskId}\`.`,
    "",
    "## Workflow",
    "",
    roleContextReadingInstruction(bundle),
    "2. Confirm that the requested action stays within the current tool-policy capabilities and allowed paths.",
    `3. Use the assigned role instructions first: \`${agentInstructionPathByType[bundle.manifest.assignedAgentType] ?? "AGENTS.md"}\`.`,
    `4. Use the recommended role instructions from planning: \`${agentInstructionPathByType[bundle.spec.recommendedAgentType] ?? "AGENTS.md"}\`.`,
    "5. Produce evidence-friendly output that traces assumptions, affected areas, constraints, acceptance criteria, and verification intent.",
    toolPolicyRequiresScmEscalation(bundle)
      ? "6. Escalate whenever the task would require code-writing, secrets, PR creation, or a blocked phase in v1."
      : "6. Escalate whenever the task would require code-writing, secrets outside approved scopes, or a blocked phase in v1.",
    "",
    "## Role-Scoped Context Files",
    "",
    ...contextFiles.map((path) => `- \`${path}\``),
    "",
    "## Canonical Sources",
    "",
    ...canonicalSources.map((path) => `- \`${path}\``),
    ""
  ].join("\n");
}

async function readWorkspaceDescriptorForDestroy(
  stateFile: string,
  destroyedAt: string
): Promise<WorkspaceDescriptor | null> {
  try {
    const descriptor = workspaceDescriptorSchema.parse(
      JSON.parse(await readFile(stateFile, "utf8"))
    );

    return workspaceDescriptorSchema.parse({
      ...descriptor,
      status: "destroyed",
      updatedAt: destroyedAt,
      destroyedAt
    });
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }

    throw error;
  }
}

function assertWorkspacePathWithinRoot(
  targetRoot: string,
  workspaceRoot: string
): void {
  const resolvedTargetRoot = resolve(targetRoot);
  const resolvedWorkspaceRoot = resolve(workspaceRoot);
  const relativePath = relative(resolvedTargetRoot, resolvedWorkspaceRoot);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(
      `Workspace path ${resolvedWorkspaceRoot} escapes configured root ${resolvedTargetRoot}.`
    );
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
