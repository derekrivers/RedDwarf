import { describe, expect, it } from "vitest";
import {
  createDefaultIssueSubmissionCapabilitySet,
  defaultIssueSubmissionCapabilities
} from "./issue-submission";

describe("issue submission defaults", () => {
  it("enables a safe implementation-focused capability subset by default", () => {
    expect(defaultIssueSubmissionCapabilities).toEqual([
      "can_write_code",
      "can_run_tests",
      "can_open_pr",
      "can_archive_evidence"
    ]);
  });

  it("creates an isolated set for form state", () => {
    const first = createDefaultIssueSubmissionCapabilitySet();
    const second = createDefaultIssueSubmissionCapabilitySet();

    first.delete("can_open_pr");

    expect(first.has("can_open_pr")).toBe(false);
    expect(second.has("can_open_pr")).toBe(true);
  });
});
