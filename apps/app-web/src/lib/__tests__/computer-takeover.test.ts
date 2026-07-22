/**
 * [COMP:app-web/sandbox-takeover] Take-Over input geometry.
 *
 * The live frame renders object-contain, so the <img> box carries letterbox
 * bars whenever the container's aspect ratio differs from the frame's. These
 * pin the click mapping to the fitted content rect — the pre-fix relay mapped
 * linearly across the whole box and landed every click offset.
 */

import { describe, expect, it } from "vitest";
import {
  LOCAL_ONLY_KEYS,
  createFrameGate,
  createWheelForwarder,
  mapClickToFrame,
  normalizeNavigateUrl,
} from "../computer-takeover";

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

  it("wheel forwarder sends the first tick immediately (leading edge), then accumulates per window", async () => {
    const sent: number[] = [];
    const fwd = createWheelForwarder((d) => sent.push(d), 40);
    fwd.add(120);
    expect(sent).toEqual([120]); // no fixed pre-delay before the page moves
    fwd.add(30);
    fwd.add(30);
    expect(sent).toEqual([120]); // in-window deltas accumulate, not spam
    await new Promise((r) => setTimeout(r, 60));
    expect(sent).toEqual([120, 60]); // one relayed scroll per flush window
    fwd.dispose();
  });

  it("wheel forwarder drops a window that nets to zero and resets on dispose", async () => {
    const sent: number[] = [];
    const fwd = createWheelForwarder((d) => sent.push(d), 40);
    fwd.add(80);
    fwd.add(50);
    fwd.add(-50);
    await new Promise((r) => setTimeout(r, 60));
    expect(sent).toEqual([80]); // net-zero accumulation never relays
    fwd.dispose();
    fwd.add(10);
    expect(sent).toEqual([80, 10]); // post-dispose add opens a fresh gesture
    fwd.dispose();
  });
});

describe("[COMP:app-web/sandbox-takeover] Frame commit gate", () => {
  it("holds a frame back until it decodes, so the <img> never swaps to an undecoded src", async () => {
    const committed: string[] = [];
    let finishDecode!: () => void;
    const gate = createFrameGate({
      decode: () =>
        new Promise<void>((resolve) => {
          finishDecode = resolve;
        }),
      commit: (src) => committed.push(src),
    });

    gate.push("frame-1");
    await Promise.resolve();
    expect(committed).toEqual([]); // mid-decode — swapping now is the blank frame

    finishDecode();
    await new Promise((r) => setTimeout(r, 0));
    expect(committed).toEqual(["frame-1"]);

    gate.dispose();
  });

  it("drops a frame whose decode lands after a newer one already committed", async () => {
    const committed: string[] = [];
    const finishers = new Map<string, () => void>();
    const gate = createFrameGate({
      decode: (src) =>
        new Promise<void>((resolve) => {
          finishers.set(src, resolve);
        }),
      commit: (src) => committed.push(src),
    });

    gate.push("frame-1");
    gate.push("frame-2");

    finishers.get("frame-2")!(); // the newer frame wins the decode race
    await new Promise((r) => setTimeout(r, 0));
    expect(committed).toEqual(["frame-2"]);

    finishers.get("frame-1")!(); // the stale decode lands late
    await new Promise((r) => setTimeout(r, 0));
    expect(committed).toEqual(["frame-2"]); // never rewinds to an older picture

    gate.dispose();
  });

  it("releases a frame's object url only once a newer frame has replaced it on screen", async () => {
    const committed: string[] = [];
    const released: string[] = [];
    const gate = createFrameGate({
      decode: () => Promise.resolve(),
      commit: (src) => committed.push(src),
      release: (src) => released.push(src),
    });

    gate.push("blob:1");
    await new Promise((r) => setTimeout(r, 0));
    expect(committed).toEqual(["blob:1"]);
    expect(released).toEqual([]); // blob:1 IS the picture — revoking it blanks the view

    gate.push("blob:2");
    await new Promise((r) => setTimeout(r, 0));
    expect(committed).toEqual(["blob:1", "blob:2"]);
    expect(released).toEqual(["blob:1"]); // only now is it off screen

    gate.dispose();
  });

  it("releases frames that never reach the screen, so the socket path cannot leak urls", async () => {
    const committed: string[] = [];
    const released: string[] = [];
    const finishers = new Map<string, (ok: boolean) => void>();
    const gate = createFrameGate({
      decode: (src) =>
        new Promise<void>((resolve, reject) => {
          finishers.set(src, (ok) => (ok ? resolve() : reject(new Error("corrupt"))));
        }),
      commit: (src) => committed.push(src),
      release: (src) => released.push(src),
    });

    gate.push("blob:stale");
    gate.push("blob:winner");
    finishers.get("blob:winner")!(true);
    await new Promise((r) => setTimeout(r, 0));

    finishers.get("blob:stale")!(true); // decodes late, loses the race
    gate.push("blob:corrupt");
    finishers.get("blob:corrupt")!(false); // never decodes at all
    await new Promise((r) => setTimeout(r, 0));

    expect(committed).toEqual(["blob:winner"]);
    expect(released.sort()).toEqual(["blob:corrupt", "blob:stale"]);

    gate.dispose();
  });

  it("releases the on-screen frame on dispose", async () => {
    const released: string[] = [];
    const gate = createFrameGate({
      decode: () => Promise.resolve(),
      commit: () => {},
      release: (src) => released.push(src),
    });

    gate.push("blob:last");
    await new Promise((r) => setTimeout(r, 0));
    expect(released).toEqual([]);

    gate.dispose();
    expect(released).toEqual(["blob:last"]); // unmount frees the final frame
  });
});

describe("[COMP:app-web/sandbox-takeover] Address-bar URL normalization", () => {
  it("adds https:// to a bare host", () => {
    expect(normalizeNavigateUrl("cathaypacific.com")).toBe("https://cathaypacific.com/");
    expect(normalizeNavigateUrl("example.com/path?q=1")).toBe("https://example.com/path?q=1");
  });

  it("keeps an explicit http(s) scheme", () => {
    expect(normalizeNavigateUrl("http://example.com")).toBe("http://example.com/");
    expect(normalizeNavigateUrl("https://example.com/a")).toBe("https://example.com/a");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeNavigateUrl("  example.com  ")).toBe("https://example.com/");
  });

  it("rejects a non-http(s) scheme so the toolbar never forwards it", () => {
    expect(normalizeNavigateUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeNavigateUrl("chrome://settings")).toBeNull();
    expect(normalizeNavigateUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects empty / whitespace-only input", () => {
    expect(normalizeNavigateUrl("")).toBeNull();
    expect(normalizeNavigateUrl("   ")).toBeNull();
  });
});
