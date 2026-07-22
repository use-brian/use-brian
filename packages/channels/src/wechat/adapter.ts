/**
 * WeChat (iLink bot) channel adapter.
 *
 * DMs only: iLink does not deliver ordinary group events for bot accounts, and
 * any message that does arrive carrying a `group_id` is dropped outright —
 * never half-handled. The bot is its own contact identity (QR-bound), so
 * `channelId` == the peer's `ilink_user_id`.
 *
 * Outbound sends must echo the per-user `context_token` the last inbound
 * message carried (an iLink protocol requirement) — the route supplies it via
 * `getContextToken`, backed by the `wechat_context_tokens` table. No message
 * edits on WeChat, so no edit-in-place status flow; the route uses the native
 * typing indicator instead.
 *
 * See docs/architecture/channels/wechat.md. Component tag:
 * [COMP:channels/wechat-adapter].
 */

import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from '../types.js'
import { chunkText } from '../chunking.js'
import {
  createIlinkClient,
  WeixinItemType,
  WeixinMessageState,
  WeixinMessageType,
  type WeixinMessage,
  type WeixinMessageItem,
} from './ilink.js'
import { findWechatMediaItem } from './media.js'
import { markdownToWechat } from './markdown.js'

// WeChat text messages are comfortable well below the platform's byte cap;
// chunk at 4000 chars like Telegram (headroom for CJK byte inflation).
const WECHAT_MAX_MESSAGE_LENGTH = 4000

export type WechatAdapterOptions = {
  /** Per-bot API base from QR-login confirm (falls back to the fixed base). */
  baseUrl: string
  botToken: string
  /**
   * Resolve the `context_token` to echo when sending to a user. Absent or
   * returning undefined, sends go out without context (iLink accepts it but
   * may route degraded — the route should always supply this).
   */
  getContextToken?: (ilinkUserId: string) => Promise<string | undefined> | string | undefined
  /**
   * Typing-ticket resolver for `sendTypingIndicator` (fetched per-user via
   * `getconfig`). Absent, the typing indicator is a no-op.
   */
  getTypingTicket?: (ilinkUserId: string) => Promise<string | undefined> | string | undefined
}

