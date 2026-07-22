import { describe, it, expect, vi } from 'vitest'
import { RelayClient, BACKOFF_STEPS_MS, type WebSocketLike } from '../relay-client.js'

type FakeWs = WebSocketLike & { sentFrames: string[]; opened: boolean }

function fakeWsFactory(): { sockets: FakeWs[]; connect: (url: string) => WebSocketLike } {
  const sockets: FakeWs[] = []
  return {
    sockets,
    connect: () => {
      const ws: FakeWs = {
        readyState: 0,
        sentFrames: [],
        opened: false,
        send(data: string) {
          ws.sentFrames.push(data)
        },
        close() {
          ws.readyState = 3
          ws.onclose?.()
        },
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      }
      sockets.push(ws)
      return ws
    },
  }
}

type Scheduled = { fn: () => void; ms: number; dueAt?: number; cleared?: boolean; fired?: boolean }

function timers(): {
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (h: unknown) => void
  fire: (ms: number) => void
  /** Move the clock forward, firing everything that comes due (re-arming chains included). */
  advance: (ms: number) => void
  scheduled: Array<{ fn: () => void; ms: number }>
} {
  const scheduled: Scheduled[] = []
  let nowMs = 0
  return {
    scheduled,
    advance: (delta) => {
      const target = nowMs + delta
      // Self-rearming chains (schedulePing) enqueue while we drain, so keep
      // taking the earliest due entry rather than snapshotting the list.
      for (;;) {
        const due = scheduled
          .filter((e) => !e.cleared && !e.fired && (e.dueAt ?? 0) <= target)
          .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0))[0]
        if (!due) break
        nowMs = due.dueAt ?? nowMs
        due.fired = true
        due.fn()
      }
      nowMs = target
    },
    setTimer: (fn, ms) => {
      const entry: Scheduled = { fn, ms, dueAt: nowMs + ms }
      scheduled.push(entry)
      return entry
    },
    clearTimer: (h) => {
      const entry = scheduled.find((e) => e === h)
      if (entry) (entry as { cleared?: boolean }).cleared = true
    },
    fire: (ms) => {
      const due = scheduled.filter((e) => e.ms === ms && !(e as { cleared?: boolean; fired?: boolean }).cleared && !(e as { fired?: boolean }).fired)
      for (const e of due) {
        ;(e as { fired?: boolean }).fired = true
        e.fn()
      }
    },
  }
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

