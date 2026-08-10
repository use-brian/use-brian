import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import { isExtensionBuildStale } from '@use-brian/api/sandbox/extension-build.js'
import {
  ExtensionMessageSchema,
  type InternalCommandResponse,
  type RelayToExtensionMessage,
} from './protocol.js'

/**
 * The relay core (P1.3 verify + P1.4 registry/routing), transport-agnostic so
 * tests can drive it with fake sockets. One process holds the whole
 * `(userId, browserProfileId) → connection` registry — the reason the Cloud Run service is
 * single-instance (min=max=1), like the other connector apps.
 */

export type PairingVerifier = (
  token: string,
) => {
  kind?: 'browser-ext-pair' | 'browser-ext-session'
  userId: string
  workspaceId: string
  browserProfileId: string
} | null

/**
 * Mints the longer-lived `browser-ext-session` token returned in
 * `ready{sessionToken}` after a first-time pair-token hello, so reconnects
 * never need a fresh pairing. Optional — absent, `ready` carries no token.
 */
export type SessionTokenMinter = (identity: {
  userId: string
  workspaceId: string
  browserProfileId: string
}) => string

export type RelaySocket = Pick<WebSocket, 'send' | 'close'>

type Pending = {
  resolve: (res: InternalCommandResponse) => void
  timer: NodeJS.Timeout
}

type Connection = {
  socket: RelaySocket
  userId: string
  workspaceId: string
  browserProfileId: string
  pending: Map<string, Pending>
  lastSeenAt: number
  terminalEvent: 'stopped' | 'tab_closed' | null
  /** Source fingerprint the extension reported in hello; null from builds that predate the stamp. */
  build: string | null
  staleBuild: boolean
}

/** One local executor per Use Brian profile. NUL cannot occur in either id. */
function connectionKey(userId: string, browserProfileId: string): string {
  return `${userId}\0${browserProfileId}`
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
  error: 'No connected browser extension for this browser profile.',
  code: 'no_extension',
}

export class BrowserRelay {
  private readonly byConnection = new Map<string, Connection>()
  private readonly bySocket = new Map<RelaySocket, Connection>()
  private readonly terminalByConnection = new Map<string, 'stopped' | 'tab_closed'>()
  private readonly pendingStops = new Set<string>()
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

  /** Keep a disconnected Stop durable until the extension acknowledges it. */
  private deliverPendingStop(conn: Connection): void {
    const key = connectionKey(conn.userId, conn.browserProfileId)
    if (!this.pendingStops.has(key)) return
    const id = randomUUID()
    const retry = () => {
      if (this.byConnection.get(key) === conn && this.pendingStops.has(key)) {
        this.deliverPendingStop(conn)
      }
    }
    const timer = setTimeout(() => {
      conn.pending.delete(id)
      retry()
    }, this.commandTimeoutMs)
    conn.pending.set(id, {
      timer,
      resolve: (result) => {
        if (result.ok) this.pendingStops.delete(key)
        else setTimeout(retry, 1_000)
      },
    })
    this.sendTo(conn.socket, { type: 'command', id, op: 'stop', args: {} })
  }

  /** Number of live extension connections (health/status surface). */
  connectionCount(): number {
    return this.byConnection.size
  }

  isConnected(userId: string, browserProfileId?: string): boolean {
    if (browserProfileId) return this.byConnection.has(connectionKey(userId, browserProfileId))
    return [...this.byConnection.values()].some((connection) => connection.userId === userId)
  }

