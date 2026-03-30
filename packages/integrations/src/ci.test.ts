import { describe, expect, it } from "vitest";
import { FixtureCiAdapter, NullNotificationAdapter } from "./ci.js";
import { V1MutationDisabledError } from "./errors.js";

describe("FixtureCiAdapter", () => {
  it("returns a registered snapshot for a known repo+ref", async () => {
    const adapter = new FixtureCiAdapter([
      {
        repo: "acme/platform",
        ref: "main",
        overallStatus: "success",
        checks: [],
        observedAt: "2026-01-01T00:00:00.000Z"
      }
    ]);

    const snapshot = await adapter.getLatestChecks("acme/platform", "main");
    expect(snapshot.overallStatus).toBe("success");
  });

  it("returns pending with empty checks for unknown repo+ref", async () => {
    const adapter = new FixtureCiAdapter([]);
    const snapshot = await adapter.getLatestChecks("acme/platform", "unknown-branch");
    expect(snapshot.overallStatus).toBe("pending");
    expect(snapshot.checks).toEqual([]);
  });

  it("throws V1MutationDisabledError for triggerWorkflow", async () => {
    const adapter = new FixtureCiAdapter([]);
    await expect(
      adapter.triggerWorkflow("acme/platform", "ci.yml", "main")
    ).rejects.toBeInstanceOf(V1MutationDisabledError);
  });

  it("throws V1MutationDisabledError for attachBuildOutput", async () => {
    const adapter = new FixtureCiAdapter([]);
    await expect(
      adapter.attachBuildOutput("task-1", { name: "report", url: "https://example.com/report" })
    ).rejects.toBeInstanceOf(V1MutationDisabledError);
  });
});

describe("NullNotificationAdapter", () => {
  it("resolves sendStatusUpdate without error", async () => {
    const adapter = new NullNotificationAdapter();
    await expect(adapter.sendStatusUpdate()).resolves.toBeUndefined();
  });

  it("resolves sendFailureAlert without error", async () => {
    const adapter = new NullNotificationAdapter();
    await expect(adapter.sendFailureAlert()).resolves.toBeUndefined();
  });
});
