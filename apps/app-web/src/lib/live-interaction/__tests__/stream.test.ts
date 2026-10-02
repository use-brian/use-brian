import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ interactionRequest: request }));
import { InteractionStream, UtteranceAssembler } from "../stream";

function events(id: string, previous: string | null = null, text = "Hey Brian, summarize") {
  return [
    { type: "input_audio_buffer.speech_started", item_id: id, audio_start_ms: 10 },
    { type: "input_audio_buffer.speech_stopped", item_id: id, audio_end_ms: 50 },
    { type: "input_audio_buffer.committed", item_id: id, previous_item_id: previous },
    { type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: text },
  ];
}
class Track {
  enabled = true;
  stop = vi.fn();
  clones: Track[] = [];
  clone() { const copy = new Track(); this.clones.push(copy); return copy; }
}
class Stream {
  constructor(public tracks: Track[]) {}
  getAudioTracks() { return this.tracks; }
}
class Peer {
  static all: Peer[] = [];
  connectionState = "connected";
  onconnectionstatechange: (() => void) | null = null;
  channel = { onmessage: null as null | ((event: { data: string }) => void), close: vi.fn() };
  addTrack = vi.fn();
  createDataChannel = () => this.channel;
  createOffer = async () => ({ sdp: "offer" });
  setLocalDescription = vi.fn();
  setRemoteDescription = vi.fn();
  close = vi.fn();
  constructor() { Peer.all.push(this); }
  emit(id: string, previous: string | null = null) { for (const event of events(id, previous)) this.channel.onmessage?.({ data: JSON.stringify(event) }); }
}
beforeEach(() => {
  vi.useFakeTimers(); Peer.all = [];
  request.mockReset().mockResolvedValue({ value: "ephemeral", expiresAt: 9999 });
  vi.stubGlobal("RTCPeerConnection", Peer); vi.stubGlobal("MediaStream", Stream);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => "answer" }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("source-isolated streaming transcription", () => {
  it("orders late finals, retains provenance/offsets, and deduplicates provider replay but not repeated speech", () => {
    const assembler = new UtteranceAssembler("system", 100);
    for (const event of events("two", "one")) expect(assembler.accept(event)).toEqual([]);
    const result = events("one").flatMap((event) => assembler.accept(event));
    expect(result.map((u) => u.id)).toEqual(["one", "two"]);
    expect(result[0]).toMatchObject({ source: "system", startMs: 110, endMs: 150 });
    expect(events("one").flatMap((event) => assembler.accept(event))).toEqual([]);
  });
  it("flushes a missing predecessor at drain without inventing an unfinished transcript", () => {
    const assembler = new UtteranceAssembler("microphone", 0);
    events("late", "missing").forEach((event) => assembler.accept(event));
    assembler.accept(events("unfinished")[0]);
    expect(assembler.flush(true).map((u) => u.id)).toEqual(["late"]);
  });
  it("uses the ephemeral token with realtime/calls and stops only cloned tracks after draining finals", async () => {
    const track = new Track(); const gap = vi.fn();
    const stream = new InteractionStream("capture", "microphone", new Stream([track]) as unknown as MediaStream, () => 200, gap);
    await stream.start();
    expect(request).toHaveBeenCalledWith("/capture/token", { source: "microphone" });
    expect(fetch).toHaveBeenCalledWith("https://api.openai.com/v1/realtime/calls", expect.objectContaining({ headers: { Authorization: "Bearer ephemeral", "Content-Type": "application/sdp" } }));
    const stop = stream.stop();
    expect(stream.stop()).toBe(stop);
    expect(track.clones[0].enabled).toBe(false);
    Peer.all[0].emit("final");
    await vi.advanceTimersByTimeAsync(2500); await stop;
    expect(request).toHaveBeenCalledWith("/capture/utterances", expect.objectContaining({ id: "final", source: "microphone", startMs: 210 }));
    expect(track.stop).not.toHaveBeenCalled(); expect(track.clones[0].stop).toHaveBeenCalledOnce();
    expect(gap).not.toHaveBeenCalled();
  });
  it("keeps system playback in a distinct source lane", async () => {
    const stream = new InteractionStream("capture", "system", new Stream([new Track()]) as unknown as MediaStream, () => 0, vi.fn());
    await stream.start(); Peer.all[0].emit("system-wake"); await Promise.resolve();
    expect(request).toHaveBeenCalledWith("/capture/utterances", expect.objectContaining({ source: "system", text: "Hey Brian, summarize" }));
    const done = stream.stop(); await vi.advanceTimersByTimeAsync(2500); await done;
  });
  it("serializes final delivery, retries with the same ID, and does not send a later question first", async () => {
    const stream = new InteractionStream("capture", "microphone", new Stream([new Track()]) as unknown as MediaStream, () => 0, vi.fn());
    await stream.start();
    request.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ok: true });
    Peer.all[0].emit("one"); Peer.all[0].emit("two", "one");
    await vi.advanceTimersByTimeAsync(1);
    expect(request.mock.calls.filter(([path]) => path.endsWith("utterances"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(request.mock.calls.filter(([path]) => path.endsWith("utterances")).map(([, body]) => body.id)).toEqual(["one", "one", "two"]);
    const done = stream.stop(); await vi.advanceTimersByTimeAsync(2500); await done;
  });
  it("retries startup and preserves pause/source identity across reconnect", async () => {
    const track = new Track(); const gap = vi.fn();
    request.mockRejectedValueOnce(new Error("token failed"));
    const stream = new InteractionStream("capture", "microphone", new Stream([track]) as unknown as MediaStream, () => 0, gap);
    stream.setPaused(true);
    const started = stream.start(); await vi.advanceTimersByTimeAsync(1000); await started;
    expect(gap).toHaveBeenCalled(); expect(track.clones[0].enabled).toBe(false);
    Peer.all[0].connectionState = "failed"; Peer.all[0].onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(2000);
    expect(Peer.all).toHaveLength(2); expect(track.clones[1].enabled).toBe(false);
    stream.setPaused(false); expect(track.clones[1].enabled).toBe(true);
    const done = stream.stop(); await vi.advanceTimersByTimeAsync(2500); await done;
    expect(track.stop).not.toHaveBeenCalled();
  });
  it("does not open a peer when stop wins an in-flight token request", async () => {
    let resolve!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const stream = new InteractionStream("capture", "microphone", new Stream([new Track()]) as unknown as MediaStream, () => 0, vi.fn());
    const start = stream.start(); const stop = stream.stop();
    resolve({ value: "late" }); await start;
    expect(Peer.all).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2500); await stop;
  });
});

it("resolves failed predecessors immediately, marks the gap, and ignores late replay", () => {
  const assembler = new UtteranceAssembler("microphone", 0);
  events("two", "one").forEach((event) => assembler.accept(event));
  const failed = { type: "conversation.item.input_audio_transcription.failed", item_id: "one" };
  expect(assembler.accept(failed)).toEqual([expect.objectContaining({ id: "two", discontinuity: true })]);
  expect(assembler.accept(failed)).toEqual([]);
  expect(events("one").flatMap((event) => assembler.accept(event))).toEqual([]);
  expect(events("three", "two").flatMap((event) => assembler.accept(event))).toEqual([expect.not.objectContaining({ discontinuity: true })]);
  expect(assembler.hasPending).toBe(false);
});
it("marks the next final after pause and reconnect, but not ordinary successors", async () => {
  const stream = new InteractionStream("capture", "microphone", new Stream([new Track()]) as unknown as MediaStream, () => 0, vi.fn());
  await stream.start();
  stream.setPaused(true); stream.setPaused(false);
  Peer.all[0].emit("after-pause"); Peer.all[0].emit("ordinary", "after-pause");
  await vi.advanceTimersByTimeAsync(1);
  expect(request).toHaveBeenCalledWith("/capture/utterances", expect.objectContaining({ id: "after-pause", discontinuity: true }));
  expect(request.mock.calls.find(([, body]) => body.id === "ordinary")?.[1].discontinuity).toBeUndefined();
  Peer.all[0].connectionState = "failed"; Peer.all[0].onconnectionstatechange?.();
  await vi.advanceTimersByTimeAsync(1000);
  Peer.all[1].emit("after-reconnect"); await vi.advanceTimersByTimeAsync(1);
  expect(request).toHaveBeenCalledWith("/capture/utterances", expect.objectContaining({ id: "after-reconnect", discontinuity: true }));
  const done = stream.stop(); await vi.advanceTimersByTimeAsync(2500); await done;
});
it("carries an exhausted delivery gap into the queued successor with stable retry payloads", async () => {
  const stream = new InteractionStream("capture", "microphone", new Stream([new Track()]) as unknown as MediaStream, () => 0, vi.fn());
  await stream.start();
  request.mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new Error("offline"));
  Peer.all[0].emit("lost"); Peer.all[0].emit("next", "lost");
  await vi.advanceTimersByTimeAsync(1500);
  const calls = request.mock.calls.filter(([path]) => path.endsWith("utterances"));
  expect(calls.map(([, body]) => body.id)).toEqual(["lost", "lost", "lost", "next"]);
  expect(calls[0][1]).toEqual(calls[2][1]);
  expect(calls[3][1].discontinuity).toBe(true);
  const done = stream.stop(); await vi.advanceTimersByTimeAsync(2500); await done;
});
