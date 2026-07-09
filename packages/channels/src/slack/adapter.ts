import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from '../types.js'
import { chunkText } from '../chunking.js'
import { createSlackApi, type SlackApi, type SlackOutboundAudit } from './api.js'
import { resolveMentionsCached } from './mentions.js'

const SLACK_MAX_MESSAGE_LENGTH = 3000 // Slack's limit is 4000 but leave room for formatting

// ── Markdown → Slack mrkdwn conversion ────────────────────────

/** Convert standard Markdown to Slack's mrkdwn format. */
function markdownToMrkdwn(text: string): string {
  let out = text

  // Links: [text](url) → <url|text>
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')

  // Headers: ### text → strip the hashes (bold is handled below)
  // Must run BEFORE bold so "### **text**" becomes "**text**" then bold converts it.
  out = out.replace(/^#{1,6}\s+/gm, '')

  // Bold: **text** → *text*  (must come before italic to avoid conflict)
  out = out.replace(/\*\*(.+?)\*\*/g, '*$1*')

  // Strikethrough: ~~text~~ → ~text~
  out = out.replace(/~~(.+?)~~/g, '~$1~')

  // Unordered lists: lines starting with * or - → •  (Slack has no list syntax)
  out = out.replace(/^[\t ]*[*\-]\s+/gm, '  • ')

  // Inline images: ![alt](url) → <url|alt> (best we can do)
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<$2|$1>')

  return out
}

// ── Slack event types ──────────────────────────────────────────

type SlackEvent = {
  type: string
  event?: {
    type: string
    subtype?: string
    text?: string
    user?: string
    channel?: string
    ts?: string
    thread_ts?: string
    bot_id?: string
    files?: Array<{ url_private: string; mimetype: string; name: string }>
    // Present on message_changed subtype
    message?: {
      text?: string
      user?: string
      ts?: string
      thread_ts?: string
      bot_id?: string
      files?: Array<{ url_private: string; mimetype: string; name: string }>
    }
  }
  challenge?: string
}

// ── Adapter ────────────────────────────────────────────────────

export type SlackAdapterConfig = {
  replyInThread?: boolean      // default: false — reply at channel level
  ackReaction?: string         // default: '' — no reaction. e.g. 'eyes', 'brain'
  requireMention?: boolean     // default: true — only respond when @mentioned in channels
  userAccessMode?: 'allow_all' | 'allowlist' | 'blocklist'  // default: 'allow_all'
  allowedUserIds?: string[]    // used when userAccessMode = 'allowlist'
  blockedUserIds?: string[]    // used when userAccessMode = 'blocklist'
}

export type SlackAdapterOptions = {
  botToken: string
  botUserId?: string
  config?: SlackAdapterConfig
  /**
   * Called when `handleEvent()` parses an inbound message.
   * Optional: if the adapter is constructed purely to send messages
   * (e.g. from the scheduled-job executor), `handleEvent` won't be
   * called so this callback can be omitted.
   */
  onMessage?: (msg: IncomingMessage) => void
  /**
   * Optional outbound audit hook — fires after every successful (or
   * failed) `chat.postMessage` / `chat.update`. The Slack route wires
   * this through to `emitConnectorAction` per
   * `docs/architecture/integrations/connector-actions.md`.
   *
   * TODO: migrate Slack to the unified `connector_instance` substrate.
   * Until then audit emission happens at the bot-socket boundary
   * rather than the tool boundary (other connectors emit at tool
   * execute callbacks; Slack writes don't have one because the bot
   * socket bypasses the tool layer).
   */
  onOutboundAudit?: (event: SlackOutboundAudit) => Promise<void>
}

export type { SlackOutboundAudit }

export function createSlackAdapter(options: SlackAdapterOptions): ChannelAdapter & {
  handleEvent(payload: unknown): { challenge?: string } | null
} {
  const api = createSlackApi({
    botToken: options.botToken,
    onOutboundAudit: options.onOutboundAudit,
  })
  const config = options.config ?? {}
  const requireMention = config.requireMention ?? true

  function isBotMentioned(text: string): boolean {
    if (!options.botUserId) return false
    return text.includes(`<@${options.botUserId}>`)
  }

  function stripMentions(text: string): string {
    return text.replace(/<@\w+>/g, '').trim()
  }

  function isDirectMessage(channelId: string): boolean {
    // Slack DM channel IDs start with 'D'
    return channelId.startsWith('D')
  }

  // Per-request state for status indicator.
  // Native assistant status (DMs with assistant:write scope) vs
  // reaction-based fallback (channels, or apps without the scope).
  let nativeStatusActive = false
  let nativeStatusThreadTs: string | null = null
  let reactionFallbackActive = false

  return {
    type: 'slack',
    maxMessageLength: SLACK_MAX_MESSAGE_LENGTH,
    supportsMarkdown: true,
    supportsMessageEdit: true,
    drainDelayMs: 2000,

    parseIncoming(webhookPayload: unknown): IncomingMessage | null {
      const event = (webhookPayload as SlackEvent).event
      if (!event || event.type !== 'message') return null

      // Handle message_changed (user edits) — unwrap the nested message
      if (event.subtype === 'message_changed' && event.message) {
        const msg = event.message
        if (!msg.user || msg.bot_id) return null

        const isDM = isDirectMessage(event.channel ?? '')
        const text = msg.text ?? ''
        const mentioned = isBotMentioned(text)
        if (!isDM && requireMention && !mentioned) return null

        return {
          userId: msg.user,
          channelId: event.channel ?? '',
          messageId: msg.ts,
          text: stripMentions(text),
          isGroupChat: !isDM,
          isMentioned: mentioned,
          isEdit: true,
          timestamp: msg.ts ? parseFloat(msg.ts) * 1000 : Date.now(),
          replyToMessageId: msg.thread_ts,
          raw: webhookPayload,
        }
      }

      if (!event.user) return null
      // Ignore bot messages
      if (event.bot_id) return null
      // Ignore system subtypes (channel_join, bot_add, etc.)
      // Exception: 'file_share' subtype carries user-uploaded files.
      if (event.subtype && event.subtype !== 'file_share') return null

      const hasText = !!event.text?.trim()
      const hasFiles = !!event.files?.length
      // Require at least text or files
      if (!hasText && !hasFiles) return null

      const isDM = isDirectMessage(event.channel ?? '')
      const text = event.text ?? ''
      const mentioned = isBotMentioned(text)

      // In channels, filter by mention requirement
      if (!isDM && requireMention && !mentioned) return null

      // Extract file metadata for downstream processing
      const files = event.files?.map((f) => ({
        url: f.url_private,
        mimeType: f.mimetype,
        name: f.name,
      }))

      return {
        userId: event.user,
        channelId: event.channel ?? '',
        messageId: event.ts,
        text: stripMentions(text),
        files: files?.length ? files : undefined,
        isGroupChat: !isDM,
        isMentioned: mentioned,
        timestamp: event.ts ? parseFloat(event.ts) * 1000 : Date.now(),
        replyToMessageId: event.thread_ts,
        raw: webhookPayload,
      }
    },

    deduplicateId(webhookPayload: unknown): string | null {
      const event = (webhookPayload as SlackEvent).event
      return event?.ts ?? null
    },

    handleEvent(payload: unknown): { challenge?: string } | null {
      const data = payload as SlackEvent

      // URL verification challenge
      if (data.type === 'url_verification' && data.challenge) {
        return { challenge: data.challenge }
      }

      // Event callback
      if (data.type === 'event_callback' && data.event) {
        const msg = this.parseIncoming(payload)
        if (msg && options.onMessage) {
          options.onMessage(msg)
        }
      }

      return null
    },

    async sendMessage(channelId: string, response: OutgoingMessage, opts?: { threadTs?: string }): Promise<string> {
      // Never send empty messages — Slack renders them as blank bubbles.
      // Documents still deliver when present (a docs-only send is legal).
      if (!response.text.trim() && !response.documents?.length) return ''
      const raw = response.format === 'markdown' ? markdownToMrkdwn(response.text) : response.text
      // Rewrite name-shaped mentions (`<@handle>`, `@handle`, `@Real Name`)
      // to real `<@U…>` ids against the workspace directory — Slack only
      // notifies on real ids. Best-effort + TTL-cached; a directory failure
      // still strips literal `<@name>` noise. See slack/mentions.ts.
      const text = await resolveMentionsCached(raw, options.botToken, async () => (await api.usersList()).members)
      const chunks = chunkText(text, SLACK_MAX_MESSAGE_LENGTH)
      let lastTs = ''

      for (const chunk of chunks) {
        if (!chunk.trim()) continue
        const result = await api.postMessage(channelId, chunk, { threadTs: opts?.threadTs })
        lastTs = result.ts
      }

      // Outbound documents — external upload flow (getUploadURLExternal →
      // POST bytes → completeUploadExternal). Per-document failure sends a
      // short notice instead of failing the send: the text already landed.
      // Requires the `files:write` scope on the BYO app — a missing scope
      // surfaces here as `missing_scope` and degrades to the notice.
      // The returned ts stays the LAST TEXT chunk's ts (the channel-id
      // round-trip anchor). See adapter-pattern.md → "Outbound documents".
      if (response.documents?.length) {
        for (const doc of response.documents) {
          try {
            const { upload_url, file_id } = await api.getUploadURLExternal(doc.filename, doc.data.length)
            await api.uploadToExternalURL(upload_url, doc.data)
            await api.completeUploadExternal(
              [{ id: file_id, title: doc.caption ?? doc.filename }],
              { channelId, threadTs: opts?.threadTs },
            )
          } catch (err) {
            console.warn(
              `[slack] file upload failed for ${doc.filename}:`,
              err instanceof Error ? err.message : String(err),
            )
            await api.postMessage(channelId, `Could not attach ${doc.filename}.`, { threadTs: opts?.threadTs }).catch(() => {})
          }
        }
      }

      return lastTs
    },

    async editMessage(channelId: string, messageId: string, response: OutgoingMessage, opts?: { threadTs?: string }): Promise<void> {
      const converted = response.format === 'markdown' ? markdownToMrkdwn(response.text) : response.text
      const raw = await resolveMentionsCached(converted, options.botToken, async () => (await api.usersList()).members)
      const text = raw.slice(0, SLACK_MAX_MESSAGE_LENGTH)
      try {
        await api.updateMessage(channelId, messageId, text)
      } catch {
        // Edit failed — send as new message
        await api.postMessage(channelId, text, { threadTs: opts?.threadTs })
      }
    },

    async sendTypingIndicator(_channelId: string): Promise<void> {
      // Slack doesn't have a typing indicator API for bots
    },

    async sendStatus(channelId: string, status: string, opts?: { threadTs?: string; messageId?: string }): Promise<string> {
      // Try Slack's native assistant thread status first — shows a flashing
      // "thinking" indicator without posting an actual message.
      // Requires thread_ts — in Slack's Assistants model, every DM is a thread.
      const threadTs = opts?.threadTs
      if (threadTs) {
        try {
          await api.setAssistantStatus(channelId, threadTs, status)
          nativeStatusActive = true
          nativeStatusThreadTs = threadTs
          return '' // no message ID — this is not a real message
        } catch {
          // Fall through to reaction fallback
        }
      }

      // Fallback: add a thinking reaction to the user's message.
      // No real message posted — just an emoji that shows the bot is working.
      if (opts?.messageId && !reactionFallbackActive) {
        await api.addReaction(channelId, opts.messageId, 'thought_balloon').catch(() => {})
        reactionFallbackActive = true
      }
      return '' // no message ID in either mode
    },

    async clearStatus(channelId: string, opts?: { messageId?: string }): Promise<void> {
      if (nativeStatusActive && nativeStatusThreadTs) {
        await api.clearAssistantStatus(channelId, nativeStatusThreadTs).catch(() => {})
      }
      if (reactionFallbackActive && opts?.messageId) {
        await api.removeReaction(channelId, opts.messageId, 'thought_balloon').catch(() => {})
        reactionFallbackActive = false
      }
    },

    async reactToMessage(channelId: string, messageId: string, emoji: string): Promise<void> {
      try {
        await api.addReaction(channelId, messageId, emoji)
      } catch {
        // Non-critical — reaction might fail if already reacted or missing scope
      }
    },
  }
}
