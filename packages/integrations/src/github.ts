import { asIsoTimestamp, capabilities, type Capability, type PlanningTaskInput, type TicketSpec } from "@reddwarf/contracts";
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
  addLabels(repo: string, issueNumber: number, labels: string[]): Promise<void>;
  removeLabels(repo: string, issueNumber: number, labels: string[]): Promise<void>;
  createIssue(input: GitHubIssueDraft): Promise<GitHubCreatedIssueSummary>;
  createBranch(
    repo: string,
    baseBranch: string,
    branchName: string
  ): Promise<GitHubBranchSummary>;
  createPullRequest(input: GitHubPullRequestDraft): Promise<GitHubPullRequestSummary>;
  commentOnIssue(comment: GitHubIssueComment): Promise<void>;
  /**
   * Ensures the RedDwarf ticket-advance workflow file exists in the target repo.
   * Creates `.github/workflows/reddwarf-advance.yml` if absent; skips silently if
   * the file is already present so user customizations are preserved.
   */
  ensureWorkflowFile(repo: string): Promise<{ created: boolean; skipped: boolean }>;
}

export interface GitHubAdapter extends GitHubReader, GitHubWriter {}

// ============================================================
// GitHubRepoDiscovery — list repos accessible to the token
// ============================================================

export interface GitHubRepoSummary {
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  updatedAt: string | null;
  language: string | null;
  archived: boolean;
}

export interface GitHubRepoDiscovery {
  listUserRepos(options?: {
    perPage?: number;
    page?: number;
    sort?: "updated" | "full_name" | "created" | "pushed";
    direction?: "asc" | "desc";
    query?: string;
  }): Promise<{ repos: GitHubRepoSummary[]; total: number }>;
}

// ============================================================
// GitHubIssuesAdapter — project mode sub-issue operations
// ============================================================

export interface GitHubIssuesAdapter {
  createSubIssue(
    parentIssueNumber: number,
    ticketSpec: TicketSpec,
    repo?: string
  ): Promise<number>;
  closeIssue(issueNumber: number, repo?: string): Promise<void>;
  getIssue(issueNumber: number, repo?: string): Promise<GitHubIssueStatusSnapshot>;
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

  async addLabels(repo: string, issueNumber: number, labels: string[]): Promise<void> {
    throw new V1MutationDisabledError(`Adding labels ${labels.join(", ")} to ${repo}#${issueNumber}`);
  }

  async removeLabels(repo: string, issueNumber: number, labels: string[]): Promise<void> {
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

  async commentOnIssue(comment: GitHubIssueComment): Promise<void> {
    throw new V1MutationDisabledError(`Commenting on ${comment.repo}#${comment.issueNumber}`);
  }

  async ensureWorkflowFile(_repo: string): Promise<{ created: boolean; skipped: boolean }> {
    return { created: false, skipped: true };
  }
}

export interface FixtureGitHubIssuesAdapterOptions {
  repo: string;
  enabled?: boolean;
  issueNumberStart?: number;
}

export class FixtureGitHubIssuesAdapter implements GitHubIssuesAdapter {
  private readonly repo: string;
  private readonly enabled: boolean;
  private readonly createdSubIssues: Map<number, { parentIssueNumber: number; ticketSpec: TicketSpec; body: string; repo: string }>;
  private readonly closedIssues: Set<number>;
  private nextIssueNumber: number;

  constructor(options: FixtureGitHubIssuesAdapterOptions) {
    this.repo = options.repo;
    this.enabled = options.enabled ?? true;
    this.createdSubIssues = new Map();
    this.closedIssues = new Set();
    this.nextIssueNumber = options.issueNumberStart ?? 2_000;
  }

  getCreatedSubIssues(): Map<number, { parentIssueNumber: number; ticketSpec: TicketSpec; body: string; repo: string }> {
    return this.createdSubIssues;
  }

  getClosedIssues(): Set<number> {
    return this.closedIssues;
  }

