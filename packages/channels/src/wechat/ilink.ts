/**
 * iLink Bot API client — the sanctioned personal-WeChat bot surface.
 *
 * JSON over HTTPS against `https://ilinkai.weixin.qq.com` (a per-bot `baseurl`
 * override arrives at QR-login confirm). Auth is `Authorization: Bearer
 * <bot_token>` with `AuthorizationType: ilink_bot_token`. Receiving is a
 * long-poll (`getupdates` with an opaque `get_updates_buf` cursor); there is no
 * inbound webhook, which is why the channel needs the `wechat-connector`
 * bridge app. Wire protocol studied from the official Tencent plugin
 * `@tencent-weixin/openclaw-weixin` (see docs/architecture/channels/wechat.md).
 *
 * Component tag: [COMP:channels/wechat-adapter].
 */

// ── Constants ──────────────────────────────────────────────────

/** Fixed base URL for QR-login requests; also the default API base. */
export const ILINK_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** CDN base for media download when the server omits `full_url`. */
export const ILINK_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

/** `bot_type` for get_bot_qrcode / get_qrcode_status. */
const ILINK_BOT_TYPE = '3'

/**
 * Server errcode meaning the bot token is stale/expired. The poller must
 * pause all requests for the account (~1h) instead of hot-looping.
 */
export const ILINK_STALE_TOKEN_ERRCODE = -14

const LONG_POLL_TIMEOUT_MS = 35_000
const API_TIMEOUT_MS = 15_000
const CONFIG_TIMEOUT_MS = 10_000

// ── Wire types (JSON mirrors of the iLink proto) ───────────────

export const WeixinMessageType = { NONE: 0, USER: 1, BOT: 2 } as const
export const WeixinItemType = {
  NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5,
  TOOL_CALL_START: 11, TOOL_CALL_RESULT: 12,
} as const
export const WeixinMessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const

/** CDN media reference; `aes_key` is base64 in JSON (see media.ts for parsing). */
export type IlinkCdnMedia = {
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
  /** Complete download URL when the server supplies it (preferred). */
  full_url?: string
}

export type WeixinMessageItem = {
  type?: number
  create_time_ms?: number
  is_completed?: boolean
  msg_id?: string
  ref_msg?: { message_item?: WeixinMessageItem; title?: string }
  text_item?: { text?: string }
  image_item?: {
    media?: IlinkCdnMedia
    thumb_media?: IlinkCdnMedia
    /** Raw AES-128 key as hex; preferred over media.aes_key for inbound decrypt. */
    aeskey?: string
    mid_size?: number
  }
  voice_item?: {
    media?: IlinkCdnMedia
    /** 6 = silk (the common case). */
    encode_type?: number
    /** Duration in milliseconds. */
    playtime?: number
    /** Server-side speech-to-text, when WeChat produced one. */
    text?: string
  }
  file_item?: { media?: IlinkCdnMedia; file_name?: string; md5?: string; len?: string }
  video_item?: { media?: IlinkCdnMedia; video_size?: number; play_length?: number }
}

export type WeixinMessage = {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  create_time_ms?: number
  session_id?: string
  /** Present on group events — this channel is DMs-only and drops them. */
  group_id?: string
  message_type?: number
  message_state?: number
  item_list?: WeixinMessageItem[]
  /** Issued per-message; must be echoed on outbound sends to this user. */
  context_token?: string
  run_id?: string
}

export type IlinkGetUpdatesResponse = {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinMessage[]
  /** Opaque cursor to persist and echo on the next request. */
  get_updates_buf?: string
  /** Server-suggested timeout (ms) for the next long-poll. */
  longpolling_timeout_ms?: number
}

export type IlinkQrStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect'

export type IlinkQrStatusResponse = {
  status: IlinkQrStatus
  bot_token?: string
  ilink_bot_id?: string
  /** Per-bot API base for all subsequent calls. */
  baseurl?: string
  /** The WeChat user who scanned the code. */
  ilink_user_id?: string
  /** New polling host when status is scaned_but_redirect. */
  redirect_host?: string
}

// ── Request plumbing ───────────────────────────────────────────

/**
 * iLink-App-ClientVersion: uint32 `major<<16 | minor<<8 | patch`.
 * Sent for observability; the app id is the fixed `bot` id.
 */
function encodeClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((p) => parseInt(p, 10) || 0)
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

const CLIENT_VERSION = '1.0.0'
const BOT_AGENT = `UseBrian/${CLIENT_VERSION}`

/** X-WECHAT-UIN: random uint32 → decimal string → base64. */
function randomWechatUin(): string {
  const uint32 = Math.floor(Math.random() * 0xffffffff)
  return Buffer.from(String(uint32), 'utf-8').toString('base64')
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': String(encodeClientVersion(CLIENT_VERSION)),
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
  }
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`
  return headers
}

function joinUrl(baseUrl: string, endpoint: string): string {
  return new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString()
}

async function postJson<T>(params: {
  baseUrl: string
  endpoint: string
  body: unknown
  token?: string
  timeoutMs: number
  abortSignal?: AbortSignal
}): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), params.timeoutMs)
  const onExternalAbort = () => controller.abort()
  params.abortSignal?.addEventListener('abort', onExternalAbort, { once: true })
  try {
    const res = await fetch(joinUrl(params.baseUrl, params.endpoint), {
      method: 'POST',
      headers: buildHeaders(params.token),
      body: JSON.stringify({ ...(params.body as object), base_info: { channel_version: CLIENT_VERSION, bot_agent: BOT_AGENT } }),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`iLink ${params.endpoint} ${res.status}: ${text.slice(0, 300)}`)
    return JSON.parse(text) as T
  } finally {
    clearTimeout(timer)
    params.abortSignal?.removeEventListener('abort', onExternalAbort)
  }
}

// ── QR login (tokenless) ───────────────────────────────────────

/**
 * Start a QR login. `qrcode` keys the status poll; `qrcode_img_content` is the
 * URL the user's WeChat must scan (render it as a QR image client-side).
 */
export async function fetchBotQrcode(
  baseUrl: string = ILINK_DEFAULT_BASE_URL,
): Promise<{ qrcode: string; qrcode_img_content: string }> {
  return postJson({
    baseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(ILINK_BOT_TYPE)}`,
    body: { local_token_list: [] },
    timeoutMs: API_TIMEOUT_MS,
  })
}

