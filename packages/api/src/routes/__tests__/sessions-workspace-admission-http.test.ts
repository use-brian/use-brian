/** Real HTTP router -> session store -> admission, with a synthetic SQL boundary.
 * Native trigger/authority coverage remains in session-admission.integration.test.ts.
 * This test does NOT assert that the current native SQL permits Project rooms.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
vi.mock('../../db/client.js', () => ({ query: vi.fn(), getPool: vi.fn(), applyRLSGucs: vi.fn() }))
vi.mock('../../db/users.js', () => ({ getWorkspacePrimaryAssistant: vi.fn(), getUserAssistant: vi.fn() }))
vi.mock('../route-helpers.js', () => ({ resolveUser: vi.fn() }))
vi.mock('../../context-scope/context-readiness.js', () => ({ assertContextActivationReady: vi.fn() }))
vi.mock('../../workspace-access/admission-policy-read.js', async original => ({ ...await original<object>(), readAdmissionPolicy: vi.fn() }))
vi.mock('../../workspace-access/resource-admission.js', () => ({ admitWorkspaceResource: vi.fn() }))
vi.mock('../../context-scope/resolve-turn-scope.js', async original => ({ ...await original<object>(), resolveTurnScopeSystem: vi.fn() }))
import { sessionRoutes } from '../sessions.js'
import { query, getPool, applyRLSGucs } from '../../db/client.js'
import { getUserAssistant } from '../../db/users.js'
import { resolveUser } from '../route-helpers.js'
import { readAdmissionPolicy } from '../../workspace-access/admission-policy-read.js'
import { admitWorkspaceResource } from '../../workspace-access/resource-admission.js'
import { resolveTurnScopeSystem, ContextNotAvailableError } from '../../context-scope/resolve-turn-scope.js'
const userId = '11111111-1111-4111-8111-111111111111', workspaceId = '22222222-2222-4222-8222-222222222222'
const assistantId = '33333333-3333-4333-8333-333333333333', projectId = '44444444-4444-4444-8444-444444444444'
const labels = [`project:${projectId}`]
let receipt: Record<string, unknown> | undefined
const sql = vi.fn(async (text: string, values?: unknown[]) => {
  if (text.includes('SELECT workspace_id FROM assistants')) return { rows: [{ workspace_id: workspaceId }] }
  if (text.includes('FROM assistants') && !text.includes('INSERT INTO sessions')) return { rows: [{ id: assistantId, workspaceId, clearance: 'internal', defaultWorkspaceGroupId: null }] }
  if (text.includes('FROM workspace_members')) return { rows: [{ user_id: userId }] }
  if (text.includes('FROM project_shared_scopes')) return { rows: [{ exists: 1 }] }
  if (text.includes('session_creation_admission')) { receipt = JSON.parse(values![0] as string); return { rows: [] } }
  if (text.includes('INSERT INTO sessions')) {
    // Emulate exact receipt equality, not PostgreSQL authority checks.
    expect(receipt).toMatchObject({ assistantId: values![0], userId: values![1], channelType: values![2], channelId: values![3], appId: values![4], appOrigin: values![5], workspaceId: values![7], sensitivity: values![8], groupId: values![9], projectId: values![10], compartments: values![11], anchorKind: 'none' })
    return { rows: [{ id: 'session', assistantId, userId, channelId: values![3], channelType: 'web', appOrigin: 'chat', visibility: 'workspace', anchorKind: 'none', contextGroupId: null, contextProjectId: projectId, contextCompartments: labels }] }
  }
  return { rows: [] }
})
const client = { query: sql, release: vi.fn() }
function app() {
  const server = express(); server.use(express.json())
  server.use((req, _res, next) => { req.userId = userId; next() })
  server.use('/api/sessions', sessionRoutes()); return server
}
const post = (patch = {}) => request(app()).post('/api/sessions/workspace').send({ workspaceId, assistantId, contextGroupId: null, contextProjectId: projectId, ...patch })
beforeEach(() => {
  vi.clearAllMocks(); receipt = undefined
  vi.mocked(query).mockImplementation(sql as never)
  vi.mocked(getPool).mockReturnValue({ connect: async () => client } as never)
  vi.mocked(resolveUser).mockResolvedValue({ id: userId } as never)
  vi.mocked(getUserAssistant).mockResolvedValue({ id: assistantId, workspaceId } as never)
  vi.mocked(readAdmissionPolicy).mockResolvedValue({ workspaceId, revision: '7', mode: 'departments', setupState: 'ready', departmentReadV2: true } as never)
  vi.mocked(resolveTurnScopeSystem).mockResolvedValue({ access: { clearance: 'internal', mutationCompartments: labels }, effectiveProjectIds: [projectId] } as never)
  vi.mocked(admitWorkspaceResource).mockResolvedValue({ policyRevision: '7', origin: 'explicit', departmentId: null, envelope: { visibility: 'workspace', sensitivity: 'internal', compartments: labels, projectIds: [projectId] } })
})
describe('Project participants launcher HTTP creation admission', () => {
  it('threads the explicit Project audience through router, admission and INSERT in one transaction', async () => {
    const response = await post()
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    expect(response.body).toMatchObject({ assistantId, contextGroupId: null, contextProjectId: projectId })
    expect(receipt).toMatchObject({ provenance: 'authenticated_chat_root', actor: userId, policyRevision: '7', groupId: null, projectId, compartments: labels })
    expect(applyRLSGucs).toHaveBeenCalledWith(client, userId)
    const statements = sql.mock.calls.map(([text]) => text)
    expect(statements.indexOf('BEGIN')).toBeLessThan(statements.findIndex(text => text.includes('session_creation_admission')))
    expect(statements.at(-1)).toBe('COMMIT')
    expect(client.release).toHaveBeenCalledOnce()
  })
  it.each(['outside_grant', 'assistant_not_participant'] as const)('refuses unauthorized Project participant/assistant (%s), including the locked recheck', async reason => {
    // The HTTP preview succeeds; authority changes before transactional admission.
    vi.mocked(resolveTurnScopeSystem).mockResolvedValueOnce({} as never).mockRejectedValueOnce(new ContextNotAvailableError('project', reason))
    const response = await post()
    expect(response.status).toBe(404)
    expect(receipt).toBeUndefined()
    expect(sql.mock.calls.some(([text]) => text.includes('INSERT INTO sessions'))).toBe(false)
    expect(sql.mock.calls.at(-1)![0]).toBe('ROLLBACK')
  })
  it('preserves stale policy denial without inserting a room', async () => {
    const response = await post({ expectedPolicyRevision: '6' })
    expect(response.status).toBe(409)
    expect(response.body).toEqual({ error: 'access_policy_conflict' })
    expect(receipt).toBeUndefined()
    expect(sql.mock.calls.some(([text]) => text.includes('INSERT INTO sessions'))).toBe(false)
  })
})
