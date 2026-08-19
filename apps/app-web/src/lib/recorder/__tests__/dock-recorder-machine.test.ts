import { describe, expect, it, vi } from "vitest";
import {
  COMPUTER_AUDIO_PREFERENCE_KEY,
  handOffVerdict,
  readComputerAudioPreference,
  recorderTransition,
  shouldCaptureComputerAudio,
  writeComputerAudioPreference,
  type RecorderEvent,
  type RecorderPhase,
} from "../use-dock-recorder";

function run(phase: RecorderPhase, events: RecorderEvent[]) {
  const effects: Array<string | null> = [];
  let current = phase;
  for (const ev of events) {
    const { phase: next, effect } = recorderTransition(current, ev);
    current = next;
    effects.push(effect);
  }
  return { phase: current, effects };
}

const IDLE: RecorderPhase = { kind: "idle" };

describe("[COMP:app-web/dock-recorder] Recorder transition machine", () => {
  it("press starts capture immediately; quick release latches; stop forks", () => {
    const { phase, effects } = run(IDLE, [
      { type: "press" },
      { type: "armed" },
      { type: "release", heldMs: 120 },
      { type: "stop" },
      { type: "finished" },
    ]);
    expect(phase.kind).toBe("idle");
    expect(effects).toEqual(["start-capture", null, "latch", "stop-capture", null]);
  });

  it("hold-to-talk: a long-held release stops and hands off", () => {
    const { phase, effects } = run(IDLE, [
      { type: "press" },
      { type: "armed" },
      { type: "release", heldMs: 2_000 },
    ]);
    expect(phase.kind).toBe("finishing");
    expect(effects[2]).toBe("stop-capture");
  });

  it("release during arming with LATCH intent proceeds into a latched capture once armed", () => {
    const { phase, effects } = run(IDLE, [
      { type: "press" },
      { type: "release", heldMs: 150 },
      { type: "armed" },
    ]);
    expect(phase).toEqual({ kind: "latched", paused: false });
    expect(effects).toEqual(["start-capture", null, "latch"]);
  });

  it("release during arming with HOLD intent cancels with the press-again hint (the permission-prompt press)", () => {
    const { phase, effects } = run(IDLE, [
      { type: "press" },
      { type: "release", heldMs: 3_000 },
      { type: "armed" },
    ]);
    expect(phase.kind).toBe("idle");
    expect(effects[2]).toBe("cancel-with-hint");
  });

  it("slide-away release cancels from holding and from arming", () => {
    expect(
      run(IDLE, [{ type: "press" }, { type: "armed" }, { type: "release", heldMs: 100, outside: true }]),
    ).toMatchObject({ phase: { kind: "idle" }, effects: ["start-capture", null, "cancel-capture"] });
    expect(run(IDLE, [{ type: "press" }, { type: "release", heldMs: 100, outside: true }])).toMatchObject({
      phase: { kind: "idle" },
      effects: ["start-capture", "cancel-capture"],
    });
  });

  it("arm failure returns to idle without a capture effect", () => {
    const { phase, effects } = run(IDLE, [{ type: "press" }, { type: "arm-failed" }]);
    expect(phase.kind).toBe("idle");
    expect(effects).toEqual(["start-capture", null]);
  });

  it("auto-start (deep link) goes straight to latched once armed", () => {
    const { phase, effects } = run(IDLE, [{ type: "auto-start" }, { type: "armed" }]);
    expect(phase).toEqual({ kind: "latched", paused: false });
    expect(effects).toEqual(["start-capture", "latch"]);
  });

  it("pause/resume toggle only in the matching state; discard cancels", () => {
    const latched: RecorderPhase = { kind: "latched", paused: false };
    expect(recorderTransition(latched, { type: "pause" })).toEqual({
      phase: { kind: "latched", paused: true },
      effect: "pause",
    });
    expect(recorderTransition({ kind: "latched", paused: true }, { type: "resume" })).toEqual({
      phase: { kind: "latched", paused: false },
      effect: "resume",
    });
    expect(recorderTransition({ kind: "latched", paused: true }, { type: "pause" }).effect).toBeNull();
    expect(recorderTransition(latched, { type: "discard" })).toEqual({
      phase: { kind: "idle" },
      effect: "cancel-capture",
    });
  });

  it("stale events are no-ops — they can never corrupt a capture", () => {
    expect(recorderTransition(IDLE, { type: "stop" }).effect).toBeNull();
    expect(recorderTransition(IDLE, { type: "release", heldMs: 100 }).effect).toBeNull();
    expect(recorderTransition({ kind: "finishing" }, { type: "press" }).effect).toBeNull();
    expect(recorderTransition({ kind: "finishing" }, { type: "finished" }).phase.kind).toBe("idle");
  });
});

describe("[COMP:app-web/dock-recorder] Long-lane hand-off verdict", () => {
  it("a queued 202 releases the spool and confirms with the flow's own line", () => {
    expect(handOffVerdict({ outcome: "queued", message: "Recording uploaded." })).toEqual({
      notice: { kind: "queued", text: "Recording uploaded." },
      safeToDrop: true,
    });
  });

  it("a closed cost-confirm is a deferral: retained + the informational kept notice", () => {
    expect(handOffVerdict({ outcome: "cancelled" })).toEqual({
      notice: { kind: "kept" },
      safeToDrop: false,
    });
  });

  it("a failed step is retained AND names the step — never the bare kept notice", () => {
    const verdict = handOffVerdict({
      outcome: "failed",
      message: "The audio could not reach storage, so nothing was processed.",
    });
    expect(verdict.safeToDrop).toBe(false);
    expect(verdict.notice.kind).toBe("handOffFailed");
    expect(verdict.notice.kind !== "kept").toBe(true);
    expect(verdict.notice).toMatchObject({ text: expect.stringContaining("could not reach storage") });
  });
});

describe("[COMP:app-web/dock-recorder] Computer-audio preference", () => {
  it("defaults on, preserves an explicit off, and treats malformed values as the upgrade default", () => {
    const getItem = vi.fn<(key: string) => string | null>()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce("0")
      .mockReturnValueOnce("unexpected");
    const storage = { getItem, setItem: vi.fn() };

    expect(readComputerAudioPreference(storage)).toBe(true);
    expect(readComputerAudioPreference(storage)).toBe(false);
    expect(readComputerAudioPreference(storage)).toBe(true);
    expect(getItem).toHaveBeenCalledWith(COMPUTER_AUDIO_PREFERENCE_KEY);
  });

  it("writes one canonical marker and tolerates blocked device storage", () => {
    const setItem = vi.fn();
    const storage = { getItem: vi.fn(), setItem };
    writeComputerAudioPreference(false, storage);
    writeComputerAudioPreference(true, storage);
    expect(setItem.mock.calls).toEqual([
      [COMPUTER_AUDIO_PREFERENCE_KEY, "0"],
      [COMPUTER_AUDIO_PREFERENCE_KEY, "1"],
    ]);

    expect(() =>
      readComputerAudioPreference({
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: vi.fn(),
      }),
    ).not.toThrow();
    expect(() =>
      writeComputerAudioPreference(false, {
        getItem: vi.fn(),
        setItem: () => {
          throw new Error("blocked");
        },
      }),
    ).not.toThrow();
  });

  it("requires both desktop capability and the user's remembered choice", () => {
    expect(shouldCaptureComputerAudio(true, true)).toBe(true);
    expect(shouldCaptureComputerAudio(true, false)).toBe(false);
    expect(shouldCaptureComputerAudio(false, true)).toBe(false);
    expect(shouldCaptureComputerAudio(undefined, true)).toBe(false);
  });
});
