/**
 * Recorder ⇄ overlay broadcast contract
 * (docs/architecture/media/live-capture.md → "Desktop floating overlay").
 *
 * The desktop shell shows a small always-on-top overlay window while a
 * latched capture runs. The overlay is a separate renderer — it does NOT
 * hold the MediaRecorder — so state and control ride a `BroadcastChannel`
 * (same origin, same Chromium session, works across Electron windows and
 * browser tabs alike, zero IPC):
 *
 *   dock hook ──state (5/s: elapsed, paused, level)──▶ overlay page
 *   overlay page ──command (pause / resume / stop)───▶ dock hook
 *
 * Messages cross a trust seam (any same-origin page can post to the
 * channel), so both sides validate with the guards here rather than
 * casting — a malformed message must be ignored, never crash the recorder.
 * Pure module: types, guards, builders, and the overlay's rolling
 * waveform-history helper, all node-tested.
 *
 * [COMP:app-web/dock-recorder]
 */

export const RECORDER_CHANNEL = "brian-recorder";

export type RecorderStateMessage = {
  type: "state";
  /** False on the final message when the capture ends — the overlay blanks. */
  capturing: boolean;
  paused: boolean;
  elapsedMs: number;
  /** 0..1 RMS mic level (the overlay's live waveform sample). */
  level: number;
};

export type RecorderCommandMessage = {
  type: "command";
  action: "pause" | "resume" | "stop";
};

export function recorderStateMessage(
  capturing: boolean,
  paused: boolean,
  elapsedMs: number,
  level: number,
): RecorderStateMessage {
  return { type: "state", capturing, paused, elapsedMs, level };
}

export function isRecorderState(msg: unknown): msg is RecorderStateMessage {
  const m = msg as RecorderStateMessage | null;
  return (
    !!m &&
    m.type === "state" &&
    typeof m.capturing === "boolean" &&
    typeof m.paused === "boolean" &&
    typeof m.elapsedMs === "number" &&
    typeof m.level === "number"
  );
}

export function isRecorderCommand(msg: unknown): msg is RecorderCommandMessage {
  const m = msg as RecorderCommandMessage | null;
  return (
    !!m &&
    m.type === "command" &&
    (m.action === "pause" || m.action === "resume" || m.action === "stop")
  );
}

/** How many level samples the overlay's rolling waveform keeps. */
export const WAVE_SAMPLES = 48;

/**
 * Append a level sample to the rolling waveform history, capped at
 * `WAVE_SAMPLES` (oldest drops). Returns a new array — React state.
 */
export function pushWaveSample(history: readonly number[], level: number): number[] {
  const next = [...history, Math.max(0, Math.min(1, level))];
  return next.length > WAVE_SAMPLES ? next.slice(next.length - WAVE_SAMPLES) : next;
}
