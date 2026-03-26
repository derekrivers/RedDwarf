import { asIsoTimestamp, type Capability, type PlanningTaskInput } from "@reddwarf/contracts";

export const ciCheckStatuses = ["success", "failure", "pending", "skipped"] as const;
export const githubIssueStates = ["open", "closed"] as const;
export const githubPullRequestStates = ["open", "closed", "merged"] as const;

export type CiCheckStatus = (typeof ciCheckStatuses)[number];
export type GitHubIssueState = (typeof githubIssueStates)[number];
export type GitHubPullRequestState = (typeof githubPullRequestStates)[number];

export interface GitHubIssueCandidate {
  repo: string;
  issueNumber: number;
  title: string;
  body: string;
  labels: string[];
  url: string;
  state: GitHubIssueState;
  author?: string;
  updatedAt?: string;
  baseBranch?: string;
  metadata?: Record<string, unknown>;
}

export interface GitHubIssueQuery {
  repo: string;
  labels?: string[];
  limit?: number;
  states?: GitHubIssueState[];
}

export interface GitHubIssueStatusSnapshot {
  repo: string;
  issueNumber: number;
  url: string;
  state: GitHubIssueState;
  labels: string[];
  assignees: string[];
  milestone: string | null;
  defaultBranch: string;
  updatedAt: string | null;
}

export interface GitHubPullRequestDraft {
  repo: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
  labels?: string[];
  issueNumber?: number;
}

export interface GitHubPullRequestSummary {
  repo: string;
  number: number;
  url: string;
  state: GitHubPullRequestState;
  baseBranch: string;
  headBranch: string;
  title: string;
  mergedAt: string | null;
}

export interface GitHubIssueDraft {
  repo: string;
  title: string;
  body: string;
  labels?: string[];
}

export interface GitHubCreatedIssueSummary {
  repo: string;
  issueNumber: number;
  url: string;
  state: GitHubIssueState;
  title: string;
  createdAt: string;
}

export interface GitHubBranchSummary {
  repo: string;
  baseBranch: string;
  branchName: string;
  ref: string;
  url: string;
  createdAt: string;
}

export interface GitHubIssueComment {
  repo: string;
  issueNumber: number;
  body: string;
}

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

export interface GitHubAdapter {
  fetchIssueCandidate(repo: string, issueNumber: number): Promise<GitHubIssueCandidate>;
  listIssueCandidates(query: GitHubIssueQuery): Promise<GitHubIssueCandidate[]>;
  readIssueStatus(repo: string, issueNumber: number): Promise<GitHubIssueStatusSnapshot>;
  convertToPlanningInput(candidate: GitHubIssueCandidate): Promise<PlanningTaskInput>;
  addLabels(repo: string, issueNumber: number, labels: string[]): Promise<never>;
  removeLabels(repo: string, issueNumber: number, labels: string[]): Promise<never>;
  createIssue(input: GitHubIssueDraft): Promise<GitHubCreatedIssueSummary>;
  createBranch(
    repo: string,
    baseBranch: string,
    branchName: string
  ): Promise<GitHubBranchSummary>;
  createPullRequest(input: GitHubPullRequestDraft): Promise<GitHubPullRequestSummary>;
  commentOnIssue(comment: GitHubIssueComment): Promise<never>;
}

export interface NotificationAdapter {
  sendStatusUpdate(message: string, metadata?: Record<string, unknown>): Promise<void>;
  sendFailureAlert(message: string, metadata?: Record<string, unknown>): Promise<void>;
}

export interface CiAdapter {
  getLatestChecks(repo: string, ref: string): Promise<CiCheckSuiteSnapshot>;
  triggerWorkflow(repo: string, workflow: string, ref: string): Promise<never>;
  attachBuildOutput(taskId: string, artifact: BuildArtifactReference): Promise<never>;
}

export interface SecretLeaseRequest {
  taskId: string;
  repo: string;
  agentType: string;
  phase: string;
  environment: string;
  riskClass: "low" | "medium" | "high";
  approvalMode: "auto" | "review_required" | "human_signoff_required" | "disallowed";
  requestedCapabilities: Capability[];
  allowedSecretScopes: string[];
}

