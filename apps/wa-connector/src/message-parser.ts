/**
 * Baileys protobuf message parsing.
 *
 * Extracts text, media placeholders, and reply context from Baileys' proto
 * messages. Ported from OpenClaw `inbound/extract.ts` — the message
 * unwrapping logic is copied verbatim since Baileys' protobuf nesting
 * (up to 4 levels) is easy to get wrong.
 *
 * See docs/architecture/channels/whatsapp.md.
 */

import type { proto } from '@whiskeysockets/baileys'
import {
  extractMessageContent,
  getContentType,
  normalizeMessageContent,
} from '@whiskeysockets/baileys'

// ── Message wrapper keys for nested unwrapping ──

const MESSAGE_WRAPPER_KEYS = [
  'botInvokeMessage',
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'groupMentionedMessage',
] as const

const MESSAGE_CONTENT_KEYS = [
  'conversation',
  'extendedTextMessage',
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
  'locationMessage',
  'liveLocationMessage',
  'contactMessage',
  'contactsArrayMessage',
  'buttonsResponseMessage',
  'listResponseMessage',
  'templateButtonReplyMessage',
  'interactiveResponseMessage',
  'buttonsMessage',
  'listMessage',
] as const

// ── Fallback normalizers (when Baileys exports are unavailable) ──

function fallbackNormalizeMessageContent(
  message: proto.IMessage | undefined,
): proto.IMessage | undefined {
  let current = message as unknown
  while (current && typeof current === 'object') {
    let unwrapped = false
    for (const key of MESSAGE_WRAPPER_KEYS) {
      const candidate = (current as Record<string, unknown>)[key]
      if (
        candidate &&
        typeof candidate === 'object' &&
        'message' in (candidate as Record<string, unknown>) &&
        (candidate as { message?: unknown }).message
      ) {
        current = (candidate as { message: unknown }).message
        unwrapped = true
        break
      }
    }
    if (!unwrapped) break
  }
  return current as proto.IMessage | undefined
}

function normalizeMessage(message: proto.IMessage | undefined): proto.IMessage | undefined {
  if (typeof normalizeMessageContent === 'function') {
    return normalizeMessageContent(message)
  }
  return fallbackNormalizeMessageContent(message)
}

function fallbackGetContentType(
  message: proto.IMessage | undefined,
): keyof proto.IMessage | undefined {
  const normalized = fallbackNormalizeMessageContent(message)
  if (!normalized || typeof normalized !== 'object') return undefined
  for (const key of MESSAGE_CONTENT_KEYS) {
    if ((normalized as Record<string, unknown>)[key] != null) {
      return key as keyof proto.IMessage
    }
  }
  return undefined
}

function getMessageContentType(
  message: proto.IMessage | undefined,
): keyof proto.IMessage | undefined {
  if (typeof getContentType === 'function') {
    return getContentType(message)
  }
  return fallbackGetContentType(message)
}

function extractMessage(message: proto.IMessage | undefined): proto.IMessage | undefined {
  if (typeof extractMessageContent === 'function') {
    return extractMessageContent(message) as proto.IMessage | undefined
  }
  const normalized = fallbackNormalizeMessageContent(message)
  const contentType = fallbackGetContentType(normalized)
  if (!normalized || !contentType || contentType === 'conversation') return normalized
  const candidate = (normalized as Record<string, unknown>)[contentType]
  return candidate && typeof candidate === 'object' ? (candidate as proto.IMessage) : normalized
}

// ── Message chain (handles up to 4 levels of nesting) ──

function getFutureProofInnerMessage(message: proto.IMessage): proto.IMessage | undefined {
  const contentType = getMessageContentType(message)
  const candidate = contentType ? (message as Record<string, unknown>)[contentType] : undefined
  if (
    candidate &&
    typeof candidate === 'object' &&
    'message' in candidate &&
    (candidate as { message?: unknown }).message &&
    typeof (candidate as { message: unknown }).message === 'object'
  ) {
    const inner = normalizeMessage((candidate as { message: proto.IMessage }).message)
    if (inner) {
      const innerType = getMessageContentType(inner)
      if (innerType && innerType !== contentType) return inner
    }
  }
  return undefined
}

function buildMessageChain(message: proto.IMessage | undefined): proto.IMessage[] {
  const chain: proto.IMessage[] = []
  let current = normalizeMessage(message)
  while (current && chain.length < 4) {
    chain.push(current)
    current = getFutureProofInnerMessage(current)
  }
  return chain
}

function unwrapMessage(message: proto.IMessage | undefined): proto.IMessage | undefined {
  const chain = buildMessageChain(message)
  return chain.at(-1)
}

// ── Context info extraction ──

