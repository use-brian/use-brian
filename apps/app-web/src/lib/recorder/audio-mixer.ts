/**
 * Capture-source acquisition for the dock recorder.
 *
 * Browsers stay microphone-only by default. The desktop preload advertises a
 * stronger contract: microphone + computer playback. That path acquires
 * Electron's display-audio stream, drops the video track immediately, and
 * mixes both inputs into ONE Web Audio destination track for MediaRecorder.
 *
 * Screen capture (`captureScreen`) keeps the display VIDEO track instead of
 * dropping it: the recording stream then carries one video track plus the one
 * audio track (raw mic, or the mixed mic + playback bus). Audio expectations
 * fork three ways and each is explicit:
 *   - `includeSystemAudio` — the DESKTOP promise: the display stream must
 *     deliver live playback audio or acquisition fails visibly (never a
 *     plausible-looking mic-only remote-call recording).
 *   - `opportunisticDisplayAudio` — the BROWSER posture: Chromium grants
 *     audio only for some picks (a tab; a Windows screen), so audio is mixed
 *     when present and its absence is an ordinary outcome, not a failure.
 *   - neither — an explicit mic-only choice: any display audio granted anyway
 *     is stopped, not mixed.
 *
 * Kept separate from recorder-engine.ts so the source/mix cleanup contract is
 * node-testable without constructing a real MediaRecorder.
 *
 * [COMP:app-web/recorder-engine]
 */

export class SystemAudioCaptureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SystemAudioCaptureError";
  }
}

/** Screen acquisition failed for a real reason (not a dismissed picker). */
export class ScreenCaptureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ScreenCaptureError";
  }
}

/**
 * The user dismissed the browser's screen picker (getDisplayMedia
 * NotAllowedError on the screen-capture path). A changed mind, not a
 * failure — callers return to idle without an error notice.
 */
export class ScreenCaptureCancelledError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Screen capture was cancelled", options);
    this.name = "ScreenCaptureCancelledError";
  }
}

export type CaptureAudio = {
  /** The stream handed to MediaRecorder: one audio track, plus the display
   *  video track when `captureScreen` was requested and granted. */
  recordingStream: MediaStream;
  /** Original inputs whose ended events represent real capture loss. */
  inputStreams: MediaStream[];
  /** Owned by the capture and closed on stop/cancel. Null when nothing mixes. */
  audioContext: AudioContext | null;
  /** Mixed-bus analyser when mixing; mic-only creates a best-effort tap later. */
  analyser: AnalyserNode | null;
  includesSystemAudio: boolean;
  /** True when the recording stream carries a live display video track. */
  capturesVideo: boolean;
};

type CaptureMediaDevices = Pick<MediaDevices, "getUserMedia" | "getDisplayMedia">;

const MICROPHONE_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

const DISPLAY_CONSTRAINTS: DisplayMediaStreamOptions = {
  // Audio is always REQUESTED (the desktop shell's handler only grants when
  // both kinds are asked for; browsers surface a share-audio checkbox). What
  // happens to a granted track is the caller-flag fork documented above.
  audio: true,
  video: true,
};

function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}

/**
 * Acquire the capture stream. A desktop shell that advertises system audio
 * must either return a real mixed stream or fail visibly — a plausible-looking
 * mic-only remote-call recording is worse than an actionable start failure.
 */