export interface SecretLease {
  leaseId: string;
  mode: "scoped_env";
  secretScopes: string[];
  injectedSecretKeys: string[];
  environmentVariables: Record<string, string>;
  issuedAt: string;
  expiresAt: string | null;
  notes: string[];
}

export interface FixtureSecretScope {
  scope: string;
  environmentVariables: Record<string, string>;
  allowedAgents?: string[];
  allowedEnvironments?: string[];
  denyHighRisk?: boolean;
  notes?: string[];
}

export interface SecretsAdapter {
  requestSecret(name: string): Promise<string>;
  issueTaskSecrets(request: SecretLeaseRequest): Promise<SecretLease | null>;
}

export interface GitHubIssueIntakeResult {
  candidate: GitHubIssueCandidate;
  issueStatus: GitHubIssueStatusSnapshot;
  planningInput: PlanningTaskInput;
  ciSnapshot: CiCheckSuiteSnapshot | null;
}

export interface PlanningInputDefaults {
  priority?: number;
  fallbackAcceptanceCriteria?: string[];
  defaultCapabilities?: Capability[];
}

export class V1MutationDisabledError extends Error {
  public readonly action: string;

  constructor(action: string) {
    super(`${action} is disabled in RedDwarf v1 and requires human approval.`);
    this.name = "V1MutationDisabledError";
    this.action = action;
  }
}

export interface FixtureGitHubMutationOptions {
  allowIssueCreation?: boolean;
  allowBranchCreation?: boolean;
  allowPullRequestCreation?: boolean;
  issueNumberStart?: number;
  pullRequestNumberStart?: number;
}

export class FixtureGitHubAdapter implements GitHubAdapter {
  private readonly candidates: Map<string, GitHubIssueCandidate>;
  private readonly statusSnapshots: Map<string, GitHubIssueStatusSnapshot>;
  private readonly mutationOptions: FixtureGitHubMutationOptions;
  private readonly createdBranches: Map<string, GitHubBranchSummary>;
  private readonly createdIssues: Map<string, GitHubCreatedIssueSummary>;
  private nextIssueNumber: number;
  private nextPullRequestNumber: number;

  constructor(input: {
    candidates: GitHubIssueCandidate[];
    statuses?: GitHubIssueStatusSnapshot[];
    mutations?: FixtureGitHubMutationOptions;
  }) {
    this.candidates = new Map(
      input.candidates.map((candidate) => [createIssueKey(candidate.repo, candidate.issueNumber), candidate])
    );
    this.statusSnapshots = new Map(
      (input.statuses ?? []).map((status) => [createIssueKey(status.repo, status.issueNumber), status])
    );
    this.mutationOptions = input.mutations ?? {};
    this.createdBranches = new Map();
    this.createdIssues = new Map();
    this.nextIssueNumber = this.mutationOptions.issueNumberStart ?? 1_000;
    this.nextPullRequestNumber = this.mutationOptions.pullRequestNumberStart ?? 1;
  }

  async fetchIssueCandidate(repo: string, issueNumber: number): Promise<GitHubIssueCandidate> {
    const candidate = this.candidates.get(createIssueKey(repo, issueNumber));

    if (!candidate) {
      throw new Error(`No fixture GitHub issue candidate for ${repo}#${issueNumber}.`);
    }

    return candidate;
  }

  async listIssueCandidates(query: GitHubIssueQuery): Promise<GitHubIssueCandidate[]> {
    return [...this.candidates.values()]
      .filter((candidate) => candidate.repo === query.repo)
      .filter((candidate) =>
        query.states && query.states.length > 0 ? query.states.includes(candidate.state) : true
      )
      .filter((candidate) =>
        query.labels && query.labels.length > 0
          ? query.labels.every((label) => candidate.labels.includes(label))
          : true
      )
      .sort((left, right) => left.issueNumber - right.issueNumber)
      .slice(0, query.limit ?? Number.MAX_SAFE_INTEGER);
  }

