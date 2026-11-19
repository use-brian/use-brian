/**
 * [COMP:api/chat-route] The direct chat stream's keepalive starts at the SSE
 * header flush, before preparation resolves, and stops on every exit (M5Q-17
 * follow-up: a slow preparation is silent, and a proxy idle cut such as
 * Cloudflare's 100 s would drop a healthy turn). Comment frames only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let releaseUser: ((user: null) => void) | undefined
vi.mock('../route-helpers.js', async (original) => ({
  ...(await original<typeof import('../route-helpers.js')>()),
  // Preparation's first await; held open so the test observes the stream while it prepares.
  resolveUser: vi.fn(() => new Promise(resolve => { releaseUser = resolve })),
}))

const { chatRoutes, startSseKeepalive, SSE_KEEPALIVE_INTERVAL_MS } = await import('../chat.js')

function fakeResponse() {
  const listeners = new Map<string, Array<() => void>>()
  const res = {
    writes: [] as string[], writableEnded: false, destroyed: false, statusCode: 200,
    setHeader: vi.fn(), flushHeaders: vi.fn(), status: vi.fn(() => res), json: vi.fn(),
    write(chunk: string) { res.writes.push(chunk); return true },
    end() { res.writableEnded = true },
    on(event: string, listener: () => void) { listeners.set(event, [...listeners.get(event) ?? [], listener]); return res },
    once(event: string, listener: () => void) { return res.on(event, listener) },
    emit(event: string) { for (const listener of listeners.get(event) ?? []) listener() },
  }
  return res
}
const keepalives = (res: { writes: string[] }) => res.writes.filter(chunk => chunk === ': keepalive\n\n').length

describe('[COMP:api/chat-route] SSE keepalive from the header flush', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); releaseUser = undefined })

  it('schedules the first keepalive before preparation resolves and stops when the route exits', async () => {
    const handle = chatRoutes({} as never).stack.find(layer => layer.route?.path === '/')!.route!.stack[0].handle
    const res = fakeResponse()
    const pending = Promise.resolve(handle({ body: { message: 'A fictional slow preparation.' }, userId: 'fictional-user',
      headers: {}, get: () => undefined } as never, res as never, () => {}))
    await vi.advanceTimersByTimeAsync(0)
    expect(res.flushHeaders).toHaveBeenCalledOnce()
    expect(releaseUser).toBeTypeOf('function')
    // Preparation has not resolved; the idle stream still receives comment frames.
    await vi.advanceTimersByTimeAsync(SSE_KEEPALIVE_INTERVAL_MS * 2)
    expect(keepalives(res)).toBe(2)
    expect(res.writes.every(chunk => chunk.startsWith(':'))).toBe(true)
    // The pre-admission refusal ends the response; the route's `finally` stops the timer.
    releaseUser!(null)
    await pending
    expect(res.writableEnded).toBe(true)
    await vi.advanceTimersByTimeAsync(SSE_KEEPALIVE_INTERVAL_MS * 3)
    expect(keepalives(res)).toBe(2)
  })

  it('stops on its own call, on client close, and once the response ended', async () => {
    for (const exit of ['stop', 'close', 'ended', 'gone'] as const) {
      const res = fakeResponse()
      let gone = false
      const stop = startSseKeepalive(res, () => gone)
      await vi.advanceTimersByTimeAsync(SSE_KEEPALIVE_INTERVAL_MS)
      expect(keepalives(res)).toBe(1)
      if (exit === 'stop') stop()
      if (exit === 'close') res.emit('close')
      if (exit === 'ended') res.end()
      if (exit === 'gone') gone = true
      await vi.advanceTimersByTimeAsync(SSE_KEEPALIVE_INTERVAL_MS * 3)
      expect(keepalives(res), exit).toBe(1)
      expect(vi.getTimerCount(), exit).toBe(0)
    }
  })
})
