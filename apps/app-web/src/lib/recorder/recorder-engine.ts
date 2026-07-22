/**
 * Live-capture engine — the thin DOM wrapper over `getUserMedia` +
 * `MediaRecorder` (docs/architecture/media/live-capture.md). Everything
 * decision-shaped lives in `recorder-gesture.ts` / `recorder-spool.ts`
 * (pure, node-tested); this file owns the browser objects and stays thin,
 * the same split the feed's `VoiceRecorder` and `recordings-board` use.
 *
 * Lifecycle: `createRecorderEngine()` acquires the mic and starts recording
 * immediately (capture-on-pointer-down — the caller has already decided to
 * record). `latch(spool, meta)` upgrades the capture to crash-durable:
 * chunks buffered so far and every chunk after are appended to the spool,
 * best-effort (a spool failure never breaks the in-memory capture).
 * `stop()` yields the assembled blob + the engine-measured duration
 * (wall clock minus paused time — the number the webm patch and the stop
 * fork run on). `cancel()` discards everything and releases the mic.
 *
 * The level tap (AnalyserNode RMS) is the "is it hearing the room" trust
 * signal the pill meter polls; it is best-effort too (an AudioContext
 * failure degrades to a meter stuck at 0, not a broken capture).
 *
 * [COMP:app-web/recorder-engine]
 */

import { pickRecorderMime } from "./recorder-gesture";
import type { SpoolSessionMeta, SpoolStore } from "./recorder-spool";

/** MediaRecorder timeslice — one chunk (and one spool write) per interval. */
const CAPTURE_TIMESLICE_MS = 5_000;

/**
 * Explicit speech bitrate. Chrome's MediaRecorder default is ~128 kbps —
 * sized for music, wasteful for a mic: a 2-hour sales call would be
 * ~115 MB. Opus at 64 kbps is transparent for speech and halves both the
 * capture footprint (~58 MB / 2h) and the upload time on meeting-room
 * wifi. The transcriber consumes far lower-fidelity audio than this.
 */
const AUDIO_BITS_PER_SECOND = 64_000;

type CaptureResult = { blob: Blob; mime: string; durationMs: number };

export interface RecorderEngine {
  /** Recorder clock: wall time since start, minus paused time. */
  elapsedMs(): number;
  /** 0..1 RMS mic level for the live meter; 0 when the tap is unavailable. */
  level(): number;
  paused(): boolean;
  pause(): void;
  resume(): void;
  /**
   * Begin spooling to `spool` under `meta.id`. Chunks already captured are
   * written first, so a latch after the opening seconds loses nothing.
   */
  latch(
    spool: SpoolStore,
    meta: Omit<SpoolSessionMeta, "elapsedMs" | "chunkCount" | "mime" | "updatedAt">,
  ): void;
  /** The spool session id when latched, else null (hand-off cleanup key). */
  spoolSessionId(): string | null;
  /** Stop and assemble. Resolves once the final chunk has flushed. */
  stop(): Promise<CaptureResult>;
  /** Discard the capture and release the mic. Safe to call in any state. */
  cancel(): void;
}

/**
 * Acquire the mic and start capturing. Rejects with the `getUserMedia`
 * error (`NotAllowedError` = denied/dismissed) — the hook maps that to the
 * permission hint. `isSupported` is injectable for the mime ladder.
 *
 * `onUnexpectedEnd` fires when the capture dies underneath us — the mic
 * track ends (device unplugged / input switched) or MediaRecorder errors.
 * Without it a long meeting can turn into a ZOMBIE: the clock keeps
 * ticking while nothing records. It never fires for our own stop/cancel.
 */
