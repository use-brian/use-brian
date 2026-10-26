import { describe, expect, it, vi } from "vitest";
import {
  captureSourceSnapshot,
  CapturePreparations,
  isTrustedCaptureOrigin,
  parseDisplayCaptureIntent,
  resolveDisplayCapture,
  screenCaptureDisabledFeatures,
  selectPrimaryDisplaySource,
} from "../system-audio-policy.js";

describe("[COMP:app-desktop/system-audio] Media capture policy", () => {
  it("bounds the tested entire-screen backend workaround to its affected runtime", () => {
    expect(screenCaptureDisabledFeatures("darwin", "25.6.0", "43.2.0")).toEqual(["ScreenCaptureKitMacScreen"]);
    for (const [platform, release, electron] of [
      ["win32", "25.6.0", "43.2.0"], ["darwin", "24.6.0", "43.2.0"],
      ["darwin", "26.0.0", "43.2.0"], ["darwin", "25.6.0", "43.2.1"],
    ]) expect(screenCaptureDisabledFeatures(platform, release, electron)).toEqual([]);
  });

  it("retains deterministic primary-display grants for legacy renderers", async () => {
    const sources = [{ id: "screen:2:0", display_id: "2" }, { id: "screen:1:0", display_id: "1" }];
    const getSources = vi.fn(async () => sources);
    await expect(resolveDisplayCapture({
      intent: { kind: "legacy", sourceId: null }, frame: {}, getSources, primaryDisplayId: 1,
    })).resolves.toEqual({ video: sources[1], audio: "loopback" });
    expect(getSources).toHaveBeenCalledWith(["screen"]);
  });

  it("keeps audio-only loopback independent of physical display startup", async () => {
    const frame = { id: "trusted-app-frame" };
    const getSources = vi.fn(async () => { throw new Error("physical display timed out"); });
    await expect(resolveDisplayCapture({
      intent: { kind: "audio", includeSystemAudio: true }, frame, getSources, primaryDisplayId: 1,
    })).resolves.toEqual({ video: frame, audio: "loopback" });
    expect(getSources).not.toHaveBeenCalled();
  });

  it("grants only the selected video source and honors its audio choice", async () => {
    const sources = [{ id: "window:7:0", display_id: "1" }];
    const getSources = vi.fn(async () => sources);
    const intent = { kind: "window" as const, sourceId: "window:7:0", includeSystemAudio: false };
    await expect(resolveDisplayCapture({ intent, frame: {}, getSources, primaryDisplayId: 1 }))
      .resolves.toEqual({ video: sources[0] });
    expect(getSources).toHaveBeenCalledWith(["window"]);
    await expect(resolveDisplayCapture({
      intent: { ...intent, sourceId: "window:gone:0" }, frame: {}, getSources, primaryDisplayId: 1,
    })).rejects.toThrow("selected capture source is unavailable");
  });

  it("consumes preparation once and refuses reuse after navigation", () => {
    const preparations = new CapturePreparations<object>();
    const frame = {};
    const intent = { kind: "audio" as const, includeSystemAudio: true as const };
    expect(preparations.take(1, frame)).toEqual({ kind: "legacy" });
    preparations.prepare(1, frame, intent);
    expect(preparations.take(2, frame)).toEqual({ kind: "legacy" });
    expect(preparations.take(1, frame)).toEqual({ kind: "prepared", intent });
    expect(preparations.take(1, frame)).toEqual({ kind: "denied" });
    preparations.prepare(1, frame, intent);
    expect(preparations.take(1, {})).toEqual({ kind: "denied" });
    preparations.clear();
    expect(preparations.take(1, frame)).toEqual({ kind: "legacy" });
  });

  it("rejects malformed or mismatched source intents", () => {
    expect(parseDisplayCaptureIntent({ kind: "audio", includeSystemAudio: true }))
      .toEqual({ kind: "audio", includeSystemAudio: true });
    for (const input of [null, {}, { kind: "audio", includeSystemAudio: false },
      { kind: "window", sourceId: "screen:1:0", includeSystemAudio: true },
      { kind: "screen", sourceId: "screen:1:0" }]) {
      expect(() => parseDisplayCaptureIntent(input)).toThrow("Invalid capture intent");
    }
  });

  it("grants only the configured app origin", () => {
    expect(
      isTrustedCaptureOrigin(
        "https://app.usebrian.ai",
        "https://app.usebrian.ai",
        false,
      ),
    ).toBe(true);
    expect(
      isTrustedCaptureOrigin(
        "https://app.usebrian.ai.evil.example",
        "https://app.usebrian.ai",
        false,
      ),
    ).toBe(false);
    expect(
      isTrustedCaptureOrigin(
        "https://other.example",
        "https://app.usebrian.ai",
        false,
      ),
    ).toBe(false);
  });

  it("allows file capture origins only while the bundled renderer is active", () => {
    expect(isTrustedCaptureOrigin("file://", "https://app.usebrian.ai", true)).toBe(true);
    expect(
      isTrustedCaptureOrigin(
        "file:///Applications/Use%20Brian.app/Contents/Resources/app.asar/renderer/index.html?api=https%3A%2F%2Fapi.usebrian.ai",
        "https://app.usebrian.ai",
        true,
      ),
    ).toBe(true);
    expect(isTrustedCaptureOrigin("file://", "https://app.usebrian.ai", false)).toBe(false);
    expect(
      isTrustedCaptureOrigin(
        "file:///Applications/Use%20Brian.app/Contents/Resources/app.asar/renderer/index.html",
        "https://app.usebrian.ai",
        false,
      ),
    ).toBe(false);
  });

  it("selects the primary display and falls back deterministically", () => {
    const sources = [
      { display_id: "20", name: "secondary" },
      { display_id: "10", name: "primary" },
    ];
    expect(selectPrimaryDisplaySource(sources, 10)?.name).toBe("primary");
    expect(selectPrimaryDisplaySource(sources, 999)?.name).toBe("secondary");
    expect(selectPrimaryDisplaySource([], 10)).toBeUndefined();
  });

  it("serializes a static source preview and preserves an honest empty fallback", () => {
    const toDataURL = () => "data:image/png;base64,preview";
    expect(captureSourceSnapshot({
      id: "screen:1",
      name: "Built-in Display",
      thumbnail: { isEmpty: () => false, toDataURL },
    })).toEqual({
      id: "screen:1",
      name: "Built-in Display",
      thumbnailDataUrl: "data:image/png;base64,preview",
    });
    expect(captureSourceSnapshot({
      id: "window:1",
      name: "Protected Window",
      thumbnail: { isEmpty: () => true, toDataURL },
    })).toEqual({
      id: "window:1",
      name: "Protected Window",
      thumbnailDataUrl: null,
    });
  });
});