function extractContextInfoFromMessage(message: proto.IMessage): proto.IContextInfo | undefined {
  const contentType = getMessageContentType(message)
  const candidate = contentType ? (message as Record<string, unknown>)[contentType] : undefined
  const contextInfo =
    candidate && typeof candidate === 'object' && 'contextInfo' in candidate
      ? (candidate as { contextInfo?: proto.IContextInfo }).contextInfo
      : undefined
  if (contextInfo) return contextInfo

  const fallback =
    message.extendedTextMessage?.contextInfo ??
    message.imageMessage?.contextInfo ??
    message.videoMessage?.contextInfo ??
    message.documentMessage?.contextInfo ??
    message.audioMessage?.contextInfo ??
    message.stickerMessage?.contextInfo
  if (fallback) return fallback

  for (const value of Object.values(message)) {
    if (!value || typeof value !== 'object') continue
    if ('contextInfo' in value) {
      const candidateContext = (value as { contextInfo?: proto.IContextInfo }).contextInfo
      if (candidateContext) return candidateContext
    }
    if ('message' in value) {
      const inner = (value as { message?: proto.IMessage }).message
      if (inner) {
        const innerCtx = extractContextInfo(inner)
        if (innerCtx) return innerCtx
      }
    }
  }
  return undefined
}

function extractContextInfo(message: proto.IMessage | undefined): proto.IContextInfo | undefined {
  for (const candidate of buildMessageChain(message)) {
    const contextInfo = extractContextInfoFromMessage(candidate)
    if (contextInfo) return contextInfo
  }
  return undefined
}

// ── Public API ──

export function extractText(rawMessage: proto.IMessage | undefined): string | undefined {
  const message = unwrapMessage(rawMessage)
  if (!message) return undefined

  const extracted = extractMessage(message)
  const candidates = [message, extracted && extracted !== message ? extracted : undefined]

  for (const candidate of candidates) {
    if (!candidate) continue

    if (typeof candidate.conversation === 'string' && candidate.conversation.trim()) {
      return candidate.conversation.trim()
    }
    const extended = candidate.extendedTextMessage?.text
    if (extended?.trim()) return extended.trim()

    const caption =
      candidate.imageMessage?.caption ??
      candidate.videoMessage?.caption ??
      candidate.documentMessage?.caption
    if (caption?.trim()) return caption.trim()
  }

  return undefined
}

export function extractMediaPlaceholder(
  rawMessage: proto.IMessage | undefined,
): string | undefined {
  const message = unwrapMessage(rawMessage)
  if (!message) return undefined

  if (message.imageMessage) return '<media:image>'
  if (message.videoMessage) return '<media:video>'
  if (message.audioMessage) return '<media:audio>'
  if (message.documentMessage) return '<media:document>'
  if (message.stickerMessage) return '<media:sticker>'
  return undefined
}

/**
 * Extract the MIME type and optional filename from a media message.
 * Returns null if the message contains no downloadable media.
 */
