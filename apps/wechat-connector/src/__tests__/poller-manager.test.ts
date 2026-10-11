/**
 * Many bots, one connector (A10): independent loops, exclusive replacement,
 * generation-tagged forwards, and conflict refusal - with the Tencent
 * transport replaced by in-memory fakes. No network, no model.
 * Spec: docs/architecture/channels/wechat.md → "Multi-connection operation".
 */
import { describe, it, expect, vi } from 'vitest'
import { createPollerManager, DuplicateBotError, type PollerConnectInput } from '../poller-manager.js'

type Reply = { ret?: number; errcode?: number; get_updates_buf?: string; msgs?: Array<{ id: string; text: string }> }
type FakeBot = {
  replies: Reply[]
  cursors: string[]
  events: string[]
  active: number
  maxActive: number
  calls: number
}

const STALE = -14

function harness(opts: { cursorStatus?: (channelId: string) => number } = {}) {
  const bots = new Map<string, FakeBot>()
  const bot = (token: string) => {
    let b = bots.get(token)
    if (!b) { b = { replies: [], cursors: [], events: [], active: 0, maxActive: 0, calls: 0 }; bots.set(token, b) }
    return b
  }
  const untilAbort = (signal: AbortSignal) => new Promise<void>((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => resolve(), { once: true })
  })
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  let restoreRows: Array<PollerConnectInput & { channelId: string }> = []
  const fetchFake = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const path = new URL(url).pathname
    if (!init?.method) return new Response(JSON.stringify(restoreRows), { status: 200 })
    const body = JSON.parse(init.body ?? '{}')
    posts.push({ path, body })
    const status = path.endsWith('/cursor') ? (opts.cursorStatus?.(body.channelId) ?? 200) : 200
    return new Response('{}', { status })
  })
  const manager = createPollerManager({
    apiUrl: 'http://api.test',
    connectorSecret: 'secret',
    deps: {
      fetch: fetchFake as unknown as typeof fetch,
      sleep: (ms, signal) => ms >= 60 * 60_000 ? untilAbort(signal) : new Promise((r) => setTimeout(r, 1)),
      createAdapter: () => ({
        deduplicateId: (raw: unknown) => (raw as { id: string }).id,
        parseIncoming: (raw: unknown) => ({ userId: 'peer', channelId: 'peer', text: (raw as { text: string }).text }) as never,
      }),
      createClient: ({ token }) => ({
        notifyStart: async () => { bot(token).events.push('start'); return { ret: 0 } as never },
        notifyStop: async () => { bot(token).events.push('stop'); return {} as never },
        getUpdates: async ({ getUpdatesBuf, abortSignal }: { getUpdatesBuf: string; abortSignal?: AbortSignal }) => {
          const b = bot(token)
          b.calls += 1
          b.cursors.push(getUpdatesBuf)
          b.active += 1
          b.maxActive = Math.max(b.maxActive, b.active)
          try {
            const next = b.replies.shift()
            if (next) { await new Promise((r) => setTimeout(r, 1)); return next as never }
            await untilAbort(abortSignal!)
            return {} as never
          } finally { b.active -= 1 }
        },
      }),
    },
  })
  const setRestore = (rows: typeof restoreRows) => { restoreRows = rows }
  return { manager, bot, posts, setRestore, fetchFake }
}

const twelve = () => Array.from({ length: 12 }, (_, i) => ({
  channelId: `chan-${i + 1}`, botToken: `token-${i + 1}`, baseUrl: 'https://ilink.example',
  botId: `bot${i + 1}@im.bot`, generation: i + 10, getUpdatesBuf: `cursor-${i + 1}`,
}))

