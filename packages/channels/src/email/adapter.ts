/**
 * Email channel adapter (AgentMail-backed, vendor-agnostic via EmailSendPort).
 *
 * Normalizes an inbound email webhook payload into the standard
 * `IncomingMessage`, and denormalizes an `OutgoingMessage` into a threaded
 * reply through the injected send port. The core never sees an email-shaped
 * payload; the adapter never talks to a vendor API (the webhook route
 * constructs the port over the EmailInboxProvider seam).
 *
 * Session mapping: `channelId` = the vendor `thread_id`, so the channel
 * pipeline's per-`channel_id` session key gives thread ↔ session continuity
 * for free.
 *
 * **Sanitize-at-send.** Email is a raw-text exit with no client render layer,
 * so `sendMessage` MUST run every outbound body through the injected
 * `sanitizeDeliveryText` (packages/shared/src/delivery-sanitize.ts) even
 * though the path is interactive — the one channel where the interactive
 * exception does not apply. The option is required, and the
 * `delivery-sanitize` graded invariant lists this file as a sanctioned
 * boundary. See docs/architecture/engine/delivery-sanitization.md.
 *
 * Spec: docs/architecture/integrations/agentmail.md → "Adapter".
 * Component tag: [COMP:channels/email]
 */

import type { ChannelAdapter, IncomingFile, IncomingMessage, OutgoingMessage } from '../types.js'
import { parseEmailAddress } from './address.js'

/**
 * The inbound `message.received` message payload shape the adapter consumes.
 * `attachments[].download_url` is route-enriched (the webhook route resolves
 * short-lived URLs via the provider before parsing); entries without one are
 * skipped.
 */
export type EmailWebhookMessage = {
  inbox_id: string
  thread_id: string
  message_id: string
  timestamp?: string
  from: string
  to?: string[]
  cc?: string[]
  subject?: string | null
  text?: string | null
  extracted_text?: string | null
  in_reply_to?: string | null
  attachments?: Array<{
    attachment_id: string
    filename?: string | null
    content_type?: string | null
    download_url?: string | null
  }>
}

/**
 * Vendor-neutral outbound port. The webhook route builds this over the
 * EmailInboxProvider seam; tests stub it.
 */
export type EmailSendPort = {
  /** Reply on the thread of `inReplyToMessageId` (vendor derives headers). */
  reply(params: {
    inReplyToMessageId: string
    text: string
    attachments?: Array<{ filename: string; contentType: string; contentBase64: string }>
  }): Promise<{ messageId: string; threadId: string }>
}

export type EmailAdapterOptions = {
  /** The inbox address this adapter sends from (used for self-mail drops). */
  inboxAddress: string
  /** The inbound message this turn replies to — threading anchor. */
  replyToMessageId: string
  send: EmailSendPort
  /**
   * REQUIRED delivery sanitizer — pass `sanitizeDeliveryText` from
   * `@use-brian/shared/delivery-sanitize`. Injected because this package is
   * dependency-free; the graded invariant holds this file to calling it.
   */
  sanitizeDeliveryText: (text: string) => string
}

/** Email bodies are not length-limited in any practical sense. */
const EMAIL_MAX_LENGTH = 500_000

export function createEmailAdapter(options: EmailAdapterOptions): ChannelAdapter {
  return {
    type: 'email',
    maxMessageLength: EMAIL_MAX_LENGTH,
    supportsMarkdown: false,
    supportsMessageEdit: false,
    drainDelayMs: 0,

    parseIncoming(webhookPayload: unknown): IncomingMessage | null {
      const msg = webhookPayload as EmailWebhookMessage | null
      if (!msg || typeof msg !== 'object') return null
      if (!msg.thread_id || !msg.message_id || !msg.from) return null

      const sender = parseEmailAddress(msg.from)
      if (!sender) return null
      // Self-mail (our own outbound echoed back) must never start a turn.
      if (sender === options.inboxAddress.toLowerCase()) return null

      // Prefer the reply-extracted body (quoted history stripped) over the
      // raw text. The subject rides as a prefix so intent expressed only in
      // the subject line ("Re: invoice overdue!") reaches the model.
      const body = (msg.extracted_text ?? msg.text ?? '').trim()
      const subject = (msg.subject ?? '').trim()
      const text = subject ? `Subject: ${subject}\n\n${body}`.trim() : body

      const files: IncomingFile[] = []
      for (const att of msg.attachments ?? []) {
        if (!att.download_url) continue
        files.push({
          url: att.download_url,
          mimeType: att.content_type ?? 'application/octet-stream',
          name: att.filename ?? att.attachment_id,
        })
      }

      if (!text && files.length === 0) return null

      const ts = msg.timestamp ? Date.parse(msg.timestamp) : NaN
      return {
        userId: sender,
        channelId: msg.thread_id,
        messageId: msg.message_id,
        text,
        ...(files.length > 0 ? { files } : {}),
        replyToMessageId: msg.in_reply_to ?? undefined,
        isGroupChat: false,
        timestamp: Number.isFinite(ts) ? ts : Date.now(),
        raw: webhookPayload,
      }
    },

    deduplicateId(webhookPayload: unknown): string | null {
      const msg = webhookPayload as EmailWebhookMessage | null
      return msg?.message_id ?? null
    },

    async sendMessage(_channelId: string, response: OutgoingMessage): Promise<string> {
      // Raw-text exit with no render layer: strip planning scaffolding
      // before anything leaves (delivery-sanitize invariant).
      const text = options.sanitizeDeliveryText(response.text ?? '').trim()
      const attachments = (response.documents ?? []).map((doc) => ({
        filename: doc.filename,
        contentType: doc.mime,
        contentBase64: Buffer.from(doc.data).toString('base64'),
      }))
      if (!text && attachments.length === 0) return ''
      const result = await options.send.reply({
        inReplyToMessageId: options.replyToMessageId,
        text,
        ...(attachments.length > 0 ? { attachments } : {}),
      })
      return result.messageId
    },

    async editMessage(): Promise<void> {
      // Email cannot edit a sent message — supportsMessageEdit is false and
      // the pipeline never calls this for such channels; no-op for safety.
    },

    async sendTypingIndicator(): Promise<void> {
      // Email has no presence surface.
    },

    async sendStatus(): Promise<string> {
      // No transient status surface either — statuses are simply dropped
      // (the reply email is the only artifact the recipient ever sees).
      return ''
    },
  }
}
