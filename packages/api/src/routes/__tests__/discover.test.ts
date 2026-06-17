/**
 * Unit tests for the public discovery routes.
 * Component tag: [COMP:api/discover-route].
 *
 * Mocks `query` and mounts discoverRoutes() on the shared test app.
 * Verifies GET /assistants (pagination limit/offset clamping + NaN
 * fallback, row serialization — iconSeed ?? 0, followerCount parseInt,
 * isOfficial passthrough), GET /assistants/:id (404 when not public,
 * serialized hit), and the 500 mapping on a query failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import { discoverRoutes } from '../discover.js'
import { query } from '../../db/client.js'

const mockQuery = vi.mocked(query)

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a-1',
    name: 'Helper Bot',
    bio: 'a helpful bot',
    iconSeed: 7,
    ownerHandle: 'alice',
    ownerName: 'Alice',
    followerCount: '12',
    isOfficial: false,
    ...over,
  }
}

const app = createTestApp('/api/discover', discoverRoutes())

beforeEach(() => {
  mockQuery.mockReset()
})

describe('[COMP:api/discover-route] GET /assistants', () => {
  it('returns the serialized public-assistant list with pagination metadata', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [row()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ total: '1' }], rowCount: 1 } as never)
    const res = await request(app).get('/api/discover/assistants')
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(1)
    expect(res.body.limit).toBe(24)
    expect(res.body.offset).toBe(0)
    expect(res.body.assistants[0]).toEqual({
      id: 'a-1',
      name: 'Helper Bot',
      bio: 'a helpful bot',
      iconSeed: 7,
      ownerHandle: 'alice',
      ownerName: 'Alice',
      followerCount: 12,
      isOfficial: false,
    })
  })

  it('defaults a null iconSeed to 0 and a non-numeric followerCount to 0', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [row({ iconSeed: null, followerCount: 'x' })],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [{ total: '1' }], rowCount: 1 } as never)
    const res = await request(app).get('/api/discover/assistants')
    expect(res.body.assistants[0].iconSeed).toBe(0)
    expect(res.body.assistants[0].followerCount).toBe(0)
  })

  it('clamps limit to 1..100 and offset to >= 0', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [{ total: '0' }], rowCount: 1 } as never)
    const res = await request(app).get('/api/discover/assistants?limit=9999&offset=-5')
    expect(res.body.limit).toBe(100)
    expect(res.body.offset).toBe(0)
    expect(mockQuery.mock.calls[0][1]?.slice(0, 2)).toEqual([100, 0])
  })

  it('falls back to limit 24 when the query param is not a number', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [{ total: '0' }], rowCount: 1 } as never)
    const res = await request(app).get('/api/discover/assistants?limit=abc')
    expect(res.body.limit).toBe(24)
  })

  it('maps a query failure to a 500', async () => {
    mockQuery.mockRejectedValue(new Error('db down'))
    const res = await request(app).get('/api/discover/assistants')
    expect(res.status).toBe(500)
    expect(res.body.error).toBeTruthy()
  })
})

describe('[COMP:api/discover-route] GET /assistants/:id', () => {
  it('serializes a public assistant on a hit', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ id: 'a-9' })], rowCount: 1 } as never)
    const res = await request(app).get('/api/discover/assistants/a-9')
    expect(res.status).toBe(200)
    expect(res.body.id).toBe('a-9')
    expect(res.body.followerCount).toBe(12)
  })

  it('returns 404 when the assistant is missing or not public', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    const res = await request(app).get('/api/discover/assistants/ghost')
    expect(res.status).toBe(404)
  })
})
