import type { IncomingMessage } from '@use-brian/channels'
import type { DispatchEvent, WorkflowEventDispatcher } from '@use-brian/core'

export type IncomingMessageEventInput = {
  workspaceId: string
  integrationId: string
  incoming: IncomingMessage & { channelType: string; mentions?: string[]; threadId?: string }
  isBot?: boolean
  providerAccountId?: string
  payload?: Record<string, unknown>
}

let messageEventDispatcher: WorkflowEventDispatcher | undefined

/** Boot seam; passing undefined also clears the dispatcher during teardown. */
export function setMessageEventDispatcher(dispatcher: WorkflowEventDispatcher | undefined): void {
  messageEventDispatcher = dispatcher
}

/** Provider-independent workflow envelope. Provider extras belong in payload. */
export function normalizeIncomingMessageEvent(input: IncomingMessageEventInput): DispatchEvent {
  const { incoming, workspaceId, integrationId, providerAccountId, payload } = input
  const isBot = input.isBot ?? false
  // Most adapters use epoch milliseconds; Cloud API and older producers use
  // seconds. Normalize both without coupling the workflow layer to providers.
  const timestampMs = Math.abs(incoming.timestamp) < 100_000_000_000
    ? incoming.timestamp * 1000 : incoming.timestamp
  const date = new Date(timestampMs)
  return {
    workspaceId,
    source: { type: 'channel', channelIntegrationId: integrationId, channel: incoming.channelType },
    text: incoming.text || null,
    actorId: incoming.userId,
    channelId: incoming.channelId,
    mentions: incoming.mentions ?? [],
    isBot,
    isGroupChat: incoming.isGroupChat,
    ...(providerAccountId !== undefined ? { providerAccountId } : {}),
    ...(Number.isFinite(date.getTime()) ? { occurredAt: date.toISOString() } : {}),
    payload: {
      message_id: incoming.messageId ?? null,
      text: incoming.text,
      user: incoming.userId,
      channel: incoming.channelId,
      channel_id: incoming.channelId,
      is_bot: isBot,
      thread_id: incoming.threadId ?? null,
      reply_to_message_id: incoming.replyToMessageId ?? null,
      is_edit: incoming.isEdit ?? false,
      media_type: incoming.mediaType ?? null,
      media_mime: incoming.mediaMime ?? null,
      media_name: incoming.mediaName ?? null,
      media_duration_sec: incoming.mediaDurationSec ?? null,
      media_size_bytes: incoming.mediaSizeBytes ?? null,
      // Copy only descriptive metadata, never transport URLs or raw envelopes.
      files: (incoming.files ?? []).map(file => ({
        name: file.name, mime_type: file.mimeType, size_bytes: file.sizeBytes ?? null,
      })),
      ...payload,
    },
  }
}

/** Best-effort: workflow failures must never interrupt the conversational turn.
 * Producers must exclude transport callbacks and self echoes before calling.
 */
export async function dispatchIncomingMessageEvent(
  input: IncomingMessageEventInput,
  dispatcher: WorkflowEventDispatcher | undefined = messageEventDispatcher,
): Promise<void> {
  if (!dispatcher) return
  try {
    await dispatcher.dispatch(normalizeIncomingMessageEvent(input))
  } catch (error) {
    console.error('[message-events] workflow event dispatch failed:', error)
  }
}