  async readIssueStatus(repo: string, issueNumber: number): Promise<GitHubIssueStatusSnapshot> {
    const key = createIssueKey(repo, issueNumber);
    const explicit = this.statusSnapshots.get(key);

    if (explicit) {
      return explicit;
    }

    const candidate = await this.fetchIssueCandidate(repo, issueNumber);
    return {
      repo,
      issueNumber,
      url: candidate.url,
      state: candidate.state,
      labels: [...candidate.labels],
      assignees: [],
      milestone: null,
      defaultBranch: candidate.baseBranch ?? "main",
      updatedAt: candidate.updatedAt ?? null
    };
  }

  async convertToPlanningInput(candidate: GitHubIssueCandidate): Promise<PlanningTaskInput> {
    return createPlanningInputFromGitHubIssue(candidate);
  }

  async addLabels(repo: string, issueNumber: number, labels: string[]): Promise<never> {
    throw new V1MutationDisabledError(`Adding labels ${labels.join(", ")} to ${repo}#${issueNumber}`);
  }

  async removeLabels(repo: string, issueNumber: number, labels: string[]): Promise<never> {
    throw new V1MutationDisabledError(`Removing labels ${labels.join(", ")} from ${repo}#${issueNumber}`);
  }

  async createIssue(
    input: GitHubIssueDraft
  ): Promise<GitHubCreatedIssueSummary> {
    if (this.mutationOptions.allowIssueCreation !== true) {
      throw new V1MutationDisabledError(`Creating a follow-up issue in ${input.repo}`);
    }

    const issueNumber = this.nextIssueNumber;
    this.nextIssueNumber += 1;
    const summary: GitHubCreatedIssueSummary = {
      repo: input.repo,
      issueNumber,
      url: `https://github.com/${input.repo}/issues/${issueNumber}`,
      state: "open",
      title: input.title,
      createdAt: asIsoTimestamp()
    };

    this.createdIssues.set(createIssueKey(input.repo, issueNumber), summary);
    return summary;
  }

  async createBranch(
    repo: string,
    baseBranch: string,
    branchName: string
  ): Promise<GitHubBranchSummary> {
    if (this.mutationOptions.allowBranchCreation !== true) {
      throw new V1MutationDisabledError(`Creating branch ${branchName} from ${baseBranch} in ${repo}`);
    }

    const summary: GitHubBranchSummary = {
      repo,
      baseBranch,
      branchName,
      ref: `refs/heads/${branchName}`,
      url: `https://github.com/${repo}/tree/${encodeURIComponent(branchName)}`,
      createdAt: asIsoTimestamp()
    };

    this.createdBranches.set(createBranchKey(repo, branchName), summary);
    return summary;
  }

  async createPullRequest(
    input: GitHubPullRequestDraft
  ): Promise<GitHubPullRequestSummary> {
    if (this.mutationOptions.allowPullRequestCreation !== true) {
      throw new V1MutationDisabledError(`Creating a pull request in ${input.repo}`);
    }

    if (!this.createdBranches.has(createBranchKey(input.repo, input.headBranch))) {
      throw new Error(
        `No fixture branch ${input.headBranch} exists in ${input.repo}. Create the branch before opening the pull request.`
      );
    }

    const number = this.nextPullRequestNumber;
    this.nextPullRequestNumber += 1;

    return {
      repo: input.repo,
      number,
      url: `https://github.com/${input.repo}/pull/${number}`,
      state: "open",
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      title: input.title,
      mergedAt: null
    };
  }

  async commentOnIssue(comment: GitHubIssueComment): Promise<never> {
    throw new V1MutationDisabledError(`Commenting on ${comment.repo}#${comment.issueNumber}`);
  }
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

export class FixtureSecretsAdapter implements SecretsAdapter {
  private readonly scopes: Map<string, FixtureSecretScope>;

  constructor(scopes: FixtureSecretScope[]) {
    this.scopes = new Map(scopes.map((scope) => [scope.scope, scope]));
  }

