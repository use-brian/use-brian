import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DepartmentReadGrant, ToolContext } from '@use-brian/core'
import type { AccessSnapshot } from '../../context-scope/reference-predicate.js'

vi.mock('../../db/workspace-store.js', () => ({ getWorkspaceMembershipWithReadScopeSystem: vi.fn() }))
vi.mock('../../db/client.js', () => ({ query: vi.fn() }))
vi.mock('../../db/agent-access-context.js', () => ({ currentAgentAccess: vi.fn() }))
vi.mock('../../context-scope/department-resolver.js', async (original) => ({
  ...await original<typeof import('../../context-scope/department-resolver.js')>(), loadDepartmentSnapshot: vi.fn(),
}))
import { getWorkspaceMembershipWithReadScopeSystem } from '../../db/workspace-store.js'
import { currentAgentAccess } from '../../db/agent-access-context.js'
import { loadDepartmentSnapshot } from '../../context-scope/department-resolver.js'
import { resolveBrowserProfileDepartmentRead } from '../profile-authority.js'

const context = { userId: 'user-1', workspaceId: 'workspace-1', assistantId: 'assistant-1' } as ToolContext
const pin: DepartmentReadGrant = { workspaceId: 'workspace-1', userId: 'user-1', assistantId: 'assistant-1',
  base: 'public', departments: { 'department-1': 'internal' }, contextDepartment: 'department-1', binding: ['department-1'], cap: 'internal' }
let snapshot: AccessSnapshot

beforeEach(() => {
  vi.resetAllMocks()
  snapshot = { workspaceId: 'workspace-1', base: { 'user:user-1': 'public', 'assistant:assistant-1': 'public' }, edges: [
    { principal: { kind: 'user', id: 'user-1' }, departmentId: 'department-1', clearance: 'confidential', expiresAt: null },
    { principal: { kind: 'assistant', id: 'assistant-1' }, departmentId: 'department-1', clearance: 'confidential', expiresAt: null },
  ] }
  const access = { snapshot, principal: { kind: 'user' as const, id: 'user-1' } }
  vi.mocked(getWorkspaceMembershipWithReadScopeSystem).mockResolvedValue({ role: 'member', clearance: 'public', compartments: [], projectIds: [], departmentAccess: access })
  vi.mocked(loadDepartmentSnapshot).mockImplementation(async () => access)
  vi.mocked(currentAgentAccess).mockReturnValue({ clearance: 'public', departmentRead: pin })
})

describe('[COMP:sandbox/profiles] current agent profile authority', () => {
  it('retains credential tier, binding and context instead of widening to fresh edges', async () => {
    expect(await resolveBrowserProfileDepartmentRead(context)).toEqual(pin)
  })
  it('renews human and assistant edges and honors expiry after an earlier admission', async () => {
    expect((await resolveBrowserProfileDepartmentRead(context))?.departments).toEqual({ 'department-1': 'internal' })
    snapshot.edges[0].expiresAt = new Date(0)
    expect((await resolveBrowserProfileDepartmentRead(context))?.departments).toEqual({})
    snapshot.edges[0].expiresAt = null
    snapshot.edges = snapshot.edges.slice(0, 1)
    expect((await resolveBrowserProfileDepartmentRead(context))?.departments).toEqual({})
  })
  it('requires current membership even with a previously trusted pin', async () => {
    vi.mocked(getWorkspaceMembershipWithReadScopeSystem).mockResolvedValue(null)
    await expect(resolveBrowserProfileDepartmentRead(context)).rejects.toThrow('authority_unavailable')
  })
  it('refuses a v2 caller without a trusted pin', async () => {
    vi.mocked(currentAgentAccess).mockReturnValue(undefined)
    await expect(resolveBrowserProfileDepartmentRead(context)).rejects.toThrow('authority_unavailable')
  })
  it.each(['workspaceId', 'userId', 'assistantId'] as const)('refuses a mismatched %s', async (field) => {
    vi.mocked(currentAgentAccess).mockReturnValue({ clearance: 'public', departmentRead: { ...pin, [field]: 'other' } })
    await expect(resolveBrowserProfileDepartmentRead(context)).rejects.toThrow('authority_unavailable')
  })
})
