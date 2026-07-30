import { EventEmitter } from 'node:events'
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  attachSessionErrorSink,
  createImapClient,
  createMailboxSessionCache,
  createSocketKeepWarm,
  MAILBOX_KEEP_WARM_MS,
  MAILBOX_SOCKET_TIMEOUT_MS,
  type ImapClientLike,
} from '../imap-session.js'
import type { MailboxAccountSettings } from '../types.js'

const SETTINGS: MailboxAccountSettings = {
  email: 'me@corp.com',
  appPassword: 'p',
  imapHost: 'imap.corp.com',
  imapPort: 993,
  smtpHost: 'smtp.corp.com',
  smtpPort: 465,
}

function makeFakeClient(overrides: Partial<ImapClientLike> = {}): ImapClientLike & {
  connectCalls: number
  logoutCalls: number
} {
  const state = { connectCalls: 0, logoutCalls: 0 }
  const client = {
    usable: true,
    async connect() { state.connectCalls++ },
    async logout() { state.logoutCalls++ },
    close() {},
    async list() { return [] },
    async getMailboxLock() { return { release() {} } },
    async search() { return [] as number[] },
    fetch: () => (async function* () {})(),
    async fetchOne() { return false as const },
    async status() { return { path: 'INBOX' } },
    async append() { return {} },
    ...overrides,
  } as unknown as ImapClientLike & { connectCalls: number; logoutCalls: number }
  Object.defineProperty(client, 'connectCalls', { get: () => state.connectCalls })
  Object.defineProperty(client, 'logoutCalls', { get: () => state.logoutCalls })
  const origConnect = client.connect.bind(client)
  client.connect = async () => { await origConnect() }
  return client
}

afterEach(() => {
  vi.useRealTimers()
})

describe('[COMP:api/mailbox-imap-client] Per-turn IMAP session reuse (D12 #1)', () => {
  it('reuses the authenticated connection across calls under the same key', async () => {
    const clients: Array<ReturnType<typeof makeFakeClient>> = []
    const cache = createMailboxSessionCache({
      createClient: () => { const c = makeFakeClient(); clients.push(c); return c },
    })
    await cache.withClient('inst-1', SETTINGS, async () => 'a')
    await cache.withClient('inst-1', SETTINGS, async () => 'b')
    expect(clients).toHaveLength(1)
    expect(clients[0].connectCalls).toBe(1)
    await cache.closeAll()
  })

  it('keeps sessions per key — a different instance gets its own connection', async () => {
    const clients: Array<ReturnType<typeof makeFakeClient>> = []
    const cache = createMailboxSessionCache({
      createClient: () => { const c = makeFakeClient(); clients.push(c); return c },
    })
    await cache.withClient('inst-1', SETTINGS, async () => null)
    await cache.withClient('inst-2', SETTINGS, async () => null)
    expect(clients).toHaveLength(2)
    await cache.closeAll()
  })

  it('closes the session after the idle window (turn end) and reconnects on the next call', async () => {
    vi.useFakeTimers()
    const clients: Array<ReturnType<typeof makeFakeClient>> = []
    const cache = createMailboxSessionCache({
      createClient: () => { const c = makeFakeClient(); clients.push(c); return c },
      idleMs: 1000,
    })
    await cache.withClient('inst-1', SETTINGS, async () => null)
    expect(cache.size()).toBe(1)
    await vi.advanceTimersByTimeAsync(1500)
    expect(cache.size()).toBe(0)
    expect(clients[0].logoutCalls).toBe(1)
    await cache.withClient('inst-1', SETTINGS, async () => null)
    expect(clients).toHaveLength(2)
    await cache.closeAll()
  })

  it('drops a dead connection so the next call reconnects', async () => {
    const clients: Array<ReturnType<typeof makeFakeClient>> = []
    const cache = createMailboxSessionCache({
      createClient: () => { const c = makeFakeClient(); clients.push(c); return c },
    })
    await cache.withClient('inst-1', SETTINGS, async (client) => {
      ;(client as { usable: boolean }).usable = false
      throw new Error('connection lost')
    }).catch(() => {})
    await cache.withClient('inst-1', SETTINGS, async () => null)
    expect(clients).toHaveLength(2)
    await cache.closeAll()
  })

  it('a failed connect is not cached — the next call retries', async () => {
    let attempts = 0
    const cache = createMailboxSessionCache({
      createClient: () => {
        attempts++
        if (attempts === 1) {
          return makeFakeClient({ connect: async () => { throw new Error('auth failed') } })
        }
        return makeFakeClient()
      },
    })
    await expect(cache.withClient('inst-1', SETTINGS, async () => null)).rejects.toThrow('auth failed')
    await expect(cache.withClient('inst-1', SETTINGS, async () => 'ok')).resolves.toBe('ok')
    expect(attempts).toBe(2)
    await cache.closeAll()
  })
})

