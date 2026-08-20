/**
 * Thin client for the agent-wechat container's HTTP + WebSocket API.
 *
 * This is the fork point named in docs/architecture/channels/wechat-desktop.md:
 * everything above `AgentWechatClient` is ours; if the upstream image changes
 * or is replaced, only this file (and the types below, which mirror its wire
 * shapes) moves. Written against the REST surface, not copied from upstream.
 */

export type AgentWechatChat = {
  id: string
  username: string
  name: string
  remark?: string
  lastMessagePreview?: string
  lastMessageSender?: string
  lastActivityAt?: string
  unreadCount: number
  isGroup: boolean
  lastMsgLocalId?: number
}

type AgentWechatReply = { sender?: string; content: string; messageId?: string }

export type AgentWechatMessage = {
  localId: number
  serverId: number
  chatId: string
  sender?: string
  senderName?: string
  type: number
  content: string
  /** ISO timestamp */
  timestamp: string
  isMentioned?: boolean
  isSelf?: boolean
  reply?: AgentWechatReply
}

export type AgentWechatMediaResult = {
  /** 'image' | 'voice' | 'video' | 'file' | 'unsupported' | ... */
  type: string
  /** base64 */
  data?: string
  url?: string
  format: string
  filename: string
  status?: 'ready' | 'pending' | 'unavailable'
  kind?: 'image' | 'file' | 'video' | 'voice' | 'sticker' | 'unsupported'
  variant?: 'original' | 'preview' | 'raw'
  mime?: string
  sizeBytes?: number
  sha256?: string
  reason?: string
  action?: string
  retryAfterMs?: number
  recoverable?: boolean
}

type AgentWechatMediaContent = {
  body: ReadableStream<Uint8Array>
  contentLength: number
  mime: string
  filename: string
  etag?: string
}

type AgentWechatAuthStatus = {
  status: 'logged_in' | 'logged_out' | 'app_not_running' | 'unknown'
  loggedInUser?: string
}

export type AgentWechatSendParams = {
  chatId: string
  text?: string
  image?: { data: string; mimeType: string }
  file?: { data: string; filename: string }
}

type AgentWechatSendResult = { success: boolean; error?: string }

export type AgentWechatLoginEvent =
  | { type: 'status'; message: string }
  | { type: 'qr'; qrData: string; qrBinaryData?: number[]; qrDataUrl?: string }
  | { type: 'phone_confirm'; message?: string }
  | { type: 'login_success'; userId?: string }
  | { type: 'login_timeout' }
  | { type: 'error'; message: string }

export type LoginSubscription = { close: () => void }

export interface AgentWechatClient {
  /** GET /health (unauthenticated). Resolves true when the container answers 2xx. */
  health(): Promise<boolean>
  authStatus(): Promise<AgentWechatAuthStatus>
  logout(): Promise<{ success: boolean; error?: string }>
  listChats(limit?: number, offset?: number): Promise<AgentWechatChat[]>
  /** Newest-first, as the container returns it. */
  listMessages(chatId: string, limit?: number, offset?: number): Promise<AgentWechatMessage[]>
  getMedia(chatId: string, localId: number): Promise<AgentWechatMediaResult>
  ensureMedia(chatId: string, localId: number): Promise<AgentWechatMediaResult>
  getMediaContent(chatId: string, localId: number): Promise<AgentWechatMediaContent>
  /**
   * Select the chat in the client UI (the container's `chat_open` plan). The
   * client then downloads the full-size media for viewport-visible messages —
   * the trigger the original-image upgrade rides. Serialized against sends by
   * the container's global plan lock. NOTE: opening marks the chat read and
   * WeChat syncs read state to the phone — callers gate on `unreadCount === 0`.
   */
  openChat(chatId: string): Promise<{ ok: boolean; error?: string }>
  sendMessage(params: AgentWechatSendParams): Promise<AgentWechatSendResult>
  /** Open /api/ws/login and stream events until closed. */
  subscribeLogin(handlers: {
    onEvent: (event: AgentWechatLoginEvent) => void
    onError?: (err: Error) => void
    onClose?: () => void
  }): LoginSubscription
}

