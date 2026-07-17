/**
 * Unit tests for the client analytics funnel bridge (POST /api/analytics/events).
 * Component tag: [COMP:api/analytics-client].
 *
 * Verifies auth gating, batch validation, the event-name allowlist, and
 * server-forced userId + metadata sanitization.
 */
import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { analyticsRoutes } from '../analytics.js'
import type { AnalyticsStore } from '@use-brian/core'

function makeApp(userId?: string) {
  const record = vi.fn().mockResolvedValue(undefined)
  const store = { record } as unknown as AnalyticsStore
  const app = express()
  app.use(express.json())
  if (userId) {
    app.use((req, _res, next) => {
      ;(req as { userId?: string }).userId = userId
      next()
    })
  }
  app.use('/api/analytics', analyticsRoutes(store))
  return { app, record }
}

describe('[COMP:api/analytics-client] POST /api/analytics/events', () => {
  it('401 without auth', async () => {
    const { app, record } = makeApp()
    const res = await request(app).post('/api/analytics/events').send({ events: [{ eventName: 'home_viewed' }] })
    expect(res.status).toBe(401)
    expect(record).not.toHaveBeenCalled()
  })

  it('400 on empty/invalid body', async () => {
    const { app, record } = makeApp('u1')
    const res = await request(app).post('/api/analytics/events').send({ events: [] })
    expect(res.status).toBe(400)
    expect(record).not.toHaveBeenCalled()
  })

  it('records allowlisted events, drops unknown names, sanitizes metadata, forces userId', async () => {
    const { app, record } = makeApp('u1')
    const res = await request(app)
      .post('/api/analytics/events')
      .send({
        events: [
          { eventName: 'home_viewed', metadata: { count: 2, ok: true, label: 'hi' }, userId: 'spoofed' },
          { eventName: 'evil_event', metadata: {} },
          { eventName: 'onboarding_nudge_tapped', sessionId: 's1', metadata: {} },
        ],
      })
    expect(res.status).toBe(200)
    expect(res.body.accepted).toBe(2)
    expect(record).toHaveBeenCalledTimes(2)
    const first = record.mock.calls[0][0]
    expect(first.userId).toBe('u1') // server-forced, not the spoofed value
    expect(first.eventName).toBe('home_viewed')
    expect(first.metadata.count).toBe(2)
    expect(first.metadata.ok).toBe(true)
    expect(typeof first.metadata.label).toBe('string')
    expect(first.channelType).toBe('web')
  })
})
