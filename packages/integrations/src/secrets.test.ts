import { describe, expect, it } from "vitest";
import {
  DenyAllSecretsAdapter,
  EnvVarSecretsAdapter,
  FixtureSecretsAdapter,
  redactSecretValues
} from "./secrets.js";
import { V1MutationDisabledError } from "./errors.js";
import type { SecretLeaseRequest } from "./secrets.js";

const baseRequest: SecretLeaseRequest = {
  taskId: "task-1",
  repo: "acme/platform",
  agentType: "developer",
  phase: "development",
  environment: "staging",
  riskClass: "medium",
  approvalMode: "human_signoff_required",
  requestedCapabilities: ["can_use_secrets"],
  allowedSecretScopes: ["github_readonly"]
};

describe("FixtureSecretsAdapter", () => {
  it("issues a lease for a configured scope", async () => {
    const adapter = new FixtureSecretsAdapter([
      {
        scope: "github_readonly",
        environmentVariables: { GITHUB_TOKEN: "ghs_fixture" }
      }
    ]);

    const lease = await adapter.issueTaskSecrets(baseRequest);
    expect(lease?.mode).toBe("scoped_env");
    expect(lease?.secretScopes).toEqual(["github_readonly"]);
    expect(lease?.injectedSecretKeys).toContain("GITHUB_TOKEN");
  });

  it("returns null when no can_use_secrets capability is requested", async () => {
    const adapter = new FixtureSecretsAdapter([
      { scope: "github_readonly", environmentVariables: { GITHUB_TOKEN: "ghs_fixture" } }
    ]);
    const lease = await adapter.issueTaskSecrets({
      ...baseRequest,
      requestedCapabilities: ["can_plan"]
    });
    expect(lease).toBeNull();
  });
});

describe("DenyAllSecretsAdapter", () => {
  it("throws V1MutationDisabledError for requestSecret", async () => {
    const adapter = new DenyAllSecretsAdapter();
    await expect(adapter.requestSecret("GITHUB_TOKEN")).rejects.toBeInstanceOf(
      V1MutationDisabledError
    );
  });

  it("throws V1MutationDisabledError for issueTaskSecrets", async () => {
    const adapter = new DenyAllSecretsAdapter();
    await expect(adapter.issueTaskSecrets(baseRequest)).rejects.toBeInstanceOf(
      V1MutationDisabledError
    );
  });
});

describe("EnvVarSecretsAdapter", () => {
  it("returns null when no scopes are requested", async () => {
    const adapter = new EnvVarSecretsAdapter({ scopes: { test_scope: { KEY: "value" } } });
    const lease = await adapter.issueTaskSecrets({ ...baseRequest, allowedSecretScopes: [] });
    expect(lease).toBeNull();
  });
});

describe("redactSecretValues", () => {
  it("replaces secret values with REDACTED", () => {
    const result = redactSecretValues("token=my-secret-value", {
      environmentVariables: { TOKEN: "my-secret-value" }
    });
    expect(result).toBe("token=***REDACTED***");
  });

  it("returns original value when lease has no env vars", () => {
    const result = redactSecretValues("token=safe-value", { environmentVariables: {} });
    expect(result).toBe("token=safe-value");
  });
});