/**
 * Long-poll the QR status (~35s server hold). A client-side timeout returns
 * `{ status: 'wait' }` so callers just poll again. `verifyCode` carries the
 * pairing digits when the server asked via `need_verifycode`.
 */
export async function pollQrcodeStatus(params: {
  baseUrl: string
  qrcode: string
  verifyCode?: string
  abortSignal?: AbortSignal
}): Promise<IlinkQrStatusResponse> {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`
  if (params.verifyCode) endpoint += `&verify_code=${encodeURIComponent(params.verifyCode)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LONG_POLL_TIMEOUT_MS)
  const onExternalAbort = () => controller.abort()
  params.abortSignal?.addEventListener('abort', onExternalAbort, { once: true })
  try {
    const res = await fetch(joinUrl(params.baseUrl, endpoint), {
      method: 'GET',
      headers: {
        'iLink-App-Id': 'bot',
        'iLink-App-ClientVersion': String(encodeClientVersion(CLIENT_VERSION)),
      },
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`iLink get_qrcode_status ${res.status}: ${text.slice(0, 300)}`)
    return JSON.parse(text) as IlinkQrStatusResponse
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError' && !params.abortSignal?.aborted) {
      return { status: 'wait' }
    }
    throw err
  } finally {
    clearTimeout(timer)
    params.abortSignal?.removeEventListener('abort', onExternalAbort)
  }
}

// ── Authenticated client ───────────────────────────────────────

export type IlinkClient = {
  /**
   * Long-poll for new messages. A client-side timeout resolves to
   * `{ ret: 0, msgs: [], get_updates_buf: <echo> }` — normal long-poll control
   * flow, just poll again.
   */
  getUpdates(params: {
    getUpdatesBuf: string
    timeoutMs?: number
    abortSignal?: AbortSignal
  }): Promise<IlinkGetUpdatesResponse>
  /** Send one message. Throws on non-zero `ret`. */
  sendMessage(msg: WeixinMessage): Promise<void>
  /** Fetch per-user bot config (carries the `typing_ticket` for sendTyping). */
  getConfig(params: { ilinkUserId: string; contextToken?: string }): Promise<{ ret?: number; typing_ticket?: string }>
  /** Typing indicator. `status` 1 = typing, 2 = cancel. */
  sendTyping(params: { ilinkUserId: string; typingTicket: string; status: 1 | 2 }): Promise<void>
  /** Presence handshake around the long-poll loop lifecycle. Best-effort. */
  notifyStart(): Promise<void>
  notifyStop(): Promise<void>
}

export function createIlinkClient(options: { baseUrl: string; token: string }): IlinkClient {
  const { baseUrl, token } = options
  return {
    async getUpdates(params) {
      const timeoutMs = params.timeoutMs ?? LONG_POLL_TIMEOUT_MS
      try {
        return await postJson<IlinkGetUpdatesResponse>({
          baseUrl,
          endpoint: 'ilink/bot/getupdates',
          body: { get_updates_buf: params.getUpdatesBuf },
          token,
          timeoutMs,
          abortSignal: params.abortSignal,
        })
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          return { ret: 0, msgs: [], get_updates_buf: params.getUpdatesBuf }
        }
        throw err
      }
    },

    async sendMessage(msg) {
      const resp = await postJson<{ ret?: number; errmsg?: string }>({
        baseUrl,
        endpoint: 'ilink/bot/sendmessage',
        body: { msg },
        token,
        timeoutMs: API_TIMEOUT_MS,
      })
      if (resp.ret && resp.ret !== 0) {
        throw new Error(`iLink sendmessage ret=${resp.ret} errmsg=${resp.errmsg ?? '(none)'}`)
      }
    },

    async getConfig(params) {
      return postJson({
        baseUrl,
        endpoint: 'ilink/bot/getconfig',
        body: { ilink_user_id: params.ilinkUserId, context_token: params.contextToken },
        token,
        timeoutMs: CONFIG_TIMEOUT_MS,
      })
    },

    async sendTyping(params) {
      await postJson({
        baseUrl,
        endpoint: 'ilink/bot/sendtyping',
        body: { ilink_user_id: params.ilinkUserId, typing_ticket: params.typingTicket, status: params.status },
        token,
        timeoutMs: CONFIG_TIMEOUT_MS,
      })
    },

    async notifyStart() {
      await postJson({ baseUrl, endpoint: 'ilink/bot/msg/notifystart', body: {}, token, timeoutMs: CONFIG_TIMEOUT_MS })
    },

    async notifyStop() {
      await postJson({ baseUrl, endpoint: 'ilink/bot/msg/notifystop', body: {}, token, timeoutMs: CONFIG_TIMEOUT_MS })
    },
  }
}