  connectionStatus(
    userId: string,
    options: { browserProfileId?: string; workspaceId?: string } = {},
  ): {
    connected: boolean
    terminalEvent: 'stopped' | 'tab_closed' | null
    build: string | null
    staleBuild: boolean
  } {
    const connections = options.browserProfileId
      ? [this.byConnection.get(connectionKey(userId, options.browserProfileId))].filter(
          (connection): connection is Connection => !!connection,
        )
      : [...this.byConnection.values()].filter(
          (connection) =>
            connection.userId === userId &&
            (!options.workspaceId || connection.workspaceId === options.workspaceId),
        )
    const connection = connections.length === 1 ? connections[0] : null
    const terminalKey = options.browserProfileId
      ? connectionKey(userId, options.browserProfileId)
      : null
    return {
      connected: connections.length > 0,
      terminalEvent:
        connection?.terminalEvent ?? (terminalKey ? this.terminalByConnection.get(terminalKey) : null) ?? null,
      // Aggregate status deliberately omits a build when several profile
      // connections are live; staleBuild below still reports if any needs an update.
      build: connection?.build ?? null,
      // No connection means nothing to update; only a live extension can be stale.
      staleBuild: connections.some((item) => item.staleBuild),
    }
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
      // A socket authenticates exactly once. Allowing a second hello with a
      // different profile would leave the first registry key pointing at the
      // same socket and defeat exact-profile routing.
      if (conn) {
        this.sendTo(socket, { type: 'error', message: 'already authenticated' })
        this.handleDisconnect(socket)
        socket.close(4400, 'already authenticated')
        return
      }
      const identity = this.verify(msg.data.pairingToken)
      if (!identity) {
        this.sendTo(socket, { type: 'error', message: 'unauthorized' })
        socket.close(4401, 'unauthorized')
        return
      }
      // Latest pairing wins only INSIDE this browser profile. Other profile
      // connections for the same user remain live and may run concurrently.
      const key = connectionKey(identity.userId, identity.browserProfileId)
      const existing = this.byConnection.get(key)
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
      // Judged once, at hello, and remembered on the connection: every later
      // read (ready, status, a failing command) must give the same answer, and
      // re-deriving it per call would let them disagree.
      const build = msg.data.build ?? null
      const staleBuild = isExtensionBuildStale(build)
      const fresh: Connection = {
        socket,
        userId: identity.userId,
        workspaceId: identity.workspaceId,
        browserProfileId: identity.browserProfileId,
        pending: new Map(),
        lastSeenAt: Date.now(),
        terminalEvent: this.terminalByConnection.get(key) ?? null,
        build,
        staleBuild,
      }
      this.byConnection.set(key, fresh)
      this.bySocket.set(socket, fresh)
      // First-time pairing (short-lived pair token) → hand back a session
      // token so reconnect + re-hello works after the pair token expires.
      const sessionToken =
        identity.kind !== 'browser-ext-session' && this.mintSessionToken
          ? this.mintSessionToken({
              userId: identity.userId,
              workspaceId: identity.workspaceId,
              browserProfileId: identity.browserProfileId,
            })
          : undefined
      this.sendTo(socket, {
        type: 'ready',
        ...(sessionToken ? { sessionToken } : {}),
        ...(staleBuild ? { staleBuild: true } : {}),
      })
      if (this.pendingStops.has(key)) {
        fresh.terminalEvent = 'stopped'
        this.terminalByConnection.set(key, 'stopped')
        this.deliverPendingStop(fresh)
      }
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
        conn.terminalEvent = null
        this.terminalByConnection.delete(connectionKey(conn.userId, conn.browserProfileId))
        pending.resolve({ ok: true, data: msg.data.data })
      } else {
        pending.resolve({
          ok: false,
          error: msg.data.error ?? 'extension error',
          code: msg.data.code,
          ...(conn.staleBuild ? { staleBuild: true } : {}),
        })
      }
      return
    }

    if (msg.data.type === 'event') {
      // stopped / tab_closed / detached abort everything in flight for this
      // user (P1.7 close-to-stop; the extension itself refuses follow-up
      // commands). Each carries its own message: they are different situations
      // and a wrong one sends the model chasing the wrong cause.
      if (msg.data.kind === 'stopped' || msg.data.kind === 'tab_closed') {
        conn.terminalEvent = msg.data.kind
        this.terminalByConnection.set(
          connectionKey(conn.userId, conn.browserProfileId),
          msg.data.kind,
        )
      }
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
    const key = connectionKey(conn.userId, conn.browserProfileId)
    if (this.byConnection.get(key)?.socket === socket) {
      this.byConnection.delete(key)
    }
    this.rejectPending(conn, {
      ok: false,
      error: 'The browser extension disconnected.',
      code: 'no_extension',
    })
  }

  /**
   * Route one command to the selected browser profile's extension and await its `result`
   * (P1.4). Missing connection → the clear no-extension error, immediately —
   * never a hang. Timeout → `{ok:false, code:'timeout'}`.
   */
  async dispatchCommand(params: {
    userId: string
    browserProfileId: string
    controlMode?: 'task_tabs' | 'full_browser'
    op: string
    args?: Record<string, unknown>
    timeoutMs?: number
  }): Promise<InternalCommandResponse> {
    const key = connectionKey(params.userId, params.browserProfileId)
    const conn = this.byConnection.get(key)
    if (!conn) {
      if (params.op === 'stop') {
        this.pendingStops.add(key)
        this.terminalByConnection.set(key, 'stopped')
        return { ok: true, data: { stopped: true } }
      }
      return NO_EXTENSION_RESPONSE
    }

    const id = randomUUID()
    const timeoutMs = params.timeoutMs ?? this.commandTimeoutMs

    return new Promise<InternalCommandResponse>((resolve) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id)
        resolve({
          ok: false,
          error: `The extension did not answer within ${Math.round(timeoutMs / 1000)}s.`,
          code: 'timeout',
          ...(conn.staleBuild ? { staleBuild: true } : {}),
        })
      }, timeoutMs)
      conn.pending.set(id, { resolve, timer })
      this.sendTo(conn.socket, {
        type: 'command',
        id,
        op: params.op,
        args: params.args ?? {},
        controlMode: params.controlMode ?? 'task_tabs',
      })
    })
  }

  /** Close connections that have gone silent past the liveness window. */
  sweepDead(now = Date.now()): number {
    let closed = 0
    for (const conn of [...this.byConnection.values()]) {
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
