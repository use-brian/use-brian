/**
 * Lightweight Telegram Bot API client using fetch.
 */

export type TelegramApiOptions = {
  token: string
  baseUrl?: string
}

/**
 * Telegram Bot API hard limit on `getFile` downloads: a bot can only download
 * files up to 20 MB. A larger inbound file (e.g. a multi-hour recording) cannot
 * be pulled through the bot at all — callers should refuse it up front rather
 * than attempt a doomed `getFile`. See docs/plans/recording-to-brain.md.
 */
export const TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024

// Retry tuning — see docs/architecture/channels/adapter-pattern.md § "Rate-limit retry".
// Cap honours the chat-lock's held PG connection: waiting much longer would
// stall the pool for no user-visible benefit.
const MAX_RETRY_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 1000
const MAX_RETRY_DELAY_MS = 10_000

// Typing keepalives: retrying a stale indicator wastes rate budget and stalls
// the query-loop event handler. The next 4s cycle retries naturally.
const METHODS_SKIP_RETRY = new Set(['sendChatAction'])

type TelegramResponse<T> = {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
  parameters?: { retry_after?: number }
}

export class TelegramApiError extends Error {
  readonly method: string
  readonly errorCode: number | undefined
  readonly description: string | undefined

  constructor(method: string, description: string | undefined, errorCode: number | undefined) {
    super(`Telegram API ${method}: ${description ?? 'unknown error'}`)
    this.name = 'TelegramApiError'
    this.method = method
    this.description = description
    this.errorCode = errorCode
  }
}

/**
 * Matches Telegram's "message thread not found" response. Raised when a topic
 * was deleted between an inbound update and our outbound call. The adapter
 * uses this to retry once without `message_thread_id`.
 */
export function isTelegramThreadNotFoundError(err: unknown): boolean {
  if (!(err instanceof TelegramApiError)) return false
  return typeof err.description === 'string'
    && err.description.toLowerCase().includes('message thread not found')
}

