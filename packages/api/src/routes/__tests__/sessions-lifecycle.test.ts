/**
 * Rename / delete authority follows the `lifecycle` row of sessionPolicy
 * (unified-sessions L11, D9): a personal session is the owner's; a workspace
 * session is renamed by any participant who can read it and deleted by a
 * workspace admin, whoever started it.
 *
 * Component tag: [COMP:api/sessions-list].
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../db/client.js', () => ({ query: vi.fn() }))
vi.mock('../../db/users.js', () => ({
  findOrCreateUser: vi.fn(),
  getDefaultAssistant: vi.fn(),
  getUserAssistant: vi.fn(),
  getUserProfilesByIds: vi.fn(),
  getWorkspacePrimaryAssistant: vi.fn(),
}))
vi.mock('../../db/sessions.js', () => ({
  findSessionByChannel: vi.fn(),
  findSessionById: vi.fn(async (id: string) => ({ id, assistantId: 'a-1', userId: 'starter', visibility: 'workspace', mode: null, effectiveClearance: 'internal' })),
  getSessionMessages: vi.fn(),
  renameSession: vi.fn(),
}))
vi.mock('../../db/workspace-store.js', () => ({
  getWorkspaceRoleSystem: vi.fn(),
  getWorkspaceMembershipWithReadScopeSystem: vi.fn(),
}))
vi.mock('../../session-read-authority.js', () => ({ gateSessionRead: vi.fn(async () => null), anchorReadGate: vi.fn() }))
vi.mock('../route-helpers.js', () => ({ resolveUser: vi.fn() }))

import { sessionRoutes } from '../sessions.js'
import { query } from '../../db/client.js'
import { renameSession } from '../../db/sessions.js'
import { getWorkspaceRoleSystem } from '../../db/workspace-store.js'
import { gateSessionRead } from '../../session-read-authority.js'

const mockQuery = vi.mocked(query)

function app(userId: string) {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => { (req as { userId?: string }).userId = userId; next() })
  a.use('/api/sessions', sessionRoutes())
  return a
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: 's-1', userId: 'starter', status: 'idle', mode: null, visibility: 'workspace',
    channelType: 'web', appOrigin: 'chat', workspaceId: 'w-1', ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(gateSessionRead).mockResolvedValue(null)
})

describe('[COMP:api/sessions-list] session lifecycle authority (L11)', () => {
  it('lets a reader who did not start a doc thread rename it', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ channelType: 'doc_thread', appOrigin: null })] } as never)
    const res = await request(app('teammate')).patch('/api/sessions/s-1').send({ title: 'Renamed' })
    expect(res.status).toBe(200)
    expect(vi.mocked(renameSession)).toHaveBeenCalledWith('s-1', 'Renamed')
  })

  it('refuses a rename from someone the read gate refuses', async () => {
    vi.mocked(gateSessionRead).mockResolvedValueOnce({ status: 403, error: 'Insufficient clearance' })
    mockQuery.mockResolvedValueOnce({ rows: [row()] } as never)
    const res = await request(app('outsider')).patch('/api/sessions/s-1').send({ title: 'Renamed' })
    expect(res.status).toBe(403)
  })

  it('refuses a delete from the non-admin starter of a room (D9: user_id grants nothing)', async () => {
    vi.mocked(getWorkspaceRoleSystem).mockResolvedValueOnce('member')
    mockQuery.mockResolvedValueOnce({ rows: [row()] } as never)
    const res = await request(app('starter')).delete('/api/sessions/s-1')
    expect(res.status).toBe(403)
  })

  it('lets a workspace admin delete a doc thread (the anchor cascade runs through the FK)', async () => {
    vi.mocked(getWorkspaceRoleSystem).mockResolvedValueOnce('admin')
    mockQuery.mockResolvedValue({ rows: [row({ channelType: 'doc_thread', appOrigin: null })], rowCount: 1 } as never)
    const res = await request(app('admin')).delete('/api/sessions/s-1')
    expect(res.status).toBe(200)
    expect(mockQuery.mock.calls.some((c) => String(c[0]).includes('DELETE FROM sessions'))).toBe(true)
  })

  it('keeps a personal session the owner\'s alone', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ visibility: 'owner', appOrigin: 'chat' })] } as never)
    const res = await request(app('someone-else')).patch('/api/sessions/s-1').send({ title: 'x' })
    expect(res.status).toBe(403)
  })
})