  async createSubIssue(
    parentIssueNumber: number,
    ticketSpec: TicketSpec,
    repo?: string
  ): Promise<number> {
    if (!this.enabled) {
      throw new V1MutationDisabledError("GitHub Issues adapter is disabled (REDDWARF_GITHUB_ISSUES_ENABLED is not true)");
    }
    const issueNumber = this.nextIssueNumber;
    this.nextIssueNumber += 1;
    const body = formatTicketSpecBody(ticketSpec, parentIssueNumber);
    this.createdSubIssues.set(issueNumber, {
      parentIssueNumber,
      ticketSpec,
      body,
      repo: repo ?? this.repo
    });
    return issueNumber;
  }

  async closeIssue(issueNumber: number): Promise<void> {
    if (!this.enabled) {
      throw new V1MutationDisabledError("GitHub Issues adapter is disabled (REDDWARF_GITHUB_ISSUES_ENABLED is not true)");
    }
    this.closedIssues.add(issueNumber);
  }

  async getIssue(issueNumber: number, repo?: string): Promise<GitHubIssueStatusSnapshot> {
    const issueRepo = repo ?? this.repo;
    return {
      repo: issueRepo,
      issueNumber,
      url: `https://github.com/${issueRepo}/issues/${issueNumber}`,
      state: this.closedIssues.has(issueNumber) ? "closed" : "open",
      labels: ["reddwarf-ticket"],
      assignees: [],
      milestone: null,
      defaultBranch: "main",
      updatedAt: null
    };
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
  const normalizedBody = normalizeIssueBodyForParsing(candidate.body);
  const sections = parseIssueBodySections(normalizedBody);
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
      : (defaults.defaultCapabilities ?? ["can_plan", "can_write_code", "can_archive_evidence"])
  );

