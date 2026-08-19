/**
 * Pure mapping: agent-wechat Message + Chat (+ the media fetch outcome) →
 * BridgeInbound.message. Spec: docs/architecture/channels/wechat-desktop.md
 * → "Monitor" step 2.
 */
import type { AgentWechatChat, AgentWechatMediaResult, AgentWechatMessage } from './agent-wechat-client.js'
import type { BridgeInboundMedia, BridgeInboundMessage, BridgeMediaKind } from './protocol-types.js'

const MSG_TYPE = {
  TEXT: 1,
  IMAGE: 3,
  VOICE: 34,
  VIDEO: 43,
  STICKER: 47,
  APP: 49,
  SYSTEM: 10000,
  SYSTEM_RECALL: 10002,
} as const

/** Message types whose row may carry a downloadable attachment. */
const MEDIA_TYPES = new Set<number>([MSG_TYPE.IMAGE, MSG_TYPE.VOICE, MSG_TYPE.VIDEO, MSG_TYPE.APP])
const SKIP_TYPES = new Set<number>([MSG_TYPE.SYSTEM, MSG_TYPE.SYSTEM_RECALL])

export const ATTACHMENT_UNAVAILABLE = '[attachment unavailable]'

const MIME_BY_FORMAT: Record<string, string> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  mp3: 'audio/mpeg',
  silk: 'audio/silk',
  amr: 'audio/amr',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  md: 'text/markdown',
}

function baseMessageType(type: number): number {
  return type & 0x7fffffff
}

/** Whether the monitor should try `GET /media/:localId` for this row. */
export function messageMayHaveMedia(msg: Pick<AgentWechatMessage, 'type'>): boolean {
  return MEDIA_TYPES.has(baseMessageType(msg.type))
}

export type MediaOutcome =
  /** Bytes arrived. */
  | { status: 'fetched'; result: AgentWechatMediaResult }
  /** The container says this row carries no media (type 'unsupported'). */
  | { status: 'unsupported' }
  /** Retries exhausted with no bytes. */
  | { status: 'unavailable' }
  /** Not attempted (row type has no media). */
  | { status: 'not_applicable' }

export function mimeForMedia(result: Pick<AgentWechatMediaResult, 'format' | 'type'>): string {
  const fmt = (result.format ?? '').toLowerCase().replace(/^\./, '')
  const known = MIME_BY_FORMAT[fmt]
  if (known) return known
  if (result.type === 'image') return fmt ? `image/${fmt}` : 'image/jpeg'
  if (result.type === 'voice') return fmt ? `audio/${fmt}` : 'audio/mpeg'
  if (result.type === 'video') return fmt ? `video/${fmt}` : 'video/mp4'
  return 'application/octet-stream'
}

function mediaKind(result: AgentWechatMediaResult, msgType: number): BridgeMediaKind {
  switch (result.type) {
    case 'image':
      return 'image'
    case 'voice':
      return 'voice'
    case 'video':
      return 'video'
    case 'file':
      return 'document'
  }
  switch (msgType) {
    case MSG_TYPE.IMAGE:
      return 'image'
    case MSG_TYPE.VOICE:
      return 'voice'
    case MSG_TYPE.VIDEO:
      return 'video'
    default:
      return 'document'
  }
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** `<title>…</title>` from an app-message XML body, or null. */
export function extractAppMessageTitle(content: string): string | null {
  if (!content) return null
  const src = content.includes('&lt;') ? unescapeXml(content) : content
  const m = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(src)
  const title = m?.[1]?.trim()
  return title ? title : null
}

function approxDecodedBytes(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding)
}

function toMedia(result: AgentWechatMediaResult, msg: AgentWechatMessage): BridgeInboundMedia | null {
  if (!result.data) return null
  const mime = mimeForMedia(result)
  const ext = (result.format ?? '').replace(/^\./, '')
  const name = result.filename?.trim() || `${msg.localId}${ext ? `.${ext}` : ''}`
  return {
    kind: mediaKind(result, baseMessageType(msg.type)),
    mime,
    name,
    dataBase64: result.data,
    sizeBytes: approxDecodedBytes(result.data),
  }
}

function messageIdOf(msg: AgentWechatMessage): string {
  return msg.serverId && msg.serverId > 0 ? String(msg.serverId) : `local-${msg.localId}`
}

function isGroupChat(chat: Pick<AgentWechatChat, 'isGroup' | 'id' | 'username'>): boolean {
  const id = chat.id || chat.username || ''
  return chat.isGroup === true || id.endsWith('@chatroom')
}

/**
 * Map one row. Returns null for rows the bridge never forwards (system
 * notices). `media` is the outcome of the monitor's fetch for this row.
 */
export function mapMessage(
  msg: AgentWechatMessage,
  chat: AgentWechatChat,
  media: MediaOutcome = { status: 'not_applicable' },
): BridgeInboundMessage | null {
  const type = baseMessageType(msg.type)
  if (SKIP_TYPES.has(type)) return null

  const chatId = chat.id || chat.username || msg.chatId
  const group = isGroupChat(chat)
  const content = (msg.content ?? '').trim()

  let text: string
  let mediaItems: BridgeInboundMedia[] | undefined

  const fetched = media.status === 'fetched' ? toMedia(media.result, msg) : null
  if (fetched) {
    mediaItems = [fetched]
    if (type === MSG_TYPE.APP) {
      // For files the content is the XML envelope; the filename is the useful text.
      text = fetched.name
    } else {
      text = ''
    }
  } else if (type === MSG_TYPE.TEXT) {
    text = content
  } else if (type === MSG_TYPE.STICKER) {
    text = '[sticker]'
  } else if (type === MSG_TYPE.APP) {
    const title = extractAppMessageTitle(content)
    text = title ? `[link] ${title}` : content
    if (media.status === 'unavailable') text = text ? `${text} ${ATTACHMENT_UNAVAILABLE}` : ATTACHMENT_UNAVAILABLE
  } else if (MEDIA_TYPES.has(type)) {
    text = ATTACHMENT_UNAVAILABLE
  } else {
    text = content
  }

  let replyToMessageId: string | undefined
  if (msg.reply) {
    if (msg.reply.messageId) {
      replyToMessageId = msg.reply.messageId
    } else {
      const quoted = msg.reply.content.length > 200 ? `${msg.reply.content.slice(0, 200)}...` : msg.reply.content
      const block = `[Replying to ${msg.reply.sender ?? 'unknown sender'}]\n${quoted}\n[/Replying]`
      text = text ? `${text}\n\n${block}` : block
    }
  }

  const senderId = msg.sender ?? chatId
  const senderName = msg.senderName ?? (group ? msg.sender : chat.remark || chat.name)
  const parsedTs = Date.parse(msg.timestamp)

  const out: BridgeInboundMessage = {
    peerId: chatId,
    peerName: chat.remark || chat.name || undefined,
    senderId,
    senderName: senderName || undefined,
    messageId: messageIdOf(msg),
    text,
    timestamp: Number.isFinite(parsedTs) ? parsedTs : Date.now(),
    isGroupChat: group,
    isMentioned: msg.isMentioned === true,
    isSelf: msg.isSelf === true,
  }
  if (replyToMessageId) out.replyToMessageId = replyToMessageId
  if (mediaItems) out.media = mediaItems
  return out
}
