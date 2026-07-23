import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import { handleRoutes } from '../handles.js'
import { query } from '../../db/client.js'

const mockQuery = vi.mocked(query)

// The discovery endpoints (/search, /:handle/assistants) were removed with the
// sharing_mode teardown. Only the caller's own-handle get/change survives.
// See docs/plans/network-feature-teardown.md.
describe('[COMP:api/handles-route] Own-handle get/change', () => {
  beforeEach(() => vi.clearAllMocks())

  function app() {
    return createTestApp('/api/handles', handleRoutes(), { userId: 'u_caller' })
  }

  it('returns the caller\'s existing handle', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ handle: 'sidan' }] } as any)

    const res = await request(app()).get('/api/handles/me')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ handle: 'sidan' })
  })

  it('rejects an invalid handle on PATCH', async () => {
    const res = await request(app()).patch('/api/handles/me').send({ handle: 'A B' })

    expect(res.status).toBe(400)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('normalizes and stores a valid handle', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 } as any)

    const res = await request(app()).patch('/api/handles/me').send({ handle: 'Sidan-AI' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ handle: 'sidan-ai' })
    expect(mockQuery.mock.calls[0][1]).toEqual(['sidan-ai', 'u_caller'])
  })

  it('surfaces a duplicate handle as 409', async () => {
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))

    const res = await request(app()).patch('/api/handles/me').send({ handle: 'taken' })

    expect(res.status).toBe(409)
  })
})
