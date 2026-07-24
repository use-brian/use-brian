import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

// The gate goes through THE assistant access predicate
// (resolveAssistantAccess) — mock it at that seam.
vi.mock('../../db/users.js', () => ({
  resolveAssistantAccess: vi.fn(),
}))

import { chatLinkRoutes } from '../chat-links.js'
import { resolveAssistantAccess } from '../../db/users.js'

const mockAccess = vi.mocked(resolveAssistantAccess)

function makeStore() {
  return {
    create: vi.fn().mockResolvedValue({ id: 'l_1', token: 'tok_raw', label: 'Public chat' }),
    listForAssistant: vi.fn().mockResolvedValue([]),
    revoke: vi.fn().mockResolvedValue(true),
    resolveToken: vi.fn(),
    consumeDailyBudget: vi.fn(),
  }
}

/** Effective role owner/admin passes the gate. */
function mockGatePass(role: 'owner' | 'admin' = 'owner') {
  mockAccess.mockResolvedValueOnce({ assistant: { id: 'a_1' }, role } as never)
}
/** Gate fails: no access at all. */
function mockGateFail() {
  mockAccess.mockResolvedValueOnce(null)
}

describe('[COMP:api/chat-links-route] Chat-link manage routes', () => {
  let store: ReturnType<typeof makeStore>

  beforeEach(() => {
    vi.clearAllMocks()
    store = makeStore()
  })

  function app(userId?: string) {
    return createTestApp(
      '/api/assistants/:assistantId/chat-links',
      chatLinkRoutes({ chatLinkStore: store as never }),
      userId ? { userId } : undefined,
    )
  }

  it('401s unauthenticated requests', async () => {
    const res = await request(app()).get('/api/assistants/a_1/chat-links')
    expect(res.status).toBe(401)
  })

  it('403s a caller with no access to the assistant', async () => {
    mockGateFail()
    const res = await request(app('u_outsider')).post('/api/assistants/a_1/chat-links').send({})
    expect(res.status).toBe(403)
    expect(store.create).not.toHaveBeenCalled()
  })

  it('403s a plain member (governance action needs owner/admin)', async () => {
    mockAccess.mockResolvedValueOnce({ assistant: { id: 'a_1' }, role: 'member' } as never)
    const res = await request(app('u_member')).post('/api/assistants/a_1/chat-links').send({})
    expect(res.status).toBe(403)
    expect(store.create).not.toHaveBeenCalled()
  })

  it('lists links for an authorized caller', async () => {
    mockGatePass()
    store.listForAssistant.mockResolvedValueOnce([{ id: 'l_1' }])
    const res = await request(app('u_owner')).get('/api/assistants/a_1/chat-links')
    expect(res.status).toBe(200)
    expect(res.body.links).toHaveLength(1)
    expect(store.listForAssistant).toHaveBeenCalledWith('a_1')
  })

  it('mints a link with label + cap', async () => {
    mockGatePass()
    const res = await request(app('u_owner'))
      .post('/api/assistants/a_1/chat-links')
      .send({ label: 'Landing page', dailyMessageLimit: 50 })
    expect(res.status).toBe(201)
    expect(res.body.link.token).toBe('tok_raw')
    expect(store.create).toHaveBeenCalledWith({
      assistantId: 'a_1',
      createdBy: 'u_owner',
      label: 'Landing page',
      dailyMessageLimit: 50,
    })
  })

  it('rejects unknown body fields (strict schema)', async () => {
    mockGatePass()
    const res = await request(app('u_owner'))
      .post('/api/assistants/a_1/chat-links')
      .send({ label: 'x', sneaky: true })
    expect(res.status).toBe(400)
    expect(store.create).not.toHaveBeenCalled()
  })

  it('revokes a link', async () => {
    mockGatePass()
    const res = await request(app('u_owner')).delete('/api/assistants/a_1/chat-links/l_1')
    expect(res.status).toBe(200)
    expect(store.revoke).toHaveBeenCalledWith('l_1', 'a_1')
  })

  it('404s revoking a link that is not the assistant\'s', async () => {
    mockGatePass()
    store.revoke.mockResolvedValueOnce(false)
    const res = await request(app('u_owner')).delete('/api/assistants/a_1/chat-links/l_other')
    expect(res.status).toBe(404)
  })

  it('gate accepts an effective workspace admin via resolveAssistantAccess', async () => {
    mockGatePass('admin')
    const res = await request(app('u_ws_admin')).get('/api/assistants/a_1/chat-links')
    expect(res.status).toBe(200)
    expect(mockAccess).toHaveBeenCalledWith('u_ws_admin', 'a_1')
  })
})
