import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
vi.mock('../../db/client.js', () => ({ query: vi.fn() }))
vi.mock('../../db/users.js', () => ({ getWorkspacePrimaryAssistant: vi.fn() }))
vi.mock('../../db/sessions.js', () => ({ createWorkspaceChatSession: vi.fn() }))
vi.mock('../route-helpers.js', () => ({ resolveUser: vi.fn() }))
vi.mock('../../context-scope/resolve-turn-scope.js', async importOriginal => ({
  ...await importOriginal<object>(), resolveTurnScopeSystem: vi.fn(),
}))
import { sessionRoutes } from '../sessions.js'
import { createWorkspaceChatSession } from '../../db/sessions.js'
import { getWorkspacePrimaryAssistant } from '../../db/users.js'
import { resolveUser } from '../route-helpers.js'
import { query } from '../../db/client.js'
import { WorkspaceAccessError } from '../../workspace-access/policy.js'
import { ContextNotAvailableError } from '../../context-scope/resolve-turn-scope.js'
const userId = '11111111-1111-1111-1111-111111111111'
const workspaceId = '22222222-2222-2222-2222-222222222222'
const assistantId = '33333333-3333-3333-3333-333333333333'
function app(authenticated = true) {
  const server = express(); server.use(express.json())
  server.use((req, _res, next) => { if (authenticated) req.userId = userId; next() })
  server.use('/api/sessions', sessionRoutes()); return server
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(resolveUser).mockResolvedValue({ id: userId } as never)
  vi.mocked(getWorkspacePrimaryAssistant).mockResolvedValue({ id: assistantId, workspaceId } as never)
  vi.mocked(query).mockResolvedValue({ rows: [{ id: assistantId, workspaceId, clearance: 'internal' }] } as never)
  vi.mocked(createWorkspaceChatSession).mockResolvedValue({ id: 'session', assistantId } as never)
})
describe('shared session create transport admission', () => {
  it('preserves omission and revision and marks only the authenticated web path', async () => {
    expect((await request(app()).post('/api/sessions/workspace').send({ workspaceId, expectedPolicyRevision: '12' })).status).toBe(201)
    const params = vi.mocked(createWorkspaceChatSession).mock.calls[0][0]
    expect(params).toMatchObject({ starterUserId: userId, authenticatedHuman: true, expectedPolicyRevision: '12' })
    expect(params).not.toHaveProperty('contextGroupId')
    expect(params).not.toHaveProperty('contextProjectId')
  })
  it('keeps explicit null and never turns a guest fallback or JSON provenance into authenticated approval', async () => {
    expect((await request(app(false)).post('/api/sessions/workspace').send({ workspaceId, contextGroupId: null, authenticatedHuman: true })).status).toBe(201)
    const params = vi.mocked(createWorkspaceChatSession).mock.calls[0][0]
    expect(params).toHaveProperty('contextGroupId', null)
    expect(params).not.toHaveProperty('authenticatedHuman')
    expect(params).not.toHaveProperty('expectedPolicyRevision')
  })
  it.each([
    [new WorkspaceAccessError('access_policy_conflict', 409), 409, 'access_policy_conflict'],
    [new WorkspaceAccessError('context_selection_required', 409), 409, 'context_selection_required'],
    [new WorkspaceAccessError('session_admission_unsupported', 409), 409, 'session_admission_unsupported'],
    [new ContextNotAvailableError('team', 'archived'), 404, 'context_not_available'],
    [{ code: '40P01' }, 409, 'access_policy_conflict'],
  ])('maps admission refusal to stable transport errors (%s)', async (error, status, code) => {
    vi.mocked(createWorkspaceChatSession).mockRejectedValue(error)
    const response = await request(app()).post('/api/sessions/workspace').send({ workspaceId })
    expect(response.status).toBe(status); expect(response.body).toEqual({ error: code })
  })
})
