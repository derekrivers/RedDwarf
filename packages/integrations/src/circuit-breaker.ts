/**
 * A simple circuit breaker implementation (closed → open → half-open → closed).
 *
 * - **Closed**: Requests pass through. Consecutive failures are tracked.
 * - **Open**: Requests are rejected immediately with a CircuitOpenError.
 *   Transitions to half-open after `cooldownMs`.
 * - **Half-open**: A single probe request is allowed through. Success resets
 *   to closed; failure re-opens the circuit.
 *
 * Thread-safety: single-threaded (Node.js event loop), no mutex required.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Human-readable name for logging / health reports. */
  name: string;
  /** Number of consecutive failures before the circuit opens. Default: 5. */
  failureThreshold?: number;
  /** Milliseconds the circuit stays open before transitioning to half-open. Default: 60_000. */
  cooldownMs?: number;
}

export interface CircuitBreakerSnapshot {
  name: string;
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
}

export class CircuitOpenError extends Error {
  constructor(
    public readonly circuitName: string,
    public readonly remainingCooldownMs: number
  ) {
    super(
      `Circuit breaker "${circuitName}" is open. ` +
        `Remaining cooldown: ${Math.ceil(remainingCooldownMs / 1000)}s.`
    );
    this.name = "CircuitOpenError";
  }
}

// ── Implementation ───────────────────────────────────────────────────────────

export class CircuitBreaker {
  readonly name: string;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private lastFailureAt: Date | null = null;
  private lastSuccessAt: Date | null = null;
  private openedAt: Date | null = null;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 60_000;
  }

  /** Execute `fn` through the circuit breaker. */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.evaluateState();

    if (this.state === "open") {
      const elapsed = Date.now() - (this.openedAt?.getTime() ?? Date.now());
      throw new CircuitOpenError(this.name, Math.max(0, this.cooldownMs - elapsed));
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /** Current snapshot for health reporting. */
  snapshot(): CircuitBreakerSnapshot {
    this.evaluateState();
    return {
      name: this.name,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastFailureAt: this.lastFailureAt?.toISOString() ?? null,
      lastSuccessAt: this.lastSuccessAt?.toISOString() ?? null
    };
  }

  /** Current state (evaluates potential half-open transition). */
  get currentState(): CircuitState {
    this.evaluateState();
    return this.state;
  }

  /** Manually reset to closed (e.g. after operator intervention). */
  reset(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private evaluateState(): void {
    if (this.state === "open" && this.openedAt !== null) {
      const elapsed = Date.now() - this.openedAt.getTime();
      if (elapsed >= this.cooldownMs) {
        this.state = "half-open";
      }
    }
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.lastSuccessAt = new Date();
    if (this.state === "half-open") {
      this.state = "closed";
      this.openedAt = null;
    }
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureAt = new Date();
    if (
      this.state === "half-open" ||
      this.consecutiveFailures >= this.failureThreshold
    ) {
      this.state = "open";
      this.openedAt = new Date();
    }
  }
}
