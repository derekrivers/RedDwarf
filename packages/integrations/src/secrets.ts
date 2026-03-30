import { asIsoTimestamp, type ApprovalMode, type Capability, type RiskClass } from "@reddwarf/contracts";
import { V1MutationDisabledError } from "./errors.js";

export interface SecretLeaseRequest {
  taskId: string;
  repo: string;
  agentType: string;
  phase: string;
  environment: string;
  riskClass: RiskClass;
  approvalMode: ApprovalMode;
  requestedCapabilities: Capability[];
  allowedSecretScopes: string[];
}

export interface SecretLease {
  leaseId: string;
  mode: "scoped_env";
  secretScopes: string[];
  injectedSecretKeys: string[];
  environmentVariables: Record<string, string>;
  issuedAt: string;
  expiresAt: string | null;
  notes: string[];
}

export interface FixtureSecretScope {
  scope: string;
  environmentVariables: Record<string, string>;
  allowedAgents?: string[];
  allowedEnvironments?: string[];
  denyHighRisk?: boolean;
  notes?: string[];
}

export interface SecretsAdapter {
  requestSecret(name: string): Promise<string>;
  issueTaskSecrets(request: SecretLeaseRequest): Promise<SecretLease | null>;
}

export interface EnvVarSecretsAdapterOptions {
  /**
   * Prefix for environment variable names. Defaults to "REDDWARF_SECRET_".
   * A secret named "db_password" with the default prefix would be read from
   * the environment variable REDDWARF_SECRET_DB_PASSWORD.
   */
  prefix?: string;
  /**
   * Explicit map of scope name → environment variables for that scope.
   * When provided, issueTaskSecrets only injects variables for scopes
   * listed here. Unrecognised scopes are silently skipped.
   */
  scopes?: Record<string, Record<string, string>>;
}

export class FixtureSecretsAdapter implements SecretsAdapter {
  private readonly scopes: Map<string, FixtureSecretScope>;

  constructor(scopes: FixtureSecretScope[]) {
    this.scopes = new Map(scopes.map((scope) => [scope.scope, scope]));
  }

  async requestSecret(name: string): Promise<string> {
    for (const scope of this.scopes.values()) {
      const value = scope.environmentVariables[name];

      if (value !== undefined) {
        return value;
      }
    }

    throw new Error(`No fixture secret named ${name} is configured.`);
  }

  async issueTaskSecrets(request: SecretLeaseRequest): Promise<SecretLease | null> {
    if (
      request.allowedSecretScopes.length === 0 ||
      !request.requestedCapabilities.includes("can_use_secrets")
    ) {
      return null;
    }

    const issuedScopes: string[] = [];
    const injectedSecretKeys = new Set<string>();
    const environmentVariables: Record<string, string> = {};
    const notes: string[] = [];

    for (const scopeName of request.allowedSecretScopes) {
      const scope = this.scopes.get(scopeName);

      if (!scope) {
        throw new Error(`No fixture secret scope ${scopeName} is configured.`);
      }

      if (scope.denyHighRisk !== false && request.riskClass === "high") {
        throw new Error(`Secret scope ${scopeName} is denied for high-risk tasks.`);
      }

      if (
        scope.allowedAgents &&
        scope.allowedAgents.length > 0 &&
        !scope.allowedAgents.includes(request.agentType)
      ) {
        throw new Error(`Secret scope ${scopeName} is not allowed for agent ${request.agentType}.`);
      }

      if (
        scope.allowedEnvironments &&
        scope.allowedEnvironments.length > 0 &&
        !scope.allowedEnvironments.includes(request.environment)
      ) {
        throw new Error(`Secret scope ${scopeName} is not allowed in environment ${request.environment}.`);
      }

      issuedScopes.push(scopeName);
      for (const [key, value] of Object.entries(scope.environmentVariables)) {
        environmentVariables[key] = value;
        injectedSecretKeys.add(key);
      }
      if (scope.notes) {
        notes.push(...scope.notes);
      }
    }

    return {
      leaseId: `${request.taskId}:${request.agentType}:${issuedScopes.join("+")}`,
      mode: "scoped_env",
      secretScopes: issuedScopes,
      injectedSecretKeys: [...injectedSecretKeys].sort(),
      environmentVariables,
      issuedAt: asIsoTimestamp(),
      expiresAt: null,
      notes: [
        `Scoped credentials issued for ${request.agentType} during ${request.phase}.`,
        ...notes
      ]
    };
  }
}

export class DenyAllSecretsAdapter implements SecretsAdapter {
  async requestSecret(name: string): Promise<never> {
    throw new V1MutationDisabledError(`Secret access for ${name}`);
  }

