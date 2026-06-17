/**
 * Unit tests for the pending-message routes.
 * Component tag: [COMP:api/pending-messages-route].
 *
 * Mocks `query` and the inter-assistant `deliverToChannel`. Verifies
 * GET / (auth gate, list payload) and POST /:id/resolve (decision
 * allow-list, the editedPayload requirement for 'edited', the 404 on
 * an already-resolved id, and the ask_confirmation approval branch —
 * which mints an async_response and delivers it to the caller).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))
vi.mock('../../inter-assistant/deliver.js', () => ({
  deliverToChannel: vi.fn().mockResolvedValue(undefined),
}))

import { pendingMessageRoutes } from '../pending-messages.js'
import { query } from '../../db/client.js'
import { deliverToChannel } from '../../inter-assistant/deliver.js'

const mockQuery = vi.mocked(query)
const mockDeliver = vi.mocked(deliverToChannel)

const pendingMessageStore = {
  listForUser: vi.fn(),
  resolve: vi.fn(),
  create: vi.fn(),
}

function app() {
  return createTestApp(
    '/api/pending-messages',
    pendingMessageRoutes({ pendingMessageStore: pendingMessageStore as never }),
    { userId: 'u-1' },
  )
}

function noAuthApp() {
  return createTestApp(
    '/api/pending-messages',
    pendingMessageRoutes({ pendingMessageStore: pendingMessageStore as never }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDeliver.mockResolvedValue(undefined)
})

describe('[COMP:api/pending-messages-route] GET /', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(noAuthApp()).get('/api/pending-messages')
    expect(res.status).toBe(401)
  })

  it('returns the current user\'s pending messages', async () => {
    pendingMessageStore.listForUser.mockResolvedValueOnce([{ id: 'pm-1' }])
    const res = await request(app()).get('/api/pending-messages')
    expect(res.body).toEqual({ messages: [{ id: 'pm-1' }] })
    expect(pendingMessageStore.listForUser).toHaveBeenCalledWith('u-1')
  })
})

describe('[COMP:api/pending-messages-route] POST /:id/resolve', () => {
  it('rejects an unknown decision with 400', async () => {
    const res = await request(app()).post('/api/pending-messages/pm-1/resolve').send({
      decision: 'maybe',
    })
    expect(res.status).toBe(400)
  })

  it('requires editedPayload when the decision is "edited"', async () => {
    const res = await request(app()).post('/api/pending-messages/pm-1/resolve').send({
      decision: 'edited',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('editedPayload')
  })

  it('returns 404 when the message is missing or already resolved', async () => {
    pendingMessageStore.resolve.mockResolvedValueOnce(null)
    const res = await request(app()).post('/api/pending-messages/pm-x/resolve').send({
      decision: 'rejected',
    })
    expect(res.status).toBe(404)
  })

  it('resolves a plain message without triggering caller delivery', async () => {
    pendingMessageStore.resolve.mockResolvedValueOnce({ id: 'pm-1', messageType: 'async_response' })
    const res = await request(app()).post('/api/pending-messages/pm-1/resolve').send({
      decision: 'approved',
    })
    expect(res.status).toBe(200)
    expect(mockDeliver).not.toHaveBeenCalled()
  })

  it('on an approved ask_confirmation, mints an async_response and delivers it to the caller', async () => {
    pendingMessageStore.resolve.mockResolvedValueOnce({
      id: 'pm-1',
      messageType: 'ask_confirmation',
      targetAssistantId: 'target-1',
      category: 'tasks',
      payload: {
        callerAssistantId: 'caller-1',
        question: 'what is due?',
        draftResponse: 'two tasks are due',
      },
    })
    mockQuery
      .mockResolvedValueOnce({ rows: [{ ownerUserId: 'owner-9' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ name: 'Sales Bot' }], rowCount: 1 } as never)

    const res = await request(app()).post('/api/pending-messages/pm-1/resolve').send({
      decision: 'approved',
    })
    expect(res.status).toBe(200)
    expect(pendingMessageStore.create).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAssistantId: 'caller-1',
        targetUserId: 'owner-9',
        sourceAssistantId: 'target-1',
        messageType: 'async_response',
      }),
    )
    expect(mockDeliver).toHaveBeenCalledWith(
      expect.objectContaining({ assistantId: 'caller-1', userId: 'owner-9' }),
    )
  })
})
