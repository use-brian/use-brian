import type { ChannelAdapter, IncomingFile, IncomingMessage, OutgoingAction, OutgoingMessage } from '../types.js'
import { chunkText } from '../chunking.js'
import { createTelegramApi, isTelegramThreadNotFoundError, type TelegramApi } from './api.js'
import { markdownToTelegramHTML, stripMarkdown } from './markdown.js'

// ── Telegram webhook types ─────────────────────────────────────

type TelegramUser = { id: number; first_name: string; username?: string }

type TelegramMessage = {
  message_id: number
  from?: TelegramUser
  chat: { id: number; type: string; title?: string; is_forum?: boolean }
  date: number
  text?: string
  caption?: string
  photo?: Array<{ file_id: string }>
  document?: { file_id: string; mime_type?: string; file_name?: string; file_size?: number }
  voice?: { file_id: string; duration?: number; file_size?: number }
  // Audio track sent "as audio" (music-note UI) — a recorded call/meeting/song.
  // Distinct from a voice note (`voice`); Telegram carries duration + size + tags.
  audio?: { file_id: string; mime_type?: string; file_name?: string; duration?: number; performer?: string; title?: string; file_size?: number }
  video?: { file_id: string; mime_type?: string; duration?: number; file_size?: number }
  media_group_id?: string
  reply_to_message?: { message_id: number; from?: { id: number; is_bot?: boolean; username?: string }; text?: string }
  message_thread_id?: number
  is_topic_message?: boolean
  forum_topic_created?: { name: string; icon_color?: number; icon_custom_emoji_id?: string }
  forum_topic_edited?: { name?: string; icon_custom_emoji_id?: string }
  new_chat_members?: unknown[]
  left_chat_member?: unknown
  entities?: Array<{ type: string; offset: number; length: number }>
  caption_entities?: Array<{ type: string; offset: number; length: number }>
}

// ── Forum-topic encoding ───────────────────────────────────────
//
// Forum-enabled supergroups partition messages into topics identified by
// `message_thread_id`. To make each topic its own conversation (own session,
// memory scope, chat lock), we embed the topic id into `channelId` as
// `"<chatId>:topic:<topicId>"` on inbound. Outbound calls parse it back.

const TELEGRAM_GENERAL_TOPIC_ID = 1
const TOPIC_CHANNEL_ID_PATTERN = /^(-?\d+):topic:(\d+)$/

/**
 * Unpack a topic-qualified channelId into the real Telegram chat id and
 * the topic thread id. Returns `{ chatId, messageThreadId }`. When the
 * channelId is bare (no topic suffix), `messageThreadId` is undefined.
 */
export function parseTopicChannelId(channelId: string): {
  chatId: string
  messageThreadId: number | undefined
} {
  const m = channelId.match(TOPIC_CHANNEL_ID_PATTERN)
  if (!m) return { chatId: channelId, messageThreadId: undefined }
  return { chatId: m[1], messageThreadId: Number(m[2]) }
}

/**
 * Telegram rejects `message_thread_id=1` (the General topic) on outbound sends,
 * so we strip it. The General topic is still represented with `:topic:1` in the
 * session key so partitioning stays uniform across forum topics.
 */
function outboundThreadId(tid: number | undefined): number | undefined {
  if (tid == null) return undefined
  if (tid === TELEGRAM_GENERAL_TOPIC_ID) return undefined
  return tid
}

type InlineKeyboardButton =
  | { text: string; web_app: { url: string } }
  | { text: string; callback_data: string }

// Telegram shrinks buttons evenly across a row, truncating descriptive labels
// mid-word on mobile. Web_app actions get their own row; callback actions
// (short binary confirms) pack together.
function buildInlineKeyboard(actions: OutgoingAction[]): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = []
  let callbackRow: InlineKeyboardButton[] | null = null
  for (const a of actions) {
    if (a.kind === 'web_app') {
      callbackRow = null
      rows.push([{ text: a.label, web_app: { url: a.url } }])
    } else {
      const btn: InlineKeyboardButton = { text: a.label, callback_data: a.data }
      if (!callbackRow) {
        callbackRow = [btn]
        rows.push(callbackRow)
      } else {
        callbackRow.push(btn)
      }
    }
  }
  return rows
}

type TelegramChatMemberStatus = 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked'

type TelegramChatMemberUpdated = {
  chat: { id: number; type: string; title?: string; is_forum?: boolean }
  from: TelegramUser
  date: number
  old_chat_member: { status: TelegramChatMemberStatus; user: { id: number; is_bot?: boolean } }
  new_chat_member: { status: TelegramChatMemberStatus; user: { id: number; is_bot?: boolean } }
}

type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
  callback_query?: {
    id: string
    from: TelegramUser
    message?: TelegramMessage
    data?: string
  }
  my_chat_member?: TelegramChatMemberUpdated
}

// ── Media group buffering ──────────────────────────────────────

type BufferedGroup = {
  messages: TelegramMessage[]
  timer: ReturnType<typeof setTimeout> | undefined
}

// ── Mime inference ─────────────────────────────────────────────
//
// Telegram's `getFile` response carries a `file_path` (e.g. `photos/file_42.jpg`,
// `documents/file_3.pdf`) but no mime metadata. For documents the webhook payload
// already has `document.mime_type`; for everything else we infer from the
// extension. The set is intentionally narrow — Gemini reads images and PDFs
// natively, so anything we can't identify falls back to `application/octet-stream`
// and the route's text-parser branch handles it.
const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
}

function mimeFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase()
  if (!ext) return 'application/octet-stream'
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

const MEDIA_GROUP_TIMEOUT_MS = 500

// ── Text fragment reassembly ───────────────────────────────────

type TextFragment = {
  messages: TelegramMessage[]
  timer: ReturnType<typeof setTimeout> | undefined
  lastMessageId: number
  lastTimestamp: number
}

const TEXT_FRAGMENT_GAP_MS = 1500
const TEXT_FRAGMENT_MAX_PARTS = 12

const TELEGRAM_MAX_MESSAGE_LENGTH = 4000

// ── Adapter ────────────────────────────────────────────────────

export type CallbackQuery = {
  id: string
  userId: string
  chatId: string
  data: string
  messageId: number
}

/**
 * Normalized `my_chat_member` event — emitted when the bot is added to,
 * removed from, or has its permissions changed in a chat. Used by BYO
 * group add-protection (see packages/api/src/routes/telegram-byo.ts).
 */
export type MyChatMemberUpdate = {
  /** Who performed the action (typically the user who added the bot). */
  adderUserId: string
  /** The chat id the bot was added to / removed from. */
  chatId: string
  /** Chat type — `group`, `supergroup`, `channel`, or `private`. */
  chatType: string
  /** Bot's previous status in this chat. */
  previousStatus: TelegramChatMemberStatus
  /** Bot's new status in this chat. */
  newStatus: TelegramChatMemberStatus
  /** True iff this is a fresh add (left/kicked → member/administrator/restricted). */
  isFreshJoin: boolean
}

/**
 * Either a static `requireMention` default, or a default + cumulative set of
 * chat/topic overrides. One or more matching entries invert the default once;
 * overlapping whole-chat and topic entries never cancel each other out.
 *
 * Keeping the simple boolean form for non-BYO callers (tests, shared bot) that
 * don't need per-topic tuning.
 */
export type RequireMentionConfig =
  | boolean
  | {
      default: boolean
      overrides: Array<{ chatId: string; topicId?: number | null }>
    }

export type TelegramAdapterConfig = {
  requireMention?: RequireMentionConfig // default: true — respond when @mentioned or replied to in groups
  ackReaction?: string                  // default: '' — no reaction
}

/**
 * Emitted when the bot sees a group/supergroup/channel — either an inbound
 * message or a `my_chat_member` update. Lets the BYO route keep an inventory
 * of chats/topics for the settings UI (see packages/api/src/db/channel-integrations.ts
 * → `SeenChat`). `topicName` is only present when we have a fresh value from
 * a `forum_topic_created` / `forum_topic_edited` update; otherwise null.
 */
export type ChatSeenEvent = {
  chatId: string
  chatTitle: string | null
  chatType: string
  isForum: boolean
  topicId: number | null
  topicName: string | null
}

export type TelegramAdapterOptions = {
  token: string
  botUsername?: string
  config?: TelegramAdapterConfig
  /**
   * Called when `handleWebhook()` parses an inbound message.
   * Optional: if the adapter is constructed purely to send messages
   * (e.g. from the scheduled-job executor for cron result delivery),
   * `handleWebhook` won't be called so this callback can be omitted.
   */
  onMessage?: (msg: IncomingMessage) => void
  /**
   * Called when a callback_query arrives (inline keyboard button press).
   * Used by the confirmation flow to handle Allow/Deny decisions.
   */
  onCallbackQuery?: (query: CallbackQuery) => void
  /**
   * Called when a `my_chat_member` update arrives — the bot's membership in
   * a chat has changed. Used by BYO group add-protection. Requires the
   * webhook to have been registered with `my_chat_member` in `allowed_updates`
   * (see `setWebhook` in `api.ts`).
   */
  onMyChatMember?: (update: MyChatMemberUpdate) => void
  /**
   * Called for every group/supergroup/channel interaction — inbound message or
   * membership update — so the caller can maintain an inventory of chats the
   * bot has been observed in. See `ChatSeenEvent`.
   */
  onChatSeen?: (evt: ChatSeenEvent) => void
}

