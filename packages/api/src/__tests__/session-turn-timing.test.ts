import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessionRoutes } from '../routes/sessions.js'
import * as sessions from '../db/sessions.js'
import * as authority from '../session-read-authority.js'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('[COMP:api/session-turn-reconnect] initial turn timing', () => {
  it.each(['running', 'idle'])('returns the stable start only for a %s turn on every reattach', async status => {
    vi.useFakeTimers()
    const start = new Date('2026-01-01T00:00:00Z')
    vi.setSystemTime(start.getTime() + 45_000)
    const session = { id: 'session-fixture', userId: 'viewer', channelType: 'web',
      visibility: 'personal', anchorKind: 'none', status, turnStartedAt: start }
    vi.spyOn(sessions, 'findSessionById').mockResolvedValue(session as sessions.Session)
    const gate = vi.spyOn(authority, 'gateSessionRead').mockResolvedValue(null)
    const router = sessionRoutes()
    const route = router.stack.find(layer => layer.route?.path === '/:id/stream')!.route!
    const handler = route.stack[0].handle
    for (let attempt = 0; attempt < 2; attempt++) {
      const req = Object.assign(new EventEmitter(), { userId: 'viewer', params: { id: session.id } })
      const res = Object.assign(new EventEmitter(), { setHeader: vi.fn(), flushHeaders: vi.fn(),
        write: vi.fn(), end: vi.fn(), writableEnded: false })
      try {
        await handler(req as never, res as never, vi.fn())
        expect(gate).toHaveBeenCalledWith('viewer', session)
        const frame = res.write.mock.calls[0][0] as string
        expect(frame).toBe(`event: status\ndata: ${JSON.stringify({ status, startedAt: status === 'running' ? start.getTime() : null })}\n\n`)
      } finally {
        req.emit('close'); res.emit('close')
      }
      vi.advanceTimersByTime(10_000)
    }
  })

  it('does not expose timing before the session read gate passes', async () => {
    vi.spyOn(sessions, 'findSessionById').mockResolvedValue({ id: 'private-session' } as sessions.Session)
    vi.spyOn(authority, 'gateSessionRead').mockResolvedValue({ status: 403, error: 'Denied' })
    const route = sessionRoutes().stack.find(layer => layer.route?.path === '/:id/stream')!.route!
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), write: vi.fn() }
    await route.stack[0].handle({ userId: 'viewer', params: { id: 'private-session' } } as never, res as never, vi.fn())
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.write).not.toHaveBeenCalled()
  })
})
