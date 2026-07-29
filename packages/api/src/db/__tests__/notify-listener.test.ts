/**
 * Unit tests for the shared LISTEN/NOTIFY connection.
 * Component tag: [COMP:platform/notify-listener].
 *
 * The point of this module is a connection-budget invariant: however many
 * channels the process subscribes to, it must hold exactly ONE dedicated
 * `pg.Client` outside the pools. These tests mock `pg` so the client count,
 * the LISTEN statements, and the reconnect re-subscribe are all directly
 * observable without a live Postgres.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type FakeClient = {
  connect: ReturnType<typeof vi.fn>
  query: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  on: (event: string, cb: (...args: unknown[]) => void) => void
  removeAllListeners: ReturnType<typeof vi.fn>
  /** Statements this client ran, in order. */
  statements: string[]
  /** Fire a handler the module registered on the client. */
  fire: (event: string, ...args: unknown[]) => void
}

/** Every client the module has constructed, in order. */
const clients: FakeClient[] = []
/** Make the next `connect()` reject, simulating a refused connection. */
let failNextConnect = false

function buildFakeClient(): FakeClient {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const statements: string[] = []
  const client: FakeClient = {
    connect: vi.fn(async () => {
      if (failNextConnect) {
        failNextConnect = false
        throw new Error('remaining connection slots are reserved')
      }
    }),
    query: vi.fn(async (text: string) => {
      statements.push(text)
      return { rows: [], rowCount: 0 }
    }),
    end: vi.fn(async () => {}),
    on: (event, cb) => {
      const list = handlers.get(event) ?? []
      list.push(cb)
      handlers.set(event, list)
    },
    removeAllListeners: vi.fn(() => handlers.clear()),
    statements,
    fire: (event, ...args) => {
      for (const cb of handlers.get(event) ?? []) cb(...args)
    },
  }
  return client
}

vi.mock('pg', () => ({
  default: {
    Client: class {
      constructor() {
        const fake = buildFakeClient()
        clients.push(fake)
        return fake as unknown as object
      }
    },
  },
}))

import {
  _getNotifyChannels,
  _shutdownNotifyListener,
  registerNotifyChannel,
  startNotifyListener,
  unregisterNotifyChannel,
} from '../notify-listener.js'

/** All LISTEN statements issued across every client built so far. */
function listens(): string[] {
  return clients.flatMap((c) => c.statements).filter((s) => s.startsWith('LISTEN'))
}

beforeEach(() => {
  clients.length = 0
  failNextConnect = false
})

afterEach(async () => {
  await _shutdownNotifyListener()
  vi.useRealTimers()
})

