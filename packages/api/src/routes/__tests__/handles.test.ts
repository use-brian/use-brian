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

describe('[COMP:api/handles-route] Handle search', () => {
  beforeEach(() => vi.clearAllMocks())

  function app() {
    return createTestApp('/api/handles', handleRoutes(), { userId: 'u_caller' })
  }

  it('discovers assistants owned via teams (post-089 ownership XOR)', async () => {
    // Query 1: handle prefix lookup → one user
    mockQuery.mockResolvedValueOnce({
      rows: [{ handle: 'sidan', name: 'Sidan', avatarUrl: null, userId: 'u_sidan' }],
    } as any)
    // Query 2: per-user assistants. Returning a row simulates a
    // team-owned assistant matched via teams.owner_user_id (the new
    // branch added to handle the post-089 ownership shape).
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'a_team_owned',
        name: 'Use Brian - Product',
        bio: 'private team assistant',
        iconSeed: 7,
        connectionCount: '0',
        sharingMode: 'private',
      }],
    } as any)

    const res = await request(app()).get('/api/handles/search?q=sidan')

    expect(res.status).toBe(200)
    expect(res.body.users).toHaveLength(1)
    expect(res.body.users[0]).toMatchObject({
      handle: 'sidan',
      assistants: [{ id: 'a_team_owned', sharingMode: 'private' }],
    })

    // The per-user assistants SQL must check both ownership shapes:
    // assistant_members (personal) AND teams.owner_user_id (team).
    const assistantsSql = mockQuery.mock.calls[1][0]
    expect(assistantsSql).toMatch(/assistant_members/)
    expect(assistantsSql).toMatch(/workspaces\b[\s\S]*owner_user_id/)
  })

  it('omits users with no shareable assistants', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ handle: 'lonely', name: null, avatarUrl: null, userId: 'u_lonely' }],
    } as any)
    mockQuery.mockResolvedValueOnce({ rows: [] } as any)

    const res = await request(app()).get('/api/handles/search?q=lonely')

    expect(res.status).toBe(200)
    expect(res.body.users).toEqual([])
  })
})
