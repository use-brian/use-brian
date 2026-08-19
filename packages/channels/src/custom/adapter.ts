/**
 * Custom (bridge-driven) channel adapter.
 *
 * The adapter never talks to a messaging platform. Outbound work is appended
 * to a per-channel DB outbox that the operator-run bridge long-polls
 * (`GET /bridge/v1/channels/:id/outbox`), so `sendMessage` enqueues a
 * `message` item and returns the OUTBOX ITEM ID as the channel message id;
 * the bridge's `providerMessageId` in its ack is recorded on the item.
 * `sendTypingIndicator` enqueues `typing {on:true}`; the route enqueues
 * `typing {on:false}` on cleanup. No message edits (the bridge has no edit
 * contract in v1), no status messages.
 *
 * `parseIncoming` takes an already-normalized `BridgeInboundMessage` (the
 * bridge does the platform parsing) and maps it onto `IncomingMessage`:
 * `userId` = senderId, `channelId` = peerId (the session key: a group is one
 * shared session, a DM one per contact).
 *
 * Outbound markdown passes through as `format:'markdown'`; the bridge decides
 * how to render it for its platform. Documents ride inline as base64 — but
 * v1 does not model bridge capabilities, so `custom` is NOT in
 * `DOCUMENT_CAPABLE_CHANNELS` and `sendFile` refuses (the field is in the
 * wire type so v2 can flip it without a protocol change).
 *
 * See docs/architecture/channels/custom-channel.md.
 * Component tag: [COMP:channels/custom-adapter].
 */

import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from '../types.js'
import type { BridgeInboundMessage, OutboxMessagePayload } from './protocol.js'

// Chunk like Telegram/WeChat: the bridge may re-chunk for its platform.
const CUSTOM_MAX_MESSAGE_LENGTH = 4000

/** What the adapter appends to the outbox; the API's store implements it. */
export type CustomOutboxEnqueue = (item: {
  type: 'message' | 'typing'
  peerId: string
  payload: Record<string, unknown>
}) => Promise<string>

export type CustomAdapterOptions = {
  /** Append an item to the channel's outbox; resolves to the item id. */
  enqueue: CustomOutboxEnqueue
}

function mediaHints(msg: BridgeInboundMessage): Pick<IncomingMessage, 'mediaType' | 'mediaMime' | 'mediaName' | 'mediaSizeBytes' | 'mediaDurationSec'> {
  const first = msg.media?.[0]
  if (!first) return {}
  return {
    mediaType: first.kind === 'image' ? 'photo' : first.kind,
    mediaMime: first.mime,
    mediaName: first.name,
    mediaSizeBytes: first.sizeBytes,
    mediaDurationSec: first.durationSec,
  }
}

function isBridgeInboundMessage(value: unknown): value is BridgeInboundMessage {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.peerId === 'string' && v.peerId.length > 0
    && typeof v.senderId === 'string' && v.senderId.length > 0
    && typeof v.messageId === 'string'
    && typeof v.text === 'string'
}

export function createCustomAdapter(options: CustomAdapterOptions): ChannelAdapter {
  return {
    type: 'custom',
    maxMessageLength: CUSTOM_MAX_MESSAGE_LENGTH,
    supportsMarkdown: true,
    supportsMessageEdit: false,
    drainDelayMs: 2000,

    parseIncoming(payload: unknown): IncomingMessage | null {
      if (!isBridgeInboundMessage(payload)) return null
      const msg = payload
      if (!msg.text && !(msg.media && msg.media.length > 0)) return null
      return {
        userId: msg.senderId,
        channelId: msg.peerId,
        messageId: msg.messageId,
        text: msg.text ?? '',
        ...mediaHints(msg),
        replyToMessageId: msg.replyToMessageId,
        isGroupChat: Boolean(msg.isGroupChat),
        // A DM is always addressed to the bridge account; a group message is
        // addressed only when the bridge says so.
        isMentioned: msg.isGroupChat ? Boolean(msg.isMentioned) : true,
        timestamp: typeof msg.timestamp === 'number' && Number.isFinite(msg.timestamp)
          ? msg.timestamp
          : Date.now(),
        raw: msg,
      }
    },

    deduplicateId(payload: unknown): string | null {
      if (!isBridgeInboundMessage(payload)) return null
      return `${payload.peerId}:${payload.messageId}`
    },

    async sendMessage(channelId: string, response: OutgoingMessage): Promise<string> {
      if (!response.text.trim() && !(response.documents && response.documents.length > 0)) return ''
      const payload: OutboxMessagePayload = {
        text: response.text,
        format: response.format === 'markdown' ? 'markdown' : 'plain',
      }
      if (response.documents && response.documents.length > 0) {
        payload.documents = response.documents.map((d) => ({
          filename: d.filename,
          mime: d.mime,
          dataBase64: Buffer.from(d.data).toString('base64'),
          ...(d.caption ? { caption: d.caption } : {}),
        }))
      }
      return options.enqueue({ type: 'message', peerId: channelId, payload: payload as unknown as Record<string, unknown> })
    },

    async editMessage(): Promise<void> {
      // The bridge protocol has no edit contract in v1; callers gate on supportsMessageEdit.
      throw new Error('Custom channels do not support message edits')
    },

    async sendTypingIndicator(channelId: string): Promise<void> {
      try {
        await options.enqueue({ type: 'typing', peerId: channelId, payload: { on: true } })
      } catch {
        // Non-critical.
      }
    },

    async sendStatus(): Promise<string> {
      // No edit support — a status message would land as a permanent extra
      // message. The route drives the typing indicator instead.
      return ''
    },
  }
}
