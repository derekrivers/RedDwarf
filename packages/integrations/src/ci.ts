import { asIsoTimestamp } from "@reddwarf/contracts";
import { V1MutationDisabledError } from "./errors.js";

export const ciCheckStatuses = ["success", "failure", "pending", "skipped"] as const;

export type CiCheckStatus = (typeof ciCheckStatuses)[number];

export interface CiCheckRun {
  name: string;
  status: CiCheckStatus;
  conclusion: string | null;
  url: string | null;
  completedAt: string | null;
}

export interface CiCheckSuiteSnapshot {
  repo: string;
  ref: string;
  overallStatus: CiCheckStatus;
  checks: CiCheckRun[];
  observedAt: string;
}

export interface BuildArtifactReference {
  name: string;
  url: string;
  contentType?: string;
}

export interface CiAdapter {
  getLatestChecks(repo: string, ref: string): Promise<CiCheckSuiteSnapshot>;
  triggerWorkflow(repo: string, workflow: string, ref: string): Promise<never>;
  attachBuildOutput(taskId: string, artifact: BuildArtifactReference): Promise<never>;
}

export interface NotificationAdapter {
  sendStatusUpdate(message: string, metadata?: Record<string, unknown>): Promise<void>;
  sendFailureAlert(message: string, metadata?: Record<string, unknown>): Promise<void>;
}

export class FixtureCiAdapter implements CiAdapter {
  private readonly snapshots: Map<string, CiCheckSuiteSnapshot>;

  constructor(snapshots: CiCheckSuiteSnapshot[]) {
    this.snapshots = new Map(snapshots.map((snapshot) => [createCheckKey(snapshot.repo, snapshot.ref), snapshot]));
  }

  async getLatestChecks(repo: string, ref: string): Promise<CiCheckSuiteSnapshot> {
    const snapshot = this.snapshots.get(createCheckKey(repo, ref));

    if (snapshot) {
      return snapshot;
    }

    return {
      repo,
      ref,
      overallStatus: "pending",
      checks: [],
      observedAt: asIsoTimestamp()
    };
  }

  async triggerWorkflow(repo: string, workflow: string, ref: string): Promise<never> {
    throw new V1MutationDisabledError(`Triggering workflow ${workflow} for ${repo}@${ref}`);
  }

  async attachBuildOutput(taskId: string, artifact: BuildArtifactReference): Promise<never> {
    throw new V1MutationDisabledError(`Attaching build output ${artifact.name} to ${taskId}`);
  }
}

export class NullNotificationAdapter implements NotificationAdapter {
  async sendStatusUpdate(): Promise<void> {
    return Promise.resolve();
  }

  async sendFailureAlert(): Promise<void> {
    return Promise.resolve();
  }
}

function createCheckKey(repo: string, ref: string): string {
  return `${repo}@${ref}`;
}
