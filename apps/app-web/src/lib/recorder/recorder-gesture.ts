/**
 * Dock live-recording gesture + fork logic — the pure half of the recorder
 * (docs/architecture/media/live-capture.md). No DOM: everything here is
 * decision logic the hook/UI layer calls with measured numbers, so the
 * gesture contract unit-tests in node.
 *
 * The one design invariant worth restating: capture starts on pointer-down
 * and the GESTURE resolves afterwards, from how long the press was held —
 * never the other way around. A quick tap latches (recording continues until
 * an explicit stop); a long hold is walkie-talkie (release = stop and send).
 * Starting capture first means resolving the gesture never costs the first
 * seconds of audio.
 *
 * The stop fork reuses the SAME duration threshold as the dropped-file fork
 * (`RECORDING_AUDIO_MIN_DURATION_SEC` in `use-file-attachments.ts`): a live
 * capture and a dropped file of the same length must take the same lane.
 * Unlike the dropped file, a live capture's duration is exact (the recorder
 * ran the clock), so there is no probe and no size fallback here.
 *
 * [COMP:app-web/recorder-gesture]
 */

import { RECORDING_AUDIO_MIN_DURATION_SEC } from "@/lib/use-file-attachments";

/** Held shorter than this → the press was a click → latch. Held longer → hold-to-talk. */
export const HOLD_LATCH_MS = 400;

/**
 * Captures under this discard silently — a stray click must not send a
 * garbage voice prompt to the assistant. (The feed's press-and-hold recorder
 * uses a 1 KB size floor for the same reason; time is the honest axis here
 * since we know it exactly.)
 */
export const MIN_CAPTURE_MS = 2000;

/** The stop fork's threshold, in ms — one constant with the dropped-file fork. */
export const CAPTURE_FORK_MS = RECORDING_AUDIO_MIN_DURATION_SEC * 1000;

/** How a finished press resolves: a quick tap latches, a long hold stops-and-sends. */
export function resolveRelease(heldMs: number): "latch" | "stop" {
  return heldMs < HOLD_LATCH_MS ? "latch" : "stop";
}

/**
 * The hard limit per capture — a PRODUCT decision (2026-07-22, founder):
 * two hours of recording per go. It also sits comfortably under the
 * server's 180-minute transcription ceiling (`RECORDING_DURATION_CEILING_
 * MINUTES` in api-platform's `billing/credit-usage.ts` — a closed server
 * module, so the value is pinned by test rather than imported), which a
 * capture must NEVER cross: past it the estimate 413s `too_long` forever
 * and a spooled capture has no client-side splitter. At the limit the
 * capture stops to the spool and the user presses record again for the
 * rest of the meeting.
 */
export const CAPTURE_AUTO_STOP_MS = 120 * 60_000;

/** True once a latched capture must stop to stay under the server ceiling. */
export function shouldAutoStop(elapsedMs: number): boolean {
  return elapsedMs >= CAPTURE_AUTO_STOP_MS;
}

/**
 * How long a capture may sit PAUSED before it stops itself (to the spool,
 * like the hard-limit auto-stop). A paused capture freezes the recorder
 * clock, so the duration guard alone would hold the mic stream and the
 * session FOREVER for a paused-and-forgotten recording. One hour: pause
 * exists precisely for real mid-session breaks (founder use case — a
 * lunch recess in a long sales visit), so the cap must outlast any
 * deliberate break while staying far under "forgot it overnight".
 */
export const PAUSE_AUTO_STOP_MS = 60 * 60_000;

export type CaptureLane = "discard" | "voice" | "recording";

/**
 * Where a stopped capture goes. Under the floor → discarded; under the fork
 * threshold → an inline voice prompt; at/over → the recording ingestion
 * pipeline (cost + blueprint + destination confirm).
 */
export function stopLane(durationMs: number, forkMs: number = CAPTURE_FORK_MS): CaptureLane {
  if (durationMs < MIN_CAPTURE_MS) return "discard";
  return durationMs < forkMs ? "voice" : "recording";
}

/**
 * What the live pill should CALL the in-flight capture — the fork telegraph.
 * Once elapsed crosses the threshold the label flips from "voice message" to
 * "meeting recording", so the user always knows which outcome stopping
 * produces before they stop.
 */
export function captureLabelLane(elapsedMs: number, forkMs: number = CAPTURE_FORK_MS): "voice" | "recording" {
  return elapsedMs < forkMs ? "voice" : "recording";
}

/**
 * Pick the MediaRecorder mime. Opus-in-webm everywhere it exists (Chromium,
 * the desktop shell); Safari records AAC-in-mp4. Empty string = let the
 * browser choose. `isSupported` is injected so the ladder tests in node.
 */
export function pickRecorderMime(isSupported: (mime: string) => boolean): string {
  const ladder = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return ladder.find((m) => isSupported(m)) ?? "";
}

/** File extension for a capture mime — the container, not the codec suffix. */
export function extensionForMime(mime: string): string {
  if (mime.includes("webm")) return "webm";
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}

/**
 * The capture's file name — a live capture has no picked file, and the
 * recordings board seeds its row title from the upload's name, so give it a
 * human one from the capture moment. `prefix` is the localized "Recording"
 * so the name follows the workspace locale.
 */
export function captureFileName(prefix: string, now: Date, mime: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours(),
  )}.${pad(now.getMinutes())}`;
  return `${prefix} ${stamp}.${extensionForMime(mime)}`;
}

/** `M:SS` / `H:MM:SS` elapsed readout for the live pill. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
