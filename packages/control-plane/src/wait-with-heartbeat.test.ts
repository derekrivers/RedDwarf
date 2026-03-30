import { describe, expect, it, vi } from "vitest";
import { waitWithHeartbeat } from "./pipeline.js";

describe("waitWithHeartbeat", () => {
  it("returns work result when no heartbeat handler provided", async () => {
    const result = await waitWithHeartbeat({ work: Promise.resolve(42) });
    expect(result).toBe(42);
  });

  it("returns work result when heartbeat never fires", async () => {
    const onHeartbeat = vi.fn().mockResolvedValue(undefined);
    const result = await waitWithHeartbeat({
      work: Promise.resolve("done"),
      heartbeatIntervalMs: 100_000,
      onHeartbeat
    });
    expect(result).toBe("done");
    expect(onHeartbeat).not.toHaveBeenCalled();
  });

  it("throws work error when work rejects", async () => {
    const workError = new Error("work failed");
    await expect(
      waitWithHeartbeat({
        work: Promise.reject(workError),
        heartbeatIntervalMs: 100_000,
        onHeartbeat: vi.fn().mockResolvedValue(undefined)
      })
    ).rejects.toBe(workError);
  });

  it("throwing onHeartbeat does not prevent the work result from being returned", async () => {
    const onHeartbeatError = vi.fn();
    // heartbeatIntervalMs=0 causes heartbeat to fire before a slow-resolving work
    let resolveWork!: (value: string) => void;
    const work = new Promise<string>((resolve) => {
      resolveWork = resolve;
    });

    const heartbeatError = new Error("db write failed");
    const onHeartbeat = vi.fn().mockRejectedValue(heartbeatError);

    const resultPromise = waitWithHeartbeat({
      work,
      heartbeatIntervalMs: 0,
      onHeartbeat,
      onHeartbeatError
    });

    // Let the event loop run so heartbeat fires
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onHeartbeatError).toHaveBeenCalledWith(heartbeatError);

    // Now resolve the work — must still succeed
    resolveWork("success");
    const result = await resultPromise;
    expect(result).toBe("success");
  });

  it("repeated heartbeat failures are reported via onHeartbeatError callback", async () => {
    const onHeartbeatError = vi.fn();
    let resolveWork!: (value: number) => void;
    const work = new Promise<number>((resolve) => {
      resolveWork = resolve;
    });

    const heartbeatError = new Error("transient");
    const onHeartbeat = vi.fn().mockRejectedValue(heartbeatError);

    const resultPromise = waitWithHeartbeat({
      work,
      heartbeatIntervalMs: 0,
      onHeartbeat,
      onHeartbeatError
    });

    // Let multiple heartbeat cycles fire
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onHeartbeatError.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [err] of onHeartbeatError.mock.calls) {
      expect(err).toBe(heartbeatError);
    }

    resolveWork(99);
    await expect(resultPromise).resolves.toBe(99);
  });

  it("work error still throws even when onHeartbeat also fails", async () => {
    const onHeartbeatError = vi.fn();
    const workError = new Error("work error");
    const heartbeatError = new Error("heartbeat error");

    let rejectWork!: (err: unknown) => void;
    const work = new Promise<never>((_resolve, reject) => {
      rejectWork = reject;
    });

    const resultPromise = waitWithHeartbeat({
      work,
      heartbeatIntervalMs: 0,
      onHeartbeat: vi.fn().mockRejectedValue(heartbeatError),
      onHeartbeatError
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    rejectWork(workError);
    await expect(resultPromise).rejects.toBe(workError);
  });
});
