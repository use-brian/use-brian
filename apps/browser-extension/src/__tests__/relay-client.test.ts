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
        close(code?: number) {
          ws.readyState = 3
          ws.onclose?.(code == null ? undefined : { code })
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
  /** The same clock the timers run on, so connection lifetimes are drivable. */
  now: () => number
  scheduled: Scheduled[]
} {
  const scheduled: Scheduled[] = []
  let nowMs = 0
  return {
    scheduled,
    now: () => nowMs,
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

  it('does NOT reconnect after the relay replaces this connection (kills the eviction storm)', async () => {
    // The relay keeps ONE connection per user and closes the previous socket
    // with 4000 "replaced". Reconnecting into that is a mutual-eviction loop:
    // A connects, evicts B, B reconnects, evicts A, forever. `attempts` resets
    // to 0 on every `ready`, so the backoff never escalates and both clients
    // hammer at the first step. Prod on 2026-07-22 logged 110 upgrades in nine
    // minutes at a mean hold of 5.0s, while the assistant saw `no_extension`.
    //
    // "Replaced" is not an error — another client legitimately owns the
    // pairing now. Racing back in is exactly wrong.
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
    expect(client.getState()).toBe('ready')

    ws.close(4000) // the relay handed this user's slot to another client
    await flush()

    // Drive well past every backoff step: nothing may dial again.
    t.advance(120_000)
    await flush()
    expect(sockets).toHaveLength(1)
    expect(client.getState()).toBe('replaced')
  })

  it('escalates backoff when connections keep dying young, so a flap cannot become a flood', async () => {
    // `attempts` reset on every `ready`, so a connection that reached ready and
    // died seconds later always retried at the FIRST backoff step. In the
    // eviction storm every connection did reach ready — for about five seconds
    // — which is exactly why the schedule never advanced and prod logged 110
    // upgrades in nine minutes. Treating the replaced close as terminal fixes
    // that trigger; this fixes the general shape, so the next close reason that
    // recurs immediately cannot flood the relay the same way.
    //
    // A backoff that resets on success is right everywhere EXCEPT when the
    // success itself is what keeps recurring. Only a connection that stayed up
    // is evidence the trouble passed.
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
      now: t.now,
    })
    client.start()
    await flush()

    const delays: number[] = []
    for (let i = 0; i < 4; i++) {
      const ws = sockets.at(-1) as FakeWs
      ws.readyState = 1
      ws.onopen?.()
      ws.onmessage?.({ data: JSON.stringify({ type: 'ready' }) })
      t.advance(3_000) // up for three seconds, then dropped — a flap
      ws.close()
      const pending = t.scheduled.filter(
        (e) => (BACKOFF_STEPS_MS as readonly number[]).includes(e.ms) && !e.fired && !e.cleared,
      )
      delays.push(pending.at(-1)?.ms as number)
      t.advance(pending.at(-1)?.ms as number)
      await flush()
    }

    // Strictly increasing until the schedule tops out — never a flat 1s wall.
    expect(delays).toEqual([...BACKOFF_STEPS_MS].slice(0, 4))
  })

  it('resets backoff once a connection proves stable', async () => {
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
      now: t.now,
    })
    client.start()
    await flush()

    const first = sockets[0]
    first.readyState = 1
    first.onopen?.()
    first.onmessage?.({ data: JSON.stringify({ type: 'ready' }) })
    t.advance(2_000)
    first.close() // flap → escalates off step 0
    t.advance(BACKOFF_STEPS_MS[0])
    await flush()

    const second = sockets[1]
    second.readyState = 1
    second.onopen?.()
    second.onmessage?.({ data: JSON.stringify({ type: 'ready' }) })
    t.advance(10 * 60_000) // a long, healthy session
    second.close()

    const pending = t.scheduled.filter(
      (e) => (BACKOFF_STEPS_MS as readonly number[]).includes(e.ms) && !e.fired && !e.cleared,
    )
    // Back to the fastest step: the earlier trouble is not held against it.
    expect(pending.at(-1)?.ms).toBe(BACKOFF_STEPS_MS[0])
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
