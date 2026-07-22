/**
 * Client for the wechat-connector service (apps/wechat-connector).
 *
 * The connector holds the iLink long-poll session(s) and the QR pairing
 * sessions; the API drives their lifecycle over HTTP. Two flows ride this
 * seam:
 *
 * - **Pairing**: `startPairing()` opens a QR-login session on the bridge;
 *   the Studio connect flow polls `pairingStatus()` (proxied) until iLink
 *   confirms, then the API persists the returned credentials and calls
 *   `connect()`. `submitVerifyCode()` forwards the pairing digits when iLink
 *   asks for them (`need_verifycode`).
 * - **Runtime**: `connect()` / `disconnect()` open and tear down a channel's
 *   long-poll loop with the decrypted credentials.
 *
 * Inbound messages flow the other way (connector → `/internal/wechat/inbound`)
 * and outbound sends go API → iLink REST directly, so neither passes through
 * this client. See docs/architecture/channels/wechat.md.
 *
 * Component tag: [COMP:api/wechat-inbound].
 */

export type WechatPairingSnapshot = {
  pairingId: string
  /**
   * Bridge-level pairing state. `qr` = show/refresh the QR; `scanned` =
   * verifying after scan; `need_verifycode` = the user must type the digits
   * their phone shows; `verify_code_rejected` = wrong digits, ask again;
   * `confirmed` = credentials issued; `already_bound` = this bot is already
   * connected somewhere and iLink issued nothing new.
   */
  status:
    | 'qr'
    | 'scanned'
    | 'need_verifycode'
    | 'verify_code_rejected'
    | 'confirmed'
    | 'already_bound'
    | 'expired'
    | 'error'
  /** URL to render as a QR code (refreshes in place when iLink expires one). */
  qrcodeUrl?: string
  error?: string
  /** Present only when status = confirmed. Consumed by the API, never the UI. */
  result?: {
    botToken: string
    baseUrl: string
    ilinkBotId: string
    boundUserId?: string
  }
}

export type WechatConnectorStatus = {
  channelId: string
  status: 'polling' | 'paused' | 'stopped'
  lastEventAt?: number
}

export type WechatConnectorClient = {
  /** Open a QR pairing session. Returns the id to poll + the QR content URL. */
  startPairing(): Promise<{ pairingId: string; qrcodeUrl: string }>
  /** Snapshot of a pairing session (null when unknown/expired-and-purged). */
  pairingStatus(pairingId: string): Promise<WechatPairingSnapshot | null>
  /** Forward the pairing digits iLink asked for via `need_verifycode`. */
  submitVerifyCode(pairingId: string, code: string): Promise<void>
  /** Start (or replace) the long-poll loop for a channel's bot. */
  connect(
    channelId: string,
    input: { botToken: string; baseUrl: string; getUpdatesBuf?: string },
  ): Promise<WechatConnectorStatus>
  /** Stop the long-poll loop for a channel. Idempotent. */
  disconnect(channelId: string): Promise<void>
  /** Current poller status, or null if the connector has no loop for it. */
  status(channelId: string): Promise<WechatConnectorStatus | null>
}

export type WechatConnectorClientOptions = {
  /** Base URL of the deployed wechat-connector (WECHAT_CONNECTOR_URL). */
  connectorUrl: string
  /** Shared secret presented as X-Connector-Secret (WECHAT_CONNECTOR_SECRET). */
  connectorSecret: string
}

export function createWechatConnectorClient(
  options: WechatConnectorClientOptions,
): WechatConnectorClient {
  const base = options.connectorUrl.replace(/\/$/, '')

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'X-Connector-Secret': options.connectorSecret,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`wechat-connector ${method} ${path} failed: ${res.status} ${text}`.trim())
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  return {
    startPairing() {
      return call<{ pairingId: string; qrcodeUrl: string }>('POST', '/pair/start')
    },

    async pairingStatus(pairingId) {
      try {
        return await call<WechatPairingSnapshot>('GET', `/pair/${encodeURIComponent(pairingId)}/status`)
      } catch (err) {
        if (err instanceof Error && err.message.includes('404')) return null
        throw err
      }
    },

    async submitVerifyCode(pairingId, code) {
      await call<{ ok: boolean }>('POST', `/pair/${encodeURIComponent(pairingId)}/verify-code`, { code })
    },

    connect(channelId, input) {
      return call<WechatConnectorStatus>('POST', `/connect/${encodeURIComponent(channelId)}`, input)
    },

    async disconnect(channelId) {
      await call<{ ok: boolean }>('POST', `/disconnect/${encodeURIComponent(channelId)}`)
    },

    async status(channelId) {
      try {
        return await call<WechatConnectorStatus>('GET', `/status/${encodeURIComponent(channelId)}`)
      } catch (err) {
        if (err instanceof Error && err.message.includes('404')) return null
        throw err
      }
    },
  }
}
