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
 * than attempt a doomed `getFile`. See docs/architecture/media/transcription.md.
 */
export const TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024

export const TELEGRAM_BOT_COMMANDS = [
  { command: 'ask', description: 'Ask Brian anything' },
] as const

// Retry tuning — see docs/architecture/channels/adapter-pattern.md § "Transient retry".
// Cap honours the chat-lock's held PG connection: waiting much longer would
// stall the pool for no user-visible benefit.
const MAX_RETRY_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 1000
const MAX_RETRY_DELAY_MS = 10_000

// A 5xx / socket reset carries no `retry_after`, so the backoff is ours to
// pick. Kept much shorter than the rate-limit delay for the same reason the
// cap above exists: an inbound webhook holds a chat-lock connection for the
// whole download, so ~2s of total patience is the budget. Delay per attempt is
// `TRANSIENT_RETRY_DELAY_MS * attempt` (500ms, then 1000ms).
const TRANSIENT_RETRY_DELAY_MS = 500

// Typing keepalives: retrying a stale indicator wastes rate budget and stalls
// the query-loop event handler. The next 4s cycle retries naturally.
const METHODS_SKIP_RETRY = new Set(['sendChatAction'])

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Is this failure worth another attempt?
 *
 * A 5xx is Telegram's own infrastructure, not our request: on 2026-08-17 a
 * `getFile` came back `504 Gateway Timeout` and, because only 429 was retried,
 * the voice note behind it was lost outright — the same file downloaded fine
 * minutes later. A 4xx (other than 429) is a verdict on the request and must
 * NOT be replayed.
 */
function isTransientStatus(status: number | undefined): boolean {
  return status !== undefined && status >= 500
}

/**
 * undici surfaces a connection reset / DNS blip as an opaque
 * `TypeError: fetch failed`, with the real cause nested. Flatten it so the log
 * line and the `TelegramApiError.description` say what actually happened
 * instead of "fetch failed".
 */
function transportMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = (err as { cause?: unknown }).cause
  const causeMsg = cause instanceof Error ? cause.message : undefined
  const code = (cause as { code?: string } | undefined)?.code
  return [err.message, causeMsg, code ? `(${code})` : undefined].filter(Boolean).join(' - ')
}

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

/**
 * A short, user-facing reason for a failure on the inbound *download* leg
 * (`getFile` + `downloadFile`), carrying Telegram's own status code.
 *
 * This exists because a download failure used to be described by the
 * transcription describer. Telegram's `504 Gateway Timeout` matched that
 * function's `/timeout|abort/i` branch and came out as "transcription timed
 * out", so on 2026-08-17 an assistant told a user their voice note was too
 * long for the transcriber and asked them to re-record something shorter —
 * about a file the transcriber had never been handed. A vendor's wording must
 * never fall through into another layer's vocabulary; the code is what makes
 * the difference legible, so it is always named.
 *
 * Callers pass the raw error: anything that is not a `TelegramApiError` still
 * gets an honest download-leg sentence rather than being re-described as a
 * model failure.
 */
