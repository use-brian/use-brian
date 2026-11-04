import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
const mocks = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../../db/session-legacy-history.js', async original => ({
  ...await original<typeof import('../../db/session-legacy-history.js')>(), readPrivateLegacyHistory: mocks.read,
}))
import { sessionLegacyHistoryRoutes } from '../session-legacy-history.js'
import { privateHistoryText } from '../../db/session-legacy-history.js'
import { WorkspaceAccessError } from '../../workspace-access/policy.js'
const id = '11111111-1111-4111-8111-111111111111', workspace = '22222222-2222-4222-8222-222222222222'
function app(native = true) {
  const result = express()
  result.use((req, _res, next) => {
    if (native) Object.assign(req, { userId: 'owner', authSessionId: 'device', authVersion: 3 })
    next()
  })
  result.use('/sessions/:id/legacy-history', sessionLegacyHistoryRoutes()); return result
}
beforeEach(() => { vi.clearAllMocks(); mocks.read.mockResolvedValue({ rows: [] }) })
describe('[COMP:api/session-legacy-history] native display boundary', () => {
  it('requires verified native claims, bounds pagination and prevents caching', async () => {
    const result = await request(app()).get(`/sessions/${id}/legacy-history?workspaceId=${workspace}`).expect(200)
    expect(result.headers['cache-control']).toBe('no-store')
    expect(mocks.read).toHaveBeenCalledWith({ sessionId: id, workspaceId: workspace, afterSequence: 0, limit: 50,
      claims: { userId: 'owner', sessionId: 'device', authVersion: 3 } })
    await request(app(false)).get(`/sessions/${id}/legacy-history?workspaceId=${workspace}`).expect(401)
    for (const extra of ['&limit=101', '&afterSequence=-1', '&userId=someone', '&limit=Infinity']) {
      await request(app()).get(`/sessions/${id}/legacy-history?workspaceId=${workspace}${extra}`).expect(400)
    }
    expect(mocks.read).toHaveBeenCalledTimes(1)
  })
  it('returns opaque refusal without any historical bytes', async () => {
    mocks.read.mockRejectedValue(new WorkspaceAccessError('legacy_history_unavailable', 404))
    await request(app()).get(`/sessions/${id}/legacy-history?workspaceId=${workspace}`)
      .expect(404, { error: 'legacy_history_unavailable' })
  })
  it('extracts display prose without thinking, tool content, attachment bodies or tool-bearing narration', () => {
    expect(privateHistoryText([{ type: 'text', text: 'Visible' }, { type: 'thinking', thinking: 'Private' }], 'assistant')).toBe('Visible')
    expect(privateHistoryText([{ type: 'text', text: 'Plan' }, { type: 'tool_use', input: { secret: 'hidden' } }], 'assistant')).toBeNull()
    expect(privateHistoryText([{ type: 'tool_result', content: 'Hidden' }], 'user')).toBeNull()
    expect(privateHistoryText('Hello <attached_file name="private">Hidden</attached_file> world', 'user')).toBe('Hello  world')
    expect(privateHistoryText('<attached_file name="private">Incomplete hidden body', 'user')).toBeNull()
    expect(privateHistoryText({ unexpected: 'Hidden' }, 'assistant')).toBeNull()
  })
})