describe('[COMP:platform/notify-listener] shared LISTEN connection', () => {
  it('holds ONE client no matter how many channels register', async () => {
    registerNotifyChannel('brain_events', () => {})
    registerNotifyChannel('feed_events', () => {})
    registerNotifyChannel('session_event', () => {})
    startNotifyListener()
    await vi.waitFor(() => expect(listens()).toHaveLength(3))

    expect(clients).toHaveLength(1)
    expect(listens().sort()).toEqual([
      'LISTEN brain_events',
      'LISTEN feed_events',
      'LISTEN session_event',
    ])
  })

  it('subscribes a channel registered after the connection is already live, on the same client', async () => {
    registerNotifyChannel('brain_events', () => {})
    startNotifyListener()
    await vi.waitFor(() => expect(listens()).toHaveLength(1))

    registerNotifyChannel('feed_events', () => {})
    await vi.waitFor(() => expect(listens()).toHaveLength(2))

    expect(clients).toHaveLength(1)
    expect(listens()).toContain('LISTEN feed_events')
  })

  it('startNotifyListener is idempotent', async () => {
    registerNotifyChannel('brain_events', () => {})
    startNotifyListener()
    startNotifyListener()
    await vi.waitFor(() => expect(listens()).toHaveLength(1))
    startNotifyListener()

    expect(clients).toHaveLength(1)
  })

  it('routes a notification only to the handler for its channel', async () => {
    const brain: string[] = []
    const feed: string[] = []
    registerNotifyChannel('brain_events', (p) => brain.push(p))
    registerNotifyChannel('feed_events', (p) => feed.push(p))
    startNotifyListener()
    await vi.waitFor(() => expect(listens()).toHaveLength(2))

    clients[0]!.fire('notification', { channel: 'feed_events', payload: '{"a":1}' })

    expect(feed).toEqual(['{"a":1}'])
    expect(brain).toEqual([])
  })

  it('ignores notifications for unregistered channels and empty payloads', async () => {
    const brain: string[] = []
    registerNotifyChannel('brain_events', (p) => brain.push(p))
    startNotifyListener()
    await vi.waitFor(() => expect(listens()).toHaveLength(1))

    clients[0]!.fire('notification', { channel: 'nobody_listening', payload: 'x' })
    clients[0]!.fire('notification', { channel: 'brain_events', payload: undefined })

    expect(brain).toEqual([])
  })

  it('a throwing handler does not stop the other channels', async () => {
    const feed: string[] = []
    registerNotifyChannel('brain_events', () => {
      throw new Error('subscriber exploded')
    })
    registerNotifyChannel('feed_events', (p) => feed.push(p))
    startNotifyListener()
    await vi.waitFor(() => expect(listens()).toHaveLength(2))

    expect(() =>
      clients[0]!.fire('notification', { channel: 'brain_events', payload: 'boom' }),
    ).not.toThrow()
    clients[0]!.fire('notification', { channel: 'feed_events', payload: 'ok' })

    expect(feed).toEqual(['ok'])
  })

  it('re-issues LISTEN for every channel after a reconnect', async () => {
    vi.useFakeTimers()
    registerNotifyChannel('brain_events', () => {})
    registerNotifyChannel('feed_events', () => {})
    startNotifyListener()
    await vi.waitFor(() => expect(listens()).toHaveLength(2))

    clients[0]!.fire('error', new Error('connection terminated'))
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(clients).toHaveLength(2))

    expect(clients[1]!.statements.filter((s) => s.startsWith('LISTEN')).sort()).toEqual([
      'LISTEN brain_events',
      'LISTEN feed_events',
    ])
  })

  it('retries with backoff when the connection is refused', async () => {
    vi.useFakeTimers()
    failNextConnect = true
    registerNotifyChannel('brain_events', () => {})
    startNotifyListener()
    await vi.waitFor(() => expect(clients).toHaveLength(1))
    expect(listens()).toEqual([])

    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(clients).toHaveLength(2))
    await vi.waitFor(() => expect(listens()).toEqual(['LISTEN brain_events']))
  })

  it('deregistering one channel leaves the others listening on the same client', async () => {
    const brain: string[] = []
    const feed: string[] = []
    registerNotifyChannel('brain_events', (p) => brain.push(p))
    registerNotifyChannel('feed_events', (p) => feed.push(p))
    startNotifyListener()
    await vi.waitFor(() => expect(listens()).toHaveLength(2))

    await unregisterNotifyChannel('brain_events')

    // One module tearing itself down must not silence the others.
    expect(_getNotifyChannels()).toEqual(['feed_events'])
    expect(clients[0]!.end).not.toHaveBeenCalled()
    clients[0]!.fire('notification', { channel: 'feed_events', payload: 'still here' })
    clients[0]!.fire('notification', { channel: 'brain_events', payload: 'gone' })
    expect(feed).toEqual(['still here'])
    expect(brain).toEqual([])
  })

  it('closes the shared connection when the LAST channel deregisters', async () => {
    registerNotifyChannel('brain_events', () => {})
    registerNotifyChannel('feed_events', () => {})
    startNotifyListener()
    await vi.waitFor(() => expect(listens()).toHaveLength(2))

    await unregisterNotifyChannel('brain_events')
    await unregisterNotifyChannel('feed_events')

    expect(_getNotifyChannels()).toEqual([])
    expect(clients[0]!.end).toHaveBeenCalled()
  })

  it('rejects a channel name that is not a bare identifier', () => {
    // The channel is interpolated into `LISTEN <channel>` — it cannot be a
    // bind parameter, so the identifier shape is the only guard.
    expect(() => registerNotifyChannel('brain_events; DROP TABLE users', () => {})).toThrow(
      /identifier/i,
    )
    expect(() => registerNotifyChannel('Brain-Events', () => {})).toThrow(/identifier/i)
    expect(_getNotifyChannels()).toEqual([])
  })
})
