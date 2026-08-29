/**
 * Live-capture engine — the thin DOM wrapper over capture-source acquisition +
 * `MediaRecorder` (docs/architecture/media/live-capture.md). Everything
 * decision-shaped lives in `recorder-gesture.ts` / `recorder-spool.ts`
 * (pure, node-tested); this file owns the browser objects and stays thin,
 * the same split the feed's `VoiceRecorder` and `recordings-board` use.
 *
 * Lifecycle: `createRecorderEngine()` acquires the available audio sources
 * (mic in browsers; mixed mic + playback in the desktop shell) and starts
 * recording immediately (capture-on-pointer-down — the caller has already
 * decided to record). `latch(spool, meta)` upgrades the capture to crash-durable:
 * chunks buffered so far and every chunk after are appended to the spool,
 * best-effort (a spool failure never breaks the in-memory capture).
 * `stop()` yields the assembled blob + the engine-measured duration
 * (wall clock minus paused time — the number the webm patch and the stop
 * fork run on). `cancel()` discards everything and releases every input.
 *
 * The level tap (AnalyserNode RMS) is the "is it hearing the call" trust
 * signal the pill meter polls; it is best-effort too (an AudioContext
 * failure degrades to a meter stuck at 0, not a broken capture).
 *
 * [COMP:app-web/recorder-engine]
 */

import { pickRecorderMime } from "./recorder-gesture";
import { acquireCaptureAudio } from "./audio-mixer";
import type { SpoolSessionMeta, SpoolStore } from "./recorder-spool";

/** MediaRecorder timeslice — one chunk (and one spool write) per interval. */
const CAPTURE_TIMESLICE_MS = 5_000;

/** Each live transcript upload is a complete, independently decodable file. */
const LIVE_TRANSCRIPT_WINDOW_MS = 30_000;

/**
 * Explicit speech bitrate. Chrome's MediaRecorder default is ~128 kbps —
 * sized for music, wasteful for a mic: a 2-hour sales call would be
 * ~115 MB. Opus at 64 kbps is transparent for speech and halves both the
 * capture footprint (~58 MB / 2h) and the upload time on meeting-room
 * wifi. The transcriber consumes far lower-fidelity audio than this.
 */
const AUDIO_BITS_PER_SECOND = 64_000;

/**
 * Explicit screen-content video bitrate. VP9 at ~1 Mbps keeps a 1080p
 * screencast (slides, demos, text) readable while bounding a 2-hour capture
 * near ~950 MB of spool/upload; camera-quality fidelity is not the goal —
 * the frames feed visual analysis and a seek-to-moment player.
 */
const VIDEO_BITS_PER_SECOND = 1_000_000;

type CaptureResult = { blob: Blob; mime: string; durationMs: number };

export interface RecorderEngine {
  /** Recorder clock: wall time since start, minus paused time. */
  elapsedMs(): number;
  /** 0..1 RMS capture-bus level for the live meter; 0 when unavailable. */
  level(): number;
  /** True when the recorded track contains both mic and computer playback. */
  includesSystemAudio(): boolean;
  /** True when the capture records a screen/window video track. */
  capturesVideo(): boolean;
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
  /** Discard the capture and release every input. Safe in any state. */
  cancel(): void;
}

/**
 * Acquire the configured sources and start capturing. A mic permission error
 * remains the `getUserMedia` DOMException; desktop playback failures are
 * wrapped by `audio-mixer.ts` so the hook can show the correct permission
 * guidance. `isSupported` is injectable for the mime ladder.
 *
 * `onUnexpectedEnd` fires when the capture dies underneath us — an input
 * track ends (device unplugged / input switched / loopback lost) or
 * MediaRecorder errors.
 * Without it a long meeting can turn into a ZOMBIE: the clock keeps
 * ticking while nothing records. It never fires for our own stop/cancel.
 */
