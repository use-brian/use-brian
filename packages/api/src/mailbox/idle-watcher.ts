/**
 * Mailbox IDLE watcher - the instant-ish wake-up in front of the sync worker
 * (mailbox-imap.md → "IDLE watcher"; plan docs/plans/mailbox-event-reply.md §6, D6).
 *
 * Per connected `imap` instance, ONE dedicated long-lived imapflow connection
 * (never the shared per-turn session cache - that one has a 60 s idle
 * eviction by design) opens INBOX and lets imapflow auto-IDLE. When the server
 * pushes `exists` (new mail), the watcher debounces ~2 s and calls the sync
 * worker's `syncInstanceById(id)` - the SAME delta sync the 5-minute tick
 * runs, so there is one archive insert, one rules pass, one workflow dispatch,
 * whichever clock woke it. The watcher never reads mail itself: it is a
 * wake-up signal, not a second ingest path (D6). INBOX only; the tick keeps
 * covering every other folder and remains the safety net.
 *
 * Capability + fallback: a server without `IDLE` in CAPABILITY holds no
 * socket - the instance is marked `unsupported` and rides the tick.
 * imapflow's `missingIdleCommand` NOOP loop is deliberately NOT used: it is a
 * second poller in disguise.
 *
 * Lifecycle: `reconcile()` (own timer at the sync cadence, and on demand from
 * the connect route's `watchInstance`) brings watchers up for new connected
 * instances and down for removed / disconnected / auth-failed ones. A dropped
 * socket reconnects with jittered exponential backoff (cap 5 min); an
 * authentication failure stops retrying and leaves the instance to the
 * existing connector-health path (the sync tick marks `auth_failed`).
 *
 * Health surface: `connector_instance.config.mailboxIdle = { status, since,
 * lastEventAt?, lastError? }` - a SIBLING key of `mailboxSync`, not nested in
 * it, because the sync worker rewrites `mailboxSync` wholesale from the state
 * it read at the start of a pass (`setConfigSystem` merges top-level keys
 * only), so a nested `idle` would be clobbered by any concurrent sync. Read by
 * `GET /imap/sync-status` → `idle` and shown on the panel as one line, so a
 * dead socket can never look like "no mail". No new table.
 *
 * Every ImapFlow instance carries an `'error'` listener (imap-session.ts Rule 1).
 *
 * [COMP:api/mailbox-idle-watcher]
 */

import { ImapFlow } from 'imapflow'
import type { ConnectorInstance, ConnectorInstanceStore } from '../db/connector-instance-store.js'
import { MAILBOX_GREETING_TIMEOUT_MS } from './imap-session.js'
import type { MailboxSyncSummary } from './sync-worker.js'
import type { MailboxAccountSettings } from './types.js'

// ── Types ─────────────────────────────────────────────────────────

/** The slice of an imapflow client the watcher drives (fake in tests). */
export type IdleClientLike = {
  connect(): Promise<void>
  logout(): Promise<void>
  close(): void
  mailboxOpen(path: string): Promise<unknown>
  /** Server CAPABILITY set (imapflow: a Map keyed by capability name). */
  capabilities: { has(name: string): boolean }
  on(event: 'exists' | 'close' | 'error', listener: (arg?: unknown) => void): unknown
  usable: boolean
}

type MailboxIdleStatusKind = 'connected' | 'unsupported' | 'reconnecting' | 'off'

export type MailboxIdleStatus = {
  status: MailboxIdleStatusKind
  /** When this status began (ISO). */
  since: string
  /** Last `exists` push (ISO) - the proof the socket is alive AND useful. */
  lastEventAt?: string | null
  /** Why the watcher is reconnecting / off. */
  lastError?: string | null
}

/** Config key on `connector_instance.config` (sibling of `mailboxSync`, see header). */
const MAILBOX_IDLE_CONFIG_KEY = 'mailboxIdle'

export function readMailboxIdleStatus(config: Record<string, unknown> | null | undefined): MailboxIdleStatus | null {
  const raw = config?.[MAILBOX_IDLE_CONFIG_KEY]
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<MailboxIdleStatus>
  if (r.status !== 'connected' && r.status !== 'unsupported' && r.status !== 'reconnecting' && r.status !== 'off') return null
  return {
    status: r.status,
    since: typeof r.since === 'string' ? r.since : '',
    ...(r.lastEventAt !== undefined ? { lastEventAt: r.lastEventAt } : {}),
    ...(r.lastError !== undefined ? { lastError: r.lastError } : {}),
  }
}