describe('[COMP:app/wechat-connector] twelve bots in one connector (A10)', () => {
  it('restores each bot once with its own cursor and tags forwards with its generation', async () => {
    const h = harness()
    const rows = twelve()
    rows.forEach((r, i) => h.bot(r.botToken).replies.push({ msgs: [{ id: `m${i}`, text: `hi ${i}` }], get_updates_buf: `next-${i + 1}` }))
    h.setRestore(rows)
    await h.manager.restoreAll()
    await vi.waitFor(() => expect(h.posts.filter((p) => p.path.endsWith('/inbound'))).toHaveLength(12))
    for (const [i, r] of rows.entries()) {
      expect(h.bot(r.botToken).cursors[0]).toBe(`cursor-${i + 1}`)
      expect(h.bot(r.botToken).events).toEqual(['start'])
      expect(h.manager.getStatus(r.channelId)?.status).toBe('polling')
      expect(h.posts).toContainEqual({ path: '/internal/wechat/inbound', body: expect.objectContaining({ channelId: r.channelId, generation: r.generation }) })
    }
    await vi.waitFor(() => expect(h.posts.filter((p) => p.path.endsWith('/cursor'))).toHaveLength(12))
    expect(h.posts).toContainEqual({ path: '/internal/wechat/cursor', body: { channelId: 'chan-4', getUpdatesBuf: 'next-4', generation: 13 } })
    await h.manager.disconnectAll()
  })

  it('a stale token, a failing bot and a disconnect each affect only their own loop', async () => {
    const h = harness()
    const rows = twelve()
    h.bot('token-3').replies.push({ errcode: STALE })
    h.bot('token-5').replies.push({ ret: 1 }, { ret: 1 }, { ret: 1 }, { ret: 1 })
    h.setRestore(rows)
    await h.manager.restoreAll()
    await vi.waitFor(() => expect(h.manager.getStatus('chan-3')?.status).toBe('paused'))
    await vi.waitFor(() => expect(h.bot('token-5').calls).toBeGreaterThanOrEqual(5))
    await h.manager.disconnect('chan-7')
    expect(h.manager.getStatus('chan-7')).toBeNull()
    expect(h.bot('token-7').events).toEqual(['start', 'stop'])
    for (const r of rows.filter((x) => !['chan-3', 'chan-7'].includes(x.channelId))) {
      expect(h.manager.getStatus(r.channelId)?.status).toBe('polling')
      expect(h.bot(r.botToken).events).toEqual(['start'])
    }
    await h.manager.disconnectAll()
    for (const r of rows) expect(h.bot(r.botToken).events.at(-1)).toBe('stop')
  })

  it('concurrent reconnects never overlap two pollers for one bot', async () => {
    const h = harness()
    const input = { botToken: 'token-x', baseUrl: 'https://ilink.example', botId: 'x@im.bot', generation: 1 }
    await Promise.all([1, 2, 3, 4].map((g) => h.manager.connect('chan-x', { ...input, generation: g })))
    await vi.waitFor(() => expect(h.bot('token-x').events.filter((e) => e === 'start')).toHaveLength(4))
    const events = h.bot('token-x').events
    expect(events).toEqual(['start', 'stop', 'start', 'stop', 'start', 'stop', 'start'])
    expect(h.bot('token-x').maxActive).toBe(1)
    await h.manager.disconnectAll()
  })

  it('refuses a second channel for a bot another live loop holds', async () => {
    const h = harness()
    await h.manager.connect('chan-a', { botToken: 'token-a', baseUrl: 'https://ilink.example', botId: 'same@im.bot', generation: 1 })
    await expect(h.manager.connect('chan-b', { botToken: 'token-b', baseUrl: 'https://ilink.example', botId: 'same@im.bot', generation: 1 }))
      .rejects.toBeInstanceOf(DuplicateBotError)
    expect(h.manager.getStatus('chan-b')).toBeNull()
    expect(h.bot('token-b').events).toEqual([])
    await h.manager.disconnectAll()
  })

  it('a loop whose cursor generation the API calls stale stops itself', async () => {
    const h = harness({ cursorStatus: (channelId) => (channelId === 'chan-old' ? 409 : 200) })
    h.bot('token-old').replies.push({ get_updates_buf: 'advanced' })
    await h.manager.connect('chan-old', { botToken: 'token-old', baseUrl: 'https://ilink.example', botId: 'old@im.bot', generation: 1 })
    await vi.waitFor(() => expect(h.manager.getStatus('chan-old')?.status).toBe('stopped'))
    expect(h.bot('token-old').events).toEqual(['start', 'stop'])
  })
})
