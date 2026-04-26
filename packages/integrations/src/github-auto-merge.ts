/**
 * M25 F-194 — narrow GitHub-side surface required by the auto-merge evaluator.
 *
 * Kept as a standalone interface (not folded into GitHubWriter) so existing
 * fixtures and downstream packages don't have to implement methods they
 * never use. RestGitHubAdapter implements this; tests use FixtureGitHubAutoMergeAdapter.
 */

export interface PullRequestSnapshot {
  number: number;
  state: "open" | "closed" | "merged";
  merged: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  title: string;
  body: string;
  labels: string[];
}

export interface PullRequestFile {
  path: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
}

export interface PullRequestCommit {
  sha: string;
  message: string;
}

export interface MergePullRequestResult {
  merged: boolean;
  mergedSha: string | null;
  message: string;
}

export interface GitHubAutoMergeAdapter {
  /** Fetch a PR's current snapshot — labels, head SHA, ref, body, etc. */
  getPullRequest(repo: string, prNumber: number): Promise<PullRequestSnapshot>;
  /** Files changed by the PR (used by gate 9 — forbidEmptyTestDiff). */
  getPullRequestFiles(repo: string, prNumber: number): Promise<PullRequestFile[]>;
  /** Commits on the PR branch (used by gate 8 — forbidSkipCi). */
  getPullRequestCommits(repo: string, prNumber: number): Promise<PullRequestCommit[]>;
  /** Add a single label to a PR (used when blocking for human review). */
  addLabel(repo: string, prNumber: number, label: string): Promise<void>;
  /** Post a single comment on a PR (used when blocking for human review). */
  postComment(repo: string, prNumber: number, body: string): Promise<void>;
  /**
   * Perform the merge. Always uses merge_method=squash to match the
   * existing manual-merge convention (see GitHub Actions advance workflow).
   */
  mergePullRequest(input: {
    repo: string;
    prNumber: number;
    headSha: string;
    commitTitle?: string;
  }): Promise<MergePullRequestResult>;
}
