import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
const mocks = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../../db/session-display-history.js', () => ({ readPrivateSessionDisplay: mocks.read }))
import { sessionDisplayHistoryRoutes } from '../session-display-history.js'
import { WorkspaceAccessError } from '../../workspace-access/policy.js'

const id = '11111111-1111-4111-8111-111111111111', workspace = '22222222-2222-4222-8222-222222222222'
function app(claims: Record<string, unknown> = { userId: 'owner', authSessionId: 'device', authVersion: 3 }) {
  const result = express()
  result.use((req, _res, next) => { Object.assign(req, claims); next() })
  result.use('/sessions/:id/display-history', sessionDisplayHistoryRoutes())
  return result
}
beforeEach(() => { vi.clearAllMocks(); mocks.read.mockResolvedValue({ rows: [] }) })
describe('[COMP:api/session-display-history] native historical display boundary', () => {
  it('requires native device claims and never accepts caller-selected authority', async () => {
    await request(app({ userId: 'owner' })).get(`/sessions/${id}/display-history?workspaceId=${workspace}`).expect(401)
    for (const extra of ['&userId=someone', '&purpose=model', '&limit=101', '&afterSequence=-1']) {
      await request(app()).get(`/sessions/${id}/display-history?workspaceId=${workspace}${extra}`).expect(400)
    }
    expect(mocks.read).not.toHaveBeenCalled()
    const response = await request(app()).get(`/sessions/${id}/display-history?workspaceId=${workspace}`).expect(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith({ sessionId: id, workspaceId: workspace,
      afterSequence: 0, limit: 100, claims: { userId: 'owner', sessionId: 'device', authVersion: 3 } })
  })
  it('returns an opaque denial and no protected rows', async () => {
    mocks.read.mockRejectedValue(new WorkspaceAccessError('display_history_unavailable', 404))
    await request(app()).get(`/sessions/${id}/display-history?workspaceId=${workspace}`)
      .expect(404, { error: 'display_history_unavailable' })
  })
})
