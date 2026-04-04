import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { IconAlertCircle, IconCircleCheck, IconExternalLink, IconPlus, IconTrash } from "@tabler/icons-react";
import type { Capability } from "@reddwarf/contracts";
import { capabilities } from "@reddwarf/contracts";
import type { SubmitIssueResponse } from "../api/client";
import type { DashboardApiClient } from "../types/dashboard";

const CAPABILITY_LABELS: Record<Capability, string> = {
  can_plan: "Planning",
  can_write_code: "Write Code",
  can_run_tests: "Run Tests",
  can_open_pr: "Open Pull Request",
  can_modify_schema: "Modify Schema",
  can_touch_sensitive_paths: "Sensitive Paths",
  can_use_secrets: "Use Secrets",
  can_review: "Review",
  can_archive_evidence: "Archive Evidence"
};

const RISK_CLASS_OPTIONS = [
  { value: "", label: "(auto-detect)" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" }
] as const;

function parseLinesInput(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function SubmitIssuePage(props: { apiClient: DashboardApiClient }) {
  const { apiClient } = props;

  const reposQuery = useQuery({
    queryKey: ["repos-list"],
    queryFn: () => apiClient.getRepos()
  });

  const [repo, setRepo] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [criteria, setCriteria] = useState<string[]>([""]);
  const [affectedPathsRaw, setAffectedPathsRaw] = useState("");
  const [constraintsRaw, setConstraintsRaw] = useState("");
  const [selectedCapabilities, setSelectedCapabilities] = useState<Set<Capability>>(
    new Set(capabilities)
  );
  const [riskClassHint, setRiskClassHint] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successResult, setSuccessResult] = useState<SubmitIssueResponse | null>(null);

  const repos = reposQuery.data?.repos ?? [];
  const effectiveRepo = repo || repos[0]?.repo || "";

  function toggleCapability(cap: Capability) {
    setSelectedCapabilities((prev) => {
      const next = new Set(prev);
      if (next.has(cap)) {
        next.delete(cap);
      } else {
        next.add(cap);
      }
      return next;
    });
  }

  function addCriterion() {
    setCriteria((prev) => [...prev, ""]);
  }

  function updateCriterion(index: number, value: string) {
    setCriteria((prev) => prev.map((c, i) => (i === index ? value : c)));
  }

  function removeCriterion(index: number) {
    setCriteria((prev) => prev.filter((_, i) => i !== index));
  }

  function resetForm() {
    setRepo("");
    setTitle("");
    setSummary("");
    setCriteria([""]);
    setAffectedPathsRaw("");
    setConstraintsRaw("");
    setSelectedCapabilities(new Set(capabilities));
    setRiskClassHint("");
    setSubmitError(null);
    setSuccessResult(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    const filledCriteria = criteria.map((c) => c.trim()).filter((c) => c.length > 0);
    if (filledCriteria.length === 0) {
      setSubmitError("At least one acceptance criterion is required.");
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await apiClient.submitIssue({
        repo: effectiveRepo,
        title: title.trim(),
        summary: summary.trim(),
        acceptanceCriteria: filledCriteria,
        affectedPaths: parseLinesInput(affectedPathsRaw),
        constraints: parseLinesInput(constraintsRaw),
        labels: [],
        requestedCapabilities: [...selectedCapabilities],
        ...(riskClassHint ? { riskClassHint: riskClassHint as "low" | "medium" | "high" } : {})
      });
      setSuccessResult(result);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Failed to submit issue.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (successResult) {
    return (
      <div className="row justify-content-center">
        <div className="col-lg-7">
          <div className="card border-success">
            <div className="card-body text-center py-5">
              <IconCircleCheck size={48} className="text-success mb-3" stroke={1.5} />
              <h2 className="mb-2">Issue Created</h2>
              <p className="text-secondary mb-4">
                GitHub issue{" "}
                <strong>
                  {successResult.repo}#{successResult.issueNumber}
                </strong>{" "}
                has been created. It will be processed on the next polling cycle.
              </p>
              <div className="d-flex gap-2 justify-content-center">
                <a
                  href={successResult.issueUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-primary"
                >
                  <IconExternalLink size={16} className="me-2" />
                  View on GitHub
                </a>
                <button className="btn btn-outline-secondary" onClick={resetForm} type="button">
                  Submit Another
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <div className="row g-4">
        <div className="col-lg-7">
          <div className="card mb-4">
            <div className="card-header">
              <h3 className="card-title">Issue Details</h3>
            </div>
            <div className="card-body">
              <div className="mb-3">
                <label className="form-label required" htmlFor="issue-repo">
                  Target Repository
                </label>
                {reposQuery.isLoading ? (
                  <div className="skeleton-input" />
                ) : repos.length > 0 ? (
                  <select
                    id="issue-repo"
                    className="form-select"
                    value={repo}
                    onChange={(e) => setRepo(e.target.value)}
                    required
                  >
                    {repos.map((r) => (
                      <option key={r.repo} value={r.repo}>
                        {r.repo}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id="issue-repo"
                    type="text"
                    className="form-control"
                    placeholder="owner/repo"
                    value={repo}
                    onChange={(e) => setRepo(e.target.value)}
                    required
                  />
                )}
                {repos.length === 0 && !reposQuery.isLoading && (
                  <div className="form-hint">
                    No polling repos configured. Enter a repo manually.
                  </div>
                )}
              </div>

              <div className="mb-3">
                <label className="form-label required" htmlFor="issue-title">
                  Title
                </label>
                <input
                  id="issue-title"
                  type="text"
                  className="form-control"
                  placeholder="Short, descriptive task title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  minLength={5}
                  maxLength={200}
                  required
                />
              </div>

              <div className="mb-3">
                <label className="form-label required" htmlFor="issue-summary">
                  Summary
                </label>
                <textarea
                  id="issue-summary"
                  className="form-control"
                  rows={4}
                  placeholder="Describe the task, its context, and what needs to change"
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  minLength={20}
                  required
                />
              </div>

              <div className="mb-3">
                <label className="form-label required">Acceptance Criteria</label>
                {criteria.map((criterion, index) => (
                  <div className="input-group mb-2" key={index}>
                    <input
                      type="text"
                      className="form-control"
                      placeholder={`Criterion ${index + 1}`}
                      value={criterion}
                      onChange={(e) => updateCriterion(index, e.target.value)}
                    />
                    {criteria.length > 1 && (
                      <button
                        className="btn btn-outline-secondary"
                        type="button"
                        onClick={() => removeCriterion(index)}
                        aria-label="Remove criterion"
                      >
                        <IconTrash size={14} />
                      </button>
                    )}
                  </div>
                ))}
                <button
                  className="btn btn-sm btn-outline-secondary"
                  type="button"
                  onClick={addCriterion}
                >
                  <IconPlus size={14} className="me-1" />
                  Add Criterion
                </button>
              </div>

              <div className="mb-3">
                <label className="form-label" htmlFor="issue-paths">
                  Affected Paths
                </label>
                <textarea
                  id="issue-paths"
                  className="form-control"
                  rows={2}
                  placeholder={"packages/auth/src/\npackages/api/routes.ts"}
                  value={affectedPathsRaw}
                  onChange={(e) => setAffectedPathsRaw(e.target.value)}
                />
                <div className="form-hint">One path per line. Optional.</div>
              </div>

              <div className="mb-0">
                <label className="form-label" htmlFor="issue-constraints">
                  Constraints
                </label>
                <textarea
                  id="issue-constraints"
                  className="form-control"
                  rows={2}
                  placeholder={"Must not break existing API contracts\nBackward compatible only"}
                  value={constraintsRaw}
                  onChange={(e) => setConstraintsRaw(e.target.value)}
                />
                <div className="form-hint">One constraint per line. Optional.</div>
              </div>
            </div>
          </div>
        </div>

        <div className="col-lg-5">
          <div className="card mb-4">
            <div className="card-header">
              <h3 className="card-title">Requested Capabilities</h3>
            </div>
            <div className="card-body">
              <p className="text-secondary small mb-3">
                Select which agent capabilities this task may use. All are enabled by default.
              </p>
              <div className="divide-y">
                {(capabilities as readonly Capability[]).map((cap) => (
                  <div className="py-2" key={cap}>
                    <label className="form-check">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        checked={selectedCapabilities.has(cap)}
                        onChange={() => toggleCapability(cap)}
                      />
                      <span className="form-check-label">{CAPABILITY_LABELS[cap]}</span>
                    </label>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="card mb-4">
            <div className="card-header">
              <h3 className="card-title">Risk Classification</h3>
            </div>
            <div className="card-body">
              <label className="form-label" htmlFor="issue-risk">
                Risk Class Hint
              </label>
              <select
                id="issue-risk"
                className="form-select"
                value={riskClassHint}
                onChange={(e) => setRiskClassHint(e.target.value)}
              >
                {RISK_CLASS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <div className="form-hint">
                Leave as auto-detect unless you need to override the planner.
              </div>
            </div>
          </div>

          {submitError && (
            <div className="alert alert-danger mb-4" role="alert">
              <div className="d-flex align-items-start gap-2">
                <IconAlertCircle size={18} className="mt-1 flex-shrink-0" />
                <div>{submitError}</div>
              </div>
            </div>
          )}

          <button
            className="btn btn-primary w-100"
            type="submit"
            disabled={isSubmitting || !effectiveRepo || title.trim().length < 5 || summary.trim().length < 20}
          >
            {isSubmitting ? (
              <>
                <span className="spinner-border spinner-border-sm me-2" role="status" />
                Creating Issue...
              </>
            ) : (
              "Create GitHub Issue"
            )}
          </button>
        </div>
      </div>
    </form>
  );
}
