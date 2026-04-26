/**
 * M25 — make a project "auto-merge ready" by populating its RequiredCheckContract
 * (and, on greenfield repos, installing the F-192 scaffold workflow).
 *
 * Called from two entrypoints:
 *   - executeProjectApproval (when auto_merge: { enabled: true } at approval time)
 *   - PATCH /projects/:id (when autoMergeEnabled flips false → true post-approval)
 *
 * Without this, the F-194 evaluator's gate 3 (empty contract) would block forever
 * on any project that opted in via the toggle, because F-191's surveyor only ran
 * at planning time and F-192's installer only ran at approve-with-opt-in time.
 *
 * Contract: idempotent. If the contract is already non-empty we leave it alone.
 * If the survey produces names we trust those (the developer's real workflows).
 * Only fall back to the scaffold + scaffold-derived contract on greenfield.
 *
 * Returns the (possibly mutated) project plus a structured result so callers
 * can persist + log + flip autoMergeEnabled back off when scaffolding fails.
 */

import {
  asIsoTimestamp,
  isRequiredCheckContractEmpty,
  type ProjectSpec,
  type RequiredCheckContract
} from "@reddwarf/contracts";
import {
  buildRequiredCheckContractFromSurvey,
  ensureRequiredChecksWorkflow,
  SCAFFOLD_REQUIRED_CHECK_NAMES,
  surveyWorkflowFiles,
  type RequiredChecksScaffoldAdapter,
  type WorkflowSurveyAdapter
} from "@reddwarf/integrations";

