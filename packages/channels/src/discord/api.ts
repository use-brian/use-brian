/**
 * Lightweight Discord REST API (v10) client using fetch.
 *
 * Outbound only — receiving messages happens over the Gateway WebSocket
 * (a separate transport) or via HTTP Interactions; both are parsed by
 * `adapter.parseIncoming`. This client covers the send/edit/delete/react/
 * typing surface plus `getCurrentUser` for credential validation.
 *
 * Auth header is `Authorization: Bot <token>` (note the `Bot ` prefix — a
 * raw token without it is rejected). Discord also requires a descriptive
 * `User-Agent` on every request.
 */

export type DiscordApiOptions = {
  token: string
  baseUrl?: string
}

// Retry tuning mirrors the Telegram client. Discord returns HTTP 429 with a
// JSON body `{ retry_after: <seconds>, global: <bool> }`; we honour
// `retry_after` up to a cap so a per-chat lock's held PG connection never
// stalls indefinitely. See docs/architecture/channels/discord.md § "Rate limits".
const MAX_RETRY_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 1000
const MAX_RETRY_DELAY_MS = 10_000

// Discord asks bots to send a User-Agent of the form `DiscordBot ($url, $version)`.
const USER_AGENT = 'DiscordBot (https://usebrian.ai, 1.0)'

type DiscordErrorBody = {
  message?: string
  code?: number
  retry_after?: number
  global?: boolean
}

export class DiscordApiError extends Error {
  readonly method: string
  readonly httpStatus: number
  readonly code: number | undefined

  constructor(method: string, httpStatus: number, body: DiscordErrorBody | undefined) {
    super(`Discord API ${method} (HTTP ${httpStatus}): ${body?.message ?? 'unknown error'}${body?.code != null ? ` [code ${body.code}]` : ''}`)
    this.name = 'DiscordApiError'
    this.method = method
    this.httpStatus = httpStatus
    this.code = body?.code
  }
}

// ── Discord REST shapes (only the fields we read) ──────────────

export type DiscordRestUser = {
  id: string
  username: string
  global_name?: string | null
  bot?: boolean
}

export type DiscordRestMessage = {
  id: string
  channel_id: string
}

export type DiscordAllowedMentions = {
  parse: Array<'users' | 'roles' | 'everyone'>
}

type DiscordMessageReference = {
  message_id: string
  channel_id?: string
  fail_if_not_exists?: boolean
}

// ── Message components (buttons) ───────────────────────────────
//
// Discord renders interactive buttons from a `components` array of action rows
// (type 1), each holding up to 5 buttons (type 2). A button is either a callback
// button (styles 1-4) carrying a `custom_id` echoed back on click, or a link
// button (style 5) carrying a `url` and no custom_id. Styles: 1 primary, 2
// secondary, 3 success (green), 4 danger (red), 5 link.
export type DiscordButton =
  | { type: 2; style: 1 | 2 | 3 | 4; label: string; custom_id: string }
  | { type: 2; style: 5; label: string; url: string }

export type DiscordActionRow = { type: 1; components: DiscordButton[] }

export type DiscordCreateMessageBody = {
  content: string
  message_reference?: DiscordMessageReference
  allowed_mentions?: DiscordAllowedMentions
  components?: DiscordActionRow[]
  flags?: number
}

export type DiscordEditMessageBody = {
  content: string
  components?: DiscordActionRow[]
  allowed_mentions?: DiscordAllowedMentions
}

// ── Interaction responses ──────────────────────────────────────
//
// A component (button) interaction is acknowledged via the interaction-callback
// endpoint. Type 6 (DEFERRED_UPDATE_MESSAGE) acks silently; type 7
// (UPDATE_MESSAGE) acks and edits the message the button is attached to in the
// same call. We use type 7 to morph the confirmation prompt into a result line
// and clear its buttons atomically.
export const InteractionCallbackType = { DEFERRED_UPDATE_MESSAGE: 6, UPDATE_MESSAGE: 7 } as const

export type DiscordInteractionResponse =
  | { type: 6 }
  | {
      type: 7
      data: { content?: string; components?: DiscordActionRow[]; allowed_mentions?: DiscordAllowedMentions }
    }

