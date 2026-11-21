import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVisibleRecoveryLoop } from "../visible-recovery-loop";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("[COMP:app-web/live-watch-pane] visible recovery loop", () => {
  it("bounds retry frequency and retries failed reads without replaying actions", async () => {
    const recover = vi.fn().mockRejectedValue(new Error("offline"));
    const loop = createVisibleRecoveryLoop({ recover, isVisible: () => true });
    loop.wake(); await flush();
    expect(recover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(recover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(recover).toHaveBeenCalledTimes(2);
    loop.dispose();
  });
  it("coalesces wake signals and never overlaps a slow read", async () => {
    let finish!: () => void;
    const recover = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const loop = createVisibleRecoveryLoop({ recover, isVisible: () => true });
    loop.wake(); loop.wake(); await flush();
    await vi.advanceTimersByTimeAsync(60_000); loop.wake();
    expect(recover).toHaveBeenCalledTimes(1);
    finish(); await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(recover).toHaveBeenCalledTimes(2);
    loop.dispose(); finish(); await flush();
  });
  it("does not poll hidden views and wakes when visible again", async () => {
    let visible = false;
    const recover = vi.fn().mockResolvedValue(undefined);
    const loop = createVisibleRecoveryLoop({ recover, isVisible: () => visible });
    loop.wake(); await vi.advanceTimersByTimeAsync(30_000);
    expect(recover).not.toHaveBeenCalled();
    visible = true; loop.wake(); await flush();
    expect(recover).toHaveBeenCalledTimes(1);
    visible = false; loop.pause(); await vi.advanceTimersByTimeAsync(30_000);
    expect(recover).toHaveBeenCalledTimes(1);
    visible = true; loop.wake(); await flush();
    expect(recover).toHaveBeenCalledTimes(2); loop.dispose();
  });
  it("does not restart after disposal, including completion of an in-flight read", async () => {
    let finish!: () => void;
    const recover = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const loop = createVisibleRecoveryLoop({ recover, isVisible: () => true });
    loop.wake(); await flush(); loop.dispose(); finish(); await flush();
    loop.wake(); await vi.advanceTimersByTimeAsync(30_000);
    expect(recover).toHaveBeenCalledTimes(1);
  });
  it.each(["hidden", "disposed"])("does not start a queued microtask after becoming %s", async mode => {
    let visible = true;
    const recover = vi.fn().mockResolvedValue(undefined);
    const loop = createVisibleRecoveryLoop({ recover, isVisible: () => visible });
    loop.wake();
    if (mode === "hidden") { visible = false; loop.pause(); }
    else loop.dispose();
    await flush(); await vi.advanceTimersByTimeAsync(30_000);
    expect(recover).not.toHaveBeenCalled(); loop.dispose();
  });
  it("enforces a minimum interval even for invalid caller timing", async () => {
    const recover = vi.fn().mockResolvedValue(undefined);
    const loop = createVisibleRecoveryLoop({ recover, isVisible: () => true, intervalMs: -1 });
    loop.wake(); await flush(); await vi.advanceTimersByTimeAsync(999);
    expect(recover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(recover).toHaveBeenCalledTimes(2); loop.dispose();
  });
});