export interface EnsureProjectAutoMergeReadyDeps {
  workflowSurveyAdapter?: WorkflowSurveyAdapter | null;
  scaffoldAdapter?: RequiredChecksScaffoldAdapter | null;
  clock?: () => Date;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

export type EnsureProjectAutoMergeReadyOutcome =
  | "already_ready"
  | "populated_from_survey"
  | "scaffolded_and_populated"
  | "scaffold_already_present"
  | "scaffold_unsupported_stack"
  | "scaffold_failed"
  | "no_adapters";

export interface EnsureProjectAutoMergeReadyResult {
  /** The project after any mutation. Caller persists it. */
  project: ProjectSpec;
  outcome: EnsureProjectAutoMergeReadyOutcome;
  /** Human-readable reason — surfaced via logs / evidence / Discord. */
  reason: string;
  /** When true, the project should NOT auto-merge (caller should set
   *  autoMergeEnabled = false defensively before persisting). */
  forceDisableAutoMerge: boolean;
  /** Effective contract on the returned project, for logging. */
  contract: RequiredCheckContract | null;
}

const SCAFFOLD_RATIONALE =
  "Populated from F-192 reddwarf-required-checks.yml scaffold (greenfield repo).";

function buildScaffoldContract(): RequiredCheckContract {
  return {
    requiredCheckNames: [...SCAFFOLD_REQUIRED_CHECK_NAMES],
    minimumCheckCount: SCAFFOLD_REQUIRED_CHECK_NAMES.length,
    forbidSkipCi: true,
    forbidEmptyTestDiff: true,
    rationale: SCAFFOLD_RATIONALE
  };
}

export async function ensureProjectAutoMergeReady(
  inputProject: ProjectSpec,
  deps: EnsureProjectAutoMergeReadyDeps
): Promise<EnsureProjectAutoMergeReadyResult> {
  const { logger, clock = () => new Date() } = deps;
  const now = (): string => asIsoTimestamp(clock());

  // Already has a real contract — nothing to do. Don't re-survey because the
  // surveyed contract at planning time is the source of truth for that project.
  if (!isRequiredCheckContractEmpty(inputProject.requiredCheckContract)) {
    return {
      project: inputProject,
      outcome: "already_ready",
      reason: "Project already carries a non-empty RequiredCheckContract.",
      forceDisableAutoMerge: false,
      contract: inputProject.requiredCheckContract!
    };
  }

  if (!deps.workflowSurveyAdapter && !deps.scaffoldAdapter) {
    // Nothing we can do — caller should have provided adapters. The
    // evaluator's gate 3 will continue to block until someone re-plans.
    return {
      project: inputProject,
      outcome: "no_adapters",
      reason:
        "No workflowSurveyAdapter or scaffoldAdapter supplied; cannot populate contract or install scaffold.",
      forceDisableAutoMerge: false,
      contract: null
    };
  }

  // Step 1 — try to derive a contract from the repo's existing workflow files.
  // The repo may have grown CI between project planning and the toggle, in
  // which case we prefer the developer's real workflows over the scaffold.
  if (deps.workflowSurveyAdapter) {
    try {
      const survey = await surveyWorkflowFiles(
        deps.workflowSurveyAdapter,
        inputProject.sourceRepo
      );
      const surveyedContract = buildRequiredCheckContractFromSurvey(survey);
      if (surveyedContract) {
        const updated: ProjectSpec = {
          ...inputProject,
          requiredCheckContract: surveyedContract,
          updatedAt: now()
        };
        logger?.info(
          `M25 readiness: populated contract from existing workflows in ${inputProject.sourceRepo}: ${surveyedContract.requiredCheckNames.join(", ")}.`
        );
        return {
          project: updated,
          outcome: "populated_from_survey",
          reason: `Surveyed ${survey.workflowFiles.length} workflow file(s); contract carries ${surveyedContract.requiredCheckNames.length} check name(s).`,
          forceDisableAutoMerge: false,
          contract: surveyedContract
        };
      }
    } catch (err) {
      logger?.warn(
        `M25 readiness: workflow survey failed for ${inputProject.sourceRepo}: ${err instanceof Error ? err.message : String(err)}. Falling back to scaffold path.`
      );
    }
  }

  // Step 2 — greenfield: install F-192 scaffold and populate contract from
  // its known job ids (lint/build/test).
  if (!deps.scaffoldAdapter) {
    return {
      project: inputProject,
      outcome: "no_adapters",
      reason:
        "Survey returned empty and no scaffoldAdapter was provided; cannot install default workflow.",
      forceDisableAutoMerge: true,
      contract: null
    };
  }

  let scaffoldResult: Awaited<ReturnType<typeof ensureRequiredChecksWorkflow>>;
  try {
    scaffoldResult = await ensureRequiredChecksWorkflow(
      deps.scaffoldAdapter,
      inputProject.sourceRepo
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn(
      `M25 readiness: scaffold install failed for ${inputProject.sourceRepo}: ${msg}. Auto-merge will be disabled.`
    );
    return {
      project: inputProject,
      outcome: "scaffold_failed",
      reason: `Scaffold install failed: ${msg}`,
      forceDisableAutoMerge: true,
      contract: null
    };
  }

  if (scaffoldResult.installed || scaffoldResult.reason === "already_present") {
    // Either we just installed lint/build/test, or those jobs are already
    // present in some pre-existing reddwarf-required-checks.yml. Either way,
    // the contract names are stable.
    const contract = buildScaffoldContract();
    const updated: ProjectSpec = {
      ...inputProject,
      requiredCheckContract: contract,
      updatedAt: now()
    };
    return {
      project: updated,
      outcome: scaffoldResult.installed
        ? "scaffolded_and_populated"
        : "scaffold_already_present",
      reason: scaffoldResult.installed
        ? `Installed default required-checks workflow (${scaffoldResult.stack}); contract populated with ${contract.requiredCheckNames.join(", ")}.`
        : `Default required-checks workflow already present; contract populated with ${contract.requiredCheckNames.join(", ")}.`,
      forceDisableAutoMerge: false,
      contract
    };
  }

  // No recognized stack manifest. Auto-merge can't be made safe here.
  logger?.warn(
    `M25 readiness: ${inputProject.sourceRepo} has no recognized stack manifest (package.json / pyproject.toml / Cargo.toml). Auto-merge will be disabled.`
  );
  return {
    project: inputProject,
    outcome: "scaffold_unsupported_stack",
    reason:
      "Repo has no recognized stack manifest (package.json / pyproject.toml / Cargo.toml). Cannot install a default CI workflow.",
    forceDisableAutoMerge: true,
    contract: null
  };
}
