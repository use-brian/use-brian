/**
 * Mailbox IDLE watcher (mailbox-imap.md → "IDLE watcher"; plan §6 / §10 rows
 * 10-12): a fake imapflow client drives `exists` → one debounced
 * `syncInstanceById`, the no-IDLE fallback (no socket held), drop → backoff →
 * reconnect, roster add/remove, and the auth-failure stop.
 *
 * [COMP:api/mailbox-idle-watcher]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createMailboxIdleWatcher,
  readMailboxIdleStatus,
  type IdleClientLike,
  type MailboxIdleWatcherDeps,
} from '../idle-watcher.js'
import type { ConnectorInstance } from '../../db/connector-instance-store.js'
import type { MailboxSyncSummary } from '../sync-worker.js'

const IMAP_CREDS = {
  type: 'imap' as const,
  email: 'maya@harborlane.example',
  appPassword: 'pw',
  imapHost: 'imap.gmail.com',
  imapPort: 993,
  smtpHost: 'smtp.gmail.com',
  smtpPort: 465,
}

type FakeClient = IdleClientLike & {
  emit(event: 'exists' | 'close' | 'error', arg?: unknown): void
  opened: string[]
  logoutCalls: number
  closeCalls: number
}

function makeFakeClient(opts: { idle?: boolean; connectError?: Error } = {}): FakeClient {
  const listeners = new Map<string, Array<(arg?: unknown) => void>>()
  const client: FakeClient = {
    usable: false,
    opened: [],
    logoutCalls: 0,
    closeCalls: 0,
    capabilities: { has: (name: string) => (opts.idle ?? true) && name === 'IDLE' },
    async connect() {
      if (opts.connectError) throw opts.connectError
      client.usable = true
    },
    async logout() {
      client.logoutCalls++
      client.usable = false
      client.emit('close')
    },
    close() {
      client.closeCalls++
      client.usable = false
    },
    async mailboxOpen(path: string) {
      client.opened.push(path)
      return {}
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return client
    },
    emit(event, arg) {
      for (const l of listeners.get(event) ?? []) l(arg)
    },
  }
  return client
}

function instanceRow(over: Partial<ConnectorInstance> = {}): ConnectorInstance {
  return {
    id: 'inst-1',
    provider: 'imap',
    userId: 'owner-1',
    connected: true,
    healthStatus: 'ok',
    config: {},
    ...over,
  } as unknown as ConnectorInstance
}

function makeWatcher(over: {
  instances?: ConnectorInstance[]
  clients?: FakeClient[]
  sync?: (id: string) => Promise<MailboxSyncSummary>
  creds?: typeof IMAP_CREDS | null
} = {}) {
  const instances = over.instances ?? [instanceRow()]
  const clients = over.clients ?? [makeFakeClient()]
  let nextClient = 0
  const created: FakeClient[] = []
  const configs = new Map<string, Record<string, unknown>>()
  const setConfigSystem = vi.fn(async (id: string, config: Record<string, unknown>) => {
    configs.set(id, { ...(configs.get(id) ?? {}), ...config })
  })
  const syncInstanceById = vi.fn(over.sync ?? (async () => ({ synced: true, newMessages: 1 })))
  const deps: MailboxIdleWatcherDeps = {
    connectorInstanceStore: {
      listByProviderSystem: vi.fn(async () => instances),
      getAuthCredentialsSystem: vi.fn(async () => (over.creds === undefined ? IMAP_CREDS : over.creds)),
      setConfigSystem,
    } as never,
    syncInstanceById,
    createClient: () => {
      const c = clients[Math.min(nextClient, clients.length - 1)]
      nextClient++
      created.push(c)
      return c
    },
    debounceMs: 100,
    reconcileIntervalMs: 60_000,
    backoffBaseMs: 1_000,
    backoffCapMs: 8_000,
    random: () => 1, // deterministic: full backoff (exp/2 + exp/2)
    log: () => {},
  }
  const watcher = createMailboxIdleWatcher(deps)
  return { watcher, syncInstanceById, setConfigSystem, configs, created, instances }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('[COMP:api/mailbox-idle-watcher] wake-up on exists (row 10)', () => {
  it('opens INBOX on a dedicated client, and a burst of exists collapses into ONE debounced sync', async () => {
    const client = makeFakeClient()
    const { watcher, syncInstanceById, configs } = makeWatcher({ clients: [client] })
    await watcher.watchInstance('inst-1')
    expect(client.opened).toEqual(['INBOX'])
    expect(watcher.statusOf('inst-1')?.status).toBe('connected')
    expect(readMailboxIdleStatus(configs.get('inst-1'))?.status).toBe('connected')

    client.emit('exists', { count: 5 })
    client.emit('exists', { count: 6 })
    client.emit('exists', { count: 7 })
    expect(syncInstanceById).not.toHaveBeenCalled() // debounced
    await vi.advanceTimersByTimeAsync(150)
    expect(syncInstanceById).toHaveBeenCalledTimes(1)
    expect(syncInstanceById).toHaveBeenCalledWith('inst-1')
    // lastEventAt is the proof the socket is alive AND useful.
    expect(watcher.statusOf('inst-1')?.lastEventAt).toBeTruthy()
    expect(readMailboxIdleStatus(configs.get('inst-1'))?.lastEventAt).toBeTruthy()
  })

  it('an in-progress sync re-arms once (bounded), so mail landing mid-pass is not lost until the tick', async () => {
    const client = makeFakeClient()
    const sync = vi.fn<(id: string) => Promise<MailboxSyncSummary>>()
      .mockResolvedValueOnce({ synced: false, newMessages: 0, reason: 'in_progress' })
      .mockResolvedValue({ synced: true, newMessages: 1 })
    const { watcher, syncInstanceById } = makeWatcher({ clients: [client], sync })
    await watcher.watchInstance('inst-1')
    client.emit('exists')
    await vi.advanceTimersByTimeAsync(150)
    expect(syncInstanceById).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(150)
    expect(syncInstanceById).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(syncInstanceById).toHaveBeenCalledTimes(2) // settled, no loop
  })
})

describe('[COMP:api/mailbox-idle-watcher] no IDLE capability (row 11)', () => {
  it('marks the instance unsupported and holds NO socket (the tick covers it)', async () => {
    const client = makeFakeClient({ idle: false })
    const { watcher, configs, syncInstanceById } = makeWatcher({ clients: [client] })
    await watcher.watchInstance('inst-1')
    expect(watcher.statusOf('inst-1')?.status).toBe('unsupported')
    expect(readMailboxIdleStatus(configs.get('inst-1'))?.status).toBe('unsupported')
    expect(client.logoutCalls).toBe(1)
    expect(client.opened).toEqual([]) // never SELECTed - no NOOP loop in disguise
    // The logout's own close must not schedule a reconnect.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(watcher.statusOf('inst-1')?.status).toBe('unsupported')
    expect(syncInstanceById).not.toHaveBeenCalled()
    // Reconcile leaves a parked unsupported entry alone (no re-probe storm).
    await watcher.reconcile()
    expect(client.logoutCalls).toBe(1)
  })
})

describe('[COMP:api/mailbox-idle-watcher] socket drop → backoff → reconnect (row 12)', () => {
  it('reconnects with exponential backoff, reports reconnecting meanwhile, and does not double-sync', async () => {
    const first = makeFakeClient()
    const second = makeFakeClient()
    const { watcher, created, syncInstanceById, configs } = makeWatcher({ clients: [first, second] })
    await watcher.watchInstance('inst-1')
    expect(created).toHaveLength(1)

    first.emit('close') // provider dropped the socket
    expect(watcher.statusOf('inst-1')?.status).toBe('reconnecting')
    expect(watcher.statusOf('inst-1')?.lastError).toMatch(/connection closed/)
    await vi.advanceTimersByTimeAsync(0)
    expect(readMailboxIdleStatus(configs.get('inst-1'))?.status).toBe('reconnecting')

    // Attempt 1 backoff = base (1 s) with random()=1 → exactly 1000 ms.
    await vi.advanceTimersByTimeAsync(900)
    expect(created).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(150)
    expect(created).toHaveLength(2)
    expect(watcher.statusOf('inst-1')?.status).toBe('connected')
    expect(second.opened).toEqual(['INBOX'])

    // A late exists from the STALE first client is ignored; the live one wakes the sync once.
    first.emit('exists')
    second.emit('exists')
    await vi.advanceTimersByTimeAsync(150)
    expect(syncInstanceById).toHaveBeenCalledTimes(1)
  })

  it('backoff grows and is capped; a healthy connection resets it', async () => {
    const failing = makeFakeClient({ connectError: new Error('ECONNRESET') })
    const ok = makeFakeClient()
    // three failing connects, then a good one
    const { watcher, created } = makeWatcher({ clients: [failing, failing, failing, ok] })
    await watcher.watchInstance('inst-1')
    expect(watcher.statusOf('inst-1')?.status).toBe('reconnecting')
    expect(created).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000) // attempt 2 after 1 s
    expect(created).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(2_000) // attempt 3 after 2 s
    expect(created).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(4_000) // attempt 4 after 4 s → connects
    expect(created).toHaveLength(4)
    expect(watcher.statusOf('inst-1')?.status).toBe('connected')
    expect(watcher.statusOf('inst-1')?.lastError).toBeNull()
  })

  it('an authentication failure STOPS retrying (the health path owns it) instead of hammering the provider', async () => {
    const authErr = Object.assign(new Error('Invalid credentials (Failure)'), { authenticationFailed: true })
    const dead = makeFakeClient({ connectError: authErr })
    const { watcher, created } = makeWatcher({ clients: [dead] })
    await watcher.watchInstance('inst-1')
    expect(watcher.statusOf('inst-1')?.status).toBe('off')
    expect(watcher.statusOf('inst-1')?.lastError).toMatch(/authentication failed/)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(created).toHaveLength(1)
    expect(watcher.watched()).toEqual([])
    // Once the tick has marked the instance auth_failed, reconcile drops it entirely.
    const { watcher: w2, created: c2 } = makeWatcher({
      clients: [dead],
      instances: [instanceRow({ healthStatus: 'auth_failed' } as never)],
    })
    await w2.reconcile()
    expect(c2).toHaveLength(0)
    expect(w2.watched()).toEqual([])
  })
})

describe('[COMP:api/mailbox-idle-watcher] roster reconcile', () => {
  it('brings watchers up for connected instances and down for removed / disconnected ones', async () => {
    const a = makeFakeClient()
    const b = makeFakeClient()
    const instances = [instanceRow({ id: 'a' }), instanceRow({ id: 'b' })]
    const { watcher, created } = makeWatcher({ clients: [a, b], instances })
    watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(watcher.watched().sort()).toEqual(['a', 'b'])
    expect(created).toHaveLength(2)

    // b disconnects; a stays. Reconcile on the timer.
    instances.splice(1, 1, instanceRow({ id: 'b', connected: false }))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(watcher.watched()).toEqual(['a'])
    expect(b.logoutCalls).toBe(1)
    expect(watcher.statusOf('b')).toBeNull()
    // a is untouched: still one client, no reconnect.
    expect(created).toHaveLength(2)

    await watcher.stop()
    expect(watcher.isRunning()).toBe(false)
    expect(watcher.watched()).toEqual([])
    expect(a.logoutCalls).toBe(1)
  })

  it('watchInstance is idempotent for a live watcher and re-probes a parked one (the connect-route hook)', async () => {
    const live = makeFakeClient()
    const { watcher, created } = makeWatcher({ clients: [live] })
    await watcher.watchInstance('inst-1')
    await watcher.watchInstance('inst-1')
    expect(created).toHaveLength(1)

    const noIdle = makeFakeClient({ idle: false })
    const withIdle = makeFakeClient()
    const parked = makeWatcher({ clients: [noIdle, withIdle] })
    await parked.watcher.watchInstance('inst-1')
    expect(parked.watcher.statusOf('inst-1')?.status).toBe('unsupported')
    await parked.watcher.watchInstance('inst-1') // e.g. reconnected with new hosts
    expect(parked.created).toHaveLength(2)
    expect(parked.watcher.statusOf('inst-1')?.status).toBe('connected')
  })

  it('readMailboxIdleStatus tolerates a missing / malformed config', () => {
    expect(readMailboxIdleStatus(undefined)).toBeNull()
    expect(readMailboxIdleStatus({ mailboxIdle: 'nope' })).toBeNull()
    expect(readMailboxIdleStatus({ mailboxIdle: { status: 'weird' } })).toBeNull()
    expect(readMailboxIdleStatus({ mailboxIdle: { status: 'connected', since: 't', lastEventAt: null } }))
      .toEqual({ status: 'connected', since: 't', lastEventAt: null })
  })
})
