/**
 * The process's single dedicated LISTEN/NOTIFY connection.
 *
 * `LISTEN` binds to one Postgres session, so a pool checkout cannot carry it —
 * every channel needs a client held open for the lifetime of the instance.
 * Historically each fan-out module opened its own: `brain_events`
 * (`../brain-stream/sse-fanout.ts`), `session_event` (`../session-event-bus.ts`)
 * and `feed_events` (`@use-brian/api-platform/feed/sse-fanout.ts`), so a single
 * api process held THREE connections outside the pools and the fleet held six.
 *
 * That is a connection-budget problem, not a style one. Prod Cloud SQL is a
 * `db-f1-micro`: `max_connections = 25` minus `superuser_reserved_connections = 3`
 * leaves 22 slots for the whole fleet, and the pools already claim 16. The
 * graded budget assumed 4 LISTEN clients while reality was 6, which put the
 * true worst case at exactly 22 with zero headroom — one `prod-db.sh` session or
 * migration run over the line, and Postgres refuses connections with 53300
 * ("remaining connection slots are reserved…"), which surfaces to users as a
 * failed chat turn. One session can `LISTEN` on any number of channels, so
 * multiplexing here takes the fleet from 6 dedicated clients to 2.
 *
 * Ownership split: this module owns the connection, the reconnect, and the
 * channel→handler routing. It does NOT parse payloads or know about
 * subscribers — each fan-out module registers a handler that receives the raw
 * NOTIFY payload string and does its own parsing and dispatch. Registration is
 * order-independent: register before or after `startNotifyListener()`, and a
 * channel registered while the connection is already live is subscribed on that
 * same client.
 *
 * Spec: docs/architecture/platform/deployment.md → "fleet-wide connection budget".
 *
 * [COMP:platform/notify-listener]
 */

import pg from 'pg'

/** Receives the raw NOTIFY payload; the caller parses it. */
export type NotifyHandler = (payload: string) => void

/**
 * `LISTEN <channel>` takes an identifier, not a bind parameter, so the channel
 * name is interpolated into the statement. Every caller passes a module-level
 * constant today, but the shape check is the only thing standing between this
 * function and SQL injection if that ever stops being true.
 */
const CHANNEL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/

const handlers = new Map<string, NotifyHandler>()

let client: pg.Client | null = null
let status: 'idle' | 'connecting' | 'listening' | 'reconnecting' = 'idle'
let reconnectTimer: NodeJS.Timeout | null = null
let backoffMs = 1_000

function buildClient(): pg.Client {
  return new pg.Client({ connectionString: process.env.DATABASE_URL })
}

/**
 * Register a channel and its handler. Idempotent per channel — re-registering
 * replaces the handler. Safe to call before or after `startNotifyListener()`;
 * when the connection is already live the `LISTEN` is issued immediately.
 */
export function registerNotifyChannel(channel: string, handler: NotifyHandler): void {
  if (!CHANNEL_IDENTIFIER.test(channel)) {
    throw new Error(
      `[notify-listener] "${channel}" is not a bare lowercase SQL identifier — ` +
        'LISTEN cannot bind the channel as a parameter, so it must match /^[a-z_][a-z0-9_]*$/',
    )
  }
  const alreadyRegistered = handlers.has(channel)
  handlers.set(channel, handler)
  // Only the first registration needs a LISTEN; a replacement handler rides the
  // subscription that is already open.
  if (!alreadyRegistered && status === 'listening' && client) {
    void subscribe(client, channel)
  }
}

/** Issue one `LISTEN`. Returns false if it failed and a reconnect was scheduled. */
async function subscribe(target: pg.Client, channel: string): Promise<boolean> {
  try {
    await target.query(`LISTEN ${channel}`)
    console.log(`[notify-listener] LISTEN ${channel} active`)
    return true
  } catch (err) {
    console.warn(`[notify-listener] failed to LISTEN ${channel}, will reconnect:`, err)
    scheduleReconnect()
    return false
  }
}

async function connect(): Promise<void> {
  if (status === 'connecting' || status === 'listening') return
  status = 'connecting'

  const next = buildClient()
  client = next

  next.on('notification', (msg) => {
    if (!msg.payload) return
    const handler = handlers.get(msg.channel)
    if (!handler) return
    try {
      handler(msg.payload)
    } catch (err) {
      // One module's bad payload must not take down the shared connection —
      // that would silently kill realtime for every other channel.
      console.warn(`[notify-listener] handler for ${msg.channel} threw:`, err)
    }
  })

  next.on('error', (err) => {
    console.warn('[notify-listener] connection error, will reconnect:', err.message)
    scheduleReconnect()
  })
  next.on('end', () => {
    if (status !== 'reconnecting') {
      console.warn('[notify-listener] connection ended unexpectedly')
      scheduleReconnect()
    }
  })

  try {
    await next.connect()
    status = 'listening'
    backoffMs = 1_000
    for (const channel of handlers.keys()) {
      // Stop at the first failure: `subscribe` has already scheduled the
      // reconnect and ended this client, so the remaining channels would each
      // throw against a dead client and log a duplicate warning. The reconnect
      // re-subscribes all of them.
      if (!(await subscribe(next, channel))) break
    }
  } catch (err) {
    console.warn('[notify-listener] failed to connect:', err)
    scheduleReconnect()
  }
}

function scheduleReconnect(): void {
  if (status === 'reconnecting') return
  status = 'reconnecting'

  if (client) {
    client.removeAllListeners()
    client.end().catch(() => {})
    client = null
  }

  const delay = backoffMs
  backoffMs = Math.min(backoffMs * 2, 30_000)

  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    status = 'idle'
    // Every registered channel is re-subscribed by `connect()`.
    void connect()
  }, delay)
}

/**
 * Open the shared connection. Idempotent — safe to call from every fan-out
 * module's own boot entry point and from their lazy first-subscriber paths.
 */
export function startNotifyListener(): void {
  if (status === 'idle') void connect()
}

/**
 * Drop one channel's registration and, once the last one goes, close the shared
 * connection. Scoped per channel on purpose: each fan-out module owns its own
 * channel and nothing else, so a module tearing itself down must not silence
 * the other two — which is what a blanket `handlers.clear()` here would do.
 * `UNLISTEN` is skipped: the handler lookup already drops the notification, and
 * on the last deregistration the connection closes anyway.
 */
export async function unregisterNotifyChannel(channel: string): Promise<void> {
  handlers.delete(channel)
  if (handlers.size === 0) await _shutdownNotifyListener()
}

/** Test helper — the channels currently registered, in registration order. */
export function _getNotifyChannels(): string[] {
  return [...handlers.keys()]
}

/** Close the shared connection and forget every channel. Test-only teardown. */
export async function _shutdownNotifyListener(): Promise<void> {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
  if (client) {
    client.removeAllListeners()
    await client.end().catch(() => {})
    client = null
  }
  status = 'idle'
  backoffMs = 1_000
  handlers.clear()
}
