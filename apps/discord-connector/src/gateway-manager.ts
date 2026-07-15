/**
 * Per-channel Discord Gateway connection manager.
 *
 * Holds one persistent Gateway WebSocket per connected channel (one bot token =
 * one connection), exactly the role `apps/wa-connector/src/socket-manager.ts`
 * plays for WhatsApp. Handles the HELLO → IDENTIFY handshake, the heartbeat
 * loop (with zombie detection), RESUME-on-reconnect, and backoff.
 *
 * Unlike WhatsApp, this connector is **inbound-only**: Discord's REST API is
 * plain HTTPS reachable from sidanclaw-api directly, so outbound sends do NOT
 * go through here — the API calls Discord REST itself via the `@sidanclaw/channels`
 * Discord adapter. This service exists solely to turn the receive-side WebSocket
 * into HTTP POSTs the request-driven API can consume.
 *
 * Each MESSAGE_CREATE is normalized with the shared Discord adapter
 * (`createDiscordAdapter().parseIncoming`) and forwarded to
 * `${apiUrl}/internal/discord/inbound`.
 *
 * See docs/architecture/channels/discord.md.
 */

import { WebSocket } from 'ws'
import { createDiscordAdapter, createDedupBuffer, type IncomingMessage } from '@sidanclaw/channels'
import {
  DISCORD_GATEWAY_URL,
  GatewayOp,
  buildHeartbeat,
  buildIdentify,
  buildResume,
  canResume,
  isFatalCloseCode,
  type GatewayPayload,
} from './gateway-protocol.js'

const RECONNECT_BASE_MS = 2000
const RECONNECT_MAX_MS = 30000
const RECONNECT_FACTOR = 1.8
const MAX_RECONNECT_ATTEMPTS = 12

type GatewayStatus = 'connecting' | 'connected' | 'disconnected'

type ManagedGateway = {
  channelId: string
  botUserId?: string
  status: GatewayStatus
  connectedAt?: number
}

type ConnectInput = {
  botToken: string
  /** The bot's own user id — required for self-mention detection in servers. */
  botUserId?: string
}

/**
 * A button-press (message-component) interaction, flattened to the fields the
 * API needs to resolve a parked confirmation and ack within Discord's 3s window.
 * `id`/`token` authorize the interaction-callback; `customId` carries the
 * `mcp_confirm:<toolCallId>:<decision>` payload; `channelId` is the Discord
 * channel (keys the pending-confirmation map on the API side).
 */
type ForwardedInteraction = {
  id: string
  token: string
  channelId: string
  messageId?: string
  userId?: string
  customId: string
}

// Raw INTERACTION_CREATE dispatch `d` (only the fields we read). type 3 =
// MESSAGE_COMPONENT; component_type 2 = button.
type GatewayInteraction = {
  id: string
  token: string
  type?: number
  channel_id?: string
  message?: { id?: string }
  member?: { user?: { id?: string } }
  user?: { id?: string }
  data?: { custom_id?: string; component_type?: number }
}

const INTERACTION_TYPE_MESSAGE_COMPONENT = 3
const COMPONENT_TYPE_BUTTON = 2

export type GatewayManagerOptions = {
  apiUrl: string
  connectorSecret: string
}

export type GatewayManager = {
  connect(channelId: string, input: ConnectInput): ManagedGateway
  disconnect(channelId: string): void
  disconnectAll(): void
  getStatus(channelId: string): ManagedGateway | undefined
  restoreAll(): Promise<void>
}

