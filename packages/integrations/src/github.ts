import { asIsoTimestamp, capabilities, type Capability, type PlanningTaskInput } from "@reddwarf/contracts";
import type { CiAdapter, CiCheckSuiteSnapshot } from "./ci.js";
import { V1MutationDisabledError } from "./errors.js";

export const githubIssueStates = ["open", "closed"] as const;
export const githubPullRequestStates = ["open", "closed", "merged"] as const;

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

export interface GitHubReader {
  fetchIssueCandidate(repo: string, issueNumber: number): Promise<GitHubIssueCandidate>;
  listIssueCandidates(query: GitHubIssueQuery): Promise<GitHubIssueCandidate[]>;
  readIssueStatus(repo: string, issueNumber: number): Promise<GitHubIssueStatusSnapshot>;
  convertToPlanningInput(candidate: GitHubIssueCandidate): Promise<PlanningTaskInput>;
}

export interface GitHubWriter {
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

export interface GitHubAdapter extends GitHubReader, GitHubWriter {}

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
  private readonly createdIssueBodies: Map<string, string>;
  private readonly createdPullRequests: Map<string, GitHubPullRequestSummary>;
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
    this.createdIssueBodies = new Map();
    this.createdPullRequests = new Map();
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

  async createIssue(input: GitHubIssueDraft): Promise<GitHubCreatedIssueSummary> {
    if (this.mutationOptions.allowIssueCreation !== true) {
      throw new V1MutationDisabledError(`Creating a follow-up issue in ${input.repo}`);
    }

    const existingIssue = [...this.createdIssues.entries()].find(([key, summary]) =>
      matchesIssueDraft({
        repo: summary.repo,
        title: summary.title,
        body: this.createdIssueBodies.get(key) ?? ""
      }, input)
    )?.[1];

    if (existingIssue) {
      return existingIssue;
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

    const issueKey = createIssueKey(input.repo, issueNumber);
    this.createdIssues.set(issueKey, summary);
    this.createdIssueBodies.set(issueKey, input.body);
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

    const existingBranch = this.createdBranches.get(createBranchKey(repo, branchName));
    if (existingBranch) {
      return existingBranch;
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

  async createPullRequest(input: GitHubPullRequestDraft): Promise<GitHubPullRequestSummary> {
    if (this.mutationOptions.allowPullRequestCreation !== true) {
      throw new V1MutationDisabledError(`Creating a pull request in ${input.repo}`);
    }

    if (!this.createdBranches.has(createBranchKey(input.repo, input.headBranch))) {
      throw new Error(
        `No fixture branch ${input.headBranch} exists in ${input.repo}. Create the branch before opening the pull request.`
      );
    }

    const existingPullRequest = this.createdPullRequests.get(
      createPullRequestKey(input.repo, input.baseBranch, input.headBranch)
    );
    if (existingPullRequest) {
      return existingPullRequest;
    }

    const number = this.nextPullRequestNumber;
    this.nextPullRequestNumber += 1;

    const summary = {
      repo: input.repo,
      number,
      url: `https://github.com/${input.repo}/pull/${number}`,
      state: "open",
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      title: input.title,
      mergedAt: null
    } satisfies GitHubPullRequestSummary;

    this.createdPullRequests.set(
      createPullRequestKey(input.repo, input.baseBranch, input.headBranch),
      summary
    );

    return summary;
  }

  async commentOnIssue(comment: GitHubIssueComment): Promise<never> {
    throw new V1MutationDisabledError(`Commenting on ${comment.repo}#${comment.issueNumber}`);
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
    dryRun: false,
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

// ============================================================
// RestGitHubAdapter — live GitHub REST API implementation
// ============================================================

export interface RestGitHubAdapterOptions {
  token: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
}

const DEFAULT_GITHUB_REQUEST_TIMEOUT_MS = 30_000;

// Minimal GitHub REST API response shapes (internal)

interface GitHubApiIssueLabel {
  name?: string;
}

interface GitHubApiIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  labels: Array<GitHubApiIssueLabel | string>;
  assignees: Array<{ login: string }>;
  user: { login: string } | null;
  updated_at: string | null;
  created_at: string | null;
  milestone: { title: string } | null;
}

interface GitHubApiRepository {
  default_branch: string;
}

interface GitHubApiCreatedIssue {
  number: number;
  html_url: string;
  created_at: string;
}

interface GitHubApiRef {
  ref: string;
  url: string;
  object: { sha: string };
}

interface GitHubApiPullRequest {
  number: number;
  html_url: string;
  state: string;
  base: { ref: string };
  head: { ref: string };
  title: string;
  merged_at: string | null;
}

export class RestGitHubAdapter implements GitHubAdapter {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;

  constructor(options: RestGitHubAdapterOptions) {
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? "https://api.github.com";
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_GITHUB_REQUEST_TIMEOUT_MS;
  }

  private parseRepo(repo: string): { owner: string; repoName: string } {
    const slash = repo.indexOf("/");
    if (slash <= 0 || slash >= repo.length - 1) {
      throw new Error(`Invalid repo format: "${repo}". Expected "owner/name".`);
    }
    return { owner: repo.slice(0, slash), repoName: repo.slice(slash + 1) };
  }

  private async findExistingIssueForDraft(
    input: GitHubIssueDraft
  ): Promise<GitHubCreatedIssueSummary | null> {
    const { owner, repoName } = this.parseRepo(input.repo);
    const params = new URLSearchParams();
    params.set("state", "open");
    if (input.labels && input.labels.length > 0) {
      params.set("labels", input.labels.join(","));
    }
    params.set("per_page", "100");
    const issues = await this.apiGet<GitHubApiIssue[]>(
      `/repos/${owner}/${repoName}/issues?${params.toString()}`
    );
    const match = issues.find((issue) =>
      matchesIssueDraft(
        {
          repo: input.repo,
          title: issue.title,
          body: issue.body ?? ""
        },
        input
      )
    );

    if (!match) {
      return null;
    }

    return {
      repo: input.repo,
      issueNumber: match.number,
      url: match.html_url,
      state: match.state === "open" ? "open" : "closed",
      title: match.title,
      createdAt: match.created_at ?? asIsoTimestamp()
    };
  }

  private async findExistingBranch(
    repo: string,
    baseBranch: string,
    branchName: string
  ): Promise<GitHubBranchSummary | null> {
    const { owner, repoName } = this.parseRepo(repo);
    let ref: GitHubApiRef | null = null;

    try {
      ref = await this.apiGet<GitHubApiRef>(
        `/repos/${owner}/${repoName}/git/ref/heads/${encodeURIComponent(branchName)}`
      );
    } catch (error) {
      if (!isGitHubNotFoundError(error)) {
        throw error;
      }
    }

    if (!ref) {
      return null;
    }

    return {
      repo,
      baseBranch,
      branchName,
      ref: ref.ref,
      url: `https://github.com/${owner}/${repoName}/tree/${encodeURIComponent(branchName)}`,
      createdAt: asIsoTimestamp()
    };
  }

  private async findExistingPullRequest(
    repo: string,
    baseBranch: string,
    headBranch: string
  ): Promise<GitHubPullRequestSummary | null> {
    const { owner, repoName } = this.parseRepo(repo);
    const params = new URLSearchParams();
    params.set("state", "open");
    params.set("base", baseBranch);
    params.set("head", `${owner}:${headBranch}`);
    params.set("per_page", "1");
    const pullRequests = await this.apiGet<GitHubApiPullRequest[]>(
      `/repos/${owner}/${repoName}/pulls?${params.toString()}`
    );
    const pr = pullRequests[0];

    if (!pr) {
      return null;
    }

    return {
      repo,
      number: pr.number,
      url: pr.html_url,
      state: pr.state === "merged" ? "merged" : pr.state === "closed" ? "closed" : "open",
      baseBranch: pr.base.ref,
      headBranch: pr.head.ref,
      title: pr.title,
      mergedAt: pr.merged_at
    };
  }

  private apiHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "reddwarf/0.1.0"
    };
  }

  private async apiGet<T>(path: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: this.apiHeaders(),
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      });
    } catch (error) {
      throw normalizeFetchTimeoutError(
        error,
        `GitHub API GET ${path}`,
        this.requestTimeoutMs
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`GitHub API GET ${path} returned ${response.status}: ${body}`);
    }
    return response.json() as Promise<T>;
  }

  private async apiPost<T>(path: string, payload: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.apiHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      });
    } catch (error) {
      throw normalizeFetchTimeoutError(
        error,
        `GitHub API POST ${path}`,
        this.requestTimeoutMs
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`GitHub API POST ${path} returned ${response.status}: ${body}`);
    }
    return response.json() as Promise<T>;
  }

  private labelNames(labels: Array<GitHubApiIssueLabel | string>): string[] {
    return labels
      .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
      .filter((n) => n.length > 0);
  }

  private apiIssueToCandidate(repo: string, issue: GitHubApiIssue): GitHubIssueCandidate {
    return {
      repo,
      issueNumber: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      labels: this.labelNames(issue.labels),
      url: issue.html_url,
      state: issue.state === "open" ? "open" : "closed",
      ...(issue.user?.login !== undefined ? { author: issue.user.login } : {}),
      ...(issue.updated_at !== null ? { updatedAt: issue.updated_at } : {})
    };
  }

  async fetchIssueCandidate(repo: string, issueNumber: number): Promise<GitHubIssueCandidate> {
    const { owner, repoName } = this.parseRepo(repo);
    const issue = await this.apiGet<GitHubApiIssue>(
      `/repos/${owner}/${repoName}/issues/${issueNumber}`
    );
    return this.apiIssueToCandidate(repo, issue);
  }

  async listIssueCandidates(query: GitHubIssueQuery): Promise<GitHubIssueCandidate[]> {
    const { owner, repoName } = this.parseRepo(query.repo);
    const params = new URLSearchParams();
    const states = query.states ?? [];
    if (states.includes("open") && states.includes("closed")) {
      params.set("state", "all");
    } else if (states.includes("closed")) {
      params.set("state", "closed");
    } else {
      params.set("state", "open");
    }
    if (query.labels && query.labels.length > 0) {
      params.set("labels", query.labels.join(","));
    }
    params.set("per_page", String(Math.min(query.limit ?? 30, 100)));
    const issues = await this.apiGet<GitHubApiIssue[]>(
      `/repos/${owner}/${repoName}/issues?${params.toString()}`
    );
    const candidates = issues
      .map((issue) => this.apiIssueToCandidate(query.repo, issue))
      .slice(0, query.limit ?? issues.length);
    return candidates;
  }

  async readIssueStatus(repo: string, issueNumber: number): Promise<GitHubIssueStatusSnapshot> {
    const { owner, repoName } = this.parseRepo(repo);
    const [issue, repoData] = await Promise.all([
      this.apiGet<GitHubApiIssue>(`/repos/${owner}/${repoName}/issues/${issueNumber}`),
      this.apiGet<GitHubApiRepository>(`/repos/${owner}/${repoName}`)
    ]);
    return {
      repo,
      issueNumber: issue.number,
      url: issue.html_url,
      state: issue.state === "open" ? "open" : "closed",
      labels: this.labelNames(issue.labels),
      assignees: issue.assignees.map((a) => a.login),
      milestone: issue.milestone?.title ?? null,
      defaultBranch: repoData.default_branch,
      updatedAt: issue.updated_at ?? null
    };
  }

  async convertToPlanningInput(candidate: GitHubIssueCandidate): Promise<PlanningTaskInput> {
    return createPlanningInputFromGitHubIssue(candidate);
  }

  async addLabels(_repo: string, _issueNumber: number, labels: string[]): Promise<never> {
    throw new V1MutationDisabledError(`Adding labels [${labels.join(", ")}] is disabled in RedDwarf v1`);
  }

  async removeLabels(_repo: string, _issueNumber: number, labels: string[]): Promise<never> {
    throw new V1MutationDisabledError(`Removing labels [${labels.join(", ")}] is disabled in RedDwarf v1`);
  }

  async createIssue(input: GitHubIssueDraft): Promise<GitHubCreatedIssueSummary> {
    const existingIssue = await this.findExistingIssueForDraft(input);
    if (existingIssue) {
      return existingIssue;
    }

    const { owner, repoName } = this.parseRepo(input.repo);
    const created = await this.apiPost<GitHubApiCreatedIssue>(
      `/repos/${owner}/${repoName}/issues`,
      { title: input.title, body: input.body, labels: input.labels ?? [] }
    );
    return {
      repo: input.repo,
      issueNumber: created.number,
      url: created.html_url,
      state: "open",
      title: input.title,
      createdAt: created.created_at
    };
  }

  async commentOnIssue(comment: GitHubIssueComment): Promise<never> {
    throw new V1MutationDisabledError(
      `Commenting on ${comment.repo}#${comment.issueNumber} is disabled in RedDwarf v1`
    );
  }

  async createBranch(
    repo: string,
    baseBranch: string,
    branchName: string
  ): Promise<GitHubBranchSummary> {
    const existingBranch = await this.findExistingBranch(repo, baseBranch, branchName);
    if (existingBranch) {
      return existingBranch;
    }

    const { owner, repoName } = this.parseRepo(repo);
    const baseRef = await this.apiGet<GitHubApiRef>(
      `/repos/${owner}/${repoName}/git/ref/heads/${baseBranch}`
    );
    const sha = baseRef.object.sha;

    try {
      await this.apiPost<GitHubApiRef>(`/repos/${owner}/${repoName}/git/refs`, {
        ref: `refs/heads/${branchName}`,
        sha
      });
    } catch (error) {
      const retriedBranch = await this.findExistingBranch(repo, baseBranch, branchName);
      if (retriedBranch) {
        return retriedBranch;
      }
      throw error;
    }

    return {
      repo,
      baseBranch,
      branchName,
      ref: `refs/heads/${branchName}`,
      url: `https://github.com/${owner}/${repoName}/tree/${encodeURIComponent(branchName)}`,
      createdAt: asIsoTimestamp()
    };
  }

  async createPullRequest(input: GitHubPullRequestDraft): Promise<GitHubPullRequestSummary> {
    const existingPullRequest = await this.findExistingPullRequest(
      input.repo,
      input.baseBranch,
      input.headBranch
    );
    if (existingPullRequest) {
      return existingPullRequest;
    }

    const { owner, repoName } = this.parseRepo(input.repo);

    try {
      const pr = await this.apiPost<GitHubApiPullRequest>(
        `/repos/${owner}/${repoName}/pulls`,
        {
          title: input.title,
          body: input.body,
          base: input.baseBranch,
          head: input.headBranch,
          labels: input.labels ?? []
        }
      );
      return {
        repo: input.repo,
        number: pr.number,
        url: pr.html_url,
        state: pr.state === "merged" ? "merged" : pr.state === "closed" ? "closed" : "open",
        baseBranch: pr.base.ref,
        headBranch: pr.head.ref,
        title: pr.title,
        mergedAt: pr.merged_at
      };
    } catch (error) {
      const retriedPullRequest = await this.findExistingPullRequest(
        input.repo,
        input.baseBranch,
        input.headBranch
      );
      if (retriedPullRequest) {
        return retriedPullRequest;
      }
      throw error;
    }
  }
}

