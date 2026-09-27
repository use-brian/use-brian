import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTakeoverPoller } from "../computer-takeover";

describe("[COMP:app-web/sandbox-takeover] adaptive API polling", () => {
  const clocks: ReturnType<typeof createTakeoverPoller>[] = [];
  function setup(poll = vi.fn(async (_signal: AbortSignal) => {}), hidden = () => false) {
    const clock = createTakeoverPoller({ poll, hidden });
    clocks.push(clock);
    return { clock, poll };
  }
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { clocks.splice(0).forEach(c => c.dispose()); vi.useRealTimers(); });

  it("starts immediately, idles at 1200ms, refreshes on delivery and returns from burst to idle", async () => {
    const { clock, poll } = setup();
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(1);
    clock.inputDelivered();
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(179);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1980); // first frame after burst expires
    const count = poll.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1199);
    expect(poll).toHaveBeenCalledTimes(count);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(count + 1);
  });

  it("coalesces input during a slow request into one immediate follow-up, without overlap", async () => {
    let finish!: () => void;
    const poll = vi.fn((_signal: AbortSignal) => new Promise<void>(resolve => { finish = resolve; }));
    const { clock } = setup(poll);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 20; i++) clock.inputDelivered();
    await vi.advanceTimersByTimeAsync(500);
    expect(poll).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(poll).toHaveBeenCalledTimes(2);
    clock.dispose();
    finish();
  });

  it("bounds continuous deliveries and extends the burst from the last delivery", async () => {
    const { clock, poll } = setup();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 100; i++) {
      clock.inputDelivered();
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(poll.mock.calls.length).toBeLessThanOrEqual(12);
    const count = poll.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll.mock.calls.length).toBeGreaterThan(count + 4);
  });

  it("backs off hidden tabs, ignores hidden input, and refreshes on visibility return", async () => {
    let hidden = true;
    const { clock, poll } = setup(undefined, () => hidden);
    clock.inputDelivered();
    await vi.advanceTimersByTimeAsync(4999);
    expect(poll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    hidden = false;
    clock.visibilityChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(2);
    clock.inputDelivered();
    hidden = true;
    clock.visibilityChanged();
    await vi.advanceTimersByTimeAsync(4999);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it("aborts in-flight work and cannot restart from late completion, delivery or visibility", async () => {
    let finish!: () => void;
    const poll = vi.fn((_signal: AbortSignal) => new Promise<void>(resolve => { finish = resolve; }));
    const { clock } = setup(poll);
    await vi.advanceTimersByTimeAsync(0);
    clock.inputDelivered();
    clock.dispose();
    expect(poll.mock.calls[0][0].aborted).toBe(true);
    finish();
    clock.inputDelivered();
    clock.visibilityChanged();
    await vi.advanceTimersByTimeAsync(10000);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers from errors while a separate metadata clock remains slow during bursts", async () => {
    const frames = setup(vi.fn(async (_signal: AbortSignal) => { throw new Error("offline"); }));
    const metadata = setup();
    await vi.advanceTimersByTimeAsync(0);
    frames.clock.inputDelivered();
    await vi.advanceTimersByTimeAsync(1200);
    expect(frames.poll.mock.calls.length).toBeGreaterThan(5);
    expect(metadata.poll).toHaveBeenCalledTimes(2);
  });
});
