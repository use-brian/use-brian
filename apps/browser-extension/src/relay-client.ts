/**
 * The extension's relay connection (P1.2): one WebSocket, hello on open,
 * ping every 30 s, reconnect with backoff + re-hello on drop. WebSocket
 * construction and token storage are injected so the state machine is
 * unit-testable outside Chrome.
 */
import { parseRelayMessage, type ExtensionToRelay } from './protocol.js'

export type WebSocketLike = {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev?: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev?: unknown) => void) | null
  onerror: ((ev?: unknown) => void) | null
}

export type RelayClientDeps = {
  /** Resolved per connection attempt (popup can re-configure without a new client). */
  getUrl: () => Promise<string | null>
  connect: (url: string) => WebSocketLike
  /** Session token preferred; falls back to the one-shot pairing token. */
  getToken: () => Promise<string | null>
  /** Persist the session token the relay hands back in ready. */
  onSessionToken: (token: string) => Promise<void>
  onCommand: (cmd: { id: string; op: string; args: Record<string, unknown> }) => void
  onStateChange?: (state: RelayClientState) => void
  /** Injected timers so tests can drive time. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export type RelayClientState = 'disconnected' | 'connecting' | 'ready' | 'unpaired'

/**
 * Must stay UNDER Chrome's 30 s MV3 service-worker idle kill — the ping is
 * what resets the idle timer, so an interval at exactly 30 s races the
 * teardown and the socket dies on any quiet stretch. The relay keys live
 * connections by userId in process memory, so a dropped socket reaches the
 * assistant as `no_extension` while the popup still reads "connected".
 * (Claude in Chrome solves the same constraint with a 20 s offscreen-document
 * keepalive; 20 s gives us a full interval of headroom either way.)
 */
const PING_INTERVAL_MS = 20_000
/** Backoff schedule for reconnects; stays at the last step. */
export const BACKOFF_STEPS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const

export class RelayClient {
  private deps: RelayClientDeps
  private ws: WebSocketLike | null = null
  private state: RelayClientState = 'disconnected'
  private attempts = 0
  private pingTimer: unknown = null
  private reconnectTimer: unknown = null
  private enabled = false

  constructor(deps: RelayClientDeps) {
    this.deps = deps
  }

  getState(): RelayClientState {
    return this.state
  }

  private setState(next: RelayClientState): void {
    this.state = next
    this.deps.onStateChange?.(next)
  }

  private setTimer(fn: () => void, ms: number): unknown {
    return (this.deps.setTimer ?? ((f, m) => setTimeout(f, m)))(fn, ms)
  }

  private clearTimer(handle: unknown): void {
    if (handle == null) return
    ;(this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(handle)
  }

  /** Turn the connection on (popup enable toggle / boot with stored token). */
  start(): void {
    this.enabled = true
    void this.open()
  }

  /** Turn it off (disable toggle / unpair). */
  stop(): void {
    this.enabled = false
    this.clearTimer(this.pingTimer)
    this.clearTimer(this.reconnectTimer)
    this.pingTimer = null
    this.reconnectTimer = null
    this.ws?.close(1000, 'client stopped')
    this.ws = null
    this.setState('disconnected')
  }

  send(message: ExtensionToRelay): void {
    if (!this.ws || this.ws.readyState !== 1 /* OPEN */) return
    this.ws.send(JSON.stringify(message))
  }

  sendResult(result: { id: string; ok: boolean; data?: unknown; error?: string; code?: string }): void {
    this.send({ type: 'result', ...result })
  }

  sendEvent(kind: 'stopped' | 'tab_closed' | 'detached'): void {
    this.send({ type: 'event', kind })
  }

  private async open(): Promise<void> {
    if (!this.enabled) return
    const url = await this.deps.getUrl()
    const token = await this.deps.getToken()
    if (!url || !token) {
      this.setState('unpaired')
      return
    }
    this.setState('connecting')
    const ws = this.deps.connect(url)
    this.ws = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', pairingToken: token }))
    }
    ws.onmessage = (ev) => {
      const msg = parseRelayMessage(ev.data)
      if (!msg) return
      if (msg.type === 'ready') {
        this.attempts = 0
        this.setState('ready')
        if (msg.sessionToken) void this.deps.onSessionToken(msg.sessionToken)
        this.schedulePing()
        return
      }
      if (msg.type === 'command') {
        this.deps.onCommand(msg)
        return
      }
      if (msg.type === 'error') {
        // Unauthorized hello → the stored token is dead; require re-pairing.
        this.setState('unpaired')
      }
      // pong: nothing to do — arrival alone proves liveness.
    }
    ws.onclose = () => {
      this.clearTimer(this.pingTimer)
      this.pingTimer = null
      this.ws = null
      if (!this.enabled || this.state === 'unpaired') {
        if (this.enabled) return // unpaired: wait for a new token, no auto-retry
        this.setState('disconnected')
        return
      }
      this.scheduleReconnect()
    }
    ws.onerror = () => {
      try {
        ws.close()
      } catch {
        /* already closing */
      }
    }
  }

  private schedulePing(): void {
    this.clearTimer(this.pingTimer)
    this.pingTimer = this.setTimer(() => {
      this.send({ type: 'ping' })
      this.schedulePing()
    }, PING_INTERVAL_MS)
  }

  private scheduleReconnect(): void {
    const delay = BACKOFF_STEPS_MS[Math.min(this.attempts, BACKOFF_STEPS_MS.length - 1)]
    this.attempts += 1
    this.setState('disconnected')
    this.clearTimer(this.reconnectTimer)
    this.reconnectTimer = this.setTimer(() => void this.open(), delay)
  }
}
