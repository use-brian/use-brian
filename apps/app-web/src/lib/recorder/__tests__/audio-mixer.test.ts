import { describe, expect, it, vi } from "vitest";
import {
  ScreenCaptureCancelledError,
  SystemAudioCaptureError,
  acquireCaptureAudio,
} from "../audio-mixer";

type FakeTrack = MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };

function fakeTrack(kind: "audio" | "video", readyState: MediaStreamTrackState = "live"): FakeTrack {
  return {
    kind,
    readyState,
    stop: vi.fn(),
  } as unknown as FakeTrack;
}

function fakeStream(tracks: FakeTrack[]): MediaStream {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((track) => track.kind === "audio"),
    getVideoTracks: () => tracks.filter((track) => track.kind === "video"),
  } as unknown as MediaStream;
}

function fakeContext(output: MediaStream) {
  const gains = [
    { gain: { value: 0 }, connect: vi.fn() },
    { gain: { value: 0 }, connect: vi.fn() },
  ];
  const sources = [
    { connect: vi.fn() },
    { connect: vi.fn() },
  ];
  const compressor = {
    threshold: { value: 0 },
    knee: { value: 0 },
    ratio: { value: 0 },
    attack: { value: 0 },
    release: { value: 0 },
    connect: vi.fn(),
  };
  const analyser = { fftSize: 0, connect: vi.fn() };
  const destination = { stream: output };
  const context = {
    state: "running" as AudioContextState,
    createMediaStreamSource: vi.fn(() => sources.shift()),
    createGain: vi.fn(() => gains.shift()),
    createDynamicsCompressor: vi.fn(() => compressor),
    createAnalyser: vi.fn(() => analyser),
    createMediaStreamDestination: vi.fn(() => destination),
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  } as unknown as AudioContext;
  return { context, compressor, analyser };
}