  async requestSecret(name: string): Promise<string> {
    for (const scope of this.scopes.values()) {
      const value = scope.environmentVariables[name];

      if (value !== undefined) {
        return value;
      }
    }

    throw new Error(`No fixture secret named ${name} is configured.`);
  }

  async issueTaskSecrets(
    request: SecretLeaseRequest
  ): Promise<SecretLease | null> {
    if (
      request.allowedSecretScopes.length === 0 ||
      !request.requestedCapabilities.includes("can_use_secrets")
    ) {
      return null;
    }

    const issuedScopes: string[] = [];
    const injectedSecretKeys = new Set<string>();
    const environmentVariables: Record<string, string> = {};
    const notes: string[] = [];

    for (const scopeName of request.allowedSecretScopes) {
      const scope = this.scopes.get(scopeName);

      if (!scope) {
        throw new Error(`No fixture secret scope ${scopeName} is configured.`);
      }

      if (scope.denyHighRisk !== false && request.riskClass === "high") {
        throw new Error(
          `Secret scope ${scopeName} is denied for high-risk tasks.`
        );
      }

      if (
        scope.allowedAgents &&
        scope.allowedAgents.length > 0 &&
        !scope.allowedAgents.includes(request.agentType)
      ) {
        throw new Error(
          `Secret scope ${scopeName} is not allowed for agent ${request.agentType}.`
        );
      }

      if (
        scope.allowedEnvironments &&
        scope.allowedEnvironments.length > 0 &&
        !scope.allowedEnvironments.includes(request.environment)
      ) {
        throw new Error(
          `Secret scope ${scopeName} is not allowed in environment ${request.environment}.`
        );
      }

      issuedScopes.push(scopeName);
      for (const [key, value] of Object.entries(scope.environmentVariables)) {
        environmentVariables[key] = value;
        injectedSecretKeys.add(key);
      }
      if (scope.notes) {
        notes.push(...scope.notes);
      }
    }

    return {
      leaseId: `${request.taskId}:${request.agentType}:${issuedScopes.join("+")}`,
      mode: "scoped_env",
      secretScopes: issuedScopes,
      injectedSecretKeys: [...injectedSecretKeys].sort(),
      environmentVariables,
      issuedAt: asIsoTimestamp(),
      expiresAt: null,
      notes: [
        `Scoped credentials issued for ${request.agentType} during ${request.phase}.`,
        ...notes
      ]
    };
  }
}

export class DenyAllSecretsAdapter implements SecretsAdapter {
  async requestSecret(name: string): Promise<never> {
    throw new V1MutationDisabledError(`Secret access for ${name}`);
  }