/**
 * Create a RestGitHubAdapter from environment variables or explicit options.
 * Reads GITHUB_TOKEN from the environment when no token is provided.
 */
export function createRestGitHubAdapter(
  options: { token?: string; baseUrl?: string; requestTimeoutMs?: number } = {}
): RestGitHubAdapter {
  const token = options.token ?? process.env["GITHUB_TOKEN"];
  if (!token) {
    throw new Error(
      "RestGitHubAdapter requires a GitHub token. Set the GITHUB_TOKEN environment variable or pass token explicitly."
    );
  }
  return new RestGitHubAdapter({
    token,
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: options.requestTimeoutMs }
      : {})
  });
}

// ── Private helpers ───────────────────────────────────────────────────────────

function createIssueKey(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`;
}

function createBranchKey(repo: string, branchName: string): string {
  return `${repo}@${branchName}`;
}

function createPullRequestKey(
  repo: string,
  baseBranch: string,
  headBranch: string
): string {
  return `${repo}@${baseBranch}...${headBranch}`;
}

function extractTaskIdMarker(body: string): string | null {
  const match = body.match(/^Task ID:\s*(.+)$/m);
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : null;
}

function matchesIssueDraft(
  existing: { repo: string; title: string; body: string },
  input: GitHubIssueDraft
): boolean {
  if (existing.repo !== input.repo || existing.title !== input.title) {
    return false;
  }

  const existingTaskId = extractTaskIdMarker(existing.body);
  const inputTaskId = extractTaskIdMarker(input.body);

  if (existingTaskId && inputTaskId) {
    return existingTaskId === inputTaskId;
  }

  return existing.body.trim() === input.body.trim();
}

function isGitHubNotFoundError(error: unknown): boolean {
  return error instanceof Error && /returned 404:/i.test(error.message);
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
      continue;
    }

    const normalizedHeading = line.toLowerCase().replace(/[:#]/g, "").trim();

    if (normalizedHeading === "acceptance criteria") {
      current = "acceptanceCriteria";
      continue;
    }

    if (normalizedHeading === "affected paths" || normalizedHeading === "affected areas") {
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
  return (capabilities as readonly string[]).includes(value);
}

function normalizeFetchTimeoutError(
  error: unknown,
  context: string,
  timeoutMs: number
): Error {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new Error(`${context} timed out after ${timeoutMs}ms.`);
  }

  return error instanceof Error ? error : new Error(String(error));
}
