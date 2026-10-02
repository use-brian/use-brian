import { interactionRequest, type InteractionCapture, type InteractionUtterance } from "./api";
import { dispatchLiveTranscriptWindow } from "@/lib/recordings/live-transcript-events";
import { InteractionStream } from "./stream";

export async function startInteractionCapture(
  binding: { workspaceId: string; pageId: string; chatSessionId: string; assistantId: string },
  sources: { microphone: MediaStream; system: MediaStream | null },
  clock: () => number,
  onGap: () => void,
  signal?: AbortSignal,
  onCaptureStarted?: (captureId: string) => void,
) {
  const capture = await interactionRequest<InteractionCapture>("/start", binding);
  // A stop/disable can win while /start is still in flight. Do not acquire
  // streaming tracks for that stale capture, but still close its server state.
  if (signal?.aborted) {
    await interactionRequest(`/${capture.id}/stop`, {});
    return { captureId: capture.id, pause: (_paused: boolean) => {}, stop: async () => {} };
  }
  onCaptureStarted?.(capture.id);
  const onPersisted = (u: InteractionUtterance) => dispatchLiveTranscriptWindow({
    pageId: binding.pageId, chunkId: `stream:${capture.id}:${u.id}`,
    offsetMs: u.startMs, durationMs: Math.max(1, u.endMs - u.startMs),
    missedBefore: u.discontinuity ? 1 : 0,
    lines: u.text.trim() ? [{ speaker: null, text: u.text }] : [],
  });
  const streams = [new InteractionStream(capture.id, "microphone", sources.microphone, clock, onGap, onPersisted)];
  if (sources.system) streams.push(new InteractionStream(capture.id, "system", sources.system, clock, onGap, onPersisted));
  const abort = () => { for (const stream of streams) void stream.stop(); };
  signal?.addEventListener("abort", abort, { once: true });
  await Promise.all(streams.map(async (stream) => { try { await stream.start(); } catch { onGap(); } }));
  let stopping: Promise<void> | undefined;
  return {
    captureId: capture.id,
    pause: (paused: boolean) => streams.forEach((stream) => stream.setPaused(paused)),
    stop: () => stopping ??= (async () => {
      signal?.removeEventListener("abort", abort);
      await Promise.all(streams.map((stream) => stream.stop()));
      try { await interactionRequest(`/${capture.id}/stop`, {}); } catch { onGap(); }
    })(),
  };
}

/** Typed controls never enter the ASR stream or its upload retry queue. */
export function controlInteractionQuestion(captureId: string, action: "submit" | "cancel", text?: string, id = crypto.randomUUID()) {
  return interactionRequest(`/${captureId}/question`, { id, action, ...(text === undefined ? {} : { text }) });
}