export type MailboxIdleWatcherDeps = {
  connectorInstanceStore: Pick<
    ConnectorInstanceStore,
    'listByProviderSystem' | 'getAuthCredentialsSystem' | 'setConfigSystem'
  >
  /** The sync worker's single-instance path (the ONLY thing the watcher triggers, D6). */
  syncInstanceById: (instanceId: string) => Promise<MailboxSyncSummary>
  /** Client factory (test seam). Defaults to a dedicated ImapFlow. */
  createClient?: (settings: MailboxAccountSettings, opts: { maxIdleTimeMs: number }) => IdleClientLike
  /** `exists` → sync debounce. */
  debounceMs?: number
  /** Break + restart IDLE this often (under the 29-min RFC 2177 server cap). */
  maxIdleTimeMs?: number
  /** Roster reconcile cadence (own timer; the sync worker's cadence by default). */
  reconcileIntervalMs?: number
  /** Reconnect backoff bounds. */
  backoffBaseMs?: number
  backoffCapMs?: number
  /** Deterministic jitter for tests ([0,1)). */
  random?: () => number
  now?: () => Date
  log?: (msg: string) => void
}

export type MailboxIdleWatcher = {
  start(): void
  /** Tear down every watcher (shutdown / tests). */
  stop(): Promise<void>
  isRunning(): boolean
  /** Bring the watcher roster in line with the connected imap instances. */
  reconcile(): Promise<void>
  /** Watch ONE instance now (the connect route's hook). Idempotent. */
  watchInstance(instanceId: string): Promise<void>
  unwatchInstance(instanceId: string): Promise<void>
  /** In-memory status (what the last transition wrote to config). */
  statusOf(instanceId: string): MailboxIdleStatus | null
  /** Instances currently watched (tests / diagnostics). */
  watched(): string[]
}

// ── Defaults ──────────────────────────────────────────────────────

const DEFAULT_DEBOUNCE_MS = 2_000
const DEFAULT_MAX_IDLE_TIME_MS = 25 * 60_000
const DEFAULT_RECONCILE_INTERVAL_MS = 5 * 60_000
const DEFAULT_BACKOFF_BASE_MS = 5_000
const DEFAULT_BACKOFF_CAP_MS = 5 * 60_000
/** `in_progress` re-arm ceiling: a sync that never frees the guard is a sync worker problem, not ours. */
const MAX_IN_PROGRESS_RETRIES = 10

function errText(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err)
  const e = err as { responseText?: unknown; code?: unknown } | null
  const extra = [e?.responseText, e?.code].filter((x): x is string => typeof x === 'string' && x.trim() !== '' && !base.includes(x))
  return [base, ...extra].join(' - ')
}

function isAuthFailure(err: unknown): boolean {
  return Boolean((err as { authenticationFailed?: boolean } | null)?.authenticationFailed)
}

function createIdleImapClient(settings: MailboxAccountSettings, opts: { maxIdleTimeMs: number }): IdleClientLike {
  return new ImapFlow({
    host: settings.imapHost,
    port: settings.imapPort,
    secure: true,
    auth: { user: settings.email, pass: settings.appPassword },
    logger: false,
    greetingTimeout: MAILBOX_GREETING_TIMEOUT_MS,
    maxIdleTime: opts.maxIdleTimeMs,
    // socketTimeout is left at imapflow's default: during IDLE its inactivity
    // handler recovers with NOOP + re-IDLE (see imap-flow.js `_socketTimeout`),
    // which is a keepalive, not a poll - and `maxIdleTime` re-arms IDLE anyway.
  }) as unknown as IdleClientLike
}

// ── The watcher ───────────────────────────────────────────────────

type WatchEntry = {
  instanceId: string
  client: IdleClientLike | null
  status: MailboxIdleStatus
  /** Consecutive reconnect attempts since the last healthy connection. */
  attempts: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  debounceTimer: ReturnType<typeof setTimeout> | null
  inProgressRetries: number
  /** Set on unwatch so a late `close` never schedules a reconnect. */
  stopped: boolean
  /** Monotonic connect generation - a stale client's `close` must not act on a newer one. */
  generation: number
}

