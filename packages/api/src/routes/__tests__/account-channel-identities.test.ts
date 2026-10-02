import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))
vi.mock('../../db/workspace-store.js', () => ({
  getWorkspaceRoleSystem: vi.fn(),
}))

import { accountRoutes } from '../account.js'
import { query } from '../../db/client.js'
import { getWorkspaceRoleSystem } from '../../db/workspace-store.js'

const mockQuery = vi.mocked(query)
const mockRole = vi.mocked(getWorkspaceRoleSystem)
const workspaceId = '00000000-0000-4000-a000-0000000000aa'
const channelId = '00000000-0000-4000-a000-0000000000cc'

function app() {
  return createTestApp('/api/account', accountRoutes({}), { userId: 'u_1' })
}

describe('[COMP:api/account-channel-identities] GET /api/account/channel-identities', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns email matches and, for an admin, each channel email-matching status', async () => {
    mockRole.mockResolvedValue('admin')
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ provider: 'slack', providerId: 'U1', displayName: 'Ada' }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [{
          channelId,
          eventName: 'channel_email_lookup_unavailable',
          metadata: {
            integration_id: channelId,
            reason: 'lookup_denied',
            provider_code: '99991672',
            missing_scopes: 'contact:contact.base:readonly,contact:contact:readonly',
          },
          at: new Date('2026-10-02T12:37:26Z'),
        }],
        rowCount: 1,
      } as never)

    const res = await request(app()).get(`/api/account/channel-identities?workspaceId=${workspaceId}`)

    expect(res.status).toBe(200)
    expect(res.body.emailMatches).toEqual([{ provider: 'slack', providerId: 'U1', displayName: 'Ada' }])
    expect(res.body.emailMatching).toEqual([{
      channelId,
      status: 'off',
      reason: 'lookup_denied',
      missingScopes: ['contact:contact.base:readonly', 'contact:contact:readonly'],
      providerCode: '99991672',
      at: '2026-10-02T12:37:26.000Z',
    }])
    expect(res.body.emailMatchingVisible).toBe(true)
    expect(mockQuery.mock.calls[0][1]).toEqual(['u_1'])
    expect(mockQuery.mock.calls[1][1]).toEqual([workspaceId])
  })

  it('never shows email-matching diagnostics to a plain member', async () => {
    mockRole.mockResolvedValue('member')
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

    const res = await request(app()).get(`/api/account/channel-identities?workspaceId=${workspaceId}`)

    expect(res.status).toBe(200)
    expect(res.body.emailMatching).toEqual([])
    expect(res.body.emailMatchingVisible).toBe(false)
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('ignores a malformed workspaceId instead of failing the caller\'s own rows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    const res = await request(app()).get('/api/account/channel-identities?workspaceId=not-a-uuid')
    expect(res.status).toBe(200)
    expect(res.body.emailMatchingVisible).toBe(false)
    expect(mockRole).not.toHaveBeenCalled()
  })

  it('requires auth', async () => {
    const res = await request(createTestApp('/api/account', accountRoutes({}), {})).get('/api/account/channel-identities')
    expect(res.status).toBe(401)
  })
})
