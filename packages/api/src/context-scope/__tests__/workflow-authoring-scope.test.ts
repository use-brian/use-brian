import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthoringAuthority } from '@use-brian/core'
import { resolveWorkflowAuthoringScope } from '../workflow-authority.js'
import { findAssistantById } from '../../db/users.js'
import { query } from '../../db/client.js'
import { resolveOperationCeilingsSystem } from '../../db/workspace-store.js'
import { resolveLiveAccessCeilingSystem, resolveTurnScopeSystem } from '../resolve-turn-scope.js'

vi.mock('../../db/client.js', () => ({ query: vi.fn(), queryWithRLS: vi.fn(), runWithAgentAccess: vi.fn() }))
vi.mock('../../db/users.js', () => ({ findAssistantById: vi.fn() }))
vi.mock('../../db/workspace-store.js', () => ({ resolveOperationCeilingsSystem: vi.fn() }))
vi.mock('../resolve-turn-scope.js', () => ({ resolveLiveAccessCeilingSystem: vi.fn(), resolveTurnScopeSystem: vi.fn() }))
vi.mock('../workflow-input-evidence.js', () => ({ readWorkflowInputEvidence: vi.fn() }))
vi.mock('../caller-evidence.js', () => ({ validateCallerScopeEvidence: vi.fn() }))

const ceiling = { userId: 'user', workspaceId: 'workspace', clearance: 'internal' as const,
  compartments: ['product'], mutationCompartments: ['product'], projectIds: ['project'], visibilityAssistantIds: null }
const authoringAuthority: AuthoringAuthority = { version: 1, assistantId: 'author', ceiling }
const params = { userId: 'user', workspaceId: 'workspace', assistantId: 'executor', authoringAuthority,
  contextGroupId: 'team', contextProjectId: 'project' }
const broad = { ...ceiling, compartments: null, mutationCompartments: null, projectIds: null }

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(findAssistantById).mockImplementation(async (id) => ({ id, workspaceId: 'workspace', clearance: 'internal' }) as never)
  vi.mocked(resolveLiveAccessCeilingSystem).mockResolvedValue(broad)
  vi.mocked(resolveTurnScopeSystem).mockResolvedValue({
    access: { ...broad, assistantId: 'executor', assistantKind: 'standard' },
    effectiveCompartments: null, effectiveProjectIds: null,
    writeCompartments: ['product'], writeProjectIds: ['project'],
    activeGroupId: 'team', activeProjectId: 'project', activeTeam: null, activeProject: null,
  } as never)
})

describe('workflow authoring execution-scope preview', () => {
  it('uses the acting assistant and binding, intersects consent, and never touches run rows', async () => {
    const scope = await resolveWorkflowAuthoringScope(params)
    expect(scope.access).toMatchObject({ ...ceiling, assistantId: 'executor', visibilityAssistantIds: ['executor'] })
    expect(scope.effectiveCompartments).toEqual(['product'])
    expect(scope.effectiveProjectIds).toEqual(['project'])
    expect(resolveLiveAccessCeilingSystem).toHaveBeenCalledWith(expect.objectContaining({ assistant: expect.objectContaining({ id: 'author' }) }))
    expect(resolveTurnScopeSystem).toHaveBeenCalledWith(expect.objectContaining({
      assistant: expect.objectContaining({ id: 'executor' }), key: expect.objectContaining({ contextGroupId: 'team', contextProjectId: 'project' }),
    }), expect.any(Object))
    const options = vi.mocked(resolveTurnScopeSystem).mock.calls[0][1]!
    await options.resolveReadCeilings!('user', 'workspace', 'internal', ['product'])
    expect(resolveOperationCeilingsSystem).toHaveBeenCalledWith('user', 'workspace', 'internal', ['product'], true)
    expect(query).not.toHaveBeenCalled()
  })

  it('fails closed when authoring authority contracts', async () => {
    vi.mocked(resolveLiveAccessCeilingSystem).mockResolvedValue({ ...ceiling, compartments: [] })
    await expect(resolveWorkflowAuthoringScope(params)).rejects.toMatchObject({ reason: 'workflow_authority_unavailable' })
    expect(resolveTurnScopeSystem).not.toHaveBeenCalled()
  })

  it('rejects write defaults outside pinned consent', async () => {
    const scope = await resolveTurnScopeSystem({} as never)
    vi.mocked(resolveTurnScopeSystem).mockResolvedValue({ ...scope, writeCompartments: ['finance'] })
    await expect(resolveWorkflowAuthoringScope(params)).rejects.toMatchObject({ reason: 'workflow_authority_unavailable' })
  })

  it('rejects mismatched actors and unresolved execution contexts', async () => {
    await expect(resolveWorkflowAuthoringScope({ ...params, userId: 'other' })).rejects.toThrow()
    vi.mocked(resolveTurnScopeSystem).mockRejectedValue(new Error('context unavailable'))
    await expect(resolveWorkflowAuthoringScope(params)).rejects.toMatchObject({ reason: 'workflow_authority_unavailable' })
    expect(query).not.toHaveBeenCalled()
  })
})
