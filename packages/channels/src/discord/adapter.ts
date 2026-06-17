import type { ChannelAdapter, IncomingFile, IncomingMessage, OutgoingMessage } from '../types.js'
import { chunkText } from '../chunking.js'
import { createDiscordApi, type DiscordAllowedMentions } from './api.js'
import { markdownToDiscord } from './markdown.js'

// Discord's content limit is 2000 characters for bot messages (Nitro's 4000 is
// not available to bots). We chunk at exactly the limit.
const DISCORD_MAX_MESSAGE_LENGTH = 2000

// Discord epoch (2015-01-01) — used to recover a millisecond timestamp from a
// snowflake id when the payload carries no ISO timestamp (interactions).
const DISCORD_EPOCH_MS = 1420070400000n

// Message `type` values we treat as user chat. 0 = DEFAULT, 19 = REPLY.
// Everything else (joins, pins, thread-created, …) is a system message we skip.
const HANDLED_MESSAGE_TYPES = new Set([0, 19])

// Interaction `type` 2 = APPLICATION_COMMAND (a slash command invocation).
const INTERACTION_APPLICATION_COMMAND = 2

// ── Discord payload shapes (only the fields we read) ───────────

type DiscordUser = {
  id: string
  username: string
  global_name?: string | null
  bot?: boolean
}

type DiscordAttachment = {
  id: string
  filename: string
  content_type?: string
  size: number
  url: string
  proxy_url?: string
}

type DiscordMessage = {
  id: string
  channel_id: string
  guild_id?: string
  author?: DiscordUser
  content?: string
  timestamp?: string
  attachments?: DiscordAttachment[]
  mentions?: DiscordUser[]
  message_reference?: { message_id?: string; channel_id?: string }
  referenced_message?: { id: string; author?: DiscordUser } | null
  type?: number
  webhook_id?: string
}

/** Gateway dispatch envelope: `{ op: 0, t: 'MESSAGE_CREATE', d: <message> }`. */
type GatewayDispatch = {
  op?: number
  t?: string
  d?: unknown
}

type DiscordInteraction = {
  id: string
  application_id?: string
  token?: string
  type?: number
  channel_id?: string
  guild_id?: string
  member?: { user?: DiscordUser }
  user?: DiscordUser
  data?: {
    id?: string
    name?: string
    options?: Array<{ name: string; type: number; value?: string | number | boolean }>
  }
}

// ── Snowflake → timestamp ──────────────────────────────────────

function snowflakeToTimestamp(id: string): number {
  try {
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS)
  } catch {
    return Date.now()
  }
}

// ── Attachment → IncomingMessage media mapping ─────────────────

function mediaTypeFromMime(mime: string | undefined): IncomingMessage['mediaType'] {
  if (!mime) return 'document'
  if (mime.startsWith('image/')) return 'photo'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'voice'
  return 'document'
}

// ── Adapter ────────────────────────────────────────────────────

export type DiscordAdapterConfig = {
  /** Only respond in guild (server) channels when the bot is @mentioned. Default: true. DMs always respond. */
  requireMention?: boolean
  /**
   * Allow the bot to ping users named in its own outgoing text. Default: false
   * — outbound messages are sent with `allowed_mentions: { parse: [] }` so the
   * model can never trigger an `@everyone` / role ping from generated content.
   * When true, only `users` mentions are honoured (never roles or everyone).
   */
  allowUserMentions?: boolean
}

export type DiscordAdapterOptions = {
  token: string
  /**
   * The bot's own Discord user id. Required for self-mention detection and to
   * strip `<@botId>` from inbound text. Resolve it once via
   * `validateDiscordCredentials` (GET /users/@me) and persist it alongside the
   * token. Without it, `requireMention` can never match in guilds and every
   * server message is dropped.
   */
  botUserId?: string
  config?: DiscordAdapterConfig
  /**
   * Called when an inbound message is parsed from a forwarded Gateway event or
   * an interaction. Optional: a send-only adapter (e.g. the scheduled-job
   * executor) omits it.
   */
  onMessage?: (msg: IncomingMessage) => void
}

