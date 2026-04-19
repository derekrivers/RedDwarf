import type { PlanningTaskInput } from "@reddwarf/contracts";
import type { GitHubAdapter, GitHubIssueCandidate } from "./github.js";
import {
  buildIntakeTaskId,
  parseIntakeTaskId,
  type IntakeAdapter,
  type IntakeCandidate,
  type IntakeDiscoveryQuery,
  type IntakeOutcome,
  type IntakeTaskId
} from "./intake.js";

// Feature 188 — GitHub IntakeAdapter implementation.
//
// Thin wrapper around the existing `GitHubAdapter`. The polling daemon and
// webhook receiver continue to call `GitHubAdapter` directly today; this
// adapter exists so future intake call sites and any future Linear / Slack
// adapters share one shape.

const PROVIDER = "github" as const;

function fromGitHubCandidate(candidate: GitHubIssueCandidate): IntakeCandidate {
  const externalId = candidate.issueNumber;
  return {
    id: buildIntakeTaskId({
      provider: PROVIDER,
      repo: candidate.repo,
      externalId
    }),
    provider: PROVIDER,
    repo: candidate.repo,
    title: candidate.title,
    body: candidate.body,
    labels: [...candidate.labels],
    state: candidate.state,
    url: candidate.url,
    author: candidate.author ?? null,
    metadata: {
      issueNumber: candidate.issueNumber,
      ...(candidate.baseBranch ? { baseBranch: candidate.baseBranch } : {}),
      ...(candidate.updatedAt ? { updatedAt: candidate.updatedAt } : {}),
      ...(candidate.metadata ?? {})
    }
  };
}

export class GitHubIntakeAdapter implements IntakeAdapter {
  readonly provider = PROVIDER;

  constructor(private readonly github: GitHubAdapter) {}

  async discoverCandidates(
    query: IntakeDiscoveryQuery
  ): Promise<IntakeCandidate[]> {
    const candidates = await this.github.listIssueCandidates({
      repo: query.repo,
      ...(query.labels !== undefined ? { labels: query.labels } : {}),
      ...(query.states !== undefined ? { states: query.states } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {})
    });
    return candidates.map(fromGitHubCandidate);
  }

  async fetchCanonicalTask(id: IntakeTaskId): Promise<IntakeCandidate> {
    const parsed = parseIntakeTaskId(id);
    if (!parsed || parsed.provider !== PROVIDER) {
      throw new Error(
        `GitHubIntakeAdapter cannot resolve intake id '${id}'.`
      );
    }
    const issueNumber = Number.parseInt(parsed.externalId, 10);
    if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
      throw new Error(
        `GitHubIntakeAdapter received non-numeric issue number in '${id}'.`
      );
    }
    const candidate = await this.github.fetchIssueCandidate(
      parsed.repo,
      issueNumber
    );
    return fromGitHubCandidate(candidate);
  }

  async toPlanningTaskInput(
    candidate: IntakeCandidate
  ): Promise<PlanningTaskInput> {
    if (candidate.provider !== PROVIDER) {
      throw new Error(
        `GitHubIntakeAdapter cannot convert non-GitHub candidate '${candidate.id}'.`
      );
    }
    const issueNumber =
      typeof candidate.metadata["issueNumber"] === "number"
        ? (candidate.metadata["issueNumber"] as number)
        : Number.parseInt(
            parseIntakeTaskId(candidate.id)?.externalId ?? "",
            10
          );
    if (!Number.isFinite(issueNumber)) {
      throw new Error(
        `GitHubIntakeAdapter cannot derive issue number for '${candidate.id}'.`
      );
    }
    const baseBranch =
      typeof candidate.metadata["baseBranch"] === "string"
        ? (candidate.metadata["baseBranch"] as string)
        : undefined;
    const updatedAt =
      typeof candidate.metadata["updatedAt"] === "string"
        ? (candidate.metadata["updatedAt"] as string)
        : undefined;
    const githubCandidate: GitHubIssueCandidate = {
      repo: candidate.repo,
      issueNumber,
      title: candidate.title,
      body: candidate.body,
      labels: [...candidate.labels],
      url: candidate.url,
      state: candidate.state,
      ...(candidate.author !== null ? { author: candidate.author } : {}),
      ...(baseBranch !== undefined ? { baseBranch } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      metadata: { ...candidate.metadata }
    };
    return this.github.convertToPlanningInput(githubCandidate);
  }

  async markProcessed(
    _id: IntakeTaskId,
    _outcome: IntakeOutcome
  ): Promise<void> {
    // v1 intentionally no-ops — the polling daemon already persists its
    // own cursor in `github_issue_polling_cursors`. Adding label / comment
    // mutations is gated behind `addLabels` and would need an explicit
    // capability flag, so it stays opt-in for a follow-up.
  }
}
