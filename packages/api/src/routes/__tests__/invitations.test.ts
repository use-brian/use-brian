/**
 * Unit tests for workspace invitations — both surfaces:
 *   - admin create/list/revoke on the workspace router
 *     ([COMP:api/workspaces-route])
 *   - token preview/accept on the invitation router
 *     ([COMP:api/invitations-route])
 *
 * Mocks `query` / `findUserById` and injects mock stores, mirroring
 * `workspaces.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))
vi.mock('../../db/users.js', () => ({
  findUserById: vi.fn(),
}))

import { workspaceRoutes } from '../workspaces.js'
import { invitationRoutes } from '../invitations.js'
import { query } from '../../db/client.js'

const mockQuery = vi.mocked(query)

const workspaceStore = {
  getRole: vi.fn(),
  addMember: vi.fn(),
  // unused by these routes but present so the cast is structurally complete
  create: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  listMembers: vi.fn(),
}

const invitationStore = {
  create: vi.fn(),
  listPending: vi.fn(),
  revoke: vi.fn(),
  getByToken: vi.fn(),
  markAccepted: vi.fn(),
}

function wsApp(userId?: string) {
  return createTestApp(
    '/api/workspaces',
    workspaceRoutes({
      workspaceStore: workspaceStore as never,
      invitationStore: invitationStore as never,
      appUrl: 'https://app.test',
    }),
    userId ? { userId } : undefined,
  )
}

function invApp(userId?: string) {
  return createTestApp(
    '/api/invitations',
    invitationRoutes({
      invitationStore: invitationStore as never,
      workspaceStore: workspaceStore as never,
    }),
    userId ? { userId } : undefined,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('[COMP:api/workspaces-route] POST /:workspaceId/invitations', () => {
  it('requires at least an admin role', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('member')
    const res = await request(wsApp('u-1'))
      .post('/api/workspaces/ws-1/invitations')
      .send({ emails: ['new@example.com'] })
    expect(res.status).toBe(403)
  })

  it('400s when no emails are supplied', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('admin')
    const res = await request(wsApp('u-1'))
      .post('/api/workspaces/ws-1/invitations')
      .send({ emails: [] })
    expect(res.status).toBe(400)
  })

  it('invites a new email, skips an existing member, flags an invalid one', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('admin')
    // workspace name + inviter name lookups
    mockQuery
      .mockResolvedValueOnce({ rows: [{ name: 'Acme' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ name: 'Dana' }], rowCount: 1 } as never)
      // existing-member check for new@ (none) then member@ (one)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [{ id: 'u-2' }], rowCount: 1 } as never)
    invitationStore.create.mockResolvedValueOnce({ invitation: {}, token: 'rawtoken123' })

    const res = await request(wsApp('u-1'))
      .post('/api/workspaces/ws-1/invitations')
      .send({ emails: 'new@example.com, member@example.com, not-an-email', role: 'admin' })

    expect(res.status).toBe(201)
    const byEmail = Object.fromEntries(
      (res.body.results as Array<{ email: string; status: string; link?: string }>).map((r) => [r.email, r]),
    )
    expect(byEmail['new@example.com'].status).toBe('invited')
    expect(byEmail['new@example.com'].link).toContain('rawtoken123')
    expect(byEmail['member@example.com'].status).toBe('already_member')
    expect(byEmail['not-an-email'].status).toBe('invalid')
    expect(invitationStore.create).toHaveBeenCalledTimes(1)
  })

  it('GET lists pending invitations for an admin', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('admin')
    invitationStore.listPending.mockResolvedValueOnce([{ id: 'inv-1', email: 'a@b.com' }])
    const res = await request(wsApp('u-1')).get('/api/workspaces/ws-1/invitations')
    expect(res.status).toBe(200)
    expect(res.body.invitations).toHaveLength(1)
  })

  it('DELETE revokes a pending invitation', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('admin')
    invitationStore.revoke.mockResolvedValueOnce(true)
    const res = await request(wsApp('u-1')).delete('/api/workspaces/ws-1/invitations/inv-1')
    expect(res.status).toBe(204)
  })

  it('DELETE 404s an unknown invitation', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('admin')
    invitationStore.revoke.mockResolvedValueOnce(false)
    const res = await request(wsApp('u-1')).delete('/api/workspaces/ws-1/invitations/missing')
    expect(res.status).toBe(404)
  })
})

describe('[COMP:api/invitations-route] GET /:token preview', () => {
  const future = new Date(Date.now() + 86_400_000)

  it('404s an unknown token', async () => {
    invitationStore.getByToken.mockResolvedValueOnce(null)
    const res = await request(invApp()).get('/api/invitations/sometokenvalue1234')
    expect(res.status).toBe(404)
  })

  it('returns a pending preview without auth', async () => {
    invitationStore.getByToken.mockResolvedValueOnce({
      workspaceName: 'Acme',
      inviterName: 'Dana',
      role: 'member',
      email: 'a@b.com',
      expiresAt: future,
      acceptedAt: null,
    })
    const res = await request(invApp()).get('/api/invitations/sometokenvalue1234')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('pending')
    expect(res.body.workspaceName).toBe('Acme')
  })
})

describe('[COMP:api/invitations-route] POST /accept', () => {
  const future = new Date(Date.now() + 86_400_000)

  it('401s without auth', async () => {
    const res = await request(invApp()).post('/api/invitations/accept').send({ token: 'x' })
    expect(res.status).toBe(401)
  })

  it('403s when the signed-in email does not match the invite', async () => {
    invitationStore.getByToken.mockResolvedValueOnce({
      workspaceName: 'Acme', inviterName: null, role: 'member',
      email: 'invited@example.com', expiresAt: future, acceptedAt: null,
    })
    mockQuery.mockResolvedValueOnce({ rows: [{ email: 'someone-else@example.com' }], rowCount: 1 } as never)
    const res = await request(invApp('u-9'))
      .post('/api/invitations/accept')
      .send({ token: 'rawtoken123' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('email_mismatch')
  })

  it('accepts a matching invitation and joins the workspace', async () => {
    invitationStore.getByToken.mockResolvedValueOnce({
      workspaceName: 'Acme', inviterName: 'Dana', role: 'admin',
      email: 'invited@example.com', expiresAt: future, acceptedAt: null,
    })
    mockQuery.mockResolvedValueOnce({ rows: [{ email: 'invited@example.com' }], rowCount: 1 } as never)
    invitationStore.markAccepted.mockResolvedValueOnce({ workspaceId: 'ws-1', email: 'invited@example.com', role: 'admin' })
    workspaceStore.addMember.mockResolvedValueOnce({})

    const res = await request(invApp('u-9'))
      .post('/api/invitations/accept')
      .send({ token: 'rawtoken123' })

    expect(res.status).toBe(200)
    expect(res.body.workspaceId).toBe('ws-1')
    expect(workspaceStore.addMember).toHaveBeenCalledWith('u-9', 'ws-1', 'u-9', 'admin')
  })

  it('410s an expired invitation', async () => {
    invitationStore.getByToken.mockResolvedValueOnce({
      workspaceName: 'Acme', inviterName: null, role: 'member',
      email: 'invited@example.com', expiresAt: new Date(Date.now() - 1000), acceptedAt: null,
    })
    const res = await request(invApp('u-9'))
      .post('/api/invitations/accept')
      .send({ token: 'rawtoken123' })
    expect(res.status).toBe(410)
  })
})
