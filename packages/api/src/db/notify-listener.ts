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

/**
 * Channels whose `LISTEN` succeeded on the CURRENT connection. Cleared on every
 * reconnect, because a new session inherits no subscriptions. Keeping this
 * separate from `handlers` is what lets a channel registered while `connect()`
 * is mid-loop be picked up exactly once.
 */
const subscribed = new Set<string>()
const subscribing = new Set<string>()

/** Readiness is channel-specific and becomes true only after LISTEN completes. */
export type NotifyLifecycleState = Readonly<{
  ready: boolean
  reason: 'initial' | 'ready' | 'disconnected'
}>
type LifecycleObserver = (state: NotifyLifecycleState) => void
const lifecycleObservers = new Map<string, Set<LifecycleObserver>>()

function deliverLifecycle(observer: LifecycleObserver, state: NotifyLifecycleState): void {
  try { observer(state) } catch (err) {
    console.warn('[notify-listener] lifecycle observer threw:', err)
  }
}

function emitLifecycle(channel: string, ready: boolean): void {
  for (const observer of [...(lifecycleObservers.get(channel) ?? [])]) {
    deliverLifecycle(observer, { ready, reason: ready ? 'ready' : 'disconnected' })
  }
}

/** Synchronously delivers initial state. Unsubscribe does not affect the channel. */
export function subscribeNotifyLifecycle(channel: string, observer: LifecycleObserver): () => void {
  const observers = lifecycleObservers.get(channel) ?? new Set<LifecycleObserver>()
  lifecycleObservers.set(channel, observers)
  observers.add(observer)
  deliverLifecycle(observer, {
    ready: status === 'listening' && handlers.has(channel) && subscribed.has(channel),
    reason: 'initial',
  })
  return () => {
    observers.delete(observer)
    if (observers.size === 0) lifecycleObservers.delete(channel)
  }
}

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
  const wasRegistered = handlers.has(channel)
  handlers.set(channel, handler)
  // A replacement handler rides the subscription that is already open; only a
  // channel this connection has not yet subscribed needs a LISTEN. `subscribed`
  // (not `handlers`) is the right guard: it is per-connection, so this stays
  // correct across reconnects and cannot double-issue against `connect()`'s
  // in-flight loop.
  if (status === 'listening' && client) {
    if (!subscribed.has(channel)) void subscribe(client, channel)
    // Deregistration does not UNLISTEN. Restoring that handler must restore
    // existing observers too, even though no new SQL subscription is needed.
    else if (!wasRegistered) emitLifecycle(channel, true)
  }
}

/** Issue one `LISTEN`. Returns false if it failed and a reconnect was scheduled. */
async function subscribe(target: pg.Client, channel: string): Promise<boolean> {
  if (subscribed.has(channel) || subscribing.has(channel)) return true
  subscribing.add(channel)
  try {
    await target.query(`LISTEN ${channel}`)
    // An error/end or shutdown may have retired this client during the await.
    if (client !== target) return false
    subscribed.add(channel)
    if (status === 'listening' && handlers.has(channel)) emitLifecycle(channel, true)
    console.log(`[notify-listener] LISTEN ${channel} active`)
    return true
  } catch (err) {
    console.warn(`[notify-listener] failed to LISTEN ${channel}, will reconnect:`, err)
    if (client === target) scheduleReconnect()
    return false
  } finally {
    if (client === target) subscribing.delete(channel)
  }
}

async function connect(): Promise<void> {
  if (status === 'connecting' || status === 'listening') return
  status = 'connecting'

  const next = buildClient()
  client = next

  next.on('notification', (msg) => {
    if (client !== next) return
    const handler = handlers.get(msg.channel)
    if (!handler) return
    try {
      handler(msg.payload ?? '')
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
    if (client !== next) return
    for (const channel of handlers.keys()) {
      // Stop at the first failure: `subscribe` has already scheduled the
      // reconnect and ended this client, so the remaining channels would each
      // throw against a dead client and log a duplicate warning. The reconnect
      // re-subscribes all of them.
      if (!(await subscribe(next, channel))) return
    }
    // Only now is the connection actually useful, so only now does it count as
    // a success. Declaring 'listening' (and resetting the backoff) before the
    // LISTENs land would make a server that ACCEPTS connections but fails
    // LISTEN retry at a flat 1s forever instead of climbing to the 30s cap —
    // a tight reconnect loop against a database that is already struggling,
    // which is the exact condition this module exists to stay clear of.
    if (client !== next) return
    status = 'listening'
    for (const channel of subscribed) emitLifecycle(channel, true)
    backoffMs = 1_000
    // A channel registered while the loop above was in flight saw
    // `status !== 'listening'` and skipped its immediate LISTEN. The live Map
    // iteration usually catches it; this sweep covers the case where it was
    // added behind the cursor.
    for (const channel of handlers.keys()) {
      if (!subscribed.has(channel)) void subscribe(next, channel)
    }
  } catch (err) {
    console.warn('[notify-listener] failed to connect:', err)
    if (client === next) scheduleReconnect()
  }
}

function scheduleReconnect(): void {
  if (status === 'reconnecting') return
  status = 'reconnecting'
  for (const channel of lifecycleObservers.keys()) emitLifecycle(channel, false)

  if (client) {
    client.removeAllListeners()
    client.end().catch(() => {})
    client = null
  }
  // A new session inherits no subscriptions, so nothing is subscribed until
  // the next connect re-issues every LISTEN.
  subscribed.clear()
  subscribing.clear()

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
  emitLifecycle(channel, false)
  if (handlers.size === 0) await _shutdownNotifyListener()
}

/** Test helper — the channels currently registered, in registration order. */
export function _getNotifyChannels(): string[] {
  return [...handlers.keys()]
}

/** Close the shared connection and forget every channel. Test-only teardown. */
export async function _shutdownNotifyListener(): Promise<void> {
  status = 'idle'
  for (const channel of lifecycleObservers.keys()) emitLifecycle(channel, false)
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
  if (client) {
    const previous = client
    client = null
    previous.removeAllListeners()
    await previous.end().catch(() => {})
  }
  status = 'idle'
  backoffMs = 1_000
  handlers.clear()
  subscribed.clear()
  subscribing.clear()
}