/** Coerce a Baileys `fileLength` (Long | number | null) to a plain number. */
function toFileLength(v: unknown): number | undefined {
  if (v == null) return undefined
  const n = typeof v === 'object' && 'toNumber' in (v as object)
    ? (v as { toNumber: () => number }).toNumber()
    : Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export type MediaInfo = {
  mediaType: 'image' | 'video' | 'audio' | 'document' | 'sticker'
  mimeType: string
  fileName?: string
  fileLength?: number
  /** True for a push-to-talk voice note (`audioMessage.ptt`), false for an audio FILE. */
  isVoiceNote?: boolean
}

export function extractMediaInfo(
  rawMessage: proto.IMessage | undefined,
): MediaInfo | null {
  const message = unwrapMessage(rawMessage)
  if (!message) return null

  if (message.imageMessage) {
    return {
      mediaType: 'image',
      mimeType: message.imageMessage.mimetype ?? 'image/jpeg',
      fileName: message.imageMessage.caption ? undefined : undefined,
      fileLength: toFileLength(message.imageMessage.fileLength),
    }
  }
  if (message.videoMessage) {
    return {
      mediaType: 'video',
      mimeType: message.videoMessage.mimetype ?? 'video/mp4',
      fileLength: toFileLength(message.videoMessage.fileLength),
    }
  }
  if (message.audioMessage) {
    return {
      mediaType: 'audio',
      mimeType: message.audioMessage.mimetype ?? 'audio/ogg',
      fileLength: toFileLength(message.audioMessage.fileLength),
      isVoiceNote: message.audioMessage.ptt === true,
    }
  }
  if (message.documentMessage) {
    return {
      mediaType: 'document',
      mimeType: message.documentMessage.mimetype ?? 'application/octet-stream',
      fileName: message.documentMessage.fileName ?? undefined,
      fileLength: toFileLength(message.documentMessage.fileLength),
    }
  }
  if (message.stickerMessage) {
    return {
      mediaType: 'sticker',
      mimeType: message.stickerMessage.mimetype ?? 'image/webp',
      fileLength: toFileLength(message.stickerMessage.fileLength),
    }
  }
  return null
}

/**
 * Check if a media message is downloadable.
 * Audio is downloaded so the API-side voice-transcription preflight can
 * turn it into `[voice] <transcript>` text.
 * See docs/architecture/media/transcription.md.
 */
export function isDownloadableMedia(
  rawMessage: proto.IMessage | undefined,
): boolean {
  const message = unwrapMessage(rawMessage)
  if (!message) return false
  return !!(
    message.imageMessage ||
    message.videoMessage ||
    message.documentMessage ||
    message.stickerMessage ||
    message.audioMessage
  )
}

export type ReplyContext = {
  id?: string
  body: string
  senderJid?: string
}

export function describeReplyContext(
  rawMessage: proto.IMessage | undefined,
): ReplyContext | null {
  const message = unwrapMessage(rawMessage)
  if (!message) return null

  const contextInfo = extractContextInfo(message)
  const quoted = normalizeMessage(contextInfo?.quotedMessage as proto.IMessage | undefined)
  if (!quoted) return null

  let body: string | undefined = extractText(quoted)
  if (!body) body = extractMediaPlaceholder(quoted)
  if (!body) return null

  return {
    id: contextInfo?.stanzaId ? String(contextInfo.stanzaId) : undefined,
    body,
    senderJid: contextInfo?.participant ?? undefined,
  }
}

export function extractMentionedJids(rawMessage: proto.IMessage | undefined): string[] | undefined {
  const message = unwrapMessage(rawMessage)
  if (!message) return undefined

  const candidates: Array<string[] | null | undefined> = [
    message.extendedTextMessage?.contextInfo?.mentionedJid,
    message.imageMessage?.contextInfo?.mentionedJid,
    message.videoMessage?.contextInfo?.mentionedJid,
    message.documentMessage?.contextInfo?.mentionedJid,
    message.audioMessage?.contextInfo?.mentionedJid,
    message.stickerMessage?.contextInfo?.mentionedJid,
  ]

  const flattened = candidates.flatMap((arr) => arr ?? []).filter(Boolean)
  if (flattened.length === 0) return undefined
  return Array.from(new Set(flattened))
}

// ── Edit detection ──

/**
 * Check if a message is a protocol-level edit (type 14 = MESSAGE_EDIT).
 * Returns the edited text + original message ID, or null if not an edit.
 */
export function extractEditedMessage(
  rawMessage: proto.IMessage | undefined,
): { text: string; editedMessageId: string } | null {
  const pm = rawMessage?.protocolMessage
  if (!pm) return null

  // Protocol message type 14 = MESSAGE_EDIT
  if (pm.type !== 14) return null

  const editedMsg = pm.editedMessage
  if (!editedMsg) return null

  const text = extractText(editedMsg)
  if (!text) return null

  const editedMessageId = pm.key?.id
  if (!editedMessageId) return null

  return { text, editedMessageId }
}

// ── Normalized inbound message type ──

export type WhatsAppIncomingMessage = {
  messageId: string
  channelId: string
  chatJid: string
  senderJid: string
  /**
   * The sender's phone-number JID when `senderJid` is a LID (privacy
   * addressing) and the PN twin is known (key alt fields or the synced
   * LID mapping). Absent when the sender is already PN-addressed or the
   * mapping is not yet known.
   */
  senderPnJid?: string
  senderName?: string
  text: string
  isGroup: boolean
  timestamp: number
  quotedMessageId?: string
  quotedBody?: string
  /** True if this message is an edit of a previously sent message. */
  isEdit?: boolean
  /** The original message ID that was edited. */
  editedMessageId?: string
  /** Base64-encoded media content (image, document, video). */
  mediaBase64?: string
  /** MIME type of the media (e.g. 'image/jpeg', 'application/pdf'). */
  mediaMimeType?: string
  /** Original filename for the media, if available. */
  mediaFileName?: string
  /**
   * Large media (over the inline cap) the connector streamed straight to GCS —
   * a reference, not the bytes. Mutually exclusive with `mediaBase64`. The API
   * routes this through the channel-media intake.
   */
  mediaRef?: {
    /** Local chat-archive staging asset, completed by the API on inbound. */
    assetId?: string
    gcsKey: string
    /** BYO storage URI (bytes live in the workspace's own bucket); echoed from the mint. */
    storageUri?: string
    mimeType: string
    fileName?: string
    sizeBytes?: number
  }
}
