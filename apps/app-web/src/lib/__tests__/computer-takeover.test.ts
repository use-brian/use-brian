/**
 * [COMP:app-web/sandbox-takeover] Take-Over input geometry.
 *
 * The live frame renders object-contain, so the <img> box carries letterbox
 * bars whenever the container's aspect ratio differs from the frame's. These
 * pin the click mapping to the fitted content rect — the pre-fix relay mapped
 * linearly across the whole box and landed every click offset.
 */

import { describe, expect, it } from "vitest";
import { LOCAL_ONLY_KEYS, mapClickToFrame } from "../computer-takeover";

describe("[COMP:app-web/sandbox-takeover] Take-Over click mapping", () => {
  it("maps 1:1 when the box matches the frame aspect", () => {
    const rect = { left: 0, top: 0, width: 1280, height: 720 };
    expect(mapClickToFrame(rect, { w: 1280, h: 720 }, 100, 50)).toEqual({ x: 100, y: 50 });
  });

  it("scales through a shrunken box", () => {
    const rect = { left: 0, top: 0, width: 640, height: 360 };
    expect(mapClickToFrame(rect, { w: 1280, h: 720 }, 320, 180)).toEqual({ x: 640, y: 360 });
  });

  it("subtracts the letterbox offset in a too-tall box (the live-view shape)", () => {
    // 1000x500 frame centered in a 1000x1000 box: 250px bars above and below.
    const rect = { left: 0, top: 0, width: 1000, height: 1000 };
    const natural = { w: 1000, h: 500 };
    expect(mapClickToFrame(rect, natural, 500, 500)).toEqual({ x: 500, y: 250 });
    expect(mapClickToFrame(rect, natural, 500, 250)).toEqual({ x: 500, y: 0 });
  });

  it("returns null for clicks in the bars (nothing under them in the frame)", () => {
    const rect = { left: 0, top: 0, width: 1000, height: 1000 };
    const natural = { w: 1000, h: 500 };
    expect(mapClickToFrame(rect, natural, 500, 100)).toBeNull();
    expect(mapClickToFrame(rect, natural, 500, 900)).toBeNull();
  });

  it("accounts for the box's own page position", () => {
    const rect = { left: 40, top: 60, width: 1280, height: 720 };
    expect(mapClickToFrame(rect, { w: 1280, h: 720 }, 140, 160)).toEqual({ x: 100, y: 100 });
  });

  it("never relays standalone modifier or IME keys", () => {
    for (const key of ["Shift", "Control", "Alt", "Meta", "Dead", "Process"]) {
      expect(LOCAL_ONLY_KEYS.has(key)).toBe(true);
    }
    expect(LOCAL_ONLY_KEYS.has("Enter")).toBe(false);
    expect(LOCAL_ONLY_KEYS.has("a")).toBe(false);
  });
});