/** Minimal WebSocket surface (Node 22 global WebSocket satisfies it). */
interface WebSocketLike {
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void
  addEventListener(type: 'error', listener: (ev: unknown) => void): void
  addEventListener(type: 'close', listener: () => void): void
  close(): void
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type AgentWechatClientOptions = {
  baseUrl: string
  token: string
  fetch?: FetchLike
  webSocketFactory?: (url: string) => WebSocketLike
}

class AgentWechatHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    body: string,
  ) {
    super(`agent-wechat ${path} responded ${status}: ${body.slice(0, 200)}`)
    this.name = 'AgentWechatHttpError'
  }
}

function qs(params: Record<string, unknown>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
  if (entries.length === 0) return ''
  return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket
  if (!Ctor) throw new Error('Global WebSocket is not available; Node 22 or newer is required')
  return new Ctor(url)
}

export function createAgentWechatClient(opts: AgentWechatClientOptions): AgentWechatClient {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init))
  const wsFactory = opts.webSocketFactory ?? defaultWebSocketFactory
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.token}` }

  async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) throw new AgentWechatHttpError(res.status, path, await res.text().catch(() => ''))
    return (await res.json()) as T
  }

  return {
    async health() {
      try {
        const res = await doFetch(`${base}/health`, { method: 'GET' })
        return res.ok
      } catch {
        return false
      }
    },
    authStatus: () => request('GET', '/api/status/auth'),
    logout: () => request('POST', '/api/status/logout'),
    listChats: (limit, offset) => request('GET', `/api/chats${qs({ limit, offset })}`),
    listMessages: (chatId, limit, offset) =>
      request('GET', `/api/messages/${encodeURIComponent(chatId)}${qs({ limit, offset })}`),
    getMedia: (chatId, localId) =>
      request('GET', `/api/messages/${encodeURIComponent(chatId)}/media/${localId}${qs({ descriptorOnly: true })}`),
    ensureMedia: (chatId, localId) =>
      request('POST', `/api/messages/${encodeURIComponent(chatId)}/media/${localId}/ensure${qs({ descriptorOnly: true })}`),
    async getMediaContent(chatId, localId) {
      const path = `/api/messages/${encodeURIComponent(chatId)}/media/${localId}/content`
      const res = await doFetch(`${base}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${opts.token}` },
      })
      if (!res.ok) throw new AgentWechatHttpError(res.status, path, await res.text().catch(() => ''))
      const body = res.body
      if (!body) throw new Error(`agent-wechat ${path} returned no body`)
      const disposition = res.headers.get('content-disposition') ?? ''
      const filename = /filename="([^"]+)"/i.exec(disposition)?.[1] ?? `${localId}`
      return {
        body,
        contentLength: Number(res.headers.get('content-length') ?? '0'),
        mime: res.headers.get('content-type') ?? 'application/octet-stream',
        filename,
        etag: res.headers.get('etag')?.replace(/^"|"$/g, ''),
      }
    },
    openChat: (chatId) =>
      request('POST', `/api/chats/${encodeURIComponent(chatId)}/open`),
    sendMessage: (params) => request('POST', '/api/messages/send', params),
    subscribeLogin(handlers) {
      const wsUrl = base.replace(/^http/, 'ws') + `/api/ws/login${qs({ token: opts.token })}`
      const ws = wsFactory(wsUrl)
      ws.addEventListener('message', (ev) => {
        try {
          const raw = typeof ev.data === 'string' ? ev.data : String(ev.data)
          handlers.onEvent(JSON.parse(raw) as AgentWechatLoginEvent)
        } catch (e) {
          handlers.onError?.(e instanceof Error ? e : new Error(String(e)))
        }
      })
      ws.addEventListener('error', (ev) => {
        const msg =
          ev && typeof ev === 'object' && 'message' in ev && typeof (ev as { message: unknown }).message === 'string'
            ? (ev as { message: string }).message
            : 'WebSocket error'
        handlers.onError?.(new Error(msg))
      })
      ws.addEventListener('close', () => handlers.onClose?.())
      return { close: () => ws.close() }
    },
  }
}
