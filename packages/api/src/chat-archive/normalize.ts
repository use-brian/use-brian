/** Provider-neutral live-channel normalization for the local chat archive. */

import { createHash } from 'node:crypto'
import type { IncomingMessage, OutgoingDocument } from '@use-brian/channels'
import type { CanonicalIngestMessage } from '@use-brian/shared'

function sentAt(value: number): string {
  const millis = Number.isFinite(value) ? (value < 1_000_000_000_000 ? value * 1000 : value) : 0
  return new Date(millis).toISOString()
}

function derivedMessageId(source: string, message: IncomingMessage): string {
  return `derived:${createHash('sha256').update(JSON.stringify({
    source,
    conversationId: message.channelId,
    senderId: message.userId,
    timestamp: message.timestamp,
    text: message.text,
    mediaType: message.mediaType ?? null,
    mediaUrl: message.mediaUrl ?? message.files?.[0]?.url ?? null,
    replyTo: message.replyToMessageId ?? null,
  })).digest('hex')}`
}

function mediaKind(message: IncomingMessage): CanonicalIngestMessage['kind'] {
  if (message.mediaType === 'photo') return 'image'
  if (message.mediaType === 'voice' || message.mediaType === 'audio') return 'voice'
  if (message.mediaType || message.files?.length) return 'file'
  if (/^https?:\/\/\S+$/i.test(message.text.trim())) return 'link'
  return 'text'
}

function mediaRef(message: IncomingMessage): CanonicalIngestMessage['media_ref'] {
  const file = message.files?.[0]
  if (!message.mediaType && !message.mediaUrl && !file) return null
  return {
    filename: message.mediaName || file?.name || 'attachment',
    mime: message.mediaMime || file?.mimeType || 'application/octet-stream',
    size_bytes: Math.max(0, Math.trunc(message.mediaSizeBytes ?? 0)),
  }
}

export function normalizeInboundChatMessage(input: {
  source: string
  message: IncomingMessage
}): CanonicalIngestMessage {
  const { source, message } = input
  return {
    provider_message_id: message.messageId || derivedMessageId(source, message),
    conversation_id: message.channelId,
    sender_id: message.userId,
    sender_display: null,
    sent_at: sentAt(message.timestamp),
    direction: 'inbound',
    kind: mediaKind(message),
    body_text: message.text.length > 0 ? message.text : null,
    media_ref: mediaRef(message),
    reply_to_provider_id: message.replyToMessageId ?? null,
    // Provider payloads can contain tokens and connector secrets. Live capture
    // needs no reparsing, so the safest sanitized payload is no payload.
    raw_provider_blob: null,
  }
}

export function normalizeOutboundChatMessage(input: {
  providerMessageId: string
  conversationId: string
  assistantId: string
  assistantName: string
  text: string
  sentAt?: Date
  documents?: OutgoingDocument[]
  replyToProviderId?: string | null
}): CanonicalIngestMessage {
  const document = input.documents?.[0]
  return {
    provider_message_id: input.providerMessageId,
    conversation_id: input.conversationId,
    sender_id: input.assistantId,
    sender_display: input.assistantName,
    sent_at: (input.sentAt ?? new Date()).toISOString(),
    direction: 'outbound',
    kind: document ? 'file' : (/^https?:\/\/\S+$/i.test(input.text.trim()) ? 'link' : 'text'),
    body_text: input.text.length > 0 ? input.text : null,
    media_ref: document ? {
      filename: document.filename,
      mime: document.mime,
      size_bytes: document.data.byteLength,
    } : null,
    reply_to_provider_id: input.replyToProviderId ?? null,
    raw_provider_blob: null,
  }
}
