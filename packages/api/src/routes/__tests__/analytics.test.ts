import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'
import { analyticsRoutes } from '../analytics.js'

describe('[COMP:api/analytics-route] Analytics routes', () => {
  const store = {
    getDailyReport: vi.fn(),
    getWeeklyReport: vi.fn(),
    listErrors: vi.fn(),
    summarizeErrors: vi.fn(),
    pruneOldEvents: vi.fn(),
    record: vi.fn(),
    recordBatch: vi.fn(),
  }

  const app = createTestApp('/api/analytics', analyticsRoutes(store as never))

  beforeEach(() => {
    vi.resetAllMocks()
  })

  // ── GET /daily ──────────────────────────────────────────────

  it('returns a daily report for a valid date', async () => {
    const report = { users: 5, sessions: 10 }
    store.getDailyReport.mockResolvedValueOnce(report)

    const res = await request(app).get('/api/analytics/daily?date=2026-04-08')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(report)
    expect(store.getDailyReport).toHaveBeenCalledWith('2026-04-08')
  })

  it('returns a daily report with no date (defaults in store)', async () => {
    store.getDailyReport.mockResolvedValueOnce({})
    const res = await request(app).get('/api/analytics/daily')
    expect(res.status).toBe(200)
    expect(store.getDailyReport).toHaveBeenCalledWith(undefined)
  })

  it('rejects invalid date format for daily', async () => {
    const res = await request(app).get('/api/analytics/daily?date=April-8')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Invalid date/)
  })

  // ── GET /weekly ─────────────────────────────────────────────

  it('returns a weekly report', async () => {
    const report = { users: 20 }
    store.getWeeklyReport.mockResolvedValueOnce(report)

    const res = await request(app).get('/api/analytics/weekly?date=2026-04-08')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(report)
  })

  it('rejects invalid date format for weekly', async () => {
    const res = await request(app).get('/api/analytics/weekly?date=bad')
    expect(res.status).toBe(400)
  })

  // ── GET /errors ─────────────────────────────────────────────

  it('lists errors with defaults', async () => {
    store.listErrors.mockResolvedValueOnce([{ id: 'e1' }])
    const res = await request(app).get('/api/analytics/errors')
    expect(res.status).toBe(200)
    expect(res.body.errors).toHaveLength(1)
    expect(res.body.sinceHours).toBe(24)
    expect(store.listErrors).toHaveBeenCalledWith({ sinceHours: 24, limit: 100 })
  })

  it('lists errors with custom sinceHours', async () => {
    store.listErrors.mockResolvedValueOnce([])
    const res = await request(app).get('/api/analytics/errors?sinceHours=48&limit=50')
    expect(res.status).toBe(200)
    expect(store.listErrors).toHaveBeenCalledWith({ sinceHours: 48, limit: 50 })
  })

  it('rejects sinceHours out of range', async () => {
    const res = await request(app).get('/api/analytics/errors?sinceHours=1000')
    expect(res.status).toBe(400)
  })

  it('rejects sinceHours < 1', async () => {
    const res = await request(app).get('/api/analytics/errors?sinceHours=0')
    expect(res.status).toBe(400)
  })

  // ── GET /errors/summary ─────────────────────────────────────

  it('returns error summary', async () => {
    store.summarizeErrors.mockResolvedValueOnce([
      { eventName: 'query_error', errorType: 'timeout', count: 3 },
    ])
    const res = await request(app).get('/api/analytics/errors/summary')
    expect(res.status).toBe(200)
    expect(res.body.totalErrors).toBe(3)
    expect(res.body.summary).toHaveLength(1)
  })

  it('rejects invalid sinceHours for summary', async () => {
    const res = await request(app).get('/api/analytics/errors/summary?sinceHours=800')
    expect(res.status).toBe(400)
  })

  // ── POST /prune ─────────────────────────────────────────────

  it('prunes old events with default 30 days', async () => {
    store.pruneOldEvents.mockResolvedValueOnce(42)
    const res = await request(app).post('/api/analytics/prune')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ deleted: 42, retentionDays: 30 })
  })

  it('prunes with custom days param', async () => {
    store.pruneOldEvents.mockResolvedValueOnce(10)
    const res = await request(app).post('/api/analytics/prune?days=7')
    expect(res.status).toBe(200)
    expect(store.pruneOldEvents).toHaveBeenCalledWith(7)
  })

  it('rejects invalid days for prune', async () => {
    const res = await request(app).post('/api/analytics/prune?days=0')
    expect(res.status).toBe(400)
  })
})
