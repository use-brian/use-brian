import { interactionRequest, type InteractionCapture } from "./api";

/** Interaction uses the existing live-window uploads; no separate audio transport. */
export async function startInteractionCapture(
  binding: { workspaceId: string; pageId: string; chatSessionId: string; assistantId: string },
  onGap: () => void,
  signal?: AbortSignal,
  onCaptureStarted?: (captureId: string) => void,
) {
  const capture = await interactionRequest<InteractionCapture>("/start", binding);
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= interactionRequest(`/${capture.id}/stop`, {}).then(() => {}).catch(onGap);
  if (signal?.aborted) await stop();
  else onCaptureStarted?.(capture.id);
  return { captureId: capture.id, stop };
}

/** Typed controls never enter the audio upload queue. */
export function controlInteractionQuestion(captureId: string, action: "submit" | "cancel", text?: string, id = crypto.randomUUID()) {
  return interactionRequest(`/${captureId}/question`, { id, action, ...(text === undefined ? {} : { text }) });
}