function generateClientId(): string {
  return `usebrian-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Extract the text body: first TEXT item (with quoted-message prefix), else voice STT. */
function textFromItemList(itemList: WeixinMessageItem[] | undefined): string {
  if (!itemList?.length) return ''
  for (const item of itemList) {
    if (item.type === WeixinItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text)
      const ref = item.ref_msg
      if (!ref) return text
      // Quoted media is surfaced via the media path; only quote text refs.
      const parts: string[] = []
      if (ref.title) parts.push(ref.title)
      const refText = ref.message_item?.text_item?.text
      if (refText) parts.push(refText)
      if (parts.length === 0) return text
      return `[Quoted: ${parts.join(' | ')}]\n${text}`
    }
    // Voice with server-side STT: the transcript is the message.
    if (item.type === WeixinItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text
    }
  }
  return ''
}

function mediaHints(item: WeixinMessageItem | null): Pick<IncomingMessage, 'mediaType' | 'mediaName' | 'mediaDurationSec' | 'mediaSizeBytes'> {
  if (!item) return {}
  switch (item.type) {
    case WeixinItemType.IMAGE:
      return { mediaType: 'photo' }
    case WeixinItemType.VIDEO:
      return {
        mediaType: 'video',
        mediaDurationSec: item.video_item?.play_length || undefined,
        mediaSizeBytes: item.video_item?.video_size || undefined,
      }
    case WeixinItemType.FILE:
      return {
        mediaType: 'document',
        mediaName: item.file_item?.file_name ?? undefined,
        mediaSizeBytes: item.file_item?.len ? Number(item.file_item.len) || undefined : undefined,
      }
    case WeixinItemType.VOICE:
      return {
        mediaType: 'voice',
        mediaDurationSec: item.voice_item?.playtime
          ? Math.round(item.voice_item.playtime / 1000)
          : undefined,
      }
    default:
      return {}
  }
}

function extractWeixinMessage(payload: unknown): WeixinMessage | null {
  const maybe = payload as WeixinMessage
  if (maybe && typeof maybe === 'object' && typeof maybe.from_user_id === 'string' && maybe.from_user_id) {
    return maybe
  }
  return null
}

export function createWechatAdapter(options: WechatAdapterOptions): ChannelAdapter {
  const client = createIlinkClient({ baseUrl: options.baseUrl, token: options.botToken })

  return {
    type: 'wechat',
    maxMessageLength: WECHAT_MAX_MESSAGE_LENGTH,
    supportsMarkdown: true,
    supportsMessageEdit: false,
    drainDelayMs: 2000,

    parseIncoming(webhookPayload: unknown): IncomingMessage | null {
      const msg = extractWeixinMessage(webhookPayload)
      if (!msg) return null
      // Only user-authored messages — BOT-type messages are our own echoes.
      if (msg.message_type !== WeixinMessageType.USER) return null
      // Streaming intermediates never reach a bot in practice; skip non-final.
      if (msg.message_state != null && msg.message_state !== WeixinMessageState.FINISH) return null
      // DMs only (W2): a group event is dropped whole, never half-handled.
      if (msg.group_id) return null

      const text = textFromItemList(msg.item_list)
      const mediaItem = findWechatMediaItem(msg.item_list)
      if (!text && !mediaItem) return null

      return {
        userId: msg.from_user_id!,
        // The DM peer IS the conversation: channelId = the sender's iLink id.
        channelId: msg.from_user_id!,
        messageId:
          msg.message_id != null ? String(msg.message_id) : msg.client_id ?? undefined,
        text,
        ...mediaHints(mediaItem),
        isGroupChat: false,
        isMentioned: true,
        timestamp: msg.create_time_ms ?? Date.now(),
        raw: msg,
      }
    },

    deduplicateId(webhookPayload: unknown): string | null {
      const msg = extractWeixinMessage(webhookPayload)
      if (!msg) return null
      if (msg.message_id != null) return `${msg.from_user_id}:${msg.message_id}`
      if (msg.client_id) return `${msg.from_user_id}:${msg.client_id}`
      if (msg.seq != null) return `${msg.from_user_id}:seq:${msg.seq}`
      return null
    },

    async sendMessage(channelId: string, response: OutgoingMessage): Promise<string> {
      if (!response.text.trim()) return ''
      const text = response.format === 'markdown' ? markdownToWechat(response.text) : response.text
      const contextToken = await options.getContextToken?.(channelId)
      const chunks = chunkText(text, WECHAT_MAX_MESSAGE_LENGTH)
      let lastClientId = ''
      for (const chunk of chunks) {
        if (!chunk.trim()) continue
        lastClientId = generateClientId()
        await client.sendMessage({
          from_user_id: '',
          to_user_id: channelId,
          client_id: lastClientId,
          message_type: WeixinMessageType.BOT,
          message_state: WeixinMessageState.FINISH,
          item_list: [{ type: WeixinItemType.TEXT, text_item: { text: chunk } }],
          context_token: contextToken,
        })
      }
      return lastClientId
    },

    async editMessage(): Promise<void> {
      // WeChat has no message edit; callers gate on supportsMessageEdit.
      throw new Error('WeChat does not support message edits')
    },

    async sendTypingIndicator(channelId: string): Promise<void> {
      try {
        const ticket = await options.getTypingTicket?.(channelId)
        if (!ticket) return
        await client.sendTyping({ ilinkUserId: channelId, typingTicket: ticket, status: 1 })
      } catch {
        // Non-critical.
      }
    },

    async sendStatus(): Promise<string> {
      // No edit support — a status message would land as a permanent extra
      // message in the chat. The route relies on the typing indicator instead.
      return ''
    },
  }
}
