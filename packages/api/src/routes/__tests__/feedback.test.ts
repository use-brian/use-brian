import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

// Mock DB modules before importing the route
vi.mock('../../db/users.js', () => ({
  findOrCreateUser: vi.fn(),
  getDefaultAssistant: vi.fn(),
  findUserById: vi.fn(),
}))
vi.mock('../../feedback/record.js', () => ({ recordFeedback: vi.fn() }))

import { feedbackRoutes } from '../feedback.js'
import { findOrCreateUser, findUserById } from '../../db/users.js'
import { recordFeedback } from '../../feedback/record.js'

const mockFindOrCreateUser = vi.mocked(findOrCreateUser)
const mockFindUserById = vi.mocked(findUserById)
const mockRecordFeedback = vi.mocked(recordFeedback)

describe('[COMP:api/feedback-route] Feedback routes', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockRecordFeedback.mockResolvedValue({ analyticsId: 'event_1', memoryId: null })
  })

  const validBody = { messageId: 'msg_1', kind: 'positive' as const }

  it('saves positive feedback for a guest user', async () => {
    const app = createTestApp('/api/feedback', feedbackRoutes())
    mockFindOrCreateUser.mockResolvedValueOnce({ user: { id: 'u_guest' }, isNew: false } as never)

    const res = await request(app).post('/api/feedback').send(validBody)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(mockRecordFeedback).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u_guest', messageId: 'msg_1', kind: 'positive', source: 'web',
    }))
  })

  it('saves negative feedback for an authenticated user', async () => {
    const app = createTestApp('/api/feedback', feedbackRoutes(), { userId: 'u_1' })
    mockFindUserById.mockResolvedValueOnce({ id: 'u_1' } as never)

    const res = await request(app)
      .post('/api/feedback')
      .send({ messageId: 'msg_1', kind: 'negative' })
    expect(res.status).toBe(200)
    expect(mockRecordFeedback).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u_1', messageId: 'msg_1', kind: 'negative', source: 'web',
    }))
  })

  it('passes substantive correction details to the canonical recorder', async () => {
    const app = createTestApp('/api/feedback', feedbackRoutes(), { userId: 'u_1' })
    mockFindUserById.mockResolvedValueOnce({ id: 'u_1' } as never)

    const res = await request(app)
      .post('/api/feedback')
      .send({
        messageId: 'msg_1',
        kind: 'negative',
        issueType: 'incorrect',
        details: 'The date was wrong by one day',
      })
    expect(res.status).toBe(200)
    expect(mockRecordFeedback).toHaveBeenCalledWith(expect.objectContaining({
      issueType: 'incorrect', details: 'The date was wrong by one day',
    }))
  })

  it('passes short details to the canonical recorder without route-side interpretation', async () => {
    const app = createTestApp('/api/feedback', feedbackRoutes(), { userId: 'u_1' })
    mockFindUserById.mockResolvedValueOnce({ id: 'u_1' } as never)

    const res = await request(app)
      .post('/api/feedback')
      .send({ messageId: 'msg_1', kind: 'negative', details: 'short' })
    expect(res.status).toBe(200)
    expect(mockRecordFeedback).toHaveBeenCalledWith(expect.objectContaining({ details: 'short' }))
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

  it('returns 500 when the canonical recorder rejects the feedback operation', async () => {
    const app = createTestApp('/api/feedback', feedbackRoutes(), { userId: 'u_1' })
    mockFindUserById.mockResolvedValueOnce({ id: 'u_1' } as never)
    mockRecordFeedback.mockRejectedValueOnce(new Error('DB error'))

    const res = await request(app)
      .post('/api/feedback')
      .send({
        messageId: 'msg_1',
        kind: 'negative',
        issueType: 'incorrect',
        details: 'The date was wrong by one day',
      })
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'Failed to save feedback' })
  })
})
