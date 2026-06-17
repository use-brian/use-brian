import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

// Mock DB modules before importing the route
vi.mock('../../db/users.js', () => ({
  findOrCreateUser: vi.fn(),
  getDefaultAssistant: vi.fn(),
  findUserById: vi.fn(),
}))
vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))
vi.mock('../../db/memories.js', () => ({
  createMemory: vi.fn(),
}))

import { feedbackRoutes } from '../feedback.js'
import { findOrCreateUser, getDefaultAssistant, findUserById } from '../../db/users.js'
import { query } from '../../db/client.js'
import { createMemory } from '../../db/memories.js'

const mockFindOrCreateUser = vi.mocked(findOrCreateUser)
const mockGetDefaultAssistant = vi.mocked(getDefaultAssistant)
const mockFindUserById = vi.mocked(findUserById)
const mockQuery = vi.mocked(query)
const mockCreateMemory = vi.mocked(createMemory)

describe('[COMP:api/feedback-route] Feedback routes', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never)
  })

  const validBody = { messageId: 'msg_1', kind: 'positive' as const }

  it('saves positive feedback for a guest user', async () => {
    const app = createTestApp('/api/feedback', feedbackRoutes())
    mockFindOrCreateUser.mockResolvedValueOnce({ user: { id: 'u_guest' }, isNew: false } as never)

    const res = await request(app).post('/api/feedback').send(validBody)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    // Analytics event should be feedback_positive
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain('analytics_events')
    const params = mockQuery.mock.calls[0][1]!
    expect(params[2]).toBe('feedback_positive')
  })

  it('saves negative feedback for an authenticated user', async () => {
    const app = createTestApp('/api/feedback', feedbackRoutes(), { userId: 'u_1' })
    mockFindUserById.mockResolvedValueOnce({ id: 'u_1' } as never)

    const res = await request(app)
      .post('/api/feedback')
      .send({ messageId: 'msg_1', kind: 'negative' })
    expect(res.status).toBe(200)
    const params = mockQuery.mock.calls[0][1]!
    expect(params[2]).toBe('feedback_negative')
  })

  it('creates a memory from negative feedback with details >= 10 chars', async () => {
    const app = createTestApp('/api/feedback', feedbackRoutes(), { userId: 'u_1' })
    mockFindUserById.mockResolvedValueOnce({ id: 'u_1' } as never)
    mockGetDefaultAssistant.mockResolvedValueOnce({ id: 'a_1' } as never)
    mockCreateMemory.mockResolvedValueOnce({ id: 'm_1' } as never)

    const res = await request(app)
      .post('/api/feedback')
      .send({
        messageId: 'msg_1',
        kind: 'negative',
        issueType: 'incorrect',
        details: 'The date was wrong by one day',
      })
    expect(res.status).toBe(200)
    expect(mockCreateMemory).toHaveBeenCalledOnce()
    const memArgs = mockCreateMemory.mock.calls[0][0]
    // Post-Phase-4 (retire-memory-type): no `type` assertion.
    expect(memArgs.scope).toBe('shared')
    expect(memArgs.confidence).toBe(0.85)
    expect(memArgs.source).toBe('feedback')
    expect(memArgs.tags).toContain('feedback')
    expect(memArgs.tags).toContain('correction')
    expect(memArgs.tags).toContain('incorrect')
  })

  it('does NOT create a memory when details < 10 chars', async () => {
    const app = createTestApp('/api/feedback', feedbackRoutes(), { userId: 'u_1' })
    mockFindUserById.mockResolvedValueOnce({ id: 'u_1' } as never)

    const res = await request(app)
      .post('/api/feedback')
      .send({ messageId: 'msg_1', kind: 'negative', details: 'short' })
    expect(res.status).toBe(200)
    expect(mockCreateMemory).not.toHaveBeenCalled()
  })

  it('rejects missing messageId', async () => {
    const app = createTestApp('/api/feedback', feedbackRoutes())
    const res = await request(app).post('/api/feedback').send({ kind: 'positive' })
    expect(res.status).toBe(400)
  })

  it('rejects missing kind', async () => {
    const app = createTestApp('/api/feedback', feedbackRoutes())
    const res = await request(app).post('/api/feedback').send({ messageId: 'msg_1' })
    expect(res.status).toBe(400)
  })

  it('rejects invalid kind', async () => {
    const app = createTestApp('/api/feedback', feedbackRoutes())
    const res = await request(app)
      .post('/api/feedback')
      .send({ messageId: 'msg_1', kind: 'neutral' })
    expect(res.status).toBe(400)
  })

  it('returns 401 when authenticated user not found', async () => {
    const app = createTestApp('/api/feedback', feedbackRoutes(), { userId: 'u_gone' })
    mockFindUserById.mockResolvedValueOnce(null as never)

    const res = await request(app).post('/api/feedback').send(validBody)
    expect(res.status).toBe(401)
  })

  it('memory creation failure does not fail the request', async () => {
    const app = createTestApp('/api/feedback', feedbackRoutes(), { userId: 'u_1' })
    mockFindUserById.mockResolvedValueOnce({ id: 'u_1' } as never)
    mockGetDefaultAssistant.mockResolvedValueOnce({ id: 'a_1' } as never)
    mockCreateMemory.mockRejectedValueOnce(new Error('DB error'))

    const res = await request(app)
      .post('/api/feedback')
      .send({
        messageId: 'msg_1',
        kind: 'negative',
        issueType: 'incorrect',
        details: 'The date was wrong by one day',
      })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })
})