  async issueTaskSecrets(request: SecretLeaseRequest): Promise<never> {
    const scopes =
      request.allowedSecretScopes.length > 0
        ? ` scoped to ${request.allowedSecretScopes.join(", ")}`
        : "";
    throw new V1MutationDisabledError(`Secret access for ${request.taskId}${scopes}`);
  }
}

/**
 * A concrete SecretsAdapter implementation that reads secret values from
 * environment variables. Suitable for local development and CI environments
 * where secrets are injected as env vars rather than a dedicated vault.
 *
 * For production workloads, replace this adapter with a vault-backed
 * implementation that implements the same SecretsAdapter interface.
 */
export class EnvVarSecretsAdapter implements SecretsAdapter {
  private readonly prefix: string;
  private readonly scopeMap: Map<string, Record<string, string>>;

  constructor(options: EnvVarSecretsAdapterOptions = {}) {
    this.prefix = options.prefix ?? "REDDWARF_SECRET_";
    this.scopeMap = new Map(
      options.scopes !== undefined ? Object.entries(options.scopes) : []
    );
  }

  async requestSecret(name: string): Promise<string> {
    const envKey = `${this.prefix}${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
    const value = process.env[envKey];
    if (value === undefined) {
      throw new Error(
        `EnvVarSecretsAdapter: no environment variable "${envKey}" found for secret "${name}".`
      );
    }
    return value;
  }

  async issueTaskSecrets(request: SecretLeaseRequest): Promise<SecretLease | null> {
    if (
      request.allowedSecretScopes.length === 0 ||
      !request.requestedCapabilities.includes("can_use_secrets")
    ) {
      return null;
    }

    const issuedScopes: string[] = [];
    const injectedKeys = new Set<string>();
    const environmentVariables: Record<string, string> = {};
    const notes: string[] = [];

    for (const scopeName of request.allowedSecretScopes) {
      const scopeVars = this.resolveScope(scopeName, request);

      if (scopeVars === null) {
        continue;
      }

      issuedScopes.push(scopeName);
      for (const [key, value] of Object.entries(scopeVars)) {
        environmentVariables[key] = value;
        injectedKeys.add(key);
      }
      notes.push(`Scope "${scopeName}" injected from environment variables.`);
    }

    if (issuedScopes.length === 0) {
      return null;
    }

    return {
      leaseId: `${request.taskId}:${request.agentType}:${issuedScopes.join("+")}`,
      mode: "scoped_env",
      secretScopes: issuedScopes,
      injectedSecretKeys: [...injectedKeys].sort(),
      environmentVariables,
      issuedAt: asIsoTimestamp(),
      expiresAt: null,
      notes: [
        `Env-var-backed credentials issued for ${request.agentType} during ${request.phase}.`,
        ...notes
      ]
    };
  }

  private resolveScope(
    scopeName: string,
    request: SecretLeaseRequest
  ): Record<string, string> | null {
    if (request.riskClass === "high") {
      throw new Error(
        `EnvVarSecretsAdapter: scope "${scopeName}" is denied for high-risk tasks.`
      );
    }

    if (this.scopeMap.size > 0) {
      const explicit = this.scopeMap.get(scopeName);
      return explicit ?? null;
    }

    // When no explicit scope map is provided, read all env vars whose names
    // start with the scope prefix: REDDWARF_SECRET_{SCOPE}_{KEY}.
    const scopePrefix = `${this.prefix}${scopeName.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_`;
    const collected: Record<string, string> = {};
    for (const [envKey, envValue] of Object.entries(process.env)) {
      if (envKey.startsWith(scopePrefix) && envValue !== undefined) {
        const secretKey = envKey.slice(scopePrefix.length);
        if (secretKey.length > 0) {
          collected[secretKey] = envValue;
        }
      }
    }
    return Object.keys(collected).length > 0 ? collected : null;
  }
}

/**
 * Create an EnvVarSecretsAdapter from optional configuration.
 */
export function createEnvVarSecretsAdapter(
  options: EnvVarSecretsAdapterOptions = {}
): EnvVarSecretsAdapter {
  return new EnvVarSecretsAdapter(options);
}

export function redactSecretValues(
  value: string,
  lease: Pick<SecretLease, "environmentVariables">
): string {
  const secretValues = Object.values(lease.environmentVariables).filter(
    (secretValue) => secretValue.length > 0
  );

  if (secretValues.length === 0) {
    return value;
  }

  // Use iterative string replacement instead of regex alternation to avoid
  // ReDoS risk from secret values that share common prefixes or suffixes.
  // Replace longest values first so shorter substrings don't mask longer matches.
  const sorted = [...secretValues].sort((a, b) => b.length - a.length);
  let result = value;
  for (const secret of sorted) {
    result = result.split(secret).join("***REDACTED***");
  }
  return result;
}