export function createTelegramApi(options: TelegramApiOptions) {
  const base = options.baseUrl ?? `https://api.telegram.org/bot${options.token}`
  // Telegram serves file downloads from a different subpath than the bot API.
  // Deriving it from `base` lets tests swap the whole host in via `baseUrl`.
  const fileBase = options.baseUrl
    ? options.baseUrl.replace('/bot', '/file/bot')
    : `https://api.telegram.org/file/bot${options.token}`

  /**
   * Shared retry-aware request core. `makeInit` is a factory so multipart
   * bodies (FormData) are rebuilt per attempt — a consumed body can't be
   * re-sent.
   */
  async function perform<T>(method: string, makeInit: () => RequestInit): Promise<T> {
    const allowRetry = !METHODS_SKIP_RETRY.has(method)
    const maxAttempts = allowRetry ? MAX_RETRY_ATTEMPTS : 1

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await fetch(`${base}/${method}`, makeInit())

      const data = await res.json() as TelegramResponse<T>
      if (data.ok) return data.result as T

      const isRateLimited = data.error_code === 429 || res.status === 429
      if (allowRetry && isRateLimited && attempt < maxAttempts) {
        const retryAfterSec = data.parameters?.retry_after
        const delayMs = typeof retryAfterSec === 'number'
          ? Math.min(retryAfterSec * 1000, MAX_RETRY_DELAY_MS)
          : DEFAULT_RETRY_DELAY_MS
        console.warn(
          `[telegram-api] ${method} rate-limited, retrying in ${delayMs}ms (attempt ${attempt}/${maxAttempts - 1})`,
        )
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        continue
      }

      throw new TelegramApiError(method, data.description, data.error_code)
    }

    // Exhausted retries — the final attempt already threw; this line is unreachable
    // but satisfies the type checker.
    throw new TelegramApiError(method, 'retry budget exhausted', undefined)
  }

  async function call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    return perform<T>(method, () => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: params ? JSON.stringify(params) : undefined,
    }))
  }

  return {
    getMe: () => call<{ id: number; username: string; first_name: string }>('getMe'),

    sendMessage: (chatId: string, text: string, opts?: {
      parseMode?: string
      replyToMessageId?: number
      replyMarkup?: unknown
      messageThreadId?: number
    }) => call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: opts?.parseMode,
      reply_to_message_id: opts?.replyToMessageId,
      reply_markup: opts?.replyMarkup,
      message_thread_id: opts?.messageThreadId,
    }),

    editMessageText: (chatId: string, messageId: number, text: string, opts?: {
      parseMode?: string
      replyMarkup?: unknown
    }) => call<true | { message_id: number }>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: opts?.parseMode,
      reply_markup: opts?.replyMarkup,
    }),

    /**
     * Send a file as a Telegram document message (multipart upload).
     * Bot API bound is 50 MB for multipart uploads — the pipeline caps
     * outbound documents at 45 MB before they reach here. See
     * docs/architecture/channels/adapter-pattern.md → "Outbound documents".
     */
    sendDocument: (chatId: string, doc: {
      filename: string
      mime: string
      data: Uint8Array
      caption?: string
    }, opts?: { messageThreadId?: number; replyToMessageId?: number }) =>
      perform<{ message_id: number }>('sendDocument', () => {
        const form = new FormData()
        form.append('chat_id', chatId)
        form.append('document', new Blob([doc.data], { type: doc.mime }), doc.filename)
        if (doc.caption) form.append('caption', doc.caption)
        if (opts?.messageThreadId !== undefined) {
          form.append('message_thread_id', String(opts.messageThreadId))
        }
        if (opts?.replyToMessageId !== undefined) {
          form.append('reply_to_message_id', String(opts.replyToMessageId))
        }
        return { method: 'POST', body: form }
      }),

    sendChatAction: (chatId: string, action: string, opts?: { messageThreadId?: number }) =>
      call<true>('sendChatAction', {
        chat_id: chatId,
        action,
        message_thread_id: opts?.messageThreadId,
      }),

    answerCallbackQuery: (callbackQueryId: string, opts?: { text?: string; showAlert?: boolean }) =>
      call<true>('answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        text: opts?.text,
        show_alert: opts?.showAlert,
      }),

    setWebhook: (url: string, secretToken?: string) =>
      call<true>('setWebhook', {
        url,
        secret_token: secretToken,
        // `my_chat_member` is opt-in — default webhook set excludes it.
        // We need it for BYO group add-protection (packages/api/src/routes/telegram-byo.ts).
        // `message_reaction` is also opt-in — needed for the emoji
        // feedback signal that feeds reflection consolidation. See
        // docs/architecture/brain/corrections.md → "Emoji reactions
        // as feedback signal".
        allowed_updates: ['message', 'callback_query', 'my_chat_member', 'message_reaction'],
      }),

    deleteWebhook: () => call<true>('deleteWebhook'),

    deleteMessage: (chatId: string, messageId: number) =>
      call<true>('deleteMessage', { chat_id: chatId, message_id: messageId }),

    /**
     * Remove the bot from a group/supergroup/channel. Used by BYO group
     * add-protection when an unauthorized user adds the bot to a chat.
     */
    leaveChat: (chatId: string) =>
      call<true>('leaveChat', { chat_id: chatId }),

    pinChatMessage: (chatId: string, messageId: number, opts?: { disableNotification?: boolean }) =>
      call<true>('pinChatMessage', {
        chat_id: chatId,
        message_id: messageId,
        disable_notification: opts?.disableNotification,
      }),

    unpinChatMessage: (chatId: string, messageId: number) =>
      call<true>('unpinChatMessage', {
        chat_id: chatId,
        message_id: messageId,
      }),

    setMessageReaction: (chatId: string, messageId: number, emoji: string) =>
      call<true>('setMessageReaction', {
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: 'emoji', emoji }],
      }),

    /** Resolve a `file_id` to a downloadable `file_path`. */
    getFile: (fileId: string) =>
      call<{ file_id: string; file_unique_id: string; file_size?: number; file_path?: string }>(
        'getFile',
        { file_id: fileId },
      ),

    /**
     * Download a file by its `file_path` (returned from `getFile`).
     * Returns the raw bytes as a Buffer — the caller decides what to do
     * with them (e.g. transcribe audio, parse a document).
     */
    async downloadFile(filePath: string): Promise<Buffer> {
      const res = await fetch(`${fileBase}/${filePath}`)
      if (!res.ok) {
        throw new Error(`Telegram downloadFile failed (HTTP ${res.status})`)
      }
      const arrayBuffer = await res.arrayBuffer()
      return Buffer.from(arrayBuffer)
    },
  }
}

export type TelegramApi = ReturnType<typeof createTelegramApi>
