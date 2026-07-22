import { describe, expect, it } from "vitest";
import {
  CAPTURE_AUTO_STOP_MS,
  CAPTURE_FORK_MS,
  HOLD_LATCH_MS,
  MIN_CAPTURE_MS,
  PAUSE_AUTO_STOP_MS,
  captureFileName,
  captureLabelLane,
  extensionForMime,
  formatElapsed,
  pickRecorderMime,
  resolveRelease,
  shouldAutoStop,
  stopLane,
} from "../recorder-gesture";
import { RECORDING_AUDIO_MIN_DURATION_SEC } from "@/lib/use-file-attachments";

describe("[COMP:app-web/recorder-gesture] Live-capture gesture + fork", () => {
  it("one threshold constant: the fork mirrors the dropped-file fork exactly", () => {
    expect(CAPTURE_FORK_MS).toBe(RECORDING_AUDIO_MIN_DURATION_SEC * 1000);
  });

  it("a quick tap latches; a long hold is walkie-talkie", () => {
    expect(resolveRelease(0)).toBe("latch");
    expect(resolveRelease(HOLD_LATCH_MS - 1)).toBe("latch");
    expect(resolveRelease(HOLD_LATCH_MS)).toBe("stop");
    expect(resolveRelease(5_000)).toBe("stop");
  });

  it("stop fork: discard floor, then voice, then recording at the threshold", () => {
    expect(stopLane(0)).toBe("discard");
    expect(stopLane(MIN_CAPTURE_MS - 1)).toBe("discard");
    expect(stopLane(MIN_CAPTURE_MS)).toBe("voice");
    expect(stopLane(CAPTURE_FORK_MS - 1)).toBe("voice");
    expect(stopLane(CAPTURE_FORK_MS)).toBe("recording");
    expect(stopLane(90 * 60_000)).toBe("recording");
  });

  it("the hard limit is 2 hours per capture, safely under the server's 180-minute ceiling", () => {
    // 2h is the PRODUCT hard limit (founder, 2026-07-22). The server margin
    // is separately load-bearing: a capture that crossed the transcription
    // ceiling (RECORDING_DURATION_CEILING_MINUTES = 180, api-platform
    // credit-usage) can NEVER pass the estimate — Save retries into
    // too_long forever. The 30s check interval's worst-case overshoot must
    // still land under it.
    expect(CAPTURE_AUTO_STOP_MS).toBe(120 * 60_000);
    const serverCeilingMs = 180 * 60_000;
    expect(CAPTURE_AUTO_STOP_MS + 30_000).toBeLessThan(serverCeilingMs);
    expect(shouldAutoStop(CAPTURE_AUTO_STOP_MS - 1)).toBe(false);
    expect(shouldAutoStop(CAPTURE_AUTO_STOP_MS)).toBe(true);
    // The pause cap must outlast any deliberate mid-session break (pause
    // exists for exactly that) yet stay finite so a paused-and-forgotten
    // capture cannot hold the mic stream forever.
    expect(PAUSE_AUTO_STOP_MS).toBeGreaterThanOrEqual(30 * 60_000);
    expect(PAUSE_AUTO_STOP_MS).toBeLessThanOrEqual(2 * 60 * 60_000);
  });

  it("the pill label telegraphs the fork before it happens", () => {
    expect(captureLabelLane(0)).toBe("voice");
    expect(captureLabelLane(CAPTURE_FORK_MS - 1)).toBe("voice");
    expect(captureLabelLane(CAPTURE_FORK_MS)).toBe("recording");
  });

  it("mime ladder prefers opus-in-webm, falls to mp4, then browser default", () => {
    expect(pickRecorderMime(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickRecorderMime((m) => m === "audio/mp4")).toBe("audio/mp4");
    expect(pickRecorderMime(() => false)).toBe("");
  });

  it("file naming: localized prefix + capture moment + container extension", () => {
    const now = new Date(2026, 6, 22, 14, 5); // 2026-07-22 14:05 local
    expect(captureFileName("Recording", now, "audio/webm;codecs=opus")).toBe(
      "Recording 2026-07-22 14.05.webm",
    );
    expect(captureFileName("録音", now, "audio/mp4")).toBe("録音 2026-07-22 14.05.m4a");
    expect(extensionForMime("audio/ogg")).toBe("ogg");
    expect(extensionForMime("application/octet-stream")).toBe("webm");
  });

  it("elapsed readout: M:SS under an hour, H:MM:SS past it", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(59_400)).toBe("0:59");
    expect(formatElapsed(61_000)).toBe("1:01");
    expect(formatElapsed(3_600_000)).toBe("1:00:00");
    expect(formatElapsed(5_025_000)).toBe("1:23:45");
  });
});
