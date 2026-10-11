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
import type { ChannelIdentityBindingStore } from '../../db/channel-identity-bindings.js'

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

describe('[COMP:api/account-channel-identities] scoped WeChat account routes', () => {
  const bindingId = '00000000-0000-4000-a000-0000000000bb'
  function wechatStore(over: Partial<ChannelIdentityBindingStore> = {}) {
    return {
      mintWechatLinkCode: vi.fn(),
      revokeOwnWechatBinding: vi.fn(),
      listOwnWechatBindings: vi.fn().mockResolvedValue([]),
      listWorkspaceWechatIdentitySummary: vi.fn().mockResolvedValue([]),
      ...over,
    } as unknown as ChannelIdentityBindingStore
  }
  function wechatApp(store: ChannelIdentityBindingStore, userId = 'u_1') {
    return createTestApp('/api/account', accountRoutes({ wechatIdentityStore: store }), { userId })
  }
  beforeEach(() => {
    vi.resetAllMocks()
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never)
  })

  it('mints for the session account only, never a body-supplied account', async () => {
    const store = wechatStore({
      mintWechatLinkCode: vi.fn().mockResolvedValue({ ok: true, code: 'ABCDEFGH', expiresAt: '2026-10-11T00:15:00.000Z', channelName: 'WeChat bot' }),
    })
    const res = await request(wechatApp(store)).post('/api/account/wechat/link-code')
      .send({ workspaceId, channelId, accountId: 'someone-else', userId: 'someone-else' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ code: 'ABCDEFGH', expiresAt: '2026-10-11T00:15:00.000Z', channelName: 'WeChat bot' })
    expect(store.mintWechatLinkCode).toHaveBeenCalledWith({ accountId: 'u_1', workspaceId, channelId })
  })

  it('answers a non-member exactly like an unknown channel, and types the other refusals', async () => {
    const mint = vi.fn()
    const store = wechatStore({ mintWechatLinkCode: mint })
    const cases: Array<[string, number, string]> = [
      ['not_member', 404, 'not_found'], ['not_found', 404, 'not_found'],
      ['linked_elsewhere', 409, 'linked_elsewhere'], ['conflict', 409, 'conflict'], ['rate_limited', 429, 'rate_limited'],
    ]
    for (const [reason, status, code] of cases) {
      mint.mockResolvedValueOnce({ ok: false, reason })
      const res = await request(wechatApp(store)).post('/api/account/wechat/link-code').send({ workspaceId, channelId })
      expect([res.status, res.body.code]).toEqual([status, code])
      expect(JSON.stringify(res.body)).not.toMatch(/u_|account/)
    }
    const bad = await request(wechatApp(store)).post('/api/account/wechat/link-code').send({ workspaceId: 'x', channelId })
    expect(bad.status).toBe(400)
  })

  it('revokes only through the caller id and hides other accounts\' bindings as 404', async () => {
    const revoke = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const store = wechatStore({ revokeOwnWechatBinding: revoke })
    expect((await request(wechatApp(store)).delete(`/api/account/wechat/bindings/${bindingId}`)).status).toBe(200)
    expect(revoke).toHaveBeenCalledWith('u_1', bindingId)
    expect((await request(wechatApp(store)).delete(`/api/account/wechat/bindings/${bindingId}`)).status).toBe(404)
    expect((await request(wechatApp(store)).delete('/api/account/wechat/bindings/not-a-uuid')).status).toBe(404)
  })

  it('projects the caller\'s own bindings, and the per-channel summary only to owners and admins', async () => {
    const own = [{ bindingId, workspaceId, channelId, channelName: 'WeChat bot', state: 'linked', linkedAt: 'x', revokedAt: null }]
    const summary = [{ channelId, channelName: 'WeChat bot', state: 'linked', account: { id: 'u_1', name: 'A', email: null }, linkedAt: 'x' }]
    const store = wechatStore({
      listOwnWechatBindings: vi.fn().mockResolvedValue(own),
      listWorkspaceWechatIdentitySummary: vi.fn().mockResolvedValue(summary),
    })
    mockRole.mockResolvedValueOnce('member')
    const member = await request(wechatApp(store)).get(`/api/account/channel-identities?workspaceId=${workspaceId}`)
    expect(member.body.wechatBindings).toEqual(own)
    expect(member.body.wechatChannels).toEqual([])
    expect(store.listOwnWechatBindings).toHaveBeenCalledWith('u_1', workspaceId)
    expect(store.listWorkspaceWechatIdentitySummary).not.toHaveBeenCalled()
    mockRole.mockResolvedValueOnce('admin')
    const admin = await request(wechatApp(store)).get(`/api/account/channel-identities?workspaceId=${workspaceId}`)
    expect(admin.body.wechatChannels).toEqual(summary)
  })
})
