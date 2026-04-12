import { afterEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker, CircuitOpenError } from "./circuit-breaker.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("CircuitBreaker", () => {
  it("starts in closed state", () => {
    const cb = new CircuitBreaker({ name: "test" });
    expect(cb.currentState).toBe("closed");
    expect(cb.snapshot().consecutiveFailures).toBe(0);
  });

  it("passes through successful calls in closed state", async () => {
    const cb = new CircuitBreaker({ name: "test" });
    const result = await cb.execute(async () => "ok");
    expect(result).toBe("ok");
    expect(cb.currentState).toBe("closed");
  });

  it("tracks consecutive failures but stays closed below threshold", async () => {
    const cb = new CircuitBreaker({ name: "test", failureThreshold: 3 });

    for (let i = 0; i < 2; i++) {
      await expect(cb.execute(async () => { throw new Error("fail"); })).rejects.toThrow("fail");
    }

    expect(cb.currentState).toBe("closed");
    expect(cb.snapshot().consecutiveFailures).toBe(2);
  });

  it("opens after reaching the failure threshold", async () => {
    const cb = new CircuitBreaker({ name: "test", failureThreshold: 3 });

    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(async () => { throw new Error("fail"); })).rejects.toThrow("fail");
    }

    expect(cb.currentState).toBe("open");
  });

  it("rejects immediately when open", async () => {
    const cb = new CircuitBreaker({ name: "test", failureThreshold: 1 });
    await expect(cb.execute(async () => { throw new Error("fail"); })).rejects.toThrow("fail");

    await expect(cb.execute(async () => "ok")).rejects.toThrow(CircuitOpenError);
    expect(cb.currentState).toBe("open");
  });

  it("transitions to half-open after cooldown", async () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ name: "test", failureThreshold: 1, cooldownMs: 5000 });

    await expect(cb.execute(async () => { throw new Error("fail"); })).rejects.toThrow("fail");
    expect(cb.currentState).toBe("open");

    vi.advanceTimersByTime(5000);
    expect(cb.currentState).toBe("half-open");
  });

  it("closes after a successful probe in half-open state", async () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ name: "test", failureThreshold: 1, cooldownMs: 5000 });

    await expect(cb.execute(async () => { throw new Error("fail"); })).rejects.toThrow("fail");
    vi.advanceTimersByTime(5000);
    expect(cb.currentState).toBe("half-open");

    const result = await cb.execute(async () => "recovered");
    expect(result).toBe("recovered");
    expect(cb.currentState).toBe("closed");
    expect(cb.snapshot().consecutiveFailures).toBe(0);
  });

  it("re-opens after a failed probe in half-open state", async () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ name: "test", failureThreshold: 1, cooldownMs: 5000 });

    await expect(cb.execute(async () => { throw new Error("fail"); })).rejects.toThrow("fail");
    vi.advanceTimersByTime(5000);
    expect(cb.currentState).toBe("half-open");

    await expect(cb.execute(async () => { throw new Error("still broken"); })).rejects.toThrow("still broken");
    expect(cb.currentState).toBe("open");
  });

  it("resets consecutive failures on a success in closed state", async () => {
    const cb = new CircuitBreaker({ name: "test", failureThreshold: 5 });

    // 2 failures then 1 success
    await expect(cb.execute(async () => { throw new Error("fail"); })).rejects.toThrow();
    await expect(cb.execute(async () => { throw new Error("fail"); })).rejects.toThrow();
    await cb.execute(async () => "ok");

    expect(cb.snapshot().consecutiveFailures).toBe(0);
  });

  it("manual reset returns to closed", async () => {
    const cb = new CircuitBreaker({ name: "test", failureThreshold: 1 });
    await expect(cb.execute(async () => { throw new Error("fail"); })).rejects.toThrow();
    expect(cb.currentState).toBe("open");

    cb.reset();
    expect(cb.currentState).toBe("closed");
    expect(cb.snapshot().consecutiveFailures).toBe(0);
  });

  it("snapshot includes name and timestamps", async () => {
    const cb = new CircuitBreaker({ name: "github-api" });
    await cb.execute(async () => "ok");
    const snap = cb.snapshot();

    expect(snap.name).toBe("github-api");
    expect(snap.lastSuccessAt).not.toBeNull();
    expect(snap.lastFailureAt).toBeNull();
  });

  it("CircuitOpenError includes circuit name and remaining cooldown", async () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker({ name: "github-api", failureThreshold: 1, cooldownMs: 60_000 });

    await expect(cb.execute(async () => { throw new Error("fail"); })).rejects.toThrow();
    vi.advanceTimersByTime(10_000); // 10s into 60s cooldown

    try {
      await cb.execute(async () => "ok");
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CircuitOpenError);
      const coe = error as CircuitOpenError;
      expect(coe.circuitName).toBe("github-api");
      expect(coe.remainingCooldownMs).toBeGreaterThan(40_000);
      expect(coe.remainingCooldownMs).toBeLessThanOrEqual(50_000);
    }
  });
});
