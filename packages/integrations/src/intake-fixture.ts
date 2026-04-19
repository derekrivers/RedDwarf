import type { PlanningTaskInput } from "@reddwarf/contracts";
import {
  buildIntakeTaskId,
  parseIntakeTaskId,
  type IntakeAdapter,
  type IntakeCandidate,
  type IntakeDiscoveryQuery,
  type IntakeOutcome,
  type IntakeTaskId
} from "./intake.js";

// Feature 188 — In-process IntakeAdapter for tests + scripted scenarios.
//
// Acts as the second implementation that proves the IntakeAdapter contract
// is genuinely provider-agnostic. Production-grade non-GitHub adapters
// (Linear, Jira, Slack, scheduled-cron) can use this as a reference shape.

export interface FixtureIntakeAdapterOptions {
  /** Override the provider id reported by the adapter. Defaults to `"fixture"`. */
  provider?: string;
  /** Initial candidates to seed the adapter with. */
  candidates?: IntakeCandidate[];
  /** Custom translator from a candidate to a planning input. */
  toPlanningTaskInput?: (
    candidate: IntakeCandidate
  ) => Promise<PlanningTaskInput> | PlanningTaskInput;
}

function defaultPlanningTaskInput(
  candidate: IntakeCandidate
): PlanningTaskInput {
  return {
    source: {
      provider: "github",
      repo: candidate.repo,
      issueNumber:
        typeof candidate.metadata["issueNumber"] === "number"
          ? (candidate.metadata["issueNumber"] as number)
          : 1,
      issueUrl: candidate.url
    },
    title: candidate.title,
    summary: candidate.body,
    priority: 50,
    dryRun: false,
    labels: [...candidate.labels],
    acceptanceCriteria: ["Task satisfies the source acceptance criteria."],
    affectedPaths: [],
    requestedCapabilities: ["can_plan", "can_archive_evidence"],
    metadata: { intake: { provider: candidate.provider, id: candidate.id } }
  };
}

export class FixtureIntakeAdapter implements IntakeAdapter {
  readonly provider: string;
  private readonly candidates = new Map<IntakeTaskId, IntakeCandidate>();
  private readonly outcomes: Array<{ id: IntakeTaskId; outcome: IntakeOutcome }> = [];
  private readonly translate: (
    candidate: IntakeCandidate
  ) => Promise<PlanningTaskInput> | PlanningTaskInput;

  constructor(options: FixtureIntakeAdapterOptions = {}) {
    this.provider = options.provider ?? "fixture";
    this.translate = options.toPlanningTaskInput ?? defaultPlanningTaskInput;
    for (const candidate of options.candidates ?? []) {
      this.candidates.set(candidate.id, candidate);
    }
  }

  /** Adds a candidate to the adapter at runtime — useful for sequencing tests. */
  addCandidate(candidate: IntakeCandidate): void {
    this.candidates.set(candidate.id, candidate);
  }

  /** Returns the recorded markProcessed history for assertion in tests. */
  recordedOutcomes(): ReadonlyArray<{ id: IntakeTaskId; outcome: IntakeOutcome }> {
    return this.outcomes;
  }

  async discoverCandidates(
    query: IntakeDiscoveryQuery
  ): Promise<IntakeCandidate[]> {
    const filtered = [...this.candidates.values()].filter(
      (candidate) => candidate.repo === query.repo
    );
    const labelFiltered =
      query.labels && query.labels.length > 0
        ? filtered.filter((candidate) =>
            (query.labels ?? []).every((label) =>
              candidate.labels.some(
                (value) => value.toLowerCase() === label.toLowerCase()
              )
            )
          )
        : filtered;
    const stateFiltered =
      query.states && query.states.length > 0
        ? labelFiltered.filter((candidate) => query.states!.includes(candidate.state))
        : labelFiltered;
    return stateFiltered.slice(0, query.limit ?? stateFiltered.length);
  }

  async fetchCanonicalTask(id: IntakeTaskId): Promise<IntakeCandidate> {
    const candidate = this.candidates.get(id);
    if (!candidate) {
      throw new Error(`FixtureIntakeAdapter has no candidate for id '${id}'.`);
    }
    return candidate;
  }

  async toPlanningTaskInput(
    candidate: IntakeCandidate
  ): Promise<PlanningTaskInput> {
    return this.translate(candidate);
  }

  async markProcessed(
    id: IntakeTaskId,
    outcome: IntakeOutcome
  ): Promise<void> {
    this.outcomes.push({ id, outcome });
  }
}

/** Convenience: builds a fixture candidate with sensible defaults. */
export function makeFixtureCandidate(input: {
  provider?: string;
  repo: string;
  externalId: string | number;
  title: string;
  body?: string;
  labels?: string[];
  state?: IntakeCandidate["state"];
  url?: string;
  author?: string | null;
  metadata?: Record<string, unknown>;
}): IntakeCandidate {
  const provider = input.provider ?? "fixture";
  return {
    id: buildIntakeTaskId({ provider, repo: input.repo, externalId: input.externalId }),
    provider,
    repo: input.repo,
    title: input.title,
    body: input.body ?? "",
    labels: input.labels ?? [],
    state: input.state ?? "open",
    url: input.url ?? `https://example.invalid/${input.repo}/${input.externalId}`,
    author: input.author ?? null,
    metadata: input.metadata ?? {}
  };
}

export { parseIntakeTaskId };
