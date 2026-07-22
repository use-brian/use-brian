import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMailboxSessionCache, type ImapClientLike } from '../imap-session.js'
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
