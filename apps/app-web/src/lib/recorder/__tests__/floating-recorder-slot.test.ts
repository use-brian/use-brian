// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  claimFloatingRecorder,
  floatingRecorderLift,
  getFloatingRecorderClearances,
  isFloatingRecorderClaimed,
  registerFloatingRecorderClearance,
  resetFloatingRecorderSlotForTest,
  FLOATING_RECORDER_REST_PX,
  floatingRecorderReserve,
} from "../floating-recorder-slot";

const viewport = { width: 1280, height: 800 };
const rect = (r: Partial<{ top: number; bottom: number; right: number; width: number; height: number }>) => ({
  top: 0,
  bottom: 0,
  right: 0,
  width: 100,
  height: 100,
  ...r,
});

afterEach(() => resetFloatingRecorderSlotForTest());

describe("[COMP:app-web/dock-recorder] floating recorder slot", () => {
  it("lifts above a composer docked in the bottom-right corner", () => {
    expect(floatingRecorderLift(rect({ top: 680, bottom: 790, right: 1270 }), viewport)).toBe(128);
  });

  it("stays at rest when the composer leaves the corner clear", () => {
    // Centered composer, right edge far from the button.
    expect(floatingRecorderLift(rect({ top: 680, bottom: 790, right: 1000 }), viewport)).toBeNull();
    // Mid-screen composer (the new-chat hero).
    expect(floatingRecorderLift(rect({ top: 300, bottom: 420, right: 1270 }), viewport)).toBeNull();
    // Hidden composer (collapsed rail, inactive thread) measures as zero.
    expect(floatingRecorderLift(rect({ width: 0, height: 0 }), viewport)).toBeNull();
  });

  it("never lifts below the resting offset", () => {
    expect(floatingRecorderLift(rect({ top: 799, bottom: 800, right: 1280 }), viewport)).toBe(
      FLOATING_RECORDER_REST_PX,
    );
  });

  it("reserves room under the newest message only while lifted and shown", () => {
    expect(floatingRecorderReserve(128, 40)).toBe(48);
    expect(floatingRecorderReserve(128, 39.5)).toBe(48);
    // At rest in the corner: nothing to clear.
    expect(floatingRecorderReserve(null, 40)).toBe(0);
    // Below `lg` the cluster is display:none and measures 0.
    expect(floatingRecorderReserve(128, 0)).toBe(0);
  });

  it("claims are counted and release idempotently", () => {
    expect(isFloatingRecorderClaimed()).toBe(false);
    const a = claimFloatingRecorder();
    const b = claimFloatingRecorder();
    expect(isFloatingRecorderClaimed()).toBe(true);
    a();
    a();
    expect(isFloatingRecorderClaimed()).toBe(true);
    b();
    expect(isFloatingRecorderClaimed()).toBe(false);
  });

  it("tracks registered clearances", () => {
    const el = document.createElement("div");
    const release = registerFloatingRecorderClearance(el);
    expect(getFloatingRecorderClearances()).toEqual([el]);
    release();
    expect(getFloatingRecorderClearances()).toEqual([]);
  });
});
