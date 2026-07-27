/**
 * Capture-source acquisition for the dock recorder.
 *
 * Browsers stay microphone-only. The desktop preload advertises a stronger
 * contract: microphone + computer playback. That path acquires Electron's
 * display-audio stream, drops the video track immediately, and mixes both
 * inputs into ONE Web Audio destination track for MediaRecorder.
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

export type CaptureAudio = {
  /** The one-track stream handed to MediaRecorder. */
  recordingStream: MediaStream;
  /** Original inputs whose ended events represent real capture loss. */
  inputStreams: MediaStream[];
  /** Owned by the capture and closed on stop/cancel. Null on mic-only. */
  audioContext: AudioContext | null;
  /** Mixed-bus analyser on desktop; mic-only creates a best-effort tap later. */
  analyser: AnalyserNode | null;
  includesSystemAudio: boolean;
};

type CaptureMediaDevices = Pick<MediaDevices, "getUserMedia" | "getDisplayMedia">;

const MICROPHONE_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

const SYSTEM_AUDIO_CONSTRAINTS: DisplayMediaStreamOptions = {
  audio: true,
  // getDisplayMedia requires video. The desktop shell supplies its primary
  // display and this module stops the video track as soon as acquisition
  // resolves; no pixels enter MediaRecorder or the crash spool.
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
  mediaDevices?: CaptureMediaDevices;
  createAudioContext?: () => AudioContext;
}): Promise<CaptureAudio> {
  const mediaDevices = opts.mediaDevices ?? navigator.mediaDevices;
  const microphone = await mediaDevices.getUserMedia(MICROPHONE_CONSTRAINTS);

  if (!opts.includeSystemAudio) {
    return {
      recordingStream: microphone,
      inputStreams: [microphone],
      audioContext: null,
      analyser: null,
      includesSystemAudio: false,
    };
  }

  let system: MediaStream | null = null;
  let context: AudioContext | null = null;
  try {
    if (typeof mediaDevices.getDisplayMedia !== "function") {
      throw new Error("display media is unavailable");
    }
    system = await mediaDevices.getDisplayMedia(SYSTEM_AUDIO_CONSTRAINTS);
    // The video request exists only to satisfy getDisplayMedia's contract.
    system.getVideoTracks().forEach((track) => track.stop());

    const systemAudio = system.getAudioTracks();
    if (systemAudio.length === 0 || systemAudio.every((track) => track.readyState === "ended")) {
      throw new Error("desktop playback returned no live audio track");
    }

    context = (opts.createAudioContext ?? (() => new AudioContext()))();
    if (context.state === "suspended") await context.resume();
    if (context.state === "closed" || context.state === "suspended") {
      throw new Error("audio mixer could not start");
    }

    const microphoneSource = context.createMediaStreamSource(microphone);
    const systemSource = context.createMediaStreamSource(system);
    const microphoneGain = context.createGain();
    const systemGain = context.createGain();
    const compressor = context.createDynamicsCompressor();
    const analyser = context.createAnalyser();
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
    analyser.fftSize = 512;

    microphoneSource.connect(microphoneGain);
    microphoneGain.connect(compressor);
    systemSource.connect(systemGain);
    systemGain.connect(compressor);
    compressor.connect(analyser);
    analyser.connect(destination);

    if (destination.stream.getAudioTracks().length === 0) {
      throw new Error("audio mixer returned no output track");
    }

    return {
      recordingStream: destination.stream,
      inputStreams: [microphone, system],
      audioContext: context,
      analyser,
      includesSystemAudio: true,
    };
  } catch (cause) {
    stopStream(system);
    stopStream(microphone);
    if (context) void context.close().catch(() => {});
    throw new SystemAudioCaptureError("Could not capture computer audio", { cause });
  }
}