describe("[COMP:app-web/recorder-engine] Capture audio mixer", () => {
  it("keeps browser capture microphone-only and never requests display media", async () => {
    const microphone = fakeStream([fakeTrack("audio")]);
    const getDisplayMedia = vi.fn();
    const result = await acquireCaptureAudio({
      includeSystemAudio: false,
      mediaDevices: {
        getUserMedia: vi.fn(async () => microphone),
        getDisplayMedia,
      },
    });

    expect(result.recordingStream).toBe(microphone);
    expect(result.inputStreams).toEqual([microphone]);
    expect(result.includesSystemAudio).toBe(false);
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it("drops display video and mixes mic + computer playback into one output track", async () => {
    const micTrack = fakeTrack("audio");
    const systemTrack = fakeTrack("audio");
    const videoTrack = fakeTrack("video");
    const microphone = fakeStream([micTrack]);
    const system = fakeStream([systemTrack, videoTrack]);
    const output = fakeStream([fakeTrack("audio")]);
    const { context, compressor, analyser } = fakeContext(output);

    const result = await acquireCaptureAudio({
      includeSystemAudio: true,
      mediaDevices: {
        getUserMedia: vi.fn(async () => microphone),
        getDisplayMedia: vi.fn(async () => system),
      },
      createAudioContext: () => context,
    });

    expect(videoTrack.stop).toHaveBeenCalledOnce();
    expect(micTrack.stop).not.toHaveBeenCalled();
    expect(systemTrack.stop).not.toHaveBeenCalled();
    expect(result.recordingStream).toBe(output);
    expect(result.inputStreams).toEqual([microphone, system]);
    expect(result.includesSystemAudio).toBe(true);
    expect(result.analyser).toBe(analyser);
    expect(compressor.threshold.value).toBe(-6);
    expect(compressor.ratio.value).toBe(6);
  });

  it("never silently downgrades when a desktop playback stream fails", async () => {
    const micTrack = fakeTrack("audio");
    const microphone = fakeStream([micTrack]);

    await expect(
      acquireCaptureAudio({
        includeSystemAudio: true,
        mediaDevices: {
          getUserMedia: vi.fn(async () => microphone),
          getDisplayMedia: vi.fn(async () => {
            throw new Error("permission denied");
          }),
        },
      }),
    ).rejects.toBeInstanceOf(SystemAudioCaptureError);

    expect(micTrack.stop).toHaveBeenCalledOnce();
  });

  it("rejects and cleans up a display stream with no live audio track", async () => {
    const micTrack = fakeTrack("audio");
    const endedSystemTrack = fakeTrack("audio", "ended");
    const videoTrack = fakeTrack("video");

    await expect(
      acquireCaptureAudio({
        includeSystemAudio: true,
        mediaDevices: {
          getUserMedia: vi.fn(async () => fakeStream([micTrack])),
          getDisplayMedia: vi.fn(async () => fakeStream([endedSystemTrack, videoTrack])),
        },
      }),
    ).rejects.toBeInstanceOf(SystemAudioCaptureError);

    expect(micTrack.stop).toHaveBeenCalledOnce();
    expect(endedSystemTrack.stop).toHaveBeenCalledOnce();
    expect(videoTrack.stop).toHaveBeenCalled();
  });

  it("screen capture keeps the video track and rides it with the mixed audio bus", async () => {
    const micTrack = fakeTrack("audio");
    const systemTrack = fakeTrack("audio");
    const videoTrack = fakeTrack("video");
    const microphone = fakeStream([micTrack]);
    const display = fakeStream([systemTrack, videoTrack]);
    const mixedTrack = fakeTrack("audio");
    const output = fakeStream([mixedTrack]);
    const { context } = fakeContext(output);
    const createStream = vi.fn((tracks: MediaStreamTrack[]) => fakeStream(tracks as FakeTrack[]));

    const result = await acquireCaptureAudio({
      includeSystemAudio: true,
      captureScreen: true,
      mediaDevices: {
        getUserMedia: vi.fn(async () => microphone),
        getDisplayMedia: vi.fn(async () => display),
      },
      createAudioContext: () => context,
      createStream,
    });

    expect(videoTrack.stop).not.toHaveBeenCalled();
    expect(createStream).toHaveBeenCalledWith([videoTrack, mixedTrack]);
    expect(result.capturesVideo).toBe(true);
    expect(result.includesSystemAudio).toBe(true);
  });

  it("browser screen capture treats absent display audio as ordinary (mic + video, no mixer)", async () => {
    const micTrack = fakeTrack("audio");
    const videoTrack = fakeTrack("video");
    const microphone = fakeStream([micTrack]);
    const display = fakeStream([videoTrack]);
    const createStream = vi.fn((tracks: MediaStreamTrack[]) => fakeStream(tracks as FakeTrack[]));

    const result = await acquireCaptureAudio({
      includeSystemAudio: false,
      captureScreen: true,
      opportunisticDisplayAudio: true,
      mediaDevices: {
        getUserMedia: vi.fn(async () => microphone),
        getDisplayMedia: vi.fn(async () => display),
      },
      createStream,
    });

    expect(createStream).toHaveBeenCalledWith([videoTrack, micTrack]);
    expect(result.capturesVideo).toBe(true);
    expect(result.includesSystemAudio).toBe(false);
    expect(result.audioContext).toBeNull();
  });

  it("explicit mic-only screen capture stops display audio that was granted anyway", async () => {
    const micTrack = fakeTrack("audio");
    const loopbackTrack = fakeTrack("audio");
    const videoTrack = fakeTrack("video");
    const createStream = vi.fn((tracks: MediaStreamTrack[]) => fakeStream(tracks as FakeTrack[]));

    const result = await acquireCaptureAudio({
      includeSystemAudio: false,
      captureScreen: true,
      mediaDevices: {
        getUserMedia: vi.fn(async () => fakeStream([micTrack])),
        getDisplayMedia: vi.fn(async () => fakeStream([loopbackTrack, videoTrack])),
      },
      createStream,
    });

    expect(loopbackTrack.stop).toHaveBeenCalledOnce();
    expect(videoTrack.stop).not.toHaveBeenCalled();
    expect(result.includesSystemAudio).toBe(false);
    expect(result.capturesVideo).toBe(true);
  });

  it("a dismissed screen picker resolves as a cancel, not a failure", async () => {
    const micTrack = fakeTrack("audio");
    await expect(
      acquireCaptureAudio({
        includeSystemAudio: false,
        captureScreen: true,
        mediaDevices: {
          getUserMedia: vi.fn(async () => fakeStream([micTrack])),
          getDisplayMedia: vi.fn(async () => {
            throw new DOMException("denied", "NotAllowedError");
          }),
        },
      }),
    ).rejects.toBeInstanceOf(ScreenCaptureCancelledError);
    expect(micTrack.stop).toHaveBeenCalledOnce();
  });
});