export function createGatewayManager(options: GatewayManagerOptions): GatewayManager {
  const { apiUrl, connectorSecret } = options
  const connections = new Map<string, Connection>()

  async function forwardToApi(channelId: string, message: IncomingMessage): Promise<void> {
    try {
      const res = await fetch(`${apiUrl}/internal/discord/inbound`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Connector-Secret': connectorSecret,
        },
        // Envelope carries both the internal channel id (which bot/integration
        // this came from) and the normalized message (whose `channelId` is the
        // Discord channel to reply into).
        body: JSON.stringify({ channelId, message }),
      })
      if (!res.ok) {
        console.error(`[discord-gateway] inbound forward failed: ${res.status} ${res.statusText}`)
      }
    } catch (err) {
      console.error('[discord-gateway] inbound forward error:', err)
    }
  }

  // Button presses arrive as INTERACTION_CREATE on the gateway (no intent gate,
  // and no Interactions Endpoint URL configured for these BYO bots). The API
  // resolves the parked confirmation and acks the interaction itself — keeping
  // this connector inbound-only.
  async function forwardInteractionToApi(channelId: string, interaction: ForwardedInteraction): Promise<void> {
    try {
      const res = await fetch(`${apiUrl}/internal/discord/interaction`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Connector-Secret': connectorSecret,
        },
        body: JSON.stringify({ channelId, interaction }),
      })
      if (!res.ok) {
        console.error(`[discord-gateway] interaction forward failed: ${res.status} ${res.statusText}`)
      }
    } catch (err) {
      console.error('[discord-gateway] interaction forward error:', err)
    }
  }

  return {
    connect(channelId, input) {
      const existing = connections.get(channelId)
      if (existing) existing.destroy()

      const conn = new Connection(
        channelId,
        input,
        (msg) => forwardToApi(channelId, msg),
        (intx) => forwardInteractionToApi(channelId, intx),
      )
      connections.set(channelId, conn)
      conn.start()
      return conn.managed
    },

    disconnect(channelId) {
      const conn = connections.get(channelId)
      if (!conn) return
      conn.destroy()
      connections.delete(channelId)
    },

    disconnectAll() {
      for (const conn of connections.values()) conn.destroy()
      connections.clear()
    },

    getStatus(channelId) {
      return connections.get(channelId)?.managed
    },

    /**
     * On boot, ask the API for the set of active Discord channels and their bot
     * tokens, then open a gateway connection for each. Best-effort: if the API
     * has no such endpoint yet (deferred wiring), this logs and returns without
     * failing startup. Tokens live in `channel_integrations` (Secret Manager
     * encrypted), NOT in this service — hence the fetch rather than local state.
     */
    async restoreAll() {
      let rows: Array<{ channelId: string; botToken: string; botUserId?: string }> = []
      try {
        const res = await fetch(`${apiUrl}/internal/discord/channels`, {
          headers: { 'X-Connector-Secret': connectorSecret },
        })
        if (!res.ok) {
          console.warn(`[discord-gateway] restoreAll skipped: API returned ${res.status}`)
          return
        }
        rows = (await res.json()) as typeof rows
      } catch (err) {
        console.warn('[discord-gateway] restoreAll skipped: API unreachable:', err)
        return
      }

      console.log(`[discord-gateway] restoring ${rows.length} channel connection(s)`)
      for (const row of rows) {
        const conn = new Connection(
          row.channelId,
          row,
          (msg) => forwardToApi(row.channelId, msg),
          (intx) => forwardInteractionToApi(row.channelId, intx),
        )
        connections.set(row.channelId, conn)
        conn.start()
      }
    },
  }
}

// ── A single bot's Gateway connection ──────────────────────────

class Connection {
  readonly managed: ManagedGateway
  private ws: WebSocket | null = null
  private readonly adapter: ReturnType<typeof createDiscordAdapter>
  // Inbound message-id dedup — survives reconnects (same Connection instance),
  // so a RESUME replay or an embed-unfurl MESSAGE_UPDATE never double-fires.
  private readonly dedup = createDedupBuffer()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lastSeq: number | null = null
  private sessionId: string | null = null
  private resumeUrl: string | null = null
  private heartbeatAcked = true
  private reconnectAttempt = 0
  private destroyed = false

  constructor(
    private readonly channelId: string,
    private readonly input: ConnectInput,
    private readonly onMessage: (msg: IncomingMessage) => void,
    private readonly onInteraction: (interaction: ForwardedInteraction) => void,
  ) {
    this.managed = { channelId, botUserId: input.botUserId, status: 'connecting' }
    // Send-only adapter (no onMessage): we call parseIncoming directly per event.
    this.adapter = createDiscordAdapter({ token: input.botToken, botUserId: input.botUserId })
  }