export function createMailboxIdleWatcher(deps: MailboxIdleWatcherDeps): MailboxIdleWatcher {
  const createClient = deps.createClient ?? createIdleImapClient
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const maxIdleTimeMs = deps.maxIdleTimeMs ?? DEFAULT_MAX_IDLE_TIME_MS
  const reconcileIntervalMs = deps.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS
  const backoffBaseMs = deps.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS
  const backoffCapMs = deps.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS
  const random = deps.random ?? Math.random
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? ((msg: string) => console.warn(msg))

  const entries = new Map<string, WatchEntry>()
  let timer: ReturnType<typeof setInterval> | null = null
  let reconciling = false

  async function persist(entry: WatchEntry): Promise<void> {
    try {
      await deps.connectorInstanceStore.setConfigSystem(entry.instanceId, { [MAILBOX_IDLE_CONFIG_KEY]: entry.status })
    } catch (err) {
      log(`[mailbox-idle] status write failed for ${entry.instanceId}: ${errText(err)}`)
    }
  }

  async function transition(entry: WatchEntry, status: MailboxIdleStatusKind, lastError?: string | null): Promise<void> {
    const changed = entry.status.status !== status || (lastError ?? null) !== (entry.status.lastError ?? null)
    entry.status = {
      status,
      since: changed ? now().toISOString() : entry.status.since,
      lastEventAt: entry.status.lastEventAt ?? null,
      lastError: lastError ?? null,
    }
    if (changed) await persist(entry)
  }

  /** The one thing an `exists` does: wake the sync (debounced, in-progress-aware). */
  function scheduleSync(entry: WatchEntry): void {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null
      void runSync(entry)
    }, debounceMs)
    entry.debounceTimer.unref?.()
  }

  async function runSync(entry: WatchEntry): Promise<void> {
    if (entry.stopped) return
    let summary: MailboxSyncSummary
    try {
      summary = await deps.syncInstanceById(entry.instanceId)
    } catch (err) {
      log(`[mailbox-idle] sync trigger threw for ${entry.instanceId}: ${errText(err)}`)
      return
    }
    if (summary.reason === 'in_progress') {
      // A pass is already running; it may have STATUS-ed before this message
      // landed, so re-arm once it frees up. Bounded - never a loop.
      if (entry.inProgressRetries < MAX_IN_PROGRESS_RETRIES) {
        entry.inProgressRetries++
        scheduleSync(entry)
      }
      return
    }
    entry.inProgressRetries = 0
  }

  function backoffDelay(attempt: number): number {
    const exp = Math.min(backoffCapMs, backoffBaseMs * 2 ** Math.max(0, attempt - 1))
    // Full jitter in [exp/2, exp]: spreads a fleet-wide reconnect after a provider blip.
    return Math.round(exp / 2 + (exp / 2) * random())
  }

  function scheduleReconnect(entry: WatchEntry, reason: string): void {
    if (entry.stopped) return
    entry.attempts++
    const delay = backoffDelay(entry.attempts)
    void transition(entry, 'reconnecting', reason)
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer)
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null
      void connect(entry)
    }, delay)
    entry.reconnectTimer.unref?.()
  }

  async function teardownClient(entry: WatchEntry): Promise<void> {
    const client = entry.client
    entry.client = null
    if (!client) return
    try {
      await client.logout()
    } catch {
      try { client.close() } catch { /* already gone */ }
    }
  }

  async function connect(entry: WatchEntry): Promise<void> {
    if (entry.stopped) return
    const generation = ++entry.generation
    let creds
    try {
      creds = await deps.connectorInstanceStore.getAuthCredentialsSystem(entry.instanceId)
    } catch (err) {
      scheduleReconnect(entry, `credentials: ${errText(err)}`)
      return
    }
    if (!creds || creds.type !== 'imap') {
      // No credentials = nothing to watch; the reconcile pass drops the entry.
      await transition(entry, 'off', 'no imap credentials on the instance')
      return
    }
    const { type: _t, ...settings } = creds
    const client = createClient(settings, { maxIdleTimeMs })
    entry.client = client
    // Rule 1: every ImapFlow instance carries an 'error' listener - unlistened,
    // Node rethrows off the socket-timer stack and kills the process.
    client.on('error', (err) => {
      log(`[mailbox-idle] IMAP session error for ${settings.email}: ${errText(err)}`)
    })
    client.on('close', () => {
      // A stale generation's close (we already replaced the client) is noise.
      if (entry.generation !== generation || entry.stopped) return
      entry.client = null
      scheduleReconnect(entry, 'connection closed')
    })
    try {
      await client.connect()
      if (!client.capabilities.has('IDLE')) {
        // Do NOT hold a socket for a NOOP loop - the tick covers this mailbox.
        // Bump the generation first so this client's own `close` (from the
        // logout below) is stale to the handler and never schedules a reconnect.
        entry.generation++
        await teardownClient(entry)
        entry.attempts = 0
        await transition(entry, 'unsupported', null)
        return
      }
      client.on('exists', () => {
        if (entry.generation !== generation || entry.stopped) return
        entry.status = { ...entry.status, lastEventAt: now().toISOString() }
        // One config write per burst rides the debounced sync, not per event.
        scheduleSync(entry)
        void persist(entry)
      })
      await client.mailboxOpen('INBOX')
      // imapflow auto-IDLEs after a short quiet window on a SELECTED mailbox
      // (`autoidle`), and `maxIdleTime` re-arms it under the server cap.
      entry.attempts = 0
      await transition(entry, 'connected', null)
    } catch (err) {
      entry.client = null
      try { client.close() } catch { /* never connected */ }
      if (isAuthFailure(err)) {
        // Stop retrying: hammering a dead credential is how a mailbox gets
        // locked out. The sync tick's own login marks `auth_failed` on the
        // instance (the existing connector-health path), and reconcile drops
        // the watcher until a reconnect clears it.
        entry.stopped = true
        await transition(entry, 'off', `authentication failed: ${errText(err)}`)
        return
      }
      if (entry.generation !== generation) return
      scheduleReconnect(entry, errText(err))
    }
  }

  async function watchInstance(instanceId: string): Promise<void> {
    const existing = entries.get(instanceId)
    // Live (socket held) or mid-backoff: nothing to do. Parked (unsupported /
    // off / auth-stopped): re-probe - the connect route calls this after a
    // reconnect, which may have changed hosts or fixed the credential.
    if (existing && !existing.stopped && (existing.client || existing.reconnectTimer)) return
    if (existing) await unwatchInstance(instanceId)
    const entry: WatchEntry = {
      instanceId,
      client: null,
      status: { status: 'off', since: now().toISOString(), lastEventAt: null, lastError: null },
      attempts: 0,
      reconnectTimer: null,
      debounceTimer: null,
      inProgressRetries: 0,
      stopped: false,
      generation: 0,
    }
    entries.set(instanceId, entry)
    await connect(entry)
  }

  async function unwatchInstance(instanceId: string): Promise<void> {
    const entry = entries.get(instanceId)
    if (!entry) return
    entries.delete(instanceId)
    entry.stopped = true
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer)
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
    await teardownClient(entry)
    if (entry.status.status !== 'off') await transition(entry, 'off', null)
  }

  async function reconcile(): Promise<void> {
    if (reconciling) return
    reconciling = true
    try {
      let instances: ConnectorInstance[]
      try {
        instances = await deps.connectorInstanceStore.listByProviderSystem('imap')
      } catch (err) {
        log(`[mailbox-idle] roster listing failed: ${errText(err)}`)
        return
      }
      const wanted = new Set<string>()
      for (const inst of instances) {
        if (!inst.connected) continue
        if (inst.healthStatus === 'auth_failed') continue // the health path owns this until reconnect
        wanted.add(inst.id)
      }
      for (const id of [...entries.keys()]) {
        if (!wanted.has(id)) await unwatchInstance(id)
      }
      for (const id of wanted) {
        const entry = entries.get(id)
        // Live or mid-backoff: leave it alone. `unsupported` stays parked (a
        // server does not grow IDLE between ticks; `watchInstance` from the
        // connect route re-probes after a reconnect). An auth-stopped entry is
        // re-probed at most once per reconcile until the sync tick marks the
        // instance `auth_failed`, which drops it from `wanted` above.
        if (entry && entry.status.status === 'unsupported') continue
        if (entry && !entry.stopped && (entry.client || entry.reconnectTimer)) continue
        if (!entry || entry.stopped) await watchInstance(id)
      }
    } finally {
      reconciling = false
    }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => void reconcile(), reconcileIntervalMs)
      timer.unref?.()
      void reconcile()
    },
    async stop() {
      if (timer) clearInterval(timer)
      timer = null
      for (const id of [...entries.keys()]) await unwatchInstance(id)
    },
    isRunning() {
      return timer !== null
    },
    reconcile,
    watchInstance,
    unwatchInstance,
    statusOf(instanceId) {
      const entry = entries.get(instanceId)
      return entry ? { ...entry.status } : null
    },
    watched() {
      return [...entries.keys()].filter((id) => !entries.get(id)!.stopped)
    },
  }
}
