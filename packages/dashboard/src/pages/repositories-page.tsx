import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconAlertCircle,
  IconCheck,
  IconGitBranch,
  IconLock,
  IconPlus,
  IconSearch,
  IconTrash,
  IconWorld
} from "@tabler/icons-react";
import type { GitHubRepoSummary } from "../api/client";
import type { DashboardApiClient } from "../types/dashboard";

function parseOwnerRepo(fullName: string): { owner: string; repo: string } {
  const slash = fullName.indexOf("/");
  return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
}

function RelativeTime(props: { value: string | null }) {
  if (!props.value) return <span className="text-secondary">--</span>;
  const date = new Date(props.value);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffDays < 1) return <span>today</span>;
  if (diffDays === 1) return <span>yesterday</span>;
  if (diffDays < 30) return <span>{diffDays}d ago</span>;
  return (
    <span>
      {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date)}
    </span>
  );
}

export function RepositoriesPage(props: { apiClient: DashboardApiClient }) {
  const { apiClient } = props;
  const queryClient = useQueryClient();

  // --- Managed repos query ---
  const managedQuery = useQuery({
    queryKey: ["managed-repos"],
    queryFn: () => apiClient.getRepos(),
    refetchInterval: 15000
  });

  const managedRepos = new Set(
    (managedQuery.data?.repos ?? []).map((r) => r.repo)
  );

  // --- GitHub discovery ---
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [searchTimeout, setSearchTimeoutId] = useState<ReturnType<typeof setTimeout> | null>(null);

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchQuery(value);
      if (searchTimeout) clearTimeout(searchTimeout);
      setSearchTimeoutId(
        setTimeout(() => setDebouncedQuery(value), 350)
      );
    },
    [searchTimeout]
  );

  const githubQuery = useQuery({
    queryKey: ["github-repos", debouncedQuery],
    queryFn: () =>
      apiClient.listGitHubUserRepos({
        perPage: 50,
        ...(debouncedQuery.trim() ? { q: debouncedQuery.trim() } : {})
      }),
    staleTime: 30000
  });

  // --- Manual add ---
  const [manualRepo, setManualRepo] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);

  // --- Mutations ---
  const addMutation = useMutation({
    mutationFn: (repo: string) => apiClient.addRepo(repo),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["managed-repos"] });
      setManualRepo("");
      setManualError(null);
    },
    onError: (error) => {
      setManualError(error instanceof Error ? error.message : "Failed to add repository.");
    }
  });

  const removeMutation = useMutation({
    mutationFn: (fullName: string) => {
      const { owner, repo } = parseOwnerRepo(fullName);
      return apiClient.removeRepo(owner, repo);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["managed-repos"] });
    }
  });

  function handleManualAdd(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = manualRepo.trim();
    if (!trimmed || !/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
      setManualError("Enter a valid owner/repo format (e.g. myorg/myrepo).");
      return;
    }
    addMutation.mutate(trimmed);
  }

  function handleAddFromGitHub(repo: GitHubRepoSummary) {
    addMutation.mutate(repo.fullName);
  }

  function handleRemove(fullName: string) {
    removeMutation.mutate(fullName);
  }

  return (
    <div className="row g-4">
      {/* Left column: managed repos */}
      <div className="col-lg-6">
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Managed Repositories</h3>
            <span className="badge bg-blue-lt ms-auto">
              {managedQuery.data?.total ?? 0}
            </span>
          </div>
          <div className="card-body p-0">
            {managedQuery.isLoading ? (
              <div className="p-4 text-center text-secondary">Loading...</div>
            ) : managedRepos.size === 0 ? (
              <div className="empty py-5">
                <p className="empty-title">No repositories configured</p>
                <p className="empty-subtitle text-secondary">
                  Add repositories from GitHub or enter one manually below.
                </p>
              </div>
            ) : (
              <div className="list-group list-group-flush">
                {[...managedRepos].sort().map((repo) => (
                  <div
                    key={repo}
                    className="list-group-item d-flex align-items-center"
                  >
                    <IconGitBranch size={16} className="text-secondary me-2 flex-shrink-0" />
                    <span className="text-truncate fw-medium">{repo}</span>
                    <button
                      className="btn btn-ghost-danger btn-icon ms-auto flex-shrink-0"
                      type="button"
                      onClick={() => handleRemove(repo)}
                      disabled={removeMutation.isPending}
                      title="Remove repository"
                    >
                      <IconTrash size={16} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="card-footer">
            <form onSubmit={handleManualAdd} className="d-flex gap-2">
              <input
                type="text"
                className={`form-control ${manualError ? "is-invalid" : ""}`}
                placeholder="owner/repo"
                value={manualRepo}
                onChange={(e) => {
                  setManualRepo(e.target.value);
                  setManualError(null);
                }}
              />
              <button
                className="btn btn-primary flex-shrink-0"
                type="submit"
                disabled={addMutation.isPending || !manualRepo.trim()}
              >
                <IconPlus size={16} className="me-1" />
                Add
              </button>
            </form>
            {manualError && (
              <div className="invalid-feedback d-block mt-1">
                <IconAlertCircle size={14} className="me-1" />
                {manualError}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right column: GitHub repo browser */}
      <div className="col-lg-6">
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Browse GitHub Repos</h3>
          </div>
          <div className="card-body border-bottom py-3">
            <div className="input-icon">
              <span className="input-icon-addon">
                <IconSearch size={16} />
              </span>
              <input
                type="text"
                className="form-control"
                placeholder="Search your repositories..."
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
              />
            </div>
          </div>
          <div className="card-body p-0" style={{ maxHeight: "500px", overflowY: "auto" }}>
            {githubQuery.isLoading ? (
              <div className="p-4 text-center text-secondary">
                <span className="spinner-border spinner-border-sm me-2" />
                Loading from GitHub...
              </div>
            ) : githubQuery.isError ? (
              <div className="p-4 text-center text-danger">
                <IconAlertCircle size={18} className="me-1" />
                {githubQuery.error instanceof Error
                  ? githubQuery.error.message
                  : "Failed to load repositories from GitHub."}
              </div>
            ) : (githubQuery.data?.repos ?? []).length === 0 ? (
              <div className="empty py-5">
                <p className="empty-subtitle text-secondary">
                  {debouncedQuery
                    ? "No repositories matched your search."
                    : "No repositories found."}
                </p>
              </div>
            ) : (
              <div className="list-group list-group-flush">
                {(githubQuery.data?.repos ?? []).map((repo) => {
                  const isManaged = managedRepos.has(repo.fullName);
                  return (
                    <div
                      key={repo.fullName}
                      className="list-group-item"
                    >
                      <div className="d-flex align-items-center">
                        <div className="me-2 flex-shrink-0">
                          {repo.private ? (
                            <IconLock size={16} className="text-warning" />
                          ) : (
                            <IconWorld size={16} className="text-secondary" />
                          )}
                        </div>
                        <div className="flex-grow-1 text-truncate">
                          <div className="fw-medium text-truncate">
                            {repo.fullName}
                            {repo.archived && (
                              <span className="badge bg-secondary-lt ms-2">archived</span>
                            )}
                          </div>
                          {repo.description && (
                            <div className="text-secondary small text-truncate">
                              {repo.description}
                            </div>
                          )}
                          <div className="text-secondary small mt-1">
                            {repo.language && (
                              <span className="me-3">{repo.language}</span>
                            )}
                            <span>
                              Updated <RelativeTime value={repo.updatedAt} />
                            </span>
                          </div>
                        </div>
                        <div className="ms-2 flex-shrink-0">
                          {isManaged ? (
                            <span className="badge bg-green-lt">
                              <IconCheck size={14} className="me-1" />
                              Added
                            </span>
                          ) : (
                            <button
                              className="btn btn-sm btn-outline-primary"
                              type="button"
                              onClick={() => handleAddFromGitHub(repo)}
                              disabled={addMutation.isPending}
                            >
                              <IconPlus size={14} className="me-1" />
                              Add
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {githubQuery.data && githubQuery.data.total > (githubQuery.data.repos?.length ?? 0) && (
            <div className="card-footer text-secondary text-center small">
              Showing {githubQuery.data.repos.length} of {githubQuery.data.total} repositories.
              Use search to narrow results.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
