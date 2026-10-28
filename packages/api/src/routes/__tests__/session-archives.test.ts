import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../db/client.js', () => ({ query: vi.fn() }))
vi.mock('../../db/sessions.js', () => ({ readSessionById: vi.fn(), countSessionHumans: vi.fn(async () => new Map()) }))
vi.mock('../../session-read-authority.js', () => ({ gateSessionRead: vi.fn() }))
vi.mock('../route-helpers.js', () => ({ resolveUser: vi.fn() }))
vi.mock('../../db/users.js', () => ({
  getWorkspacePrimaryAssistant: vi.fn(), getUserAssistant: vi.fn(), getDefaultAssistant: vi.fn(),
  getUserProfilesByIds: vi.fn(async () => new Map()),
}))
vi.mock('../../db/workspace-store.js', () => ({ getWorkspaceMembershipWithReadScopeSystem: vi.fn() }))
vi.mock('../session-title-authority.js', () => ({
  pinSessionTitleClaims: vi.fn(), sessionTitleProjections: vi.fn(async () => new Map()),
}))

import { sessionRoutes } from '../sessions.js'
import { query } from '../../db/client.js'
import { readSessionById } from '../../db/sessions.js'
import { gateSessionRead } from '../../session-read-authority.js'
import { resolveUser } from '../route-helpers.js'
import { getWorkspacePrimaryAssistant } from '../../db/users.js'
import { getWorkspaceMembershipWithReadScopeSystem } from '../../db/workspace-store.js'

const id = '11111111-1111-4111-8111-111111111111'
const viewer = '22222222-2222-4222-8222-222222222222'
const workspace = '33333333-3333-4333-8333-333333333333'
function app(userId: string | null = viewer) {
  const result = express()
  result.use(express.json())
  result.use((req, _res, next) => { if (userId) (req as { userId?: string }).userId = userId; next() })
  result.use('/api/sessions', sessionRoutes())
  return result
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as never)
  vi.mocked(readSessionById).mockResolvedValue({ id } as never)
  vi.mocked(gateSessionRead).mockResolvedValue(null)
  vi.mocked(resolveUser).mockResolvedValue({ id: viewer } as never)
  vi.mocked(getWorkspacePrimaryAssistant).mockResolvedValue({ id: 'assistant', workspaceId: workspace } as never)
  vi.mocked(getWorkspaceMembershipWithReadScopeSystem).mockResolvedValue({ clearance: 'internal', compartments: [], projectIds: [] } as never)
})

describe('[COMP:api/sessions-list] per-viewer archives', () => {
  it('archives idempotently for the authenticated viewer without updating the session', async () => {
    for (let i = 0; i < 2; i++) {
      await request(app()).patch(`/api/sessions/${id}/archive`).send({ archived: true }).expect(200, { archived: true })
    }
    expect(query).toHaveBeenCalledTimes(2)
    for (const [sql, params] of vi.mocked(query).mock.calls) {
      expect(sql).toContain('ON CONFLICT (user_id,session_id) DO NOTHING')
      expect(params).toEqual([viewer, id])
      expect(sql).not.toContain('UPDATE sessions')
    }
  })
  it('restores only this viewer marker', async () => {
    await request(app()).patch(`/api/sessions/${id}/archive`).send({ archived: false }).expect(200)
    expect(query).toHaveBeenCalledWith('DELETE FROM session_archives WHERE user_id=$1 AND session_id=$2', [viewer, id])
  })
  it('requires authentication and rejects body coercion or a forged viewer', async () => {
    await request(app(null)).patch(`/api/sessions/${id}/archive`).send({ archived: true }).expect(401)
    for (const body of [{ archived: 'false' }, {}, { archived: true, userId: 'other' }]) {
      await request(app()).patch(`/api/sessions/${id}/archive`).send(body).expect(400)
    }
    expect(query).not.toHaveBeenCalled()
  })
  it('conceals unreadable, removed and invalid sessions', async () => {
    vi.mocked(gateSessionRead).mockResolvedValueOnce({ status: 403, error: 'Denied' })
    await request(app()).patch(`/api/sessions/${id}/archive`).send({ archived: true }).expect(404)
    vi.mocked(readSessionById).mockResolvedValueOnce(null)
    await request(app()).patch(`/api/sessions/${id}/archive`).send({ archived: false }).expect(404)
    await request(app()).patch('/api/sessions/invalid/archive').send({ archived: true }).expect(404)
    expect(query).not.toHaveBeenCalled()
  })
  it.each(['', '&archived=true'])('filters personal archive state before the limit: %s', async suffix => {
    await request(app()).get(`/api/sessions?workspaceId=${workspace}&scope=workspace&channels=all${suffix}`).expect(200)
    const [sql, params] = vi.mocked(query).mock.calls[0]
    expect(sql).toContain(`${suffix ? '' : 'NOT '}EXISTS (\n             SELECT 1 FROM session_archives`)
    expect(sql).toContain('sa.user_id=$2')
    expect(sql.indexOf('session_archives')).toBeLessThan(sql.indexOf('LIMIT'))
    expect(params?.[1]).toBe(viewer)
  })
  it('paginates personal archives with a stable timestamp and id cursor', async () => {
    const date = '2026-10-01T01:00:00.000Z'
    await request(app()).get(`/api/sessions?workspaceId=${workspace}&scope=workspace&channels=all&archived=true&before=${date}&beforeId=${id}`).expect(200)
    const [sql, params] = vi.mocked(query).mock.calls[0]
    expect(sql).toContain('(s.last_active_at,s.id)<($3::timestamptz,$4::uuid)')
    expect(params).toEqual([workspace, viewer, date, id])
    expect(sql).toContain('LIMIT 50')
  })
  it('uses the current viewer for the shared archive filter', async () => {
    await request(app()).get(`/api/sessions/workspace?workspaceId=${workspace}&archived=true`).expect(200)
    const [sql, params] = vi.mocked(query).mock.calls[0]
    expect(sql).toContain('sa.user_id=$5')
    expect(params?.[4]).toBe(viewer)
  })
  it('scans past unreadable personal archives without disclosing them or hiding older readable rows', async () => {
    const row = (id: string, userId: string) => ({
      id, lastActiveAt: new Date('2026-10-01T00:00:00Z'), userId,
      assistantId: 'assistant', visibility: 'owner', mode: null, channelType: 'web',
      appOrigin: 'chat', anchorKind: 'none', contextGroupId: null, contextProjectId: null,
      contextCompartments: [], effectiveClearance: 'internal',
    })
    vi.mocked(query).mockResolvedValueOnce({ rows: Array.from({ length: 50 }, (_, i) => row(`hidden-${i}`, 'other-viewer')) } as never)
      .mockResolvedValueOnce({ rows: [row(id, viewer)] } as never)
    const res = await request(app()).get(`/api/sessions?workspaceId=${workspace}&scope=workspace&channels=all&archived=true`).expect(200)
    expect(res.body.map((r: { id: string }) => r.id)).toEqual([id])
    expect(vi.mocked(query).mock.calls[1][1]).toEqual([workspace, viewer, '2026-10-01T00:00:00.000Z', 'hidden-49'])
  })
  it('rejects malformed filters and partial cursors', async () => {
    await request(app()).get(`/api/sessions?workspaceId=${workspace}&archived=all`).expect(400)
    await request(app()).get(`/api/sessions?workspaceId=${workspace}&beforeId=${id}`).expect(400)
    await request(app()).get(`/api/sessions/workspace?workspaceId=${workspace}&archived=all`).expect(400)
    expect(query).not.toHaveBeenCalled()
  })
})
