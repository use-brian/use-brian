import { describe, expect, it, vi } from 'vitest'
import { changeOfficeLifecycle } from '../lifecycle.js'
import type { ResolvedOfficeAccess } from '../access.js'

const access: ResolvedOfficeAccess = { artifactId: 'artifact', workspaceId: 'workspace', mode: 'artifact', role: 'edit', workspaceRole: 'member', lifecycleState: 'active', canView: true, canComment: true, canEdit: true, canRestore: false, canDeletePermanently: false, canElevate: false, canManageSharing: false }
function fixture() {
  return { resolveAccess: vi.fn(async () => access), transition: vi.fn(async () => ({ id: 'artifact', lifecycleState: 'archived' })), revokeOffline: vi.fn(async () => {}) }
}
describe('[COMP:api/office-routes] shared lifecycle service', () => {
  it('preserves native role and workspace boundaries before mutation', async () => {
    const deps = fixture(), input = { userId: 'actor', artifactId: 'artifact', reason: 'Fixture' }
    for (const action of ['restore', 'unarchive', 'purge'] as const) expect(await changeOfficeLifecycle(deps, { ...input, action })).toMatchObject({ status: 404 })
    expect(await changeOfficeLifecycle(deps, { ...input, action: 'archive', workspaceId: 'other' })).toMatchObject({ status: 404 })
    deps.resolveAccess.mockResolvedValue({ ...access, mode: 'session' })
    expect(await changeOfficeLifecycle(deps, { ...input, action: 'archive' })).toMatchObject({ status: 404 })
    expect(deps.transition).not.toHaveBeenCalled()
  })
  it('attributes assistant work and revokes offline access only after a completed transition', async () => {
    const deps = fixture(), input = { userId: 'actor', actorAssistantId: 'assistant', artifactId: 'artifact', action: 'archive' as const, reason: 'Fixture' }
    expect(await changeOfficeLifecycle(deps, input)).toMatchObject({ status: 200 })
    expect(deps.transition).toHaveBeenCalledWith(input)
    expect(deps.revokeOffline).toHaveBeenCalledWith('actor', 'artifact')
    deps.transition.mockResolvedValueOnce(null as never)
    expect(await changeOfficeLifecycle(deps, input)).toEqual({ status: 409, error: 'lifecycle_transition_blocked' })
    expect(deps.revokeOffline).toHaveBeenCalledOnce()
  })
})