export async function createRecorderEngine(opts?: {
  isSupported?: (mime: string) => boolean;
  onUnexpectedEnd?: () => void;
  /** Advertised only by new macOS/Windows desktop shells. */
  includeSystemAudio?: boolean;
  /** Record the screen/window video track alongside the audio. */
  captureScreen?: boolean;
  /** Browser screen capture: mix display audio when granted, absence is ordinary. */
  opportunisticDisplayAudio?: boolean;
  /** Optional provisional transcript lane; the durable recorder stays authoritative. */
  onLiveWindow?: (window: {
    blob: Blob;
    mime: string;
    startMs: number;
    endMs: number;
  }) => Promise<void> | void;
  /** Injectable only for deterministic tests; production uses 30 seconds. */
  liveWindowMs?: number;
}): Promise<RecorderEngine> {
  const captureAudio = await acquireCaptureAudio({
    includeSystemAudio: opts?.includeSystemAudio === true,
    captureScreen: opts?.captureScreen === true,
    opportunisticDisplayAudio: opts?.opportunisticDisplayAudio === true,
  });
  const stream = captureAudio.recordingStream;
  const capturesVideo = captureAudio.capturesVideo;
  const isSupported =
    opts?.isSupported ??
    ((m: string) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m));
  const mimeType = pickRecorderMime(isSupported, { video: capturesVideo });
  const fallbackMime = capturesVideo ? "video/webm" : "audio/webm";
  // The rolling live-transcript recorder stays AUDIO-ONLY even for a screen
  // capture: its 30-second windows feed the short-audio transcription backend
  // and the audio-window finalize fallback, both of which consume audio
  // containers. Video rides only the durable lossless recorder.
  const liveStream = capturesVideo ? new MediaStream(stream.getAudioTracks()) : stream;
  const liveMime = capturesVideo ? pickRecorderMime(isSupported) : mimeType;
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
      ...(capturesVideo ? { videoBitsPerSecond: VIDEO_BITS_PER_SECOND } : {}),
    });
  } catch (err) {
    captureAudio.inputStreams.forEach((input) => input.getTracks().forEach((track) => track.stop()));
    stream.getTracks().forEach((track) => track.stop());
    void captureAudio.audioContext?.close().catch(() => {});
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
  captureAudio.inputStreams.forEach((input) => {
    // ALL tracks: a screen capture dies through its VIDEO track too (the
    // browser's own "Stop sharing" bar ends it without touching audio).
    input.getTracks().forEach((track) => track.addEventListener("ended", notifyUnexpectedEnd));
  });
  recorder.onerror = notifyUnexpectedEnd;

  // ── level tap (best-effort) ──────────────────────────────────────────
  // Desktop mixing already owns an analyser on the final bus. Mic-only keeps
  // the previous best-effort tap, isolated from the recording stream itself.
  let analyser: AnalyserNode | null = captureAudio.analyser;
  let audioCtx: AudioContext | null = captureAudio.audioContext;
  if (!analyser) {
    try {
      audioCtx = new AudioContext();
      const src = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
    } catch {
      analyser = null;
    }
  }
  const levelBuf = analyser ? new Uint8Array(analyser.fftSize) : null;

  // ── clock ────────────────────────────────────────────────────────────
  const startedAt = Date.now();
  let pausedTotal = 0;
  let pausedSince: number | null = null;
  const elapsedMs = () =>
    (pausedSince ?? Date.now()) - startedAt - pausedTotal;

  // ── independently decodable live windows ─────────────────────────────
  // MediaRecorder timeslice blobs after the first are continuation chunks,
  // so the API cannot decode them independently. A second recorder over the
  // SAME final stream stops/restarts per window. The durable recorder above is
  // untouched and remains the recovery/final-processing source of truth.
  let liveRecorder: MediaRecorder | null = null;
  let liveParts: Blob[] = [];
  let liveWindowStartedAt = 0;
  let liveTimer: ReturnType<typeof setTimeout> | null = null;
  let liveTimerStartedAt = 0;
  let liveRemainingMs = opts?.liveWindowMs ?? LIVE_TRANSCRIPT_WINDOW_MS;
  let liveCancelled = false;
  let liveQueue: Promise<void> = Promise.resolve();

  const clearLiveTimer = () => {
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = null;
  };

  const enqueueLiveWindow = (blob: Blob, mime: string, startMs: number, endMs: number) => {
    if (!opts?.onLiveWindow || liveCancelled || endMs <= startMs) return;
    liveQueue = liveQueue
      .then(() => opts.onLiveWindow!({ blob, mime, startMs, endMs }))
      .catch(() => {});
  };

  const startLiveWindow = () => {
    if (!opts?.onLiveWindow || closed || liveCancelled) return;
    liveParts = [];
    liveWindowStartedAt = elapsedMs();
    liveRemainingMs = opts.liveWindowMs ?? LIVE_TRANSCRIPT_WINDOW_MS;
    const rolling = new MediaRecorder(liveStream, {
      ...(liveMime ? { mimeType: liveMime } : {}),
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    });
    liveRecorder = rolling;
    rolling.ondataavailable = (event) => {
      if (event.data.size > 0) liveParts.push(event.data);
    };
    rolling.onstop = () => {
      const endMs = elapsedMs();
      const mime = rolling.mimeType || liveMime || "audio/webm";
      enqueueLiveWindow(new Blob(liveParts, { type: mime }), mime, liveWindowStartedAt, endMs);
      liveParts = [];
      if (!closed && !liveCancelled) startLiveWindow();
    };
    // A provisional encoder failure must never stop the durable recording.
    // Stop this window; its empty/partial blob is reported as a missed window,
    // and onstop starts a fresh container for the next one.
    rolling.onerror = () => {
      clearLiveTimer();
      if (rolling.state !== "inactive") {
        try {
          rolling.stop();
        } catch {
          // The next full recording remains authoritative.
          if (!closed && !liveCancelled) startLiveWindow();
        }
      } else if (!closed && !liveCancelled) {
        startLiveWindow();
      }
    };
    rolling.start();
    liveTimerStartedAt = Date.now();
    liveTimer = setTimeout(() => {
      liveTimer = null;
      if (rolling.state !== "inactive") rolling.stop();
    }, liveRemainingMs);
  };

  const stopLiveWindow = (cancel: boolean): Promise<void> => {
    clearLiveTimer();
    if (cancel) liveCancelled = true;
    const rolling = liveRecorder;
    liveRecorder = null;
    if (!rolling || rolling.state === "inactive") return liveQueue;
    return new Promise<void>((resolve) => {
      const previousStop = rolling.onstop;
      rolling.onstop = (event) => {
        if (!cancel) previousStop?.call(rolling, event);
        resolve();
      };
      try {
        rolling.stop();
      } catch {
        resolve();
      }
    }).then(() => liveQueue);
  };

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
    captureAudio.inputStreams.forEach((input) =>
      input.getTracks().forEach((track) => track.stop()),
    );
    stream.getTracks().forEach((track) => track.stop());
    void audioCtx?.close().catch(() => {});
  };

  recorder.start(CAPTURE_TIMESLICE_MS);
  try {
    startLiveWindow();
  } catch (error) {
    closed = true;
    try {
      recorder.stop();
    } catch {
      // The release below is the actual cleanup boundary.
    }
    release();
    throw error;
  }

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
    includesSystemAudio: () => captureAudio.includesSystemAudio,
    capturesVideo: () => capturesVideo,
    paused: () => pausedSince !== null,
    pause() {
      if (recorder.state === "recording") {
        recorder.pause();
        if (liveRecorder?.state === "recording") {
          liveRemainingMs = Math.max(1, liveRemainingMs - (Date.now() - liveTimerStartedAt));
          clearLiveTimer();
          liveRecorder.pause();
        }
        pausedSince = Date.now();
      }
    },
    resume() {
      if (recorder.state === "paused") {
        recorder.resume();
        if (liveRecorder?.state === "paused") {
          liveRecorder.resume();
          liveTimerStartedAt = Date.now();
          const rolling = liveRecorder;
          liveTimer = setTimeout(() => {
            liveTimer = null;
            if (rolling.state !== "inactive") rolling.stop();
          }, liveRemainingMs);
        }
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
        mime: recorder.mimeType || mimeType || fallbackMime,
        elapsedMs: elapsedMs(),
        chunkCount: 0,
        updatedAt: Date.now(),
      };
      spoolQueue = spoolQueue.then(() => store.createSession(full)).catch(() => {});
      spoolFrom(0);
    },
    spoolSessionId: () => spoolId,
    async stop() {
      closed = true;
      await stopLiveWindow(false);
      return new Promise<CaptureResult>((resolve) => {
        const durationMs = elapsedMs();
        const finish = () => {
          const mime = recorder.mimeType || mimeType || fallbackMime;
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
      void stopLiveWindow(true);
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
