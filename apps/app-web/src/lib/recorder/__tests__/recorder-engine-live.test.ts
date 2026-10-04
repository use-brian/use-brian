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

  static failStream: MediaStream | undefined;
  stopAt?: number;
  deferStop = false;
  constructor(public stream: MediaStream, _options?: MediaRecorderOptions) {
    if (stream === FakeMediaRecorder.failStream) throw new Error("encoder unavailable");
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
    this.stopAt = Date.now();
    if (!this.deferStop) this.flushStop();
  }

  flushStop(): void {
    this.ondataavailable?.({ data: new Blob(["complete-window"]) } as BlobEvent);
    this.onstop?.(new Event("stop"));
  }
}

const track = {
  stop: vi.fn(),
  addEventListener: vi.fn(),
} as unknown as MediaStreamTrack;

const microphone = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
const stream = {
  getTracks: () => [track],
  getAudioTracks: () => [track],
} as unknown as MediaStream;

describe("[COMP:app-web/live-recording-page] rolling recorder windows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T08:00:00Z"));
    FakeMediaRecorder.instances = [];
    FakeMediaRecorder.failStream = undefined;
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    capture.acquireCaptureAudio.mockResolvedValue({
      recordingStream: stream,
      microphoneStream: microphone,
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

  it("stops capture and flushes the local spool without waiting for transcript network requests", async () => {
    let finishNetwork!: () => void;
    const network = new Promise<void>((resolve) => { finishNetwork = resolve; });
    const onLiveWindow = vi.fn().mockReturnValue(network);
    const { createRecorderEngine } = await import("../recorder-engine");
    const { memorySpoolStore } = await import("../recorder-spool");
    const spool = memorySpoolStore();
    const engine = await createRecorderEngine({ onLiveWindow, liveWindowMs: 100 });
    engine.latch(spool, { id: "capture-1", workspaceId: "workspace-1", assistantId: "assistant-1", startedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(150);
    const capture = await engine.stop();
    expect(capture.durationMs).toBe(150);
    expect(track.stop).toHaveBeenCalled();
    expect(FakeMediaRecorder.instances.every((recorder) => recorder.state === "inactive")).toBe(true);
    expect(await spool.readChunks("capture-1")).toHaveLength(1);
    expect(onLiveWindow).toHaveBeenCalledTimes(1);
    let drained = false;
    void capture.liveWindowsDone!.then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    finishNetwork();
    await capture.liveWindowsDone;
    expect(onLiveWindow).toHaveBeenCalledTimes(2);
  });

  it("encodes isolated pre-mix microphone on the same 30-second cadence and flushes both final files", async () => {
    capture.acquireCaptureAudio.mockResolvedValue({ ...await capture.acquireCaptureAudio(), includesSystemAudio: true });
    const onLiveWindow = vi.fn();
    const { createRecorderEngine } = await import("../recorder-engine");
    const engine = await createRecorderEngine({ onLiveWindow, interactionEnabled: true });
    const [durable, main, mic] = FakeMediaRecorder.instances;
    expect(main.stream).toBe(stream); expect(mic.stream).toBe(microphone);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(main.stopAt).toBe(mic.stopAt);
    expect(durable.state).toBe("recording");
    expect(onLiveWindow).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      startMs: 0, endMs: 30_000, interactionSource: "mixed",
      microphone: { blob: expect.any(Blob), mime: "audio/webm;codecs=opus" },
    }));
    await vi.advanceTimersByTimeAsync(500);
    const result = await engine.stop(); await result.liveWindowsDone;
    expect(onLiveWindow).toHaveBeenLastCalledWith(expect.objectContaining({ startMs: 30_000, endMs: 30_500, microphone: expect.any(Object) }));
    expect(FakeMediaRecorder.instances.every((r) => r.state === "inactive")).toBe(true);
    expect(track.stop).toHaveBeenCalled();
  });

  it("flushes both encoders at pause and marks the resumed window discontinuous, including its final stop", async () => {
    capture.acquireCaptureAudio.mockResolvedValue({ ...await capture.acquireCaptureAudio(), includesSystemAudio: true });
    const onLiveWindow = vi.fn();
    const { createRecorderEngine } = await import("../recorder-engine");
    const engine = await createRecorderEngine({ onLiveWindow, interactionEnabled: true });
    const [durable, main, mic] = FakeMediaRecorder.instances;
    await vi.advanceTimersByTimeAsync(1000);
    engine.pause();
    await vi.advanceTimersByTimeAsync(5000);
    expect(durable.state).toBe("paused");
    expect(main.state).toBe("inactive"); expect(mic.state).toBe("inactive");
    expect(main.stopAt).toBe(mic.stopAt);
    expect(FakeMediaRecorder.instances).toHaveLength(3);
    expect(onLiveWindow).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ startMs: 0, endMs: 1000, discontinuity: false }));
    engine.resume(); await vi.advanceTimersByTimeAsync(1000);
    const result = await engine.stop(); await result.liveWindowsDone;
    expect(onLiveWindow).toHaveBeenLastCalledWith(expect.objectContaining({ startMs: 1000, endMs: 2000, discontinuity: true, microphone: expect.any(Object) }));
    expect(FakeMediaRecorder.instances.every((r) => r.state === "inactive")).toBe(true);
  });

  it.each([false, true])("never duplicates a mic-only encoder (interaction=%s)", async (interactionEnabled) => {
    const { createRecorderEngine } = await import("../recorder-engine");
    const onLiveWindow = vi.fn();
    const engine = await createRecorderEngine({ onLiveWindow, interactionEnabled });
    expect(FakeMediaRecorder.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await engine.stop(); await result.liveWindowsDone;
    expect(onLiveWindow).toHaveBeenCalledWith(expect.objectContaining({ interactionSource: "microphone", microphone: undefined }));
  });

  it("preserves mixed context and durable audio when the isolated encoder fails, never substituting the mix", async () => {
    capture.acquireCaptureAudio.mockResolvedValue({ ...await capture.acquireCaptureAudio(), includesSystemAudio: true });
    FakeMediaRecorder.failStream = microphone;
    const { createRecorderEngine } = await import("../recorder-engine");
    const onLiveWindow = vi.fn(); const onInteractionGap = vi.fn();
    const engine = await createRecorderEngine({ onLiveWindow, onInteractionGap, interactionEnabled: true });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await engine.stop(); await result.liveWindowsDone;
    expect(onInteractionGap).toHaveBeenCalled();
    expect(result.blob.size).toBeGreaterThan(0);
    expect(onLiveWindow).toHaveBeenCalledWith(expect.objectContaining({ blob: expect.any(Blob), interactionSource: "mixed", microphone: undefined }));
  });

  it("waits for both local encoder flushes at pause/stop, not just the mixed file", async () => {
    capture.acquireCaptureAudio.mockResolvedValue({ ...await capture.acquireCaptureAudio(), includesSystemAudio: true });
    const { createRecorderEngine } = await import("../recorder-engine");
    const onLiveWindow = vi.fn();
    const engine = await createRecorderEngine({ onLiveWindow, interactionEnabled: true });
    const [, main, mic] = FakeMediaRecorder.instances;
    main.deferStop = true; mic.deferStop = true;
    await vi.advanceTimersByTimeAsync(1000); engine.pause(); engine.resume();
    await vi.advanceTimersByTimeAsync(10);
    expect(FakeMediaRecorder.instances).toHaveLength(3); // no overlapping window while flushing
    main.flushStop(); await Promise.resolve();
    expect(onLiveWindow).not.toHaveBeenCalled();
    const stopped = engine.stop();
    let locallyStopped = false; void stopped.then(() => { locallyStopped = true; });
    await Promise.resolve(); expect(locallyStopped).toBe(false);
    mic.flushStop();
    const result = await stopped; await result.liveWindowsDone;
    expect(onLiveWindow).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ startMs: 0, endMs: 1000, microphone: expect.any(Object) }));
    expect(FakeMediaRecorder.instances).toHaveLength(3);
  });

  it("fails closed on an isolated encoder runtime error without losing the main file", async () => {
    capture.acquireCaptureAudio.mockResolvedValue({ ...await capture.acquireCaptureAudio(), includesSystemAudio: true });
    const { createRecorderEngine } = await import("../recorder-engine");
    const onLiveWindow = vi.fn(); const onInteractionGap = vi.fn();
    const engine = await createRecorderEngine({ onLiveWindow, onInteractionGap, interactionEnabled: true });
    const mic = FakeMediaRecorder.instances[2];
    await vi.advanceTimersByTimeAsync(1000); mic.onerror?.(new Event("error"));
    const result = await engine.stop(); await result.liveWindowsDone;
    expect(onInteractionGap).toHaveBeenCalled();
    expect(onLiveWindow).toHaveBeenCalledWith(expect.objectContaining({ interactionSource: "mixed", microphone: undefined }));
    expect(result.blob.size).toBeGreaterThan(0);
    expect(mic.state).toBe("inactive");
  });

  it("does not add a microphone encoder to ordinary mixed recording", async () => {
    capture.acquireCaptureAudio.mockResolvedValue({ ...await capture.acquireCaptureAudio(), includesSystemAudio: true });
    const { createRecorderEngine } = await import("../recorder-engine");
    const engine = await createRecorderEngine({ onLiveWindow: vi.fn() });
    expect(FakeMediaRecorder.instances).toHaveLength(2);
    engine.pause(); expect(FakeMediaRecorder.instances[1].state).toBe("paused");
    engine.resume(); expect(FakeMediaRecorder.instances[1].state).toBe("recording");
    await engine.stop();
  });

  it("cleans up both rolling encoders on cancel without uploading", async () => {
    capture.acquireCaptureAudio.mockResolvedValue({ ...await capture.acquireCaptureAudio(), includesSystemAudio: true });
    const { createRecorderEngine } = await import("../recorder-engine");
    const onLiveWindow = vi.fn();
    const engine = await createRecorderEngine({ onLiveWindow, interactionEnabled: true });
    await vi.advanceTimersByTimeAsync(1000); engine.cancel();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onLiveWindow).not.toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(3);
    expect(FakeMediaRecorder.instances.every((r) => r.state === "inactive")).toBe(true);
    expect(track.stop).toHaveBeenCalled();
  });

  it("stops creating isolated windows when disabled but keeps regular live transcription", async () => {
    capture.acquireCaptureAudio.mockResolvedValue({ ...await capture.acquireCaptureAudio(), includesSystemAudio: true });
    const { createRecorderEngine } = await import("../recorder-engine");
    const onLiveWindow = vi.fn();
    const engine = await createRecorderEngine({ onLiveWindow, interactionEnabled: true });
    engine.setInteractionEnabled(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeMediaRecorder.instances).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await engine.stop(); await result.liveWindowsDone;
    expect(onLiveWindow).toHaveBeenCalledTimes(2);
    expect(onLiveWindow).toHaveBeenLastCalledWith(expect.objectContaining({ microphone: undefined }));
  });
});
