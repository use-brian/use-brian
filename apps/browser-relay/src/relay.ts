import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import {
  ExtensionMessageSchema,
  type InternalCommandResponse,
  type RelayToExtensionMessage,
} from './protocol.js'

/**
 * The relay core (P1.3 verify + P1.4 registry/routing), transport-agnostic so
 * tests can drive it with fake sockets. One process holds the whole
 * `userId → connection` registry — the reason the Cloud Run service is
 * single-instance (min=max=1), like the other connector apps.
 */

export type PairingVerifier = (
  token: string,
) => { kind?: 'browser-ext-pair' | 'browser-ext-session'; userId: string; workspaceId: string } | null

/**
 * Mints the longer-lived `browser-ext-session` token returned in
 * `ready{sessionToken}` after a first-time pair-token hello, so reconnects
 * never need a fresh pairing. Optional — absent, `ready` carries no token.
 */
export type SessionTokenMinter = (identity: { userId: string; workspaceId: string }) => string

export type RelaySocket = Pick<WebSocket, 'send' | 'close'>

type Pending = {
  resolve: (res: InternalCommandResponse) => void
  timer: NodeJS.Timeout
}

type Connection = {
  socket: RelaySocket
  userId: string
  workspaceId: string
  pending: Map<string, Pending>
  lastSeenAt: number
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000

/** Connections silent past this are presumed dead and closed by the sweep. */
export const LIVENESS_WINDOW_MS = 90_000

/** Why the in-flight commands died, in the model's terms. */
const EVENT_MESSAGES = {
  stopped: 'The user stopped the task.',
  tab_closed: 'The controlled tab was closed.',
  detached:
    'Chrome ended the debugging session for the tab, so the browser is no longer under control. ' +
    'Retry the step: the user will be asked to allow the tab again. The website did not block this.',
} as const

const NO_EXTENSION_RESPONSE: InternalCommandResponse = {
  ok: false,
  error: 'No connected browser extension for this user.',
  code: 'no_extension',
}

export class BrowserRelay {
  private readonly byUser = new Map<string, Connection>()
  private readonly bySocket = new Map<RelaySocket, Connection>()
  private readonly verify: PairingVerifier
  private readonly mintSessionToken: SessionTokenMinter | null
  private readonly commandTimeoutMs: number

  constructor(opts: {
    verifyPairingToken: PairingVerifier
    mintSessionToken?: SessionTokenMinter
    commandTimeoutMs?: number
  }) {
    this.verify = opts.verifyPairingToken
    this.mintSessionToken = opts.mintSessionToken ?? null
    this.commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  }

  private sendTo(socket: RelaySocket, message: RelayToExtensionMessage): void {
    try {
      socket.send(JSON.stringify(message))
    } catch {
      // A dying socket's close handler does the cleanup.
    }
  }

  /** Number of live extension connections (health/status surface). */
  connectionCount(): number {
    return this.byUser.size
  }

  isConnected(userId: string): boolean {
    return this.byUser.has(userId)
  }

  /**
   * Handle one inbound WebSocket frame. The first frame must be a valid
   * `hello` — anything else (or a bad token) gets `error` + close (4401).
   */
  handleMessage(socket: RelaySocket, raw: string | Buffer): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'))
    } catch {
      this.sendTo(socket, { type: 'error', message: 'invalid JSON' })
      socket.close(4400, 'invalid JSON')
      return
    }
    const msg = ExtensionMessageSchema.safeParse(parsed)
    if (!msg.success) {
      this.sendTo(socket, { type: 'error', message: 'invalid envelope' })
      socket.close(4400, 'invalid envelope')
      return
    }

    const conn = this.bySocket.get(socket)

    if (msg.data.type === 'hello') {
      const identity = this.verify(msg.data.pairingToken)
      if (!identity) {
        this.sendTo(socket, { type: 'error', message: 'unauthorized' })
        socket.close(4401, 'unauthorized')
        return
      }
      // Latest pairing wins: replace any existing connection for this user.
      const existing = this.byUser.get(identity.userId)
      if (existing && existing.socket !== socket) {
        this.rejectPending(existing, {
          ok: false,
          error: 'Extension connection was replaced by a newer pairing.',
          code: 'no_extension',
        })
        this.bySocket.delete(existing.socket)
        try {
          existing.socket.close(4000, 'replaced')
        } catch {
          /* already gone */
        }
      }
      const fresh: Connection = {
        socket,
        userId: identity.userId,
        workspaceId: identity.workspaceId,
        pending: conn?.pending ?? new Map(),
        lastSeenAt: Date.now(),
      }
      this.byUser.set(identity.userId, fresh)
      this.bySocket.set(socket, fresh)
      // First-time pairing (short-lived pair token) → hand back a session
      // token so reconnect + re-hello works after the pair token expires.
      const sessionToken =
        identity.kind !== 'browser-ext-session' && this.mintSessionToken
          ? this.mintSessionToken({ userId: identity.userId, workspaceId: identity.workspaceId })
          : undefined
      this.sendTo(socket, sessionToken ? { type: 'ready', sessionToken } : { type: 'ready' })
      return
    }

    // Every non-hello frame requires a bound connection.
    if (!conn) {
      this.sendTo(socket, { type: 'error', message: 'hello required' })
      socket.close(4401, 'hello required')
      return
    }
    conn.lastSeenAt = Date.now()

    if (msg.data.type === 'ping') {
      this.sendTo(socket, { type: 'pong' })
      return
    }

    if (msg.data.type === 'result') {
      const pending = conn.pending.get(msg.data.id)
      if (!pending) return // late result after timeout — drop
      conn.pending.delete(msg.data.id)
      clearTimeout(pending.timer)
      if (msg.data.ok) {
        pending.resolve({ ok: true, data: msg.data.data })
      } else {
        pending.resolve({
          ok: false,
          error: msg.data.error ?? 'extension error',
          code: msg.data.code,
        })
      }
      return
    }

    if (msg.data.type === 'event') {
      // stopped / tab_closed / detached abort everything in flight for this
      // user (P1.7 close-to-stop; the extension itself refuses follow-up
      // commands). Each carries its own message: they are different situations
      // and a wrong one sends the model chasing the wrong cause.
      this.rejectPending(conn, {
        ok: false,
        error: EVENT_MESSAGES[msg.data.kind],
        code: msg.data.kind,
      })
    }
  }

  /** WebSocket close/error hook: clear registry + fail anything in flight. */
  handleDisconnect(socket: RelaySocket): void {
    const conn = this.bySocket.get(socket)
    if (!conn) return
    this.bySocket.delete(socket)
    // Guard against the replaced-connection race: only unregister the user if
    // this socket is still the registered one.
    if (this.byUser.get(conn.userId)?.socket === socket) {
      this.byUser.delete(conn.userId)
    }
    this.rejectPending(conn, {
      ok: false,
      error: 'The browser extension disconnected.',
      code: 'no_extension',
    })
  }

  /**
   * Route one command to the user's extension and await its `result`
   * (P1.4). Missing connection → the clear no-extension error, immediately —
   * never a hang. Timeout → `{ok:false, code:'timeout'}`.
   */
  async dispatchCommand(params: {
    userId: string
    op: string
    args?: Record<string, unknown>
    timeoutMs?: number
  }): Promise<InternalCommandResponse> {
    const conn = this.byUser.get(params.userId)
    if (!conn) return NO_EXTENSION_RESPONSE

    const id = randomUUID()
    const timeoutMs = params.timeoutMs ?? this.commandTimeoutMs

    return new Promise<InternalCommandResponse>((resolve) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id)
        resolve({
          ok: false,
          error: `The extension did not answer within ${Math.round(timeoutMs / 1000)}s.`,
          code: 'timeout',
        })
      }, timeoutMs)
      conn.pending.set(id, { resolve, timer })
      this.sendTo(conn.socket, { type: 'command', id, op: params.op, args: params.args ?? {} })
    })
  }

  /** Close connections that have gone silent past the liveness window. */
  sweepDead(now = Date.now()): number {
    let closed = 0
    for (const conn of [...this.byUser.values()]) {
      if (now - conn.lastSeenAt > LIVENESS_WINDOW_MS) {
        closed += 1
        try {
          conn.socket.close(4002, 'liveness timeout')
        } catch {
          /* already gone */
        }
        this.handleDisconnect(conn.socket)
      }
    }
    return closed
  }

  private rejectPending(conn: Connection, response: InternalCommandResponse): void {
    for (const [, pending] of conn.pending) {
      clearTimeout(pending.timer)
      pending.resolve(response)
    }
    conn.pending.clear()
  }
}
