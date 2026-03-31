import { createMemoryRecord, deriveOrganizationId, type PlanningRepository } from "@reddwarf/evidence";
import {
  asIsoTimestamp,
  taskGroupMembershipSchema,
  type TaskGroupExecutionMode,
  type TaskGroupMembership,
  type TaskManifest
} from "@reddwarf/contracts";

export const taskGroupMemoryKey = "task.group.membership";

export async function saveTaskGroupMemberships(input: {
  repository: PlanningRepository;
  repo: string;
  groupId: string;
  groupName?: string;
  executionMode: TaskGroupExecutionMode;
  memberships: Array<{
    taskId: string;
    taskKey: string;
    sequence: number;
    dependsOnTaskKeys: string[];
    dependsOnTaskIds: string[];
  }>;
  createdAt?: string;
}): Promise<void> {
  const createdAt = input.createdAt ?? asIsoTimestamp();
  const organizationId = deriveOrganizationId(input.repo);

  await input.repository.runInTransaction(async (repository) => {
    for (const membership of input.memberships) {
      const value = taskGroupMembershipSchema.parse({
        groupId: input.groupId,
        groupName: input.groupName ?? null,
        executionMode: input.executionMode,
        taskKey: membership.taskKey,
        sequence: membership.sequence,
        dependsOnTaskKeys: membership.dependsOnTaskKeys,
        dependsOnTaskIds: membership.dependsOnTaskIds
      });

      await repository.saveMemoryRecord(
        createMemoryRecord({
          memoryId: `${membership.taskId}:memory:task-group:${input.groupId}`,
          taskId: membership.taskId,
          scope: "task",
          provenance: "pipeline_derived",
          key: taskGroupMemoryKey,
          title: "Task group membership",
          value,
          repo: input.repo,
          organizationId,
          tags: ["task-group", `group:${input.groupId}`],
          createdAt,
          updatedAt: createdAt
        })
      );
    }
  });
}

export async function getTaskGroupMembership(
  repository: PlanningRepository,
  taskId: string
): Promise<TaskGroupMembership | null> {
  const records = await repository.listMemoryRecords({
    taskId,
    keyPrefix: taskGroupMemoryKey,
    limit: 1
  });
  const value = records[0]?.value;
  if (!value) {
    return null;
  }

  return taskGroupMembershipSchema.parse(value);
}

export async function resolveUnmetTaskGroupDependencies(
  repository: PlanningRepository,
  manifest: TaskManifest
): Promise<{
  membership: TaskGroupMembership | null;
  unmetDependencies: Array<{ taskId: string; lifecycleStatus: TaskManifest["lifecycleStatus"] | "missing" }>;
}> {
  const membership = await getTaskGroupMembership(repository, manifest.taskId);
  if (!membership || membership.dependsOnTaskIds.length === 0) {
    return { membership, unmetDependencies: [] };
  }

  const unmetDependencies: Array<{
    taskId: string;
    lifecycleStatus: TaskManifest["lifecycleStatus"] | "missing";
  }> = [];

  for (const dependencyTaskId of membership.dependsOnTaskIds) {
    const dependencyManifest = await repository.getManifest(dependencyTaskId);
    if (!dependencyManifest) {
      unmetDependencies.push({
        taskId: dependencyTaskId,
        lifecycleStatus: "missing"
      });
      continue;
    }

    if (dependencyManifest.lifecycleStatus !== "completed") {
      unmetDependencies.push({
        taskId: dependencyTaskId,
        lifecycleStatus: dependencyManifest.lifecycleStatus
      });
    }
  }

  return { membership, unmetDependencies };
}
