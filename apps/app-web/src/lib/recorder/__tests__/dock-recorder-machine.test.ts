import { describe, expect, it } from "vitest";
import {
  recorderTransition,
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
