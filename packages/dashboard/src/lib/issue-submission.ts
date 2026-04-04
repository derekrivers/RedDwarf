import type { Capability } from "@reddwarf/contracts";

export const defaultIssueSubmissionCapabilities = [
  "can_write_code",
  "can_run_tests",
  "can_open_pr",
  "can_archive_evidence"
] as const satisfies readonly Capability[];

export function createDefaultIssueSubmissionCapabilitySet(): Set<Capability> {
  return new Set<Capability>(defaultIssueSubmissionCapabilities);
}