describe('[COMP:ext/agent] Relay client (P1.2 connection lifecycle)', () => {
  it('sends hello on open, stores the ready session token, and reaches ready', async () => {
    const { sockets, connect } = fakeWsFactory()
    const stored: string[] = []
    const client = new RelayClient({
      getUrl: async () => 'wss://relay.test/ext',
      connect,
      getToken: async () => 'pair-token',
      onSessionToken: async (t) => void stored.push(t),
      onCommand: () => {},
    })
    client.start()
    await flush()

    const ws = sockets[0]
    ws.readyState = 1
    ws.onopen?.()
    expect(JSON.parse(ws.sentFrames[0])).toEqual({ type: 'hello', pairingToken: 'pair-token' })

    ws.onmessage?.({ data: JSON.stringify({ type: 'ready', sessionToken: 'sess-1' }) })
    await flush()
    expect(client.getState()).toBe('ready')
    expect(stored).toEqual(['sess-1'])
  })

  it('dispatches command frames to onCommand and answers via sendResult', async () => {
    const { sockets, connect } = fakeWsFactory()
    const commands: Array<{ id: string; op: string }> = []
    const client = new RelayClient({
      getUrl: async () => 'wss://relay.test/ext',
      connect,
      getToken: async () => 'tok',
      onSessionToken: async () => {},
      onCommand: (c) => void commands.push({ id: c.id, op: c.op }),
    })
    client.start()
    await flush()
    const ws = sockets[0]
    ws.readyState = 1
    ws.onopen?.()
    ws.onmessage?.({ data: JSON.stringify({ type: 'ready' }) })
    ws.onmessage?.({ data: JSON.stringify({ type: 'command', id: 'c1', op: 'snapshot', args: {} }) })
    expect(commands).toEqual([{ id: 'c1', op: 'snapshot' }])

    client.sendResult({ id: 'c1', ok: true, data: { nodes: [] } })
    expect(JSON.parse(ws.sentFrames.at(-1) as string)).toMatchObject({ type: 'result', id: 'c1', ok: true })
  })

  it('reconnects with backoff and re-hellos after a drop (P1.2)', async () => {
    const { sockets, connect } = fakeWsFactory()
    const t = timers()
    const client = new RelayClient({
      getUrl: async () => 'wss://relay.test/ext',
      connect,
      getToken: async () => 'tok',
      onSessionToken: async () => {},
      onCommand: () => {},
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })
    client.start()
    await flush()
    const first = sockets[0]
    first.readyState = 1
    first.onopen?.()
    first.onmessage?.({ data: JSON.stringify({ type: 'ready' }) })
    expect(client.getState()).toBe('ready')

    first.close() // relay died
    expect(client.getState()).toBe('disconnected')
    t.fire(BACKOFF_STEPS_MS[0])
    await flush()
    expect(sockets).toHaveLength(2)
    const second = sockets[1]
    second.readyState = 1
    second.onopen?.()
    expect(JSON.parse(second.sentFrames[0])).toEqual({ type: 'hello', pairingToken: 'tok' })
  })

  it('pings inside Chrome\'s MV3 service-worker idle window, so the pairing survives an idle stretch', async () => {
    const { sockets, connect } = fakeWsFactory()
    const t = timers()
    const client = new RelayClient({
      getUrl: async () => 'wss://relay.test/ext',
      connect,
      getToken: async () => 'tok',
      onSessionToken: async () => {},
      onCommand: () => {},
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })
    client.start()
    await flush()
    const ws = sockets[0]
    ws.readyState = 1
    ws.onopen?.()
    ws.onmessage?.({ data: JSON.stringify({ type: 'ready' }) })
    const beforeIdle = ws.sentFrames.length

    // 29s, i.e. JUST under Chrome's 30s MV3 idle kill. The deadline is
    // Chrome's, not ours — a ping at exactly 30_000 races the teardown, and a
    // dead service worker drops the socket. The relay keys connections by
    // userId in process memory, so a silent drop surfaces to the assistant as
    // `no_extension` long after the user thinks they are paired.
    t.advance(29_000)

    const pings = ws.sentFrames
      .slice(beforeIdle)
      .filter((f) => JSON.parse(f).type === 'ping')
    expect(pings.length).toBeGreaterThan(0)
  })

  it('goes unpaired (no auto-retry) when the relay rejects the hello', async () => {
    const { sockets, connect } = fakeWsFactory()
    const client = new RelayClient({
      getUrl: async () => 'wss://relay.test/ext',
      connect,
      getToken: async () => 'expired',
      onSessionToken: async () => {},
      onCommand: () => {},
      setTimer: () => ({}),
      clearTimer: () => {},
    })
    client.start()
    await flush()
    const ws = sockets[0]
    ws.readyState = 1
    ws.onopen?.()
    ws.onmessage?.({ data: JSON.stringify({ type: 'error', message: 'unauthorized' }) })
    ws.close()
    expect(client.getState()).toBe('unpaired')
    expect(sockets).toHaveLength(1) // no reconnect attempt
  })

  it('stays unpaired without a stored token or URL', async () => {
    const { connect, sockets } = fakeWsFactory()
    const client = new RelayClient({
      getUrl: async () => null,
      connect,
      getToken: async () => 'tok',
      onSessionToken: async () => {},
      onCommand: () => {},
    })
    client.start()
    await flush()
    expect(client.getState()).toBe('unpaired')
    expect(sockets).toHaveLength(0)
  })
})