export async function acquireCaptureAudio(opts: {
  includeSystemAudio: boolean;
  /** Keep the display VIDEO track — a screen/window recording. */
  captureScreen?: boolean;
  /** Mix display audio when granted; its absence is ordinary (browsers). */
  opportunisticDisplayAudio?: boolean;
  mediaDevices?: CaptureMediaDevices;
  createAudioContext?: () => AudioContext;
  /** Injectable for node tests; production combines tracks via MediaStream. */
  createStream?: (tracks: MediaStreamTrack[]) => MediaStream;
}): Promise<CaptureAudio> {
  const mediaDevices = opts.mediaDevices ?? navigator.mediaDevices;
  const captureScreen = opts.captureScreen === true;
  const microphone = await mediaDevices.getUserMedia(MICROPHONE_CONSTRAINTS);

  if (!opts.includeSystemAudio && !captureScreen) {
    return {
      recordingStream: microphone,
      inputStreams: [microphone],
      audioContext: null,
      analyser: null,
      includesSystemAudio: false,
      capturesVideo: false,
    };
  }

  let display: MediaStream | null = null;
  let context: AudioContext | null = null;
  try {
    if (typeof mediaDevices.getDisplayMedia !== "function") {
      throw new Error("display media is unavailable");
    }
    try {
      display = await mediaDevices.getDisplayMedia(DISPLAY_CONSTRAINTS);
    } catch (cause) {
      // On the screen path a NotAllowedError is the user closing the picker —
      // a changed mind that must not render as a failure notice.
      if (
        captureScreen &&
        cause instanceof DOMException &&
        cause.name === "NotAllowedError"
      ) {
        throw new ScreenCaptureCancelledError({ cause });
      }
      throw cause;
    }

    // ── video track ────────────────────────────────────────────────────
    let videoTrack: MediaStreamTrack | null = null;
    if (captureScreen) {
      videoTrack = display.getVideoTracks().find((t) => t.readyState !== "ended") ?? null;
      if (!videoTrack) throw new Error("display capture returned no live video track");
    } else {
      // The video request exists only to satisfy getDisplayMedia's contract.
      display.getVideoTracks().forEach((track) => track.stop());
    }

    // ── audio expectation fork ─────────────────────────────────────────
    const displayAudio = display
      .getAudioTracks()
      .filter((track) => track.readyState !== "ended");
    let mixSystemAudio: boolean;
    if (opts.includeSystemAudio) {
      // The desktop promise: never silently downgrade.
      if (displayAudio.length === 0) {
        throw new Error("desktop playback returned no live audio track");
      }
      mixSystemAudio = true;
    } else if (opts.opportunisticDisplayAudio) {
      mixSystemAudio = displayAudio.length > 0;
    } else {
      // Explicit mic-only audio: never record display audio that was granted
      // anyway (e.g. the desktop handler always attaches loopback).
      display.getAudioTracks().forEach((track) => track.stop());
      mixSystemAudio = false;
    }

    // ── audio bus ──────────────────────────────────────────────────────
    let mixedStream: MediaStream | null = null;
    let analyser: AnalyserNode | null = null;
    if (mixSystemAudio) {
      context = (opts.createAudioContext ?? (() => new AudioContext()))();
      if (context.state === "suspended") await context.resume();
      if (context.state === "closed" || context.state === "suspended") {
        throw new Error("audio mixer could not start");
      }

      const microphoneSource = context.createMediaStreamSource(microphone);
      // createMediaStreamSource reads AUDIO tracks only, so the display
      // stream passes through whole — its live video track (screen capture)
      // is ignored by the mixer and carried separately below.
      const systemSource = context.createMediaStreamSource(display);
      const microphoneGain = context.createGain();
      const systemGain = context.createGain();
      const compressor = context.createDynamicsCompressor();
      const mixAnalyser = context.createAnalyser();
      const destination = context.createMediaStreamDestination();

      microphoneGain.gain.value = 1;
      // Remote participants are normally mastered louder than a laptop mic.
      // Slight attenuation leaves headroom before the shared compressor.
      systemGain.gain.value = 0.85;
      compressor.threshold.value = -6;
      compressor.knee.value = 6;
      compressor.ratio.value = 6;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;
      mixAnalyser.fftSize = 512;

      microphoneSource.connect(microphoneGain);
      microphoneGain.connect(compressor);
      systemSource.connect(systemGain);
      systemGain.connect(compressor);
      compressor.connect(mixAnalyser);
      mixAnalyser.connect(destination);

      if (destination.stream.getAudioTracks().length === 0) {
        throw new Error("audio mixer returned no output track");
      }
      mixedStream = destination.stream;
      analyser = mixAnalyser;
    }

    const createStream =
      opts.createStream ?? ((tracks: MediaStreamTrack[]) => new MediaStream(tracks));
    const recordingStream = videoTrack
      ? createStream([
          videoTrack,
          ...(mixedStream ?? microphone).getAudioTracks(),
        ])
      : (mixedStream ?? microphone);

    return {
      recordingStream,
      inputStreams: [microphone, display],
      audioContext: context,
      analyser,
      includesSystemAudio: mixSystemAudio,
      capturesVideo: videoTrack != null,
    };
  } catch (cause) {
    stopStream(display);
    stopStream(microphone);
    if (context) void context.close().catch(() => {});
    if (cause instanceof ScreenCaptureCancelledError) throw cause;
    if (captureScreen && !opts.includeSystemAudio) {
      throw new ScreenCaptureError("Could not capture the screen", { cause });
    }
    throw new SystemAudioCaptureError("Could not capture computer audio", { cause });
  }
}