export function createTelegramAdapter(options: TelegramAdapterOptions): ChannelAdapter & {
  handleWebhook(payload: unknown): void
  answerCallbackQuery(id: string, opts?: { text?: string }): Promise<void>
  /**
   * Download a Telegram voice note by `file_id` and return `{ buffer, mime }`.
   *
   * Telegram voice notes are always OGG/Opus — `mime` falls back to
   * `audio/ogg; codecs=opus` when `getFile` doesn't include metadata.
   *
   * Intended for the voice-transcription preflight in `routes/telegram.ts`.
   * See `docs/architecture/media/transcription.md`.
   */
  downloadVoice(fileId: string): Promise<{ buffer: Buffer; mime: string }>
  /**
   * Download an arbitrary Telegram file (photo, document, video) by `file_id`.
   *
   * Mime resolution: `opts.mimeHint` if provided, else inferred from the
   * `file_path` extension returned by `getFile`, else
   * `application/octet-stream`. Photos are always served as JPEG by Telegram
   * regardless of upload format, so callers should pass `mimeHint: 'image/jpeg'`.
   *
   * Used by `routes/telegram.ts` to attach inbound photos / documents as
   * multimodal `image` content blocks (Gemini `inlineData`). See
   * `docs/architecture/engine/file-handling.md`.
   */
  downloadMedia(
    fileId: string,
    opts?: { mimeHint?: string },
  ): Promise<{ buffer: Buffer; mime: string; name: string }>
  /**
   * Resolve a `file_id` to its authenticated Bot API file URL (cloud host,
   * `https://api.telegram.org/file/bot<token>/<file_path>`). Lets a caller
   * STREAM the bytes (e.g. `streamUrlToGcs` in the channel-media intake)
   * instead of buffering via `downloadMedia`. Same 20MB `getFile` cloud cap
   * applies. See large-content-artifacts §Phase 0.3.
   */
  resolveFileUrl(fileId: string): Promise<string>
  /**
   * Remove the bot from the given group/supergroup/channel. Silently swallows
   * "chat not found" errors so a best-effort leave never surfaces to the caller.
   */
  leaveChat(chatId: string): Promise<void>
} {
  const api = createTelegramApi({ token: options.token })
  const mediaGroups = new Map<string, BufferedGroup>()
  const textFragments = new Map<string, TextFragment>()
  const botIdFromToken = options.token.match(/^(\d+):/)?.[1]

  async function downloadMediaImpl(
    fileId: string,
    opts?: { mimeHint?: string },
  ): Promise<{ buffer: Buffer; mime: string; name: string }> {
    const file = await api.getFile(fileId)
    if (!file.file_path) {
      throw new Error(`Telegram getFile returned no file_path for ${fileId}`)
    }
    const buffer = await api.downloadFile(file.file_path)
    const name = file.file_path.split('/').pop() ?? `telegram-${fileId}`
    const mime = opts?.mimeHint ?? mimeFromPath(file.file_path)
    return { buffer, mime, name }
  }

  function isBotMentioned(msg: TelegramMessage): boolean {
    const content = msg.text ?? msg.caption
    const entities = msg.text !== undefined ? msg.entities : msg.caption_entities
    if (!options.botUsername || !content || !entities) return false
    return entities.some(
      (e) =>
        e.type === 'mention' &&
        content.slice(e.offset, e.offset + e.length).toLowerCase() === `@${options.botUsername!.toLowerCase()}`,
    )
  }

  function isReplyToBot(msg: TelegramMessage): boolean {
    const repliedFrom = msg.reply_to_message?.from
    if (!repliedFrom?.is_bot) return false
    if (botIdFromToken) return String(repliedFrom.id) === botIdFromToken
    return Boolean(
      options.botUsername &&
      repliedFrom.username?.toLowerCase() === options.botUsername.toLowerCase(),
    )
  }

  function parseBotCommand(msg: TelegramMessage): {
    length: number
    name: string
    rejected: boolean
  } | null {
    const content = msg.text ?? msg.caption
    const entities = msg.text !== undefined ? msg.entities : msg.caption_entities
    if (!content || !entities) return null
    const entity = entities.find((e) => e.type === 'bot_command' && e.offset === 0)
    if (!entity) return null
    const token = content.slice(0, entity.length)
    const match = token.match(/^\/([a-z][a-z0-9_]{0,31})(?:@([a-z0-9_]+))?$/i)
    if (!match) return null
    const target = match[2]
    return {
      length: entity.length,
      name: match[1].toLowerCase(),
      rejected: Boolean(
        target && (!options.botUsername || target.toLowerCase() !== options.botUsername.toLowerCase()),
      ),
    }
  }

  function isGroupChat(msg: TelegramMessage): boolean {
    return msg.chat.type === 'group' || msg.chat.type === 'supergroup'
  }

  /**
   * Resolve the effective `requireMention` for a given chat+topic. For the
   * structured config form, any matching override inverts the default exactly
   * once. A whole-chat entry (`topicId` null/undefined) applies to every topic
   * in that chat; an overlapping exact-topic entry is cumulative/idempotent,
   * not a second inversion.
   */
  /**
   * True when this bot is scoped to specific topics of `chatId` and the message
   * did not arrive in one of them — i.e. the conversation belongs to a sibling
   * bot sharing the group.
   *
   * A whole-chat override (`topicId` null/undefined) claims every topic, so a
   * bot holding one is never "bound elsewhere". A bot with no override for this
   * chat at all is not topic-bound and is likewise never excluded — that is the
   * single-bot-in-a-group case the capture-only exit was built for.
   */
  function isBoundToOtherTopics(chatId: string, topicId: number | undefined): boolean {
    const cfg = options.config?.requireMention
    if (cfg === undefined || typeof cfg === 'boolean') return false
    const forThisChat = cfg.overrides.filter((o) => o.chatId === chatId)
    if (forThisChat.length === 0) return false
    if (forThisChat.some((o) => o.topicId == null)) return false
    return !forThisChat.some((o) => topicId != null && o.topicId === topicId)
  }

  function resolveRequireMention(chatId: string, topicId: number | undefined): boolean {
    const cfg = options.config?.requireMention
    if (cfg === undefined) return true
    if (typeof cfg === 'boolean') return cfg

    const { default: base, overrides } = cfg
    const matched = overrides.some((o) => {
      if (o.chatId !== chatId) return false
      const overrideTopicId = o.topicId == null ? null : o.topicId
      return overrideTopicId === null || (topicId != null && overrideTopicId === topicId)
    })
    return matched ? !base : base
  }

  function parseMessage(msg: TelegramMessage): IncomingMessage | null {
    const text = msg.text ?? msg.caption ?? ''
    const isGroup = isGroupChat(msg)
    const mentioned = isBotMentioned(msg)
    const repliedToBot = isReplyToBot(msg)
    const botCommand = parseBotCommand(msg)
    const invokedByCommand = botCommand !== null && !botCommand.rejected

    const chatIdStr = String(msg.chat.id)
    const topicId = (msg.chat.is_forum === true && msg.message_thread_id != null)
      ? msg.message_thread_id
      : undefined
    const requireMention = resolveRequireMention(chatIdStr, topicId)

    // Skip service messages
    if (msg.new_chat_members || msg.left_chat_member) return null

    // Determine media BEFORE the addressing gate below. The gate's `return
    // null` is indistinguishable downstream from "nothing to do", so it must
    // not be reached without knowing whether this message carried a file.
    // Determine media
    let mediaUrl: string | undefined
    let mediaType: IncomingMessage['mediaType']
    let mediaMime: string | undefined
    let mediaName: string | undefined
    let mediaDurationSec: number | undefined
    let mediaSizeBytes: number | undefined
    if (msg.photo?.length) {
      mediaUrl = msg.photo[msg.photo.length - 1].file_id
      mediaType = 'photo'
      // Telegram always re-encodes photos to JPEG and strips the original
      // filename. The webhook payload carries no mime/name for photos.
      mediaMime = 'image/jpeg'
    } else if (msg.document) {
      mediaUrl = msg.document.file_id
      mediaType = 'document'
      mediaMime = msg.document.mime_type
      mediaName = msg.document.file_name
      mediaSizeBytes = msg.document.file_size
    } else if (msg.audio) {
      // Audio track ("as audio", music-note UI). Previously unhandled — the
      // message fell through to `return null` and was silently dropped (the
      // "1h45m recording" footgun). See docs/architecture/media/transcription.md Phase 1.
      mediaUrl = msg.audio.file_id
      mediaType = 'audio'
      mediaMime = msg.audio.mime_type ?? 'audio/mpeg'
      const tagName = [msg.audio.performer, msg.audio.title].filter(Boolean).join(' - ')
      mediaName = msg.audio.file_name ?? (tagName.length > 0 ? tagName : undefined)
      mediaDurationSec = msg.audio.duration
      mediaSizeBytes = msg.audio.file_size
    } else if (msg.voice) {
      mediaUrl = msg.voice.file_id
      mediaType = 'voice'
      mediaDurationSec = msg.voice.duration
      mediaSizeBytes = msg.voice.file_size
    } else if (msg.video) {
      mediaUrl = msg.video.file_id
      mediaType = 'video'
      mediaMime = msg.video.mime_type ?? 'video/mp4'
      mediaDurationSec = msg.video.duration
      mediaSizeBytes = msg.video.file_size
    }

    // ── Addressing gate ──
    // In groups, answer when @mentioned, replying to this bot, or explicitly
    // invoked through a bot command. Exact identity checks prevent co-resident bots
    // from answering each other's commands or reply threads.
    //
    // An unaddressed message that carried media is NOT dropped — it returns
    // with `captureOnly` so routes file the attachment and skip the turn.
    // Dropping it here is what made four uncaptioned .md files vanish without
    // a trace on 2026-08-07: the bot then answered a follow-up mention from an
    // empty context and invented upload instructions for a thing the user had
    // already done. See docs/architecture/channels/adapter-pattern.md →
    // "Unaddressed group media".
    const addressedToAnotherBot = botCommand?.rejected === true
    const unaddressed =
      addressedToAnotherBot ||
      (isGroup && requireMention && !mentioned && !repliedToBot && !invokedByCommand)
    // Only media a route can actually persist earns the capture-only exit.
    // Photos are outside the brain intake's scope (images are not filed), so a
    // capture-only photo would run no turn AND file nothing — a no-op dressed
    // up as a capture, which is the very failure this flag exists to end.
    // Anything not capturable keeps the historical drop.
    const capturable =
      mediaType === 'document' || mediaType === 'audio' || mediaType === 'video'
    // A capture is a write plus a "Filed X" reply, so it must only be taken by
    // a bot that is party to this conversation. Telegram delivers every group
    // message to every bot in the group, and a workspace that runs one BYO bot
    // per assistant in one topic-organized supergroup therefore had EVERY bot
    // take the capture exit: on 2026-08-11 a single CSV dropped in one topic
    // produced eight workspace-file copies and seven stray "Filed" replies from
    // assistants that were never addressed. The per-topic `requireMention`
    // overrides are the user's own statement of which topics a bot owns, so a
    // topic-bound bot outside its topics keeps the historical drop.
    if (unaddressed && isBoundToOtherTopics(chatIdStr, topicId)) return null
    if (unaddressed && !capturable) return null

    // Must have text or media
    if (!text && !mediaUrl) return null

    // Strip the addressing prefix from the model-facing text.
    let cleanText = text
    if (botCommand && !botCommand.rejected && botCommand.name === 'ask') {
      cleanText = cleanText.slice(botCommand.length).trim() || '/ask'
    } else if (botCommand && !botCommand.rejected) {
      // Strip only an optional @bot suffix. Keeping the command name lets the
      // shared pipeline resolve `/skill`, `/workflow`, and direct skill slugs.
      cleanText = `/${botCommand.name}${cleanText.slice(botCommand.length)}`.trim()
    } else if (options.botUsername) {
      cleanText = cleanText.replace(new RegExp(`@${options.botUsername}\\b`, 'gi'), '').trim()
    }

    // Forum-topic channel id: embed `message_thread_id` when the chat is a
    // forum supergroup so sessions / locks / group-chat context partition per
    // topic. Non-forum supergroups ignore `message_thread_id` (Telegram uses
    // it for reply chains in regular groups, which we don't treat as topics).
    const channelId = topicId != null
      ? `${msg.chat.id}:topic:${topicId}`
      : String(msg.chat.id)

    return {
      userId: String(msg.from?.id ?? msg.chat.id),
      senderDisplay: msg.from?.first_name ?? msg.from?.username,
      channelId,
      messageId: String(msg.message_id),
      text: cleanText,
      mediaUrl,
      mediaType,
      mediaMime,
      mediaName,
      mediaDurationSec,
      mediaSizeBytes,
      replyToMessageId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
      isGroupChat: isGroup,
      isMentioned: mentioned || repliedToBot || invokedByCommand,
      ...(unaddressed ? { captureOnly: true as const } : {}),
      timestamp: msg.date * 1000,
      raw: msg,
    }
  }

  function handleMediaGroup(msg: TelegramMessage): void {
    const groupId = msg.media_group_id!
    const existing = mediaGroups.get(groupId)

    if (existing) {
      clearTimeout(existing.timer)
      existing.messages.push(msg)
    } else {
      mediaGroups.set(groupId, { messages: [msg], timer: undefined })
    }

    const group = mediaGroups.get(groupId)!
    group.timer = setTimeout(() => {
      mediaGroups.delete(groupId)
      const messages = group.messages
      const onMessage = options.onMessage
      if (!onMessage) return

      // Addressing can ride ANY member's caption, not just the first —
      // Telegram attaches the caption to whichever item the user typed it
      // under. Prefer an addressed member as the base so one captioned file
      // isn't demoted to capture-only by its uncaptioned neighbours.
      const parsed = messages
        .map((m) => parseMessage(m))
        .filter((p): p is IncomingMessage => p !== null)
      const base = parsed.find((p) => !p.captureOnly) ?? parsed[0]
      if (!base) return

      // EVERY member contributes a file. This used to parse `messages[0]` and
      // drop the rest, so an album of four documents delivered one and
      // discarded three with nothing logged — `messages.length === 4` and
      // `=== 1` were indistinguishable downstream. See
      // docs/architecture/channels/adapter-pattern.md → "Albums".
      const files = messages
        .map((m) => fileFromMessage(m))
        .filter((f): f is IncomingFile => f !== null)
      if (files.length === 0) {
        onMessage(base)
        return
      }
      onMessage({
        ...base,
        // The multi-file shape supersedes the single-media fields so no
        // consumer can read one file and believe it has seen the album.
        mediaUrl: undefined,
        mediaType: undefined,
        mediaMime: undefined,
        mediaName: undefined,
        mediaSizeBytes: undefined,
        files,
      })
    }, MEDIA_GROUP_TIMEOUT_MS)
  }

  /**
   * One album member → one `IncomingFile`. Returns null for a member carrying
   * no supported media. Voice notes are excluded by design: their transcript
   * is authoritative and the raw audio is never attached (see
   * docs/architecture/media/transcription.md).
   */
  function fileFromMessage(m: TelegramMessage): IncomingFile | null {
    if (m.photo?.length) {
      // Telegram re-encodes photos to JPEG and strips the original filename;
      // the payload carries no mime, name, or size for them.
      return {
        url: m.photo[m.photo.length - 1].file_id,
        mimeType: 'image/jpeg',
        name: `photo_${m.message_id}.jpg`,
      }
    }
    if (m.document) {
      return {
        url: m.document.file_id,
        mimeType: m.document.mime_type ?? 'application/octet-stream',
        name: m.document.file_name ?? `document_${m.message_id}`,
        ...(m.document.file_size ? { sizeBytes: m.document.file_size } : {}),
      }
    }
    if (m.video) {
      return {
        url: m.video.file_id,
        mimeType: m.video.mime_type ?? 'video/mp4',
        name: `video_${m.message_id}.mp4`,
        ...(m.video.file_size ? { sizeBytes: m.video.file_size } : {}),
      }
    }
    if (m.audio) {
      const tagName = [m.audio.performer, m.audio.title].filter(Boolean).join(' - ')
      return {
        url: m.audio.file_id,
        mimeType: m.audio.mime_type ?? 'audio/mpeg',
        name: m.audio.file_name ?? (tagName.length > 0 ? tagName : `audio_${m.message_id}`),
        ...(m.audio.file_size ? { sizeBytes: m.audio.file_size } : {}),
      }
    }
    return null
  }

  // Buffer key: partition by chat AND topic so fragments posted in different
  // topics of the same forum aren't incorrectly merged.
  function fragmentKey(msg: TelegramMessage): string {
    return `${msg.chat.id}:${msg.message_thread_id ?? 0}`
  }

  function handleTextFragment(msg: TelegramMessage): void {
    const chatId = fragmentKey(msg)
    const existing = textFragments.get(chatId)
    const now = Date.now()

    // Check if this continues a fragment sequence
    if (
      existing &&
      msg.message_id === existing.lastMessageId + 1 &&
      now - existing.lastTimestamp < TEXT_FRAGMENT_GAP_MS &&
      existing.messages.length < TEXT_FRAGMENT_MAX_PARTS
    ) {
      clearTimeout(existing.timer)
      existing.messages.push(msg)
      existing.lastMessageId = msg.message_id
      existing.lastTimestamp = now
    } else {
      // Flush any previous fragment
      if (existing) {
        clearTimeout(existing.timer)
        flushTextFragment(chatId)
      }
      textFragments.set(chatId, {
        messages: [msg],
        timer: undefined,
        lastMessageId: msg.message_id,
        lastTimestamp: now,
      })
    }

    const frag = textFragments.get(chatId)!
    frag.timer = setTimeout(() => {
      flushTextFragment(chatId)
    }, TEXT_FRAGMENT_GAP_MS)
  }

  function flushTextFragment(chatId: string): void {
    const frag = textFragments.get(chatId)
    if (!frag) return
    textFragments.delete(chatId)

    // Merge all fragments into one message
    const mergedText = frag.messages.map((m) => m.text ?? m.caption ?? '').join('')
    const first = frag.messages[0]
    const merged: TelegramMessage = { ...first, text: mergedText }

    const parsed = parseMessage(merged)
    if (parsed && options.onMessage) {
      options.onMessage(parsed)
    }
  }

  /**
   * Send a text message, retrying once without `message_thread_id` when the
   * topic was deleted between inbound and outbound.
   */
  async function sendMessageWithThreadFallback(
    api: TelegramApi,
    chatId: string,
    text: string,
    opts: {
      parseMode?: string
      replyToMessageId?: number
      messageThreadId?: number
      replyMarkup?: unknown
    },
  ): Promise<{ message_id: number }> {
    try {
      return await api.sendMessage(chatId, text, opts)
    } catch (err) {
      if (opts.messageThreadId != null && isTelegramThreadNotFoundError(err)) {
        console.warn(
          `[telegram] sendMessage to chat ${chatId} failed because topic ${opts.messageThreadId} no longer exists; retrying without message_thread_id`,
        )
        return await api.sendMessage(chatId, text, { ...opts, messageThreadId: undefined })
      }
      throw err
    }
  }

  /**
   * Send `text` with Telegram's HTML parse_mode, falling back to plain text
   * if Telegram rejects the rendered HTML (malformed URL, unclosed tag, …).
   *
   * HTML is preferred over MarkdownV2: far fewer reserved characters, richer
   * nesting, and graceful handling of GFM constructs via `markdownToTelegramHTML`.
   * See core.telegram.org/bots/api#html-style.
   */
  async function sendWithMarkdownFallback(
    api: TelegramApi,
    chatId: string,
    text: string,
    format: string | undefined,
    replyToMessageId: number | undefined,
    messageThreadId: number | undefined,
  ): Promise<number> {
    if (format === 'markdown') {
      try {
        const html = markdownToTelegramHTML(text)
        const result = await sendMessageWithThreadFallback(api, chatId, html, {
          parseMode: 'HTML',
          replyToMessageId,
          messageThreadId,
        })
        return result.message_id
      } catch {
        const plain = stripMarkdown(text)
        const result = await sendMessageWithThreadFallback(api, chatId, plain, {
          replyToMessageId,
          messageThreadId,
        })
        return result.message_id
      }
    }
    const result = await sendMessageWithThreadFallback(api, chatId, text, {
      replyToMessageId,
      messageThreadId,
    })
    return result.message_id
  }

  return {
    type: 'telegram',
    maxMessageLength: TELEGRAM_MAX_MESSAGE_LENGTH,
    supportsMarkdown: true,
    supportsMessageEdit: true,
    drainDelayMs: 2000,

    parseIncoming(webhookPayload: unknown): IncomingMessage | null {
      const update = webhookPayload as TelegramUpdate
      const msg = update.message
      if (!msg) return null
      return parseMessage(msg)
    },

    deduplicateId(webhookPayload: unknown): string | null {
      const update = webhookPayload as TelegramUpdate
      return String(update.update_id)
    },

    handleWebhook(payload: unknown): void {
      const update = payload as TelegramUpdate

      // Handle membership changes (bot added to / removed from a chat).
      // Must come before the message/callback branches — these updates
      // arrive on their own, with no `message` or `callback_query` field.
      if (update.my_chat_member) {
        const mcm = update.my_chat_member
        const wasAbsent = mcm.old_chat_member.status === 'left' || mcm.old_chat_member.status === 'kicked'
        const isPresent = mcm.new_chat_member.status === 'member'
          || mcm.new_chat_member.status === 'administrator'
          || mcm.new_chat_member.status === 'restricted'
        if (mcm.chat.type === 'group' || mcm.chat.type === 'supergroup' || mcm.chat.type === 'channel') {
          options.onChatSeen?.({
            chatId: String(mcm.chat.id),
            chatTitle: mcm.chat.title ?? null,
            chatType: mcm.chat.type,
            isForum: mcm.chat.is_forum === true,
            topicId: null,
            topicName: null,
          })
        }
        options.onMyChatMember?.({
          adderUserId: String(mcm.from.id),
          chatId: String(mcm.chat.id),
          chatType: mcm.chat.type,
          previousStatus: mcm.old_chat_member.status,
          newStatus: mcm.new_chat_member.status,
          isFreshJoin: wasAbsent && isPresent,
        })
        return
      }

      // Handle callback queries (inline keyboard button presses).
      //
      // chatId must match the topic-qualified form used when the pending
      // confirmation was registered (route builds `${incoming.channelId}:${toolCallId}`),
      // so we read the button's underlying message for is_forum / message_thread_id.
      if (update.callback_query) {
        const cq = update.callback_query
        let chatId: string
        if (cq.message) {
          const m = cq.message
          const isForum = m.chat.is_forum === true
          const topic = isForum && m.message_thread_id != null ? m.message_thread_id : undefined
          chatId = topic != null ? `${m.chat.id}:topic:${topic}` : String(m.chat.id)
        } else {
          chatId = String(cq.from.id)
        }
        options.onCallbackQuery?.({
          id: cq.id,
          userId: String(cq.from.id),
          chatId,
          data: cq.data ?? '',
          messageId: cq.message?.message_id ?? 0,
        })
        return
      }

      const msg = update.message
      if (!msg) return

      // Chat observation: every inbound message in a group/supergroup/channel
      // feeds the seen-chats inventory. Topic name comes from service messages
      // (forum_topic_created / forum_topic_edited); regular messages in a
      // topic only carry `message_thread_id`, so `topicName` is null unless
      // this very message is the service one.
      const chatTypeObs = msg.chat.type
      if (chatTypeObs === 'group' || chatTypeObs === 'supergroup' || chatTypeObs === 'channel') {
        const isForum = msg.chat.is_forum === true
        const topicId = isForum && msg.message_thread_id != null ? msg.message_thread_id : null
        const topicName = msg.forum_topic_created?.name
          ?? msg.forum_topic_edited?.name
          ?? null
        options.onChatSeen?.({
          chatId: String(msg.chat.id),
          chatTitle: msg.chat.title ?? null,
          chatType: chatTypeObs,
          isForum,
          topicId,
          topicName,
        })
      }

      // Media group buffering
      if (msg.media_group_id) {
        handleMediaGroup(msg)
        return
      }

      // Text fragment reassembly (for long messages split by Telegram)
      if (msg.text && msg.text.length >= TELEGRAM_MAX_MESSAGE_LENGTH) {
        handleTextFragment(msg)
        return
      }

      // Normal message — flush any pending text fragments first (scoped to
      // this chat+topic so parallel topics don't disturb each other).
      const fragKey = fragmentKey(msg)
      if (textFragments.has(fragKey)) {
        clearTimeout(textFragments.get(fragKey)!.timer)
        flushTextFragment(fragKey)
      }

      const parsed = parseMessage(msg)
      if (parsed && options.onMessage) {
        options.onMessage(parsed)
      }
    },

    async sendMessage(channelId: string, response: OutgoingMessage, opts?: { threadTs?: string }): Promise<string> {
      const { chatId, messageThreadId } = parseTopicChannelId(channelId)
      const topicId = outboundThreadId(messageThreadId)
      // Telegram rejects empty text with a 400 — a documents-only send
      // skips the text loop entirely and returns the first document's id.
      const chunks = response.text.trim()
        ? chunkText(response.text, TELEGRAM_MAX_MESSAGE_LENGTH)
        : []
      let lastMessageId = 0
      const replyToId = opts?.threadTs ? Number(opts.threadTs) : undefined

      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1
        const replyMarkup = isLast && response.actions?.length
          ? { inline_keyboard: buildInlineKeyboard(response.actions) }
          : undefined

        try {
          // Only quote-reply on the first chunk
          lastMessageId = await sendWithMarkdownFallback(
            api,
            chatId,
            chunks[i],
            response.format,
            i === 0 ? replyToId : undefined,
            topicId,
          )
        } catch (err) {
          // Mid-chunk failure: earlier chunks have already landed, so a silent
          // truncation would leave the user with half a reply and no way to
          // tell. Mark the last successful chunk before re-throwing so the
          // caller's error path still runs. See adapter-pattern.md § 7.
          if (i > 0 && lastMessageId > 0) {
            const truncated = chunks[i - 1] + '\n\n— message cut off, reply to continue'
            await api.editMessageText(chatId, lastMessageId, truncated).catch(() => {})
          }
          throw err
        }

        if (replyMarkup) {
          // Re-send last chunk with buttons (Telegram needs them on the message itself)
          try {
            const body = response.format === 'markdown'
              ? markdownToTelegramHTML(chunks[i])
              : chunks[i]
            await api.editMessageText(chatId, lastMessageId, body, {
              parseMode: response.format === 'markdown' ? 'HTML' : undefined,
              replyMarkup,
            })
          } catch {
            // Edit failed — buttons just won't show
          }
        }
      }

      // Outbound documents — delivered after the text so the reply reads
      // top-down (text, then attachments). A per-document failure must not
      // fail the send: the text already landed, so surface a short notice
      // instead. The returned message id stays the LAST TEXT chunk's id —
      // that's what the channel-id round-trip (reaction feedback) anchors
      // to. See adapter-pattern.md → "Outbound documents".
      if (response.documents?.length) {
        for (const doc of response.documents) {
          try {
            let docResult: { message_id: number }
            try {
              docResult = await api.sendDocument(chatId, doc, { messageThreadId: topicId })
            } catch (err) {
              if (topicId != null && isTelegramThreadNotFoundError(err)) {
                docResult = await api.sendDocument(chatId, doc, {})
              } else {
                throw err
              }
            }
            // Documents-only send: no text chunk id to return, so the
            // round-trip anchor falls back to the first document.
            if (lastMessageId === 0) lastMessageId = docResult.message_id
          } catch (err) {
            console.warn(
              `[telegram] sendDocument failed for ${doc.filename}:`,
              err instanceof Error ? err.message : String(err),
            )
            await sendMessageWithThreadFallback(api, chatId, `Could not attach ${doc.filename}.`, {
              messageThreadId: topicId,
            }).catch(() => {})
          }
        }
      }

      return String(lastMessageId)
    },

    async editMessage(channelId: string, messageId: string, response: OutgoingMessage): Promise<void> {
      // editMessageText is keyed by (chat_id, message_id) — no message_thread_id.
      const { chatId } = parseTopicChannelId(channelId)
      const raw = response.text.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH)
      const isMarkdown = response.format === 'markdown'
      const body = isMarkdown ? markdownToTelegramHTML(raw) : raw
      try {
        await api.editMessageText(chatId, Number(messageId), body, {
          parseMode: isMarkdown ? 'HTML' : undefined,
        })
      } catch {
        try {
          const plain = stripMarkdown(raw)
          await api.editMessageText(chatId, Number(messageId), plain)
        } catch {
          // Give up on edit
        }
      }
    },

    async sendTypingIndicator(channelId: string): Promise<void> {
      const { chatId, messageThreadId } = parseTopicChannelId(channelId)
      try {
        await api.sendChatAction(chatId, 'typing', {
          messageThreadId: outboundThreadId(messageThreadId),
        })
      } catch {
        // Non-critical
      }
    },

    async sendStatus(channelId: string, status: string, opts?: { threadTs?: string; messageId?: string }): Promise<string> {
      const { chatId, messageThreadId } = parseTopicChannelId(channelId)
      const replyToId = opts?.threadTs ? Number(opts.threadTs) : undefined
      const result = await sendMessageWithThreadFallback(api, chatId, status, {
        replyToMessageId: replyToId,
        messageThreadId: outboundThreadId(messageThreadId),
      })
      return String(result.message_id)
    },

    async answerCallbackQuery(id: string, opts?: { text?: string }): Promise<void> {
      try {
        await api.answerCallbackQuery(id, opts)
      } catch {
        // Non-critical — Telegram requires answering within 30s but failure is cosmetic
      }
    },

    async deleteMessage(channelId: string, messageId: string): Promise<void> {
      const { chatId } = parseTopicChannelId(channelId)
      try {
        await api.deleteMessage(chatId, Number(messageId))
      } catch {
        // Non-critical — message may already be deleted or too old (>48h)
      }
    },

    async reactToMessage(channelId: string, messageId: string, emoji: string): Promise<void> {
      const { chatId } = parseTopicChannelId(channelId)
      try {
        await api.setMessageReaction(chatId, Number(messageId), emoji)
      } catch {
        // Non-critical — reaction might not be supported in older clients
      }
    },

    async pinMessage(channelId: string, messageId: string, opts?: { silent?: boolean }): Promise<void> {
      const { chatId } = parseTopicChannelId(channelId)
      try {
        await api.pinChatMessage(chatId, Number(messageId), {
          disableNotification: opts?.silent ?? true,
        })
      } catch (err) {
        console.warn(`[telegram] pinMessage(${chatId}, ${messageId}) failed:`, err)
      }
    },

    async unpinMessage(channelId: string, messageId: string): Promise<void> {
      const { chatId } = parseTopicChannelId(channelId)
      try {
        await api.unpinChatMessage(chatId, Number(messageId))
      } catch (err) {
        console.warn(`[telegram] unpinMessage(${chatId}, ${messageId}) failed:`, err)
      }
    },

    async downloadVoice(fileId: string): Promise<{ buffer: Buffer; mime: string }> {
      const { buffer, mime } = await downloadMediaImpl(fileId, {
        mimeHint: 'audio/ogg; codecs=opus',
      })
      return { buffer, mime }
    },

    downloadMedia: downloadMediaImpl,

    async resolveFileUrl(fileId: string): Promise<string> {
      const file = await api.getFile(fileId)
      if (!file.file_path) {
        throw new Error(`Telegram getFile returned no file_path for ${fileId}`)
      }
      return `https://api.telegram.org/file/bot${options.token}/${file.file_path}`
    },

    async leaveChat(chatId: string): Promise<void> {
      try {
        await api.leaveChat(chatId)
      } catch (err) {
        console.error(`[telegram] leaveChat(${chatId}) failed:`, err)
      }
    },
  }
}