export function createDiscordApi(options: DiscordApiOptions) {
  const base = options.baseUrl ?? 'https://discord.com/api/v10'

  async function call<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bot ${options.token}`,
          'User-Agent': USER_AGENT,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })

      // 204 No Content (typing, reactions, delete) — nothing to parse.
      if (res.status === 204) return undefined as T
      if (res.ok) return (await res.json()) as T

      // Rate limited — honour retry_after (seconds) up to the cap, then retry.
      if (res.status === 429 && attempt < MAX_RETRY_ATTEMPTS) {
        const errBody = (await res.json().catch(() => undefined)) as DiscordErrorBody | undefined
        const retryAfterSec = errBody?.retry_after
        const delayMs = typeof retryAfterSec === 'number'
          ? Math.min(retryAfterSec * 1000, MAX_RETRY_DELAY_MS)
          : DEFAULT_RETRY_DELAY_MS
        console.warn(
          `[discord-api] ${method} ${path} rate-limited, retrying in ${delayMs}ms (attempt ${attempt}/${MAX_RETRY_ATTEMPTS - 1})`,
        )
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        continue
      }

      const errBody = (await res.json().catch(() => undefined)) as DiscordErrorBody | undefined
      throw new DiscordApiError(`${method} ${path}`, res.status, errBody)
    }

    // Unreachable — the final attempt throws above — but satisfies the type checker.
    throw new DiscordApiError(`${method} ${path}`, 429, { message: 'retry budget exhausted' })
  }

  return {
    /** The bot's own user — used for credential validation and self-mention detection. */
    getCurrentUser: () => call<DiscordRestUser>('GET', '/users/@me'),

    /** POST /channels/{channel.id}/messages — returns the created message (we read `id`). */
    createMessage: (channelId: string, body: DiscordCreateMessageBody) =>
      call<DiscordRestMessage>('POST', `/channels/${channelId}/messages`, body),

    /** PATCH /channels/{channel.id}/messages/{message.id} */
    editMessage: (channelId: string, messageId: string, body: DiscordEditMessageBody) =>
      call<DiscordRestMessage>('PATCH', `/channels/${channelId}/messages/${messageId}`, body),

    /** DELETE /channels/{channel.id}/messages/{message.id} */
    deleteMessage: (channelId: string, messageId: string) =>
      call<void>('DELETE', `/channels/${channelId}/messages/${messageId}`),

    /**
     * PUT /channels/{channel.id}/messages/{message.id}/reactions/{emoji}/@me
     *
     * `emoji` is a single unicode emoji (e.g. `👀`) or a custom emoji in
     * `name:id` form. URL-encoded so multi-byte unicode survives the path.
     */
    createReaction: (channelId: string, messageId: string, emoji: string) =>
      call<void>(
        'PUT',
        `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
      ),

    /** POST /channels/{channel.id}/typing — shows the bot "typing…" for ~10s. */
    triggerTyping: (channelId: string) =>
      call<void>('POST', `/channels/${channelId}/typing`),
  }
}

export type DiscordApi = ReturnType<typeof createDiscordApi>

/**
 * Acknowledge a component (button) interaction via
 * `POST /interactions/{id}/{token}/callback`.
 *
 * This endpoint is authenticated by the interaction `token` in the URL, **not**
 * by a bot token — so it is a plain `fetch` independent of any bot's
 * credentials (the API layer can ack without re-deriving which bot owns the
 * channel). Discord requires the ack within **3 seconds** of the interaction or
 * the user sees "This interaction failed"; the caller must keep the round-trip
 * tight. A first ack returns 204; a second ack for the same interaction returns
 * 40060 ("interaction has already been acknowledged") — callers dedup upstream.
 */
export async function respondToInteraction(
  interactionId: string,
  interactionToken: string,
  response: DiscordInteractionResponse,
  opts?: { baseUrl?: string },
): Promise<void> {
  const base = opts?.baseUrl ?? 'https://discord.com/api/v10'
  const res = await fetch(`${base}/interactions/${interactionId}/${interactionToken}/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify(response),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as DiscordErrorBody | undefined
    throw new DiscordApiError('POST /interactions/:id/:token/callback', res.status, body)
  }
}