  async issueTaskSecrets(request: SecretLeaseRequest): Promise<never> {
    const scopes =
      request.allowedSecretScopes.length > 0
        ? ` scoped to ${request.allowedSecretScopes.join(", ")}`
        : "";
    throw new V1MutationDisabledError(
      `Secret access for ${request.taskId}${scopes}`
    );
  }
}

export async function intakeGitHubIssue(input: {
  github: GitHubAdapter;
  ci?: CiAdapter;
  repo: string;
  issueNumber: number;
  ref?: string;
}): Promise<GitHubIssueIntakeResult> {
  const candidate = await input.github.fetchIssueCandidate(input.repo, input.issueNumber);
  const issueStatus = await input.github.readIssueStatus(input.repo, input.issueNumber);
  const planningInput = await input.github.convertToPlanningInput(candidate);
  const ciSnapshot = input.ci
    ? await input.ci.getLatestChecks(input.repo, input.ref ?? issueStatus.defaultBranch)
    : null;

  return {
    candidate,
    issueStatus,
    planningInput,
    ciSnapshot
  };
}

export function redactSecretValues(
  value: string,
  lease: Pick<SecretLease, "environmentVariables">
): string {
  let redacted = value;

  for (const secretValue of Object.values(lease.environmentVariables)) {
    if (secretValue.length === 0) {
      continue;
    }

    redacted = redacted.split(secretValue).join("***REDACTED***");
  }

  return redacted;
}

export function createPlanningInputFromGitHubIssue(
  candidate: GitHubIssueCandidate,
  defaults: PlanningInputDefaults = {}
): PlanningTaskInput {
  const sections = parseIssueBodySections(candidate.body);
  const priority = parsePriority(candidate.labels, defaults.priority ?? 50);
  const acceptanceCriteria = dedupeStrings(
    sections.acceptanceCriteria.length > 0
      ? sections.acceptanceCriteria
      : (defaults.fallbackAcceptanceCriteria ?? ["Task satisfies the issue acceptance criteria."])
  );
  const affectedPaths = dedupeStrings(sections.affectedPaths);
  const requestedCapabilities = dedupeCapabilities(
    sections.requestedCapabilities.length > 0
      ? sections.requestedCapabilities
      : (defaults.defaultCapabilities ?? ["can_plan", "can_archive_evidence"])
  );

  return {
    source: {
      provider: "github",
      repo: candidate.repo,
      issueNumber: candidate.issueNumber,
      issueUrl: candidate.url
    },
    title: candidate.title,
    summary: buildSummary(candidate.body),
    priority,
    labels: dedupeStrings(candidate.labels),
    acceptanceCriteria,
    affectedPaths,
    requestedCapabilities,
    metadata: {
      github: {
        author: candidate.author ?? null,
        state: candidate.state,
        updatedAt: candidate.updatedAt ?? null,
        baseBranch: candidate.baseBranch ?? "main"
      },
      ...(candidate.metadata ?? {})
    }
  };
}

function createIssueKey(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`;
}

function createBranchKey(repo: string, branchName: string): string {
  return `${repo}@${branchName}`;
}

function createCheckKey(repo: string, ref: string): string {
  return `${repo}@${ref}`;
}

function parseIssueBodySections(body: string): {
  acceptanceCriteria: string[];
  affectedPaths: string[];
  requestedCapabilities: Capability[];
} {
  const lines = body.split(/\r?\n/);
  const sections: {
    acceptanceCriteria: string[];
    affectedPaths: string[];
    requestedCapabilities: Capability[];
  } = {
    acceptanceCriteria: [],
    affectedPaths: [],
    requestedCapabilities: []
  };
  let current: keyof typeof sections | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.length === 0) {
      current = null;
      continue;
    }

    const normalizedHeading = line.toLowerCase().replace(/[:#]/g, "").trim();

    if (normalizedHeading === "acceptance criteria") {
      current = "acceptanceCriteria";
      continue;
    }

    if (normalizedHeading === "affected paths") {
      current = "affectedPaths";
      continue;
    }

    if (normalizedHeading === "requested capabilities") {
      current = "requestedCapabilities";
      continue;
    }

    if (!current) {
      continue;
    }

    const value = line.replace(/^[-*]\s*/, "").trim();

    if (value.length === 0) {
      continue;
    }

    if (current === "requestedCapabilities") {
      if (isCapability(value)) {
        sections.requestedCapabilities.push(value);
      }
      continue;
    }

    sections[current].push(value);
  }

  return sections;
}

function buildSummary(body: string): string {
  const normalized = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("- ") && !line.startsWith("* "));
  const summary = normalized.join(" ").replace(/\s+/g, " ").trim();

  if (summary.length >= 20) {
    return summary;
  }

  return `${summary} This task was ingested from GitHub and requires a deterministic planning pass.`.trim();
}

function parsePriority(labels: string[], fallback: number): number {
  const label = labels.find((entry) => /^priority:\d+$/i.test(entry));

  if (!label) {
    return fallback;
  }

  const parsed = Number.parseInt(label.split(":")[1] ?? `${fallback}`, 10);
  return Number.isNaN(parsed) ? fallback : Math.max(0, Math.min(100, parsed));
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function dedupeCapabilities(values: Capability[]): Capability[] {
  return [...new Set(values)];
}

function isCapability(value: string): value is Capability {
  return [
    "can_plan",
    "can_write_code",
    "can_run_tests",
    "can_open_pr",
    "can_modify_schema",
    "can_touch_sensitive_paths",
    "can_use_secrets",
    "can_review",
    "can_archive_evidence"
  ].includes(value);
}