  start(): void {
    if (this.destroyed) return
    this.managed.status = 'connecting'
    const url = this.resumeUrl ? `${this.resumeUrl}/?v=10&encoding=json` : DISCORD_GATEWAY_URL
    const ws = new WebSocket(url)
    this.ws = ws

    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => this.onGatewayMessage(data))
    ws.on('close', (code: number) => this.onClose(code))
    ws.on('error', (err: Error) => {
      console.error(`[discord-gateway] ${this.channelId} socket error:`, err.message)
    })
  }

  destroy(): void {
    this.destroyed = true
    this.clearHeartbeat()
    this.managed.status = 'disconnected'
    try {
      this.ws?.close(1000)
    } catch {
      // ignore
    }
    this.ws = null
  }

  private onGatewayMessage(data: Buffer | ArrayBuffer | Buffer[]): void {
    let payload: GatewayPayload
    try {
      payload = JSON.parse(data.toString()) as GatewayPayload
    } catch {
      return
    }
    if (typeof payload.s === 'number') this.lastSeq = payload.s

    switch (payload.op) {
      case GatewayOp.HELLO: {
        const interval = (payload.d as { heartbeat_interval: number }).heartbeat_interval
        this.startHeartbeat(interval)
        // Resume if we have a live session, else identify fresh.
        if (this.sessionId) {
          this.send(buildResume(this.input.botToken, this.sessionId, this.lastSeq))
        } else {
          this.send(buildIdentify(this.input.botToken))
        }
        break
      }
      case GatewayOp.HEARTBEAT:
        // Server asked for an immediate heartbeat.
        this.send(buildHeartbeat(this.lastSeq))
        break
      case GatewayOp.HEARTBEAT_ACK:
        this.heartbeatAcked = true
        break
      case GatewayOp.RECONNECT:
        // Server wants us to reconnect and resume.
        this.reconnect(true)
        break
      case GatewayOp.INVALID_SESSION:
        // d === true means the session is resumable; otherwise re-identify fresh.
        if (payload.d !== true) this.sessionId = null
        this.reconnect(payload.d === true)
        break
      case GatewayOp.DISPATCH:
        this.onDispatch(payload)
        break
      default:
        break
    }
  }

  private onDispatch(payload: GatewayPayload): void {
    if (payload.t === 'READY') {
      const d = payload.d as { session_id: string; resume_gateway_url?: string; user?: { id: string } }
      this.sessionId = d.session_id
      this.resumeUrl = d.resume_gateway_url ?? null
      if (d.user?.id && !this.managed.botUserId) this.managed.botUserId = d.user.id
      this.markConnected()
      return
    }
    if (payload.t === 'RESUMED') {
      this.markConnected()
      return
    }
    if (payload.t === 'INTERACTION_CREATE') {
      const d = payload.d as GatewayInteraction
      // Only button presses (MESSAGE_COMPONENT / button) carry a confirmation
      // decision. Slash commands and other interaction types are ignored here —
      // free-form chat is the MESSAGE_CREATE path. Dedup by interaction id so a
      // RESUME replay never double-acks (a second callback errors 40060).
      if (
        d?.type === INTERACTION_TYPE_MESSAGE_COMPONENT &&
        d.data?.component_type === COMPONENT_TYPE_BUTTON &&
        d.data.custom_id &&
        d.channel_id
      ) {
        if (this.dedup.isDuplicate(`i:${d.id}`)) return
        this.onInteraction({
          id: d.id,
          token: d.token,
          channelId: d.channel_id,
          messageId: d.message?.id,
          userId: d.member?.user?.id ?? d.user?.id,
          customId: d.data.custom_id,
        })
      }
      return
    }
    if (payload.t === 'MESSAGE_CREATE') {
      // Dedup by Discord message id. Drops gateway redeliveries (e.g. a RESUME
      // that replays buffered events). We deliberately do NOT forward
      // MESSAGE_UPDATE: Discord emits an UPDATE with the same message id when a
      // posted link unfurls into an embed, which would otherwise make the bot
      // reply twice to any URL. Responding to new messages only also means a
      // user editing their message is a no-op (edit-to-retry is a future
      // enhancement; the inbound route ignores `isEdit` today).
      const dedupId = this.adapter.deduplicateId(payload)
      if (dedupId && this.dedup.isDuplicate(dedupId)) return
      // The adapter accepts the dispatch envelope ({ t, d }) directly.
      const msg = this.adapter.parseIncoming(payload)
      if (msg) this.onMessage(msg)
    }
  }

  private markConnected(): void {
    this.managed.status = 'connected'
    this.managed.connectedAt = Date.now()
    this.reconnectAttempt = 0
    console.log(`[discord-gateway] connected: ${this.channelId}`)
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat()
    this.heartbeatAcked = true
    // First beat after a jittered fraction of the interval, per Discord's guidance.
    const jitter = Math.floor(intervalMs * 0.5)
    setTimeout(() => {
      if (this.destroyed) return
      this.beat()
      this.heartbeatTimer = setInterval(() => this.beat(), intervalMs)
    }, jitter)
  }

  private beat(): void {
    if (!this.heartbeatAcked) {
      // Zombie connection — last heartbeat was never ACKed. Drop and reconnect.
      console.warn(`[discord-gateway] ${this.channelId} missed heartbeat ACK, reconnecting`)
      this.reconnect(true)
      return
    }
    this.heartbeatAcked = false
    this.send(buildHeartbeat(this.lastSeq))
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private send(payload: GatewayPayload): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload))
    }
  }

  private onClose(code: number): void {
    this.clearHeartbeat()
    this.managed.status = 'disconnected'
    if (this.destroyed) return

    if (isFatalCloseCode(code)) {
      console.error(`[discord-gateway] ${this.channelId} fatal close ${code}; not reconnecting`)
      this.destroyed = true
      return
    }
    if (!canResume(code)) this.sessionId = null
    this.reconnect(canResume(code))
  }

  private reconnect(resume: boolean): void {
    if (this.destroyed) return
    this.clearHeartbeat()
    try {
      this.ws?.removeAllListeners()
      this.ws?.close()
    } catch {
      // ignore
    }
    this.ws = null
    if (!resume) {
      this.sessionId = null
      this.resumeUrl = null
    }

    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      console.error(`[discord-gateway] ${this.channelId} max reconnect attempts reached`)
      this.destroyed = true
      return
    }
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(RECONNECT_FACTOR, this.reconnectAttempt),
      RECONNECT_MAX_MS,
    )
    this.reconnectAttempt += 1
    console.log(
      `[discord-gateway] ${this.channelId} reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS}, resume=${resume})`,
    )
    setTimeout(() => this.start(), delay)
  }
}
