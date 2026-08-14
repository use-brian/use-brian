import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.hoisted(() => ({
  acquireCaptureAudio: vi.fn(),
}));

vi.mock("../audio-mixer", () => ({
  acquireCaptureAudio: capture.acquireCaptureAudio,
}));

type Handler = ((event: Event) => void) | null;

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = () => true;

  state: RecordingState = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: Handler = null;
  onerror: Handler = null;

  constructor(_stream: MediaStream, _options?: MediaRecorderOptions) {
    FakeMediaRecorder.instances.push(this);
  }

  start(): void {
    this.state = "recording";
  }

  pause(): void {
    this.state = "paused";
  }

  resume(): void {
    this.state = "recording";
  }

  stop(): void {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["complete-window"]) } as BlobEvent);
    this.onstop?.(new Event("stop"));
  }
}

const track = {
  stop: vi.fn(),
  addEventListener: vi.fn(),
} as unknown as MediaStreamTrack;

const stream = {
  getTracks: () => [track],
  getAudioTracks: () => [track],
} as unknown as MediaStream;

describe("[COMP:app-web/live-recording-page] rolling recorder windows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T08:00:00Z"));
    FakeMediaRecorder.instances = [];
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    capture.acquireCaptureAudio.mockResolvedValue({
      recordingStream: stream,
      inputStreams: [stream],
      includesSystemAudio: false,
      analyser: {
        fftSize: 8,
        getByteTimeDomainData: vi.fn(),
      },
      audioContext: { close: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("stop-restarts a second MediaRecorder so every transcript window is a complete file", async () => {
    const onLiveWindow = vi.fn().mockResolvedValue(undefined);
    const { createRecorderEngine } = await import("../recorder-engine");
    const engine = await createRecorderEngine({ onLiveWindow, liveWindowMs: 100 });

    // One durable recorder plus one independent rolling recorder.
    expect(FakeMediaRecorder.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(onLiveWindow).toHaveBeenCalledWith(expect.objectContaining({
      blob: expect.any(Blob),
      mime: "audio/webm;codecs=opus",
      startMs: 0,
      endMs: 100,
    }));
    // The first rolling file stopped, and a fresh container immediately began.
    expect(FakeMediaRecorder.instances).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(50);
    await engine.stop();
    expect(onLiveWindow).toHaveBeenCalledTimes(2);
    expect(track.stop).toHaveBeenCalled();
  });
});