export async function createRecorderEngine(opts?: {
  isSupported?: (mime: string) => boolean;
  onUnexpectedEnd?: () => void;
}): Promise<RecorderEngine> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const isSupported =
    opts?.isSupported ??
    ((m: string) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m));
  const mimeType = pickRecorderMime(isSupported);
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    });
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    throw err;
  }

  // ── unexpected-end detection ─────────────────────────────────────────
  // `track.stop()` (our own release) does NOT dispatch 'ended' per spec, so
  // these fire only for external causes; `closed` belts-and-suspenders the
  // stop/cancel races anyway.
  let closed = false;
  const notifyUnexpectedEnd = () => {
    if (!closed) opts?.onUnexpectedEnd?.();
  };
  stream.getTracks().forEach((t) => t.addEventListener("ended", notifyUnexpectedEnd));
  recorder.onerror = notifyUnexpectedEnd;

  // ── level tap (best-effort) ──────────────────────────────────────────
  let analyser: AnalyserNode | null = null;
  let audioCtx: AudioContext | null = null;
  try {
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
  } catch {
    analyser = null;
  }
  const levelBuf = analyser ? new Uint8Array(analyser.fftSize) : null;

  // ── clock ────────────────────────────────────────────────────────────
  const startedAt = Date.now();
  let pausedTotal = 0;
  let pausedSince: number | null = null;
  const elapsedMs = () =>
    (pausedSince ?? Date.now()) - startedAt - pausedTotal;

  // ── chunks + spool ───────────────────────────────────────────────────
  const chunks: Blob[] = [];
  let spool: SpoolStore | null = null;
  let spoolId: string | null = null;
  let spooledCount = 0;
  // Serialized best-effort writes: order preserved, failures swallowed
  // (degrade to in-memory-only, never break the capture).
  let spoolQueue: Promise<void> = Promise.resolve();
  const spoolFrom = (start: number) => {
    if (!spool || !spoolId) return;
    const s = spool;
    const id = spoolId;
    for (let i = start; i < chunks.length; i++) {
      const index = i;
      const chunk = chunks[i];
      const at = elapsedMs();
      spoolQueue = spoolQueue.then(() => s.appendChunk(id, index, chunk, at)).catch(() => {});
    }
    spooledCount = chunks.length;
  };

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      chunks.push(e.data);
      if (spool) spoolFrom(spooledCount);
    }
  };

  const release = () => {
    stream.getTracks().forEach((t) => t.stop());
    void audioCtx?.close().catch(() => {});
  };

  recorder.start(CAPTURE_TIMESLICE_MS);

  return {
    elapsedMs,
    level() {
      if (!analyser || !levelBuf) return 0;
      analyser.getByteTimeDomainData(levelBuf);
      let sum = 0;
      for (let i = 0; i < levelBuf.length; i++) {
        const v = (levelBuf[i] - 128) / 128;
        sum += v * v;
      }
      return Math.min(1, Math.sqrt(sum / levelBuf.length) * 3);
    },
    paused: () => pausedSince !== null,
    pause() {
      if (recorder.state === "recording") {
        recorder.pause();
        pausedSince = Date.now();
      }
    },
    resume() {
      if (recorder.state === "paused") {
        recorder.resume();
        if (pausedSince !== null) {
          pausedTotal += Date.now() - pausedSince;
          pausedSince = null;
        }
      }
    },
    latch(store, meta) {
      if (spool) return;
      spool = store;
      spoolId = meta.id;
      const full: SpoolSessionMeta = {
        ...meta,
        mime: recorder.mimeType || mimeType || "audio/webm",
        elapsedMs: elapsedMs(),
        chunkCount: 0,
        updatedAt: Date.now(),
      };
      spoolQueue = spoolQueue.then(() => store.createSession(full)).catch(() => {});
      spoolFrom(0);
    },
    spoolSessionId: () => spoolId,
    stop() {
      closed = true;
      return new Promise<CaptureResult>((resolve) => {
        const durationMs = elapsedMs();
        const finish = () => {
          const mime = recorder.mimeType || mimeType || "audio/webm";
          release();
          resolve({ blob: new Blob(chunks, { type: mime }), mime, durationMs });
        };
        // A died track leaves the recorder already inactive — assemble what
        // was captured rather than waiting for an onstop that never fires.
        if (recorder.state === "inactive") {
          finish();
          return;
        }
        recorder.onstop = () => {
          // ondataavailable for the final chunk fires before onstop.
          finish();
        };
        recorder.stop();
      });
    },
    cancel() {
      closed = true;
      recorder.ondataavailable = null;
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // already stopping
        }
      }
      release();
    },
  };
}
