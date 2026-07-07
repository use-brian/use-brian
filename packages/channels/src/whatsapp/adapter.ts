// NOTE — The *legacy shared official responder* is deprecated (2026-06-02), but
// this adapter is ACTIVE: the Bring-Your-Own-Number path uses it for read-only
// group ingest AND, on `'chat'`-capability channels, for the full-assistant bot
// reply (`sendMessage` / `sendTypingIndicator`). See
// docs/architecture/channels/whatsapp.md → "BYON bot mode" (Status: ACTIVE).
// Don't re-add legacy-responder-only affordances (reaction feedback, the
// channel_message_id round-trip) — those stay unwired for WhatsApp.
/**
 * WhatsApp remote channel adapter.
 *
 * Implements ChannelAdapter by proxying outbound calls to the wa-connector
 * service over HTTP. The wa-connector holds the Baileys WebSocket; this
 * adapter translates the standard ChannelAdapter interface into HTTP calls.
 *
 * See docs/architecture/channels/whatsapp.md.
 * Component tag: [COMP:channels/whatsapp].
 */

import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from '../types.js'
import { chunkText } from '../chunking.js'
import { markdownToWhatsApp } from './formatter.js'

export type WhatsAppIncomingPayload = {
  messageId: string
  /** Owning workspace channel (`channels.id`) — the wa-connector routing key. */
  channelId: string
  chatJid: string
  senderJid: string
  /**
   * The sender's phone-number JID when `senderJid` is a LID (WhatsApp privacy
   * addressing) and the connector could resolve the PN twin (key alt fields or
   * the Baileys v7 LID mapping store). Absent when the sender is already
   * PN-addressed or the mapping is unknown.
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
   * Large media the connector streamed straight to GCS (over the inline cap) —
   * a reference, not the bytes. The API routes this through the channel-media
   * intake (recording / document → brain). See docs/plans/channel-media-ingest.md.
   */
  mediaRef?: {
    gcsKey: string
    mimeType: string
    fileName?: string
    sizeBytes?: number
  }
}

export type WhatsAppAdapterOptions = {
  connectorUrl: string
  connectorSecret: string
  /** wa-connector connection id — the workspace `channels.id`. */
  connectionId: string
}

export function createWhatsAppAdapter(options: WhatsAppAdapterOptions): ChannelAdapter & {
  parseIncomingPayload(payload: WhatsAppIncomingPayload): IncomingMessage
  sendReaction(channelId: string, messageId: string, emoji: string): Promise<void>
} {
  const { connectorUrl, connectorSecret, connectionId } = options

  async function connectorFetch(path: string, body?: unknown): Promise<Response> {
    return fetch(`${connectorUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Connector-Secret': connectorSecret,
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  }

  return {
    type: 'whatsapp',
    maxMessageLength: 4096,
    supportsMarkdown: true,
    supportsMessageEdit: true,
    drainDelayMs: 2000,

    parseIncoming(_webhookPayload: unknown): IncomingMessage | null {
      // Not used for WhatsApp — inbound messages arrive via wa-connector HTTP,
      // not via platform webhook. Use parseIncomingPayload instead.
      return null
    },

    parseIncomingPayload(payload: WhatsAppIncomingPayload): IncomingMessage {
      return {
        userId: payload.senderJid,
        channelId: payload.chatJid,
        messageId: payload.messageId,
        text: payload.text,
        replyToMessageId: payload.quotedMessageId,
        isEdit: payload.isEdit,
        isGroupChat: payload.isGroup,
        timestamp: payload.timestamp,
        raw: payload,
      }
    },

    deduplicateId(_webhookPayload: unknown): string | null {
      return null
    },

    async sendMessage(channelId: string, response: OutgoingMessage): Promise<string> {
      const text = response.format === 'markdown' ? markdownToWhatsApp(response.text) : response.text
      const chunks = chunkText(text, 4096)
      let lastMessageId = ''

      for (const chunk of chunks) {
        const res = await connectorFetch(`/send/${connectionId}`, {
          jid: channelId,
          text: chunk,
        })
        if (!res.ok) {
          throw new Error(`wa-connector send failed: ${res.status} ${res.statusText}`)
        }
        const data = (await res.json()) as { messageId: string }
        lastMessageId = data.messageId
      }

      return lastMessageId
    },

    async editMessage(channelId: string, messageId: string, response: OutgoingMessage): Promise<void> {
      const text = response.format === 'markdown' ? markdownToWhatsApp(response.text) : response.text
      try {
        const res = await connectorFetch(`/edit/${connectionId}`, {
          jid: channelId,
          messageId,
          text: text.slice(0, 4096),
        })
        if (!res.ok) {
          console.error(`[wa-adapter] edit failed: ${res.status} ${res.statusText}`)
        }
      } catch {
        // Edit failed — non-critical, message may be too old
      }
    },

    async sendTypingIndicator(channelId: string): Promise<void> {
      try {
        await connectorFetch(`/typing/${connectionId}`, { jid: channelId })
      } catch {
        // Best effort — non-critical
      }
    },

    async sendStatus(channelId: string, status: string, opts?: { messageId?: string }): Promise<string> {
      // Edit-in-place if we already have a status message
      if (opts?.messageId) {
        try {
          await connectorFetch(`/edit/${connectionId}`, {
            jid: channelId,
            messageId: opts.messageId,
            text: status,
          })
          return opts.messageId
        } catch {
          // Edit failed — fall through to send new message
        }
      }
      const res = await connectorFetch(`/send/${connectionId}`, {
        jid: channelId,
        text: status,
      })
      if (!res.ok) return ''
      const data = (await res.json()) as { messageId: string }
      return data.messageId
    },

    async sendReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
      await connectorFetch(`/react/${connectionId}`, {
        jid: channelId,
        messageId,
        emoji,
      })
    },
  }
}