export function createDiscordAdapter(options: DiscordAdapterOptions): ChannelAdapter & {
  /** Feed a raw Gateway event or interaction payload through to `onMessage`. */
  handleEvent(payload: unknown): void
} {
  const api = createDiscordApi({ token: options.token })
  const config = options.config ?? {}
  const requireMention = config.requireMention ?? true
  const allowedMentions: DiscordAllowedMentions = config.allowUserMentions
    ? { parse: ['users'] }
    : { parse: [] }

  function isBotMentioned(msg: DiscordMessage): boolean {
    if (!options.botUserId) return false
    const byList = msg.mentions?.some((u) => u.id === options.botUserId) ?? false
    if (byList) return true
    const content = msg.content ?? ''
    // Discord renders mentions as `<@id>` (and the legacy nickname form `<@!id>`).
    return content.includes(`<@${options.botUserId}>`) || content.includes(`<@!${options.botUserId}>`)
  }

  function stripBotMention(text: string): string {
    if (!options.botUserId) return text.trim()
    return text.replace(new RegExp(`<@!?${options.botUserId}>`, 'g'), '').trim()
  }

  function isReplyToBot(msg: DiscordMessage): boolean {
    return !!options.botUserId && msg.referenced_message?.author?.id === options.botUserId
  }

  function parseMessage(msg: DiscordMessage, isEdit: boolean): IncomingMessage | null {
    // Ignore messages from bots (including ourselves) and webhook deliveries —
    // prevents reply loops. Mirrors Slack's `bot_id` guard.
    if (msg.author?.bot || msg.webhook_id) return null
    if (!msg.author) return null
    // Only DEFAULT / REPLY messages are user chat; skip system messages.
    if (msg.type != null && !HANDLED_MESSAGE_TYPES.has(msg.type)) return null

    const isGroup = !!msg.guild_id
    const mentioned = isBotMentioned(msg)
    const replyToBot = isReplyToBot(msg)

    // In a server channel, only respond when addressed (mention or reply-to-bot)
    // unless require-mention is disabled. DMs always respond.
    if (isGroup && requireMention && !mentioned && !replyToBot) return null

    const text = stripBotMention(msg.content ?? '')

    const files: IncomingFile[] | undefined = msg.attachments?.length
      ? msg.attachments.map((a) => ({
          url: a.url,
          mimeType: a.content_type ?? 'application/octet-stream',
          name: a.filename,
        }))
      : undefined

    // Must carry text or at least one attachment.
    if (!text && !files?.length) return null

    // Surface the first attachment through the Telegram-style single-media
    // fields too, so downstream code that reads `mediaUrl` still works while
    // `files` carries the full set.
    const firstAttachment = msg.attachments?.[0]

    return {
      userId: msg.author.id,
      channelId: msg.channel_id,
      messageId: msg.id,
      text,
      mediaUrl: firstAttachment?.url,
      mediaType: firstAttachment ? mediaTypeFromMime(firstAttachment.content_type) : undefined,
      mediaMime: firstAttachment?.content_type,
      mediaName: firstAttachment?.filename,
      files,
      replyToMessageId: msg.message_reference?.message_id ?? msg.referenced_message?.id,
      isEdit: isEdit || undefined,
      isGroupChat: isGroup,
      isMentioned: mentioned || replyToBot,
      timestamp: msg.timestamp ? Date.parse(msg.timestamp) || Date.now() : Date.now(),
      raw: msg,
    }
  }

  function parseInteractionCommand(interaction: DiscordInteraction): IncomingMessage | null {
    if (interaction.type !== INTERACTION_APPLICATION_COMMAND) return null
    const user = interaction.member?.user ?? interaction.user
    if (!user || !interaction.channel_id) return null

    // Concatenate string option values (e.g. the `/ask <question>` text). Option
    // type 3 is STRING; we accept any string-valued option for robustness.
    const text = (interaction.data?.options ?? [])
      .map((o) => o.value)
      .filter((v): v is string => typeof v === 'string')
      .join(' ')
      .trim()
    if (!text) return null

    return {
      userId: user.id,
      channelId: interaction.channel_id,
      messageId: interaction.id,
      text,
      isGroupChat: !!interaction.guild_id,
      isMentioned: true, // a slash command is an explicit invocation
      timestamp: snowflakeToTimestamp(interaction.id),
      raw: interaction,
    }
  }

  /**
   * Normalize a raw inbound payload into a `DiscordMessage`, or null if it isn't
   * a message. Handles three shapes: a Gateway dispatch envelope
   * (`{ t: 'MESSAGE_CREATE', d }`), and a bare message object (a connector that
   * forwards only `d`).
   */
  function extractMessage(payload: unknown): { msg: DiscordMessage; isEdit: boolean } | null {
    const env = payload as GatewayDispatch
    if (env && (env.t === 'MESSAGE_CREATE' || env.t === 'MESSAGE_UPDATE') && env.d) {
      return { msg: env.d as DiscordMessage, isEdit: env.t === 'MESSAGE_UPDATE' }
    }
    const maybe = payload as DiscordMessage
    if (maybe && typeof maybe.channel_id === 'string' && maybe.author && typeof maybe.id === 'string') {
      return { msg: maybe, isEdit: false }
    }
    return null
  }

  function extractInteraction(payload: unknown): DiscordInteraction | null {
    const maybe = payload as DiscordInteraction
    if (maybe && typeof maybe.id === 'string' && typeof maybe.type === 'number' && maybe.application_id) {
      return maybe
    }
    return null
  }

  return {
    type: 'discord',
    maxMessageLength: DISCORD_MAX_MESSAGE_LENGTH,
    supportsMarkdown: true,
    supportsMessageEdit: true,
    drainDelayMs: 2000,

    parseIncoming(webhookPayload: unknown): IncomingMessage | null {
      const message = extractMessage(webhookPayload)
      if (message) return parseMessage(message.msg, message.isEdit)
      const interaction = extractInteraction(webhookPayload)
      if (interaction) return parseInteractionCommand(interaction)
      return null
    },

    deduplicateId(webhookPayload: unknown): string | null {
      const message = extractMessage(webhookPayload)
      if (message) return message.msg.id
      const interaction = extractInteraction(webhookPayload)
      return interaction?.id ?? null
    },

    handleEvent(payload: unknown): void {
      const msg = this.parseIncoming(payload)
      if (msg && options.onMessage) options.onMessage(msg)
    },

    async sendMessage(channelId: string, response: OutgoingMessage, opts?: { threadTs?: string }): Promise<string> {
      if (!response.text.trim()) return ''
      const text = response.format === 'markdown' ? markdownToDiscord(response.text) : response.text
      const chunks = chunkText(text, DISCORD_MAX_MESSAGE_LENGTH)
      let lastId = ''

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        if (!chunk.trim()) continue
        // Only quote-reply the first chunk; `fail_if_not_exists: false` keeps the
        // send alive if the referenced message was deleted in the meantime.
        const reference = i === 0 && opts?.threadTs
          ? { message_id: opts.threadTs, fail_if_not_exists: false }
          : undefined
        const result = await api.createMessage(channelId, {
          content: chunk,
          message_reference: reference,
          allowed_mentions: allowedMentions,
        })
        lastId = result.id
      }

      return lastId
    },

    async editMessage(channelId: string, messageId: string, response: OutgoingMessage): Promise<void> {
      const raw = response.format === 'markdown' ? markdownToDiscord(response.text) : response.text
      const content = raw.slice(0, DISCORD_MAX_MESSAGE_LENGTH)
      try {
        await api.editMessage(channelId, messageId, { content })
      } catch {
        // Edit failed (message too old, deleted, …) — fall back to a fresh send.
        await api.createMessage(channelId, { content, allowed_mentions: allowedMentions }).catch(() => {})
      }
    },

    async sendTypingIndicator(channelId: string): Promise<void> {
      try {
        await api.triggerTyping(channelId)
      } catch {
        // Non-critical.
      }
    },

    async sendStatus(channelId: string, status: string): Promise<string> {
      // Discord has no native "thinking" indicator, but it supports message
      // edits — so we post the status as a real message and return its id. The
      // caller then `editMessage`s it into the final response (edit-in-place:
      // one notification per turn). Status text is plain, never markdown.
      if (!status.trim()) return ''
      const result = await api.createMessage(channelId, {
        content: status.slice(0, DISCORD_MAX_MESSAGE_LENGTH),
        allowed_mentions: { parse: [] },
      })
      return result.id
    },

    async deleteMessage(channelId: string, messageId: string): Promise<void> {
      try {
        await api.deleteMessage(channelId, messageId)
      } catch {
        // Non-critical — message may already be gone.
      }
    },

    async reactToMessage(channelId: string, messageId: string, emoji: string): Promise<void> {
      try {
        await api.createReaction(channelId, messageId, emoji)
      } catch {
        // Non-critical — reaction may fail for missing perms or unknown emoji.
      }
    },
  }
}
