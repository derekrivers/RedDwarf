import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createPolicyPackPackage,
  validatePolicyPackRoot
} from "./lib/policy-packaging.mjs";

const packaged = await createPolicyPackPackage();
await validatePolicyPackRoot(packaged.packageRoot);

const controlPlaneModule = await import(
  pathToFileURL(
    `${packaged.packageRoot.replace(/\\/g, "/")}/packages/control-plane/dist/index.js`
  ).href
);
const manifestModule = await import(
  pathToFileURL(
    `${packaged.packageRoot.replace(/\\/g, "/")}/packages/contracts/dist/index.js`
  ).href
);
const executionPlaneModule = await import(
  pathToFileURL(
    `${packaged.packageRoot.replace(/\\/g, "/")}/packages/execution-plane/dist/index.js`
  ).href
);

const bundle = {
  manifest: {
    taskId: "packaged-verify-1",
    source: {
      provider: "github",
      repo: "acme/platform",
      issueNumber: 1,
      issueUrl: "https://github.com/acme/platform/issues/1"
    },
    title: "Verify packaged policy pack",
    summary:
      "Verify that the packaged policy pack can be mounted and its runtime helpers can still execute.",
    priority: 1,
    riskClass: "low",
    approvalMode: "auto",
    currentPhase: "archive",
    lifecycleStatus: "completed",
    assignedAgentType: "architect",
    requestedCapabilities: ["can_plan", "can_archive_evidence"],
    retryCount: 0,
    evidenceLinks: ["db://manifest/packaged-verify-1"],
    workspaceId: null,
    branchName: null,
    prNumber: null,
    policyVersion: "reddwarf-v1",
    createdAt: packaged.manifest.createdAt,
    updatedAt: packaged.manifest.createdAt
  },
  spec: {
    specId: "packaged-spec-1",
    taskId: "packaged-verify-1",
    summary: "Verify packaged policy-pack helpers.",
    assumptions: ["Packaged mount is immutable."],
    affectedAreas: ["prompts/planning-system.md"],
    constraints: ["Do not rely on the live workspace."],
    acceptanceCriteria: ["Spec markdown renders", "Manifest validates"],
    testExpectations: ["Packaged dist imports resolve."],
    recommendedAgentType: "architect",
    riskClass: "low",
    createdAt: packaged.manifest.createdAt
  },
  policySnapshot: {
    policyVersion: "reddwarf-v1",
    approvalMode: "auto",
    allowedCapabilities: ["can_plan", "can_archive_evidence"],
    allowedPaths: ["prompts/**"],
    allowedSecretScopes: [],
    blockedPhases: ["review", "scm"],
    reasons: ["Packaged policy pack verification run."]
  },
  acceptanceCriteria: ["Spec markdown renders", "Manifest validates"],
  allowedPaths: ["prompts/**"]
};

const artifacts = controlPlaneModule.createWorkspaceContextArtifacts(bundle);
const instructionLayer =
  controlPlaneModule.createRuntimeInstructionLayer(bundle);
const instructionArtifacts =
  controlPlaneModule.createRuntimeInstructionArtifacts(instructionLayer);
const parsedManifest = manifestModule.policyPackManifestSchema.parse(
  packaged.manifest
);
const openClawDefinitions = executionPlaneModule.openClawAgentRoleDefinitions;
const tempRoot = await mkdtemp(join(tmpdir(), "reddwarf-packaged-workspace-"));

try {
  const managedWorkspace = await controlPlaneModule.materializeManagedWorkspace(
    {
      bundle,
      targetRoot: tempRoot,
      workspaceId: "packaged-workspace-1",
      createdAt: packaged.manifest.createdAt
    }
  );
  const destroyed = await controlPlaneModule.destroyManagedWorkspace({
    targetRoot: tempRoot,
    workspaceId: "packaged-workspace-1",
    destroyedAt: packaged.manifest.createdAt
  });

  assert.equal(parsedManifest.policyPackId, "reddwarf-policy-pack");
  assert.match(artifacts.specMarkdown, /# Planning Spec/);
  assert.match(artifacts.taskJson, /packaged-verify-1/);
  assert.equal(
    artifacts.acceptanceCriteriaJson.includes("Spec markdown renders"),
    true
  );
  assert.match(instructionArtifacts.soulMd, /RedDwarf Runtime Soul/);
  assert.match(instructionArtifacts.agentsMd, /Architect Agent/);
  assert.match(instructionArtifacts.taskSkillMd, /\.context\/task\.json/);
  assert.equal(
    instructionLayer.canonicalSources.includes("prompts/planning-system.md"),
    true
  );
  assert.equal(managedWorkspace.descriptor.status, "provisioned");
  assert.equal(destroyed.descriptor?.status, "destroyed");
  assert.equal(destroyed.removed, true);
  await assert.rejects(access(managedWorkspace.workspaceRoot));
  assert.equal(openClawDefinitions.length, 3);

  for (const definition of openClawDefinitions) {
    for (const file of definition.bootstrapFiles) {
      await access(resolve(packaged.packageRoot, file.relativePath));
    }
  }

  console.log(
    JSON.stringify(
      {
        policyPackVersion: packaged.manifest.policyPackVersion,
        packageRoot: packaged.packageRoot,
        manifestPath: packaged.manifestPath,
        contentHash: packaged.manifest.contentHash,
        includedEntryCount: packaged.manifest.includedEntries.length,
        openClawRoleCount: openClawDefinitions.length
      },
      null,
      2
    )
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}