describe("[COMP:api/mailbox-imap-client] Session 'error' event sink", () => {
  // imapflow IS an EventEmitter and reports every post-connect failure through
  // `emit('error', err)`. These tests pin the EventEmitter semantics the
  // 2026-07-28 crash loop turned on, using a bare emitter as the stand-in.

  it('an unlistened error event throws — the crash the sink prevents', () => {
    const emitter = new EventEmitter()
    // No listener: Node rethrows rather than dropping the event. In production
    // this throw arrives on the socket timer's stack, so no `try/catch` around
    // any of our awaits can catch it — the process dies.
    expect(() => emitter.emit('error', Object.assign(new Error('Socket timeout'), { code: 'ETIMEOUT' })))
      .toThrow('Socket timeout')
  })

  it('reports the error and the account instead of throwing, once the sink is attached', () => {
    const emitter = new EventEmitter()
    const logged: string[] = []
    attachSessionErrorSink(emitter as unknown as ImapClientLike, 'me@corp.example', (m) => logged.push(m))

    expect(() => emitter.emit('error', Object.assign(new Error('Socket timeout'), { code: 'ETIMEOUT' })))
      .not.toThrow()
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('me@corp.example')
    expect(logged[0]).toContain('Socket timeout')
    // The code travels too — ETIMEOUT vs a reset distinguishes an idle socket
    // from a server hangup when reading the logs later.
    expect(logged[0]).toContain('ETIMEOUT')
  })

  it('survives a non-Error rejection value', () => {
    const emitter = new EventEmitter()
    const logged: string[] = []
    attachSessionErrorSink(emitter as unknown as ImapClientLike, 'me@corp.example', (m) => logged.push(m))
    expect(() => emitter.emit('error', 'plain string failure')).not.toThrow()
    expect(logged[0]).toContain('plain string failure')
  })

  it('createImapClient ships with the sink attached', async () => {
    // Constructing is enough — no connect, no network. If the sink were
    // missing, the emit below would throw out of this test.
    const client = createImapClient(SETTINGS)
    try {
      expect(() => (client as unknown as EventEmitter).emit('error', new Error('Socket timeout')))
        .not.toThrow()
    } finally {
      client.close()
    }
  })
})

describe('[COMP:api/mailbox-imap-client] Socket keep-warm', () => {
  it('stays under the inactivity timeout it guards', () => {
    // The NOOP itself needs room to complete inside the timeout window.
    expect(MAILBOX_KEEP_WARM_MS).toBeLessThan(MAILBOX_SOCKET_TIMEOUT_MS / 2)
  })

  it('costs nothing while the loop is fast', async () => {
    let noops = 0
    let clock = 0
    const client = makeFakeClient({ noop: async () => { noops++; return {} } })
    const warm = createSocketKeepWarm(client, { everyMs: 30_000, now: () => clock })
    for (let i = 0; i < 200; i++) {
      clock += 10 // 200 quick inserts, 2s total
      await warm.pingIfIdle()
    }
    expect(noops).toBe(0)
  })

  it('never lets the socket go quiet longer than the timeout, however slow the inserts', async () => {
    // The property that matters: not a NOOP count, but that no gap between
    // socket activity ever reaches MAILBOX_SOCKET_TIMEOUT_MS.
    let clock = 0
    const pingsAt: number[] = []
    const client = makeFakeClient({ noop: async () => { pingsAt.push(clock); return {} } })
    const warm = createSocketKeepWarm(client, {
      everyMs: MAILBOX_KEEP_WARM_MS,
      now: () => clock,
    })
    // 40 inserts at 20s each — 800s of otherwise-silent socket, nine times the
    // 90s timeout. (20s per insert is not hyperbole: the incident's inserts
    // were hitting statement timeouts.)
    for (let i = 0; i < 40; i++) {
      clock += 20_000
      await warm.pingIfIdle()
    }
    expect(pingsAt.length).toBeGreaterThan(0)

    let previous = 0
    for (const at of pingsAt) {
      expect(at - previous).toBeLessThan(MAILBOX_SOCKET_TIMEOUT_MS)
      previous = at
    }
    // And the tail: the final stretch after the last ping is also short enough.
    expect(clock - previous).toBeLessThan(MAILBOX_SOCKET_TIMEOUT_MS)
    // Cheap: one ping per idle window, not one per message.
    expect(pingsAt.length).toBeLessThan(40)
  })

  it('rethrows when the session is already gone', async () => {
    const client = makeFakeClient({ noop: async () => { throw new Error('Socket is already closed') } })
    let clock = 0
    const warm = createSocketKeepWarm(client, { everyMs: 1_000, now: () => clock })
    clock += 5_000
    // The caller's walk must abort rather than keep inserting against a dead
    // connection; `syncInstance` persists advanced checkpoints on the way out.
    await expect(warm.pingIfIdle()).rejects.toThrow('Socket is already closed')
  })
})
