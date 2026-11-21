import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'
vi.mock('../admission-policy-read.js', async original => ({ ...await original<object>(), readAdmissionPolicy: vi.fn() }))
vi.mock('../resource-admission.js', () => ({ admitWorkspaceResource: vi.fn() }))
vi.mock('../../context-scope/resolve-turn-scope.js', async original => ({ ...await original<object>(), resolveTurnScopeSystem: vi.fn() }))
import { readAdmissionPolicy } from '../admission-policy-read.js'
import { admitWorkspaceResource } from '../resource-admission.js'
import { resolveTurnScopeSystem, ContextNotAvailableError } from '../../context-scope/resolve-turn-scope.js'
import { admitSessionCreate } from '../session-create-admission.js'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const projectId = '22222222-2222-4222-8222-222222222222'
const groupId = '33333333-3333-4333-8333-333333333333'
const input = { workspaceId, assistantId: 'assistant', userId: 'participant', channelType: 'web', channelId: 'fresh', appOrigin: 'chat', contextGroupId: null, contextProjectId: projectId }
const compartments = [`project:${projectId}`]
function database() {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (sql.includes('SELECT workspace_id FROM assistants')) return { rows: [{ workspace_id: workspaceId }] }
    if (sql.includes('FROM workspace_members')) return { rows: [{ user_id: input.userId }] }
    if (sql.includes('FROM assistants')) return { rows: [{ id: input.assistantId, workspaceId, clearance: 'internal', defaultWorkspaceGroupId: groupId, defaultProjectId: null }] }
    if (sql.includes('FROM project_shared_scopes')) return { rows: [{ exists: 1 }] }
    return { rows: [] }
  })
  return { query }
}
function receipt(db: ReturnType<typeof database>) {
  const call = db.query.mock.calls.find(([sql]) => sql.includes('session_creation_admission'))
  return call ? JSON.parse(call[1]![0] as string) : undefined
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(readAdmissionPolicy).mockResolvedValue({ workspaceId, revision: '9', mode: 'departments', setupState: 'ready', departmentReadV2: true, defaultDepartmentId: groupId, defaultCompartment: `team:${groupId}` })
  vi.mocked(resolveTurnScopeSystem).mockResolvedValue({ access: { clearance: 'internal', mutationCompartments: compartments }, effectiveProjectIds: [projectId] } as never)
  vi.mocked(admitWorkspaceResource).mockResolvedValue({ policyRevision: '9', origin: 'explicit', departmentId: null, envelope: { visibility: 'workspace', sensitivity: 'internal', compartments, projectIds: [projectId] } })
})
describe('shared chat creation provenance in ready v2', () => {
  it('mints the exact transaction-local Project receipt, without adding a Department', async () => {
    const db = database()
    const admitted = await admitSessionCreate(db as unknown as PoolClient, input, true)
    expect(admitted).toMatchObject({ contextGroupId: null, contextProjectId: projectId, contextCompartments: compartments, effectiveClearance: 'internal' })
    expect(receipt(db)).toEqual({ protocol: '1', provenance: 'authenticated_chat_root', workspaceId, policyRevision: '9', actor: input.userId, assistantId: input.assistantId, userId: input.userId, channelType: 'web', channelId: 'fresh', appId: 'Use Brian', appOrigin: 'chat', visibility: 'workspace', mode: null, anchorKind: 'none', sensitivity: 'internal', groupId: null, projectId, compartments })
    expect(db.query.mock.calls.find(([sql]) => sql.includes('session_creation_admission'))![0]).toContain('$1,true)')
    expect(resolveTurnScopeSystem).toHaveBeenCalledWith(expect.objectContaining({ userId: input.userId, assistant: expect.objectContaining({ id: input.assistantId }), session: { contextGroupId: null, contextProjectId: projectId } }), expect.anything())
    expect(admitWorkspaceResource).toHaveBeenCalledWith(db, workspaceId, input.userId, expect.objectContaining({ destination: { kind: 'project', projectId } }))
  })
  it.each(['outside_grant', 'assistant_not_participant'] as const)('does not mint a receipt when Project authority fails: %s', async reason => {
    const db = database()
    vi.mocked(resolveTurnScopeSystem).mockRejectedValue(new ContextNotAvailableError('project', reason))
    await expect(admitSessionCreate(db as unknown as PoolClient, input, true)).rejects.toMatchObject({ code: 'context_not_available' })
    expect(receipt(db)).toBeUndefined()
    expect(admitWorkspaceResource).not.toHaveBeenCalled()
  })
  it.each([
    [{ expectedPolicyRevision: '8' }, true, 'access_policy_conflict'],
    [{ contextGroupId: groupId }, true, 'project_context_department_conflict'],
    [{}, false, 'session_admission_unsupported'],
    [{ appOrigin: 'studio' }, true, 'session_admission_unsupported'],
    [{ workspaceId: groupId }, true, 'context_not_available'],
  ])('preserves mismatch and unverified caller denial (%s)', async (patch, human, code) => {
    const db = database()
    await expect(admitSessionCreate(db as unknown as PoolClient, { ...input, ...patch }, human)).rejects.toMatchObject({ code })
    expect(receipt(db)).toBeUndefined()
  })
  it('does not turn read/oversight reach into Project mutation authority', async () => {
    const db = database()
    vi.mocked(resolveTurnScopeSystem).mockResolvedValue({ access: { clearance: 'internal', mutationCompartments: [] }, effectiveProjectIds: [projectId] } as never)
    await expect(admitSessionCreate(db as unknown as PoolClient, input, true)).rejects.toMatchObject({ code: 'context_not_available' })
    expect(receipt(db)).toBeUndefined()
  })
  it.each([true, false])('uses v2 assistant context and only classic simple policy defaults (%s)', async departmentReadV2 => {
    const db = database()
    const policyGroup = '66666666-6666-4666-8666-666666666666'
    vi.mocked(readAdmissionPolicy).mockResolvedValue({ workspaceId, revision: '9', mode: 'simple', setupState: 'ready', departmentReadV2, defaultDepartmentId: policyGroup } as never)
    await admitSessionCreate(db as unknown as PoolClient, { ...input, contextProjectId: null, contextGroupId: undefined }, true)
    expect(resolveTurnScopeSystem).toHaveBeenCalledWith(expect.objectContaining({
      session: { contextGroupId: departmentReadV2 ? groupId : policyGroup, contextProjectId: null },
    }), expect.anything())
    expect(receipt(db)?.provenance).toBe('authenticated_chat_root')
  })
  it('leaves legacy creation receipt-free', async () => {
    vi.mocked(readAdmissionPolicy).mockResolvedValue({ workspaceId, revision: '9', mode: 'departments', setupState: 'legacy', departmentReadV2: true } as never)
    const db = database()
    expect(await admitSessionCreate(db as unknown as PoolClient, input, false)).toEqual(input)
    expect(receipt(db)).toBeUndefined()
  })
})
