import { describe, expect, it } from "vitest";
import {
  WAVE_SAMPLES,
  isRecorderCommand,
  isRecorderState,
  pushWaveSample,
  recorderStateMessage,
} from "../recorder-broadcast";

describe("[COMP:app-web/dock-recorder] Recorder broadcast contract", () => {
  it("round-trips a state message through its guard", () => {
    const msg = recorderStateMessage(true, false, 65_000, 0.4);
    expect(isRecorderState(msg)).toBe(true);
    expect(msg).toEqual({ type: "state", capturing: true, paused: false, elapsedMs: 65_000, level: 0.4 });
  });

  it("guards reject malformed cross-channel messages instead of crashing the recorder", () => {
    for (const bad of [null, undefined, 42, "stop", {}, { type: "state" }, { type: "command" }, { type: "command", action: "eject" }]) {
      expect(isRecorderState(bad)).toBe(false);
      expect(isRecorderCommand(bad)).toBe(false);
    }
    expect(isRecorderCommand({ type: "command", action: "pause" })).toBe(true);
    expect(isRecorderCommand({ type: "command", action: "resume" })).toBe(true);
    expect(isRecorderCommand({ type: "command", action: "stop" })).toBe(true);
  });

  it("waveform history caps at WAVE_SAMPLES, drops oldest, clamps levels", () => {
    let history: number[] = [];
    for (let i = 0; i < WAVE_SAMPLES + 10; i++) history = pushWaveSample(history, i / 100);
    expect(history).toHaveLength(WAVE_SAMPLES);
    // Oldest dropped: the first surviving sample is sample #10.
    expect(history[0]).toBeCloseTo(0.1);
    expect(pushWaveSample([], 7)).toEqual([1]);
    expect(pushWaveSample([], -3)).toEqual([0]);
  });
});