  return {
    source: {
      provider: "github",
      repo: candidate.repo,
      issueNumber: candidate.issueNumber,
      issueUrl: candidate.url
    },
    title: candidate.title,
    summary: buildSummary(normalizedBody),
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
  full_name: string;
  description: string | null;
  private: boolean;
  default_branch: string;
  updated_at: string | null;
  language: string | null;
  archived: boolean;
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

const REDDWARF_ADVANCE_WORKFLOW_YAML = `# RedDwarf Project Mode — Ticket Advance Workflow
#
# Fires when a pull request is closed and merged. Extracts the ticket_id from
# the PR branch name (format: reddwarf/ticket/{ticket_id}) or the PR body,
# then calls POST /projects/advance on the RedDwarf operator API to advance
# the project ticket queue.
#
# Required secrets:
#   REDDWARF_OPERATOR_TOKEN — the operator API bearer token
#
# Required variable or secret (set in repo or environment settings):
#   REDDWARF_OPERATOR_API_URL — the operator API base URL reachable from
#     GitHub Actions runners (e.g. https://<machine>.tail<net>.ts.net:8080)

name: RedDwarf Ticket Advance

on:
  pull_request:
    types: [closed]

jobs:
  advance:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - name: Extract ticket ID
        id: extract
        env:
          PR_BRANCH: \${{ github.event.pull_request.head.ref }}
          PR_BODY: \${{ github.event.pull_request.body }}
        run: |
          # Try branch name first: reddwarf/ticket/{ticket_id}
          if [[ "$PR_BRANCH" =~ ^reddwarf/ticket/(.+)$ ]]; then
            echo "ticket_id=\${BASH_REMATCH[1]}" >> "$GITHUB_OUTPUT"
            echo "source=branch" >> "$GITHUB_OUTPUT"
            echo "Extracted ticket_id from branch: \${BASH_REMATCH[1]}"
            exit 0
          fi

          # Fall back to PR body: look for <!-- reddwarf:ticket_id:VALUE -->
          TICKET_ID=$(echo "$PR_BODY" | grep -oP '<!-- reddwarf:ticket_id:(.+?) -->' | head -1 | sed 's/<!-- reddwarf:ticket_id:\\(.*\\) -->/\\1/')
          if [ -n "$TICKET_ID" ]; then
            echo "ticket_id=$TICKET_ID" >> "$GITHUB_OUTPUT"
            echo "source=body" >> "$GITHUB_OUTPUT"
            echo "Extracted ticket_id from PR body: $TICKET_ID"
            exit 0
          fi

          echo "No ticket_id found in branch name or PR body. Skipping advance."
          echo "skip=true" >> "$GITHUB_OUTPUT"

      - name: Advance ticket queue
        if: steps.extract.outputs.skip != 'true'
        env:
          REDDWARF_OPERATOR_TOKEN: \${{ secrets.REDDWARF_OPERATOR_TOKEN }}
          REDDWARF_OPERATOR_API_URL: \${{ vars.REDDWARF_OPERATOR_API_URL || secrets.REDDWARF_OPERATOR_API_URL }}
          TICKET_ID: \${{ steps.extract.outputs.ticket_id }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
        run: |
          if [ -z "$REDDWARF_OPERATOR_API_URL" ]; then
            echo "::error::REDDWARF_OPERATOR_API_URL is not set. Configure it in repository variables or secrets."
            exit 1
          fi

          if [ -z "$REDDWARF_OPERATOR_TOKEN" ]; then
            echo "::error::REDDWARF_OPERATOR_TOKEN secret is not set."
            exit 1
          fi

          echo "Advancing ticket $TICKET_ID (PR #$PR_NUMBER)..."
          REDDWARF_OPERATOR_API_BASE_URL="\${REDDWARF_OPERATOR_API_URL%/}"

          HTTP_CODE=$(curl -s -o response.json -w "%{http_code}" \\
            -X POST \\
            -H "Authorization: Bearer $REDDWARF_OPERATOR_TOKEN" \\
            -H "Content-Type: application/json" \\
            -d "{\\"ticket_id\\": \\"$TICKET_ID\\", \\"github_pr_number\\": $PR_NUMBER}" \\
            "$REDDWARF_OPERATOR_API_BASE_URL/projects/advance")

          cat response.json
          echo ""

          if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
            OUTCOME=$(jq -r '.outcome // "unknown"' response.json)
            echo "Advance succeeded. Outcome: $OUTCOME"

            if [ "$OUTCOME" = "already_merged" ]; then
              echo "::warning::Ticket $TICKET_ID was already merged. No state change."
            elif [ "$OUTCOME" = "completed" ]; then
              echo "All tickets merged. Project complete."
            else
              NEXT_TICKET=$(jq -r '.nextDispatchedTicket.ticketId // "none"' response.json)
              echo "Next dispatched ticket: $NEXT_TICKET"
            fi
          else
            echo "::error::Advance API call failed with HTTP $HTTP_CODE"
            cat response.json
            exit 1
          fi
`;

export class RestGitHubAdapter implements GitHubAdapter, GitHubRepoDiscovery {
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
    const response = await githubFetchWithRetry(
      `${this.baseUrl}${path}`,
      { method: "GET", headers: this.apiHeaders(), signal: AbortSignal.timeout(this.requestTimeoutMs) },
      `GitHub API GET ${path}`,
      this.requestTimeoutMs
    );
    return response.json() as Promise<T>;
  }

  private async apiPost<T>(path: string, payload: unknown): Promise<T> {
    const response = await githubFetchWithRetry(
      `${this.baseUrl}${path}`,
      { method: "POST", headers: this.apiHeaders(), body: JSON.stringify(payload), signal: AbortSignal.timeout(this.requestTimeoutMs) },
      `GitHub API POST ${path}`,
      this.requestTimeoutMs
    );
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

  async addLabels(_repo: string, _issueNumber: number, labels: string[]): Promise<void> {
    throw new V1MutationDisabledError(`Adding labels [${labels.join(", ")}] is disabled in RedDwarf v1`);
  }

  async removeLabels(_repo: string, _issueNumber: number, labels: string[]): Promise<void> {
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

  async commentOnIssue(comment: GitHubIssueComment): Promise<void> {
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

  private async apiPut<T>(path: string, payload: unknown): Promise<T> {
    const response = await githubFetchWithRetry(
      `${this.baseUrl}${path}`,
      { method: "PUT", headers: this.apiHeaders(), body: JSON.stringify(payload), signal: AbortSignal.timeout(this.requestTimeoutMs) },
      `GitHub API PUT ${path}`,
      this.requestTimeoutMs
    );
    return response.json() as Promise<T>;
  }

  async ensureWorkflowFile(repo: string): Promise<{ created: boolean; skipped: boolean }> {
    const { owner, repoName } = this.parseRepo(repo);
    const apiPath = `/repos/${owner}/${repoName}/contents/.github/workflows/reddwarf-advance.yml`;

    try {
      await this.apiGet<unknown>(apiPath);
      return { created: false, skipped: true };
    } catch (error) {
      if (!isGitHubNotFoundError(error)) {
        throw error;
      }
    }

    const content = Buffer.from(REDDWARF_ADVANCE_WORKFLOW_YAML).toString("base64");
    await this.apiPut<unknown>(apiPath, {
      message: "Add RedDwarf ticket advance workflow",
      content
    });

    return { created: true, skipped: false };
  }

  async listUserRepos(
    options: {
      perPage?: number;
      page?: number;
      sort?: "updated" | "full_name" | "created" | "pushed";
      direction?: "asc" | "desc";
      query?: string;
    } = {}
  ): Promise<{ repos: GitHubRepoSummary[]; total: number }> {
    const perPage = Math.min(options.perPage ?? 100, 100);
    const page = options.page ?? 1;
    const sort = options.sort ?? "updated";
    const direction = options.direction ?? "desc";

    if (options.query) {
      const params = new URLSearchParams();
      params.set("q", `${options.query} in:name fork:true`);
      params.set("per_page", String(perPage));
      params.set("page", String(page));
      params.set("sort", sort === "full_name" ? "name" : sort);
      params.set("order", direction);
      const result = await this.apiGet<{
        total_count: number;
        items: GitHubApiRepository[];
      }>(`/search/repositories?${params.toString()}`);
      return {
        repos: result.items.map(mapApiRepoToSummary),
        total: result.total_count
      };
    }

    const params = new URLSearchParams();
    params.set("per_page", String(perPage));
    params.set("page", String(page));
    params.set("sort", sort);
    params.set("direction", direction);
    params.set("type", "owner");
    const items = await this.apiGet<GitHubApiRepository[]>(
      `/user/repos?${params.toString()}`
    );
    return { repos: items.map(mapApiRepoToSummary), total: items.length };
  }
}

function mapApiRepoToSummary(repo: GitHubApiRepository): GitHubRepoSummary {
  return {
    fullName: repo.full_name,
    description: repo.description ?? null,
    private: repo.private ?? false,
    defaultBranch: repo.default_branch ?? "main",
    updatedAt: repo.updated_at ?? null,
    language: repo.language ?? null,
    archived: repo.archived ?? false
  };
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

// ============================================================
// RestGitHubIssuesAdapter — project mode sub-issue operations
// ============================================================

export function formatTicketSpecBody(ticketSpec: TicketSpec, parentIssueNumber: number): string {
  const lines: string[] = [];
  lines.push(`Parent issue: #${parentIssueNumber}`);
  lines.push("");
  lines.push(ticketSpec.description);
  lines.push("");
  lines.push("## Acceptance Criteria");
  lines.push("");
  for (const criterion of ticketSpec.acceptanceCriteria) {
    lines.push(`- [ ] ${criterion}`);
  }
  if (ticketSpec.dependsOn.length > 0) {
    lines.push("");
    lines.push("## Dependencies");
    lines.push("");
    for (const dep of ticketSpec.dependsOn) {
      lines.push(`- ${dep}`);
    }
  }
  return lines.join("\n");
}

export interface RestGitHubIssuesAdapterOptions {
  token: string;
  repo?: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
}

export class RestGitHubIssuesAdapter implements GitHubIssuesAdapter {
  private readonly token: string;
  private readonly repo: string | undefined;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;

  constructor(options: RestGitHubIssuesAdapterOptions) {
    this.token = options.token;
    this.repo = options.repo;
    this.baseUrl = options.baseUrl ?? "https://api.github.com";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  private parseRepo(repoOverride?: string): { owner: string; repoName: string; repo: string } {
    const repo = repoOverride ?? this.repo;
    if (!repo) {
      throw new Error(
        "GitHubIssuesAdapter requires a repo for this operation. Pass a repo or set GITHUB_REPO."
      );
    }
    const slash = repo.indexOf("/");
    if (slash <= 0 || slash >= repo.length - 1) {
      throw new Error(`Invalid repo format: "${repo}". Expected "owner/name".`);
    }
    return { owner: repo.slice(0, slash), repoName: repo.slice(slash + 1), repo };
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
    const response = await githubFetchWithRetry(
      `${this.baseUrl}${path}`,
      { method: "GET", headers: this.apiHeaders(), signal: AbortSignal.timeout(this.requestTimeoutMs) },
      `GitHub API GET ${path}`,
      this.requestTimeoutMs
    );
    return response.json() as Promise<T>;
  }

  private async apiPost<T>(path: string, payload: unknown): Promise<T> {
    const response = await githubFetchWithRetry(
      `${this.baseUrl}${path}`,
      { method: "POST", headers: this.apiHeaders(), body: JSON.stringify(payload), signal: AbortSignal.timeout(this.requestTimeoutMs) },
      `GitHub API POST ${path}`,
      this.requestTimeoutMs
    );
    return response.json() as Promise<T>;
  }

  private async apiPatch<T>(path: string, payload: unknown): Promise<T> {
    const response = await githubFetchWithRetry(
      `${this.baseUrl}${path}`,
      { method: "PATCH", headers: this.apiHeaders(), body: JSON.stringify(payload), signal: AbortSignal.timeout(this.requestTimeoutMs) },
      `GitHub API PATCH ${path}`,
      this.requestTimeoutMs
    );
    return response.json() as Promise<T>;
  }

  async createSubIssue(
    parentIssueNumber: number,
    ticketSpec: TicketSpec,
    repo?: string
  ): Promise<number> {
    const { owner, repoName } = this.parseRepo(repo);
    const body = formatTicketSpecBody(ticketSpec, parentIssueNumber);
    const created = await this.apiPost<GitHubApiCreatedIssue>(
      `/repos/${owner}/${repoName}/issues`,
      {
        title: ticketSpec.title,
        body,
        labels: ["reddwarf-ticket"]
      }
    );
    return created.number;
  }

  async closeIssue(issueNumber: number, repo?: string): Promise<void> {
    const { owner, repoName } = this.parseRepo(repo);
    await this.apiPatch<GitHubApiIssue>(
      `/repos/${owner}/${repoName}/issues/${issueNumber}`,
      { state: "closed" }
    );
  }

  async getIssue(issueNumber: number, repo?: string): Promise<GitHubIssueStatusSnapshot> {
    const parsedRepo = this.parseRepo(repo);
    const { owner, repoName } = parsedRepo;
    const [issue, repoData] = await Promise.all([
      this.apiGet<GitHubApiIssue>(`/repos/${owner}/${repoName}/issues/${issueNumber}`),
      this.apiGet<GitHubApiRepository>(`/repos/${owner}/${repoName}`)
    ]);
    return {
      repo: parsedRepo.repo,
      issueNumber: issue.number,
      url: issue.html_url,
      state: issue.state === "open" ? "open" : "closed",
      labels: issue.labels
        .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
        .filter((n) => n.length > 0),
      assignees: issue.assignees.map((a) => a.login),
      milestone: issue.milestone?.title ?? null,
      defaultBranch: repoData.default_branch,
      updatedAt: issue.updated_at ?? null
    };
  }
}

/**
 * Create a RestGitHubIssuesAdapter from environment variables or explicit options.
 * Throws V1MutationDisabledError when REDDWARF_GITHUB_ISSUES_ENABLED is not "true".
 * Requires GITHUB_TOKEN. GITHUB_REPO is optional when callers pass the
 * source repo per operation.
 */
export function createGitHubIssuesAdapter(
  options: { token?: string; repo?: string; baseUrl?: string; requestTimeoutMs?: number } = {}
): RestGitHubIssuesAdapter {
  const enabled = process.env["REDDWARF_GITHUB_ISSUES_ENABLED"];
  if (enabled !== "true") {
    throw new V1MutationDisabledError("GitHub Issues adapter is disabled (REDDWARF_GITHUB_ISSUES_ENABLED is not true)");
  }

  const token = options.token ?? process.env["GITHUB_TOKEN"];
  if (!token) {
    throw new Error(
      "GitHubIssuesAdapter requires a GitHub token. Set the GITHUB_TOKEN environment variable or pass token explicitly."
    );
  }

  const repo = options.repo ?? process.env["GITHUB_REPO"];

  return new RestGitHubIssuesAdapter({
    token,
    ...(repo !== undefined ? { repo } : {}),
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {})
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

function normalizeIssueBodyForParsing(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((line) => !/^```[\w-]*\s*$/.test(line.trim()))
    .join("\n");
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

    if (isMarkdownHeading(line)) {
      current = null;
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
      sections.requestedCapabilities.push(...extractCapabilityTokens(value));
      continue;
    }

    sections[current].push(value);
  }

  return sections;
}

function buildSummary(body: string): string {
  const sectionSummary = buildSummaryFromIssueSections(body);

  if (sectionSummary.length >= 20) {
    return sectionSummary;
  }

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

function buildSummaryFromIssueSections(body: string): string {
  const lines = body.split(/\r?\n/);
  const sections: string[] = [];
  let current: "summary" | "why" | "desiredOutcome" | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.length === 0) {
      continue;
    }

    const normalizedHeading = line.toLowerCase().replace(/[:#]/g, "").trim();

    if (normalizedHeading === "summary") {
      current = "summary";
      continue;
    }

    if (normalizedHeading === "why") {
      current = "why";
      continue;
    }

    if (normalizedHeading === "desired outcome") {
      current = "desiredOutcome";
      continue;
    }

    if (isMarkdownHeading(line)) {
      current = null;
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("- ") || line.startsWith("* ")) {
      continue;
    }

    sections.push(line);
  }

  return sections.join(" ").replace(/\s+/g, " ").trim();
}

function isMarkdownHeading(line: string): boolean {
  return /^#{1,6}\s+/.test(line);
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

function extractCapabilityTokens(value: string): Capability[] {
  return value
    .split(",")
    .map((token) => token.trim())
    .filter(isCapability);
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

// ── Retryable GitHub fetch ────────────────────────────────────────────

const GITHUB_RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const GITHUB_RETRY_MAX_ATTEMPTS = 3;
const GITHUB_RETRY_BASE_DELAY_MS = 1_000;

/**
 * Wrap a single GitHub REST API fetch call with retry logic.
 *
 * - Retries on 429 (rate limit) and 5xx (server error) responses.
 * - Respects the `Retry-After` header when present (seconds).
 * - Uses exponential backoff with jitter (0.5x–1.5x of computed delay).
 * - Non-retryable errors and client errors (4xx except 429) are thrown immediately.
 */
export async function githubFetchWithRetry(
  url: string,
  init: RequestInit & { signal?: AbortSignal },
  context: string,
  timeoutMs: number,
  maxAttempts: number = GITHUB_RETRY_MAX_ATTEMPTS
): Promise<Response> {
  let lastError: Error | undefined;
  // Strip the caller's signal — a fresh per-attempt timeout is used instead.
  // AbortSignal.timeout() creates a one-shot signal that stays aborted once
  // fired, so reusing the same signal across retries would cause immediate
  // abort on attempt 2+.
  const { signal: _callerSignal, ...initWithoutSignal } = init;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...initWithoutSignal,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      // Network / timeout errors are retryable on all but the last attempt
      if (attempt < maxAttempts) {
        lastError = normalizeFetchTimeoutError(error, context, timeoutMs);
        await githubRetryDelay(attempt, undefined);
        continue;
      }
      throw normalizeFetchTimeoutError(error, context, timeoutMs);
    }

    if (response.ok) {
      return response;
    }

    if (GITHUB_RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxAttempts) {
      const retryAfter = parseRetryAfterHeader(response.headers.get("Retry-After"));
      lastError = new Error(
        `${context} returned ${response.status} (attempt ${attempt}/${maxAttempts})`
      );
      await githubRetryDelay(attempt, retryAfter);
      continue;
    }

    // Non-retryable status or final attempt — throw
    const body = await response.text().catch(() => "");
    throw new Error(`${context} returned ${response.status}: ${body}`);
  }

  // Should not be reachable, but satisfies the type checker
  throw lastError ?? new Error(`${context} failed after ${maxAttempts} attempts`);
}

function parseRetryAfterHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 300) {
    return seconds * 1_000;
  }
  return undefined;
}

async function githubRetryDelay(
  attempt: number,
  retryAfterMs: number | undefined
): Promise<void> {
  const baseDelay = retryAfterMs ?? GITHUB_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
  const jitter = 0.5 + Math.random(); // 0.5x – 1.5x
  const delayMs = Math.min(baseDelay * jitter, 30_000);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