export function describeTelegramDownloadFailure(err: unknown): string {
  if (!(err instanceof TelegramApiError)) {
    const message = err instanceof Error ? err.message : String(err)
    return `the file could not be downloaded from Telegram: ${message.slice(0, 200)}`
  }

  const code = err.errorCode
  const detail = `Telegram API error ${code ?? 'unknown'}${err.description ? `: ${err.description}` : ''}`

  if (isTransientStatus(code)) {
    return (
      `Telegram's own file service failed (${detail}) after ${MAX_RETRY_ATTEMPTS} attempts, ` +
      'so the file never reached the transcriber. This is a temporary Telegram fault, not a ' +
      'problem with the recording - ask the user to send it again'
    )
  }
  if (code === 429) {
    return `Telegram is rate-limiting this bot (${detail}), so the file could not be fetched. Ask the user to send it again shortly`
  }
  if (err.description && /too big/i.test(err.description)) {
    return `the file is larger than Telegram's ${TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES / (1024 * 1024)} MB bot download limit (${detail}), so a bot cannot fetch it at all`
  }
  if (code === 400 || code === 404) {
    return `Telegram no longer has that file reference (${detail}). Ask the user to send it again`
  }
  return `the file could not be downloaded from Telegram (${detail})`
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
      let res: Response
      try {
        res = await fetch(`${base}/${method}`, makeInit())
      } catch (err) {
        // No response exists, so nothing was consumed and a replay is safe.
        if (allowRetry && attempt < maxAttempts) {
          console.warn(
            `[telegram-api] ${method} transport failure, retrying in ${TRANSIENT_RETRY_DELAY_MS * attempt}ms ` +
            `(attempt ${attempt}/${maxAttempts}): ${transportMessage(err)}`,
          )
          await sleep(TRANSIENT_RETRY_DELAY_MS * attempt)
          continue
        }
        throw new TelegramApiError(method, transportMessage(err), undefined)
      }

      // A 5xx from Telegram's edge is not always JSON. `res.json()` would throw
      // a SyntaxError naming the stray character, which then reaches the caller
      // as the entire explanation of the failure.
      let data: TelegramResponse<T>
      try {
        data = await res.json() as TelegramResponse<T>
      } catch {
        data = { ok: false, description: res.statusText || 'non-JSON response', error_code: res.status }
      }
      if (data.ok) return data.result as T

      // `error_code` is Telegram's; `res.status` is the transport's. Prefer
      // Telegram's and fall back, so the code we surface is never `undefined`
      // just because the body was malformed.
      const status = data.error_code ?? res.status
      const isRateLimited = status === 429

      if (allowRetry && (isRateLimited || isTransientStatus(status)) && attempt < maxAttempts) {
        const retryAfterSec = data.parameters?.retry_after
        const delayMs = isRateLimited
          ? (typeof retryAfterSec === 'number'
              ? Math.min(retryAfterSec * 1000, MAX_RETRY_DELAY_MS)
              : DEFAULT_RETRY_DELAY_MS)
          : TRANSIENT_RETRY_DELAY_MS * attempt
        console.warn(
          `[telegram-api] ${method} failed with ${status}${data.description ? ` (${data.description})` : ''}, ` +
          `retrying in ${delayMs}ms (attempt ${attempt}/${maxAttempts})`,
        )
        await sleep(delayMs)
        continue
      }

      throw new TelegramApiError(method, data.description, status)
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

    setMyCommands: (commands: ReadonlyArray<{ command: string; description: string }>) =>
      call<true>('setMyCommands', { commands }),

    upsertMyCommands: async (commands: ReadonlyArray<{ command: string; description: string }>) => {
      const existing = await call<Array<{ command: string; description: string }>>('getMyCommands')
      const incomingNames = new Set(commands.map((command) => command.command))
      return call<true>('setMyCommands', {
        commands: [...existing.filter((command) => !incomingNames.has(command.command)), ...commands],
      })
    },

    deleteWebhook: () => call<true>('deleteWebhook'),

    deleteMessage: (chatId: string, messageId: number) =>
      call<true>('deleteMessage', { chat_id: chatId, message_id: messageId }),

    /**
     * Remove the bot from a group/supergroup/channel. Used by BYO group
     * add-protection when an unauthorized user adds the bot to a chat.
     */
    leaveChat: (chatId: string) =>
      call<true>('leaveChat', { chat_id: chatId }),

    /**
     * Chat metadata for a chat this bot can see. `title` is set for
     * groups/supergroups/channels; private chats carry `first_name` /
     * `last_name` / `username` instead. Only a bot that is in the chat can
     * resolve it — a wrong-bot lookup throws `TelegramApiError` ("chat not
     * found"), which callers treat as "unresolvable", not fatal. Used to
     * name sessions-derived delivery destinations in the workflow builder.
     */
    getChat: (chatId: string) =>
      call<{
        id: number
        type: 'private' | 'group' | 'supergroup' | 'channel'
        title?: string
        username?: string
        first_name?: string
        last_name?: string
      }>('getChat', { chat_id: chatId }),

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
      // Not routed through `perform` — this host returns raw bytes, not the
      // `{ ok, result }` envelope — but it needs the same transient patience:
      // it is the second half of every inbound voice note, and a blip here
      // loses the content just as completely as one on `getFile`. Throws a
      // `TelegramApiError` so callers can tell a Telegram fault from ours.
      for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
        let res: Response
        try {
          res = await fetch(`${fileBase}/${filePath}`)
        } catch (err) {
          if (attempt < MAX_RETRY_ATTEMPTS) {
            console.warn(
              `[telegram-api] downloadFile transport failure, retrying in ${TRANSIENT_RETRY_DELAY_MS * attempt}ms ` +
              `(attempt ${attempt}/${MAX_RETRY_ATTEMPTS}): ${transportMessage(err)}`,
            )
            await sleep(TRANSIENT_RETRY_DELAY_MS * attempt)
            continue
          }
          throw new TelegramApiError('downloadFile', transportMessage(err), undefined)
        }

        if (res.ok) return Buffer.from(await res.arrayBuffer())

        if ((isTransientStatus(res.status) || res.status === 429) && attempt < MAX_RETRY_ATTEMPTS) {
          console.warn(
            `[telegram-api] downloadFile failed with ${res.status}, ` +
            `retrying in ${TRANSIENT_RETRY_DELAY_MS * attempt}ms (attempt ${attempt}/${MAX_RETRY_ATTEMPTS})`,
          )
          await sleep(TRANSIENT_RETRY_DELAY_MS * attempt)
          continue
        }

        throw new TelegramApiError('downloadFile', res.statusText || `HTTP ${res.status}`, res.status)
      }

      throw new TelegramApiError('downloadFile', 'retry budget exhausted', undefined)
    },
  }
}

export type TelegramApi = ReturnType<typeof createTelegramApi>
