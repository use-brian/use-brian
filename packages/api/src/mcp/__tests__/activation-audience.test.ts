import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tool, ToolContext } from '@use-brian/agent-runtime/tools/types.js'
const scope = vi.hoisted(() => ({ allowed: true, runtimeAllowed: true }))
vi.mock('../../context-scope/connector-exposure.js', () => ({ connectorExposureAllowed: () => scope.allowed }))
vi.mock('../../application-platform/connector-runtime-authority.js', () => ({
  createConnectorRuntimeAuthority: async () => ({ allows: () => scope.runtimeAllowed, assertCurrent: async () => {},
    execute: async (operation: () => Promise<unknown>) => operation() }),
}))
import { createTurnAuthority } from '../activation.js'
const row = { id: 'instance', provider: 'github', connected: true, scope: 'workspace', userId: null, workspaceId: 'workspace',
  sensitivity: 'internal', compartments: [], projectIds: [], healthStatus: 'ok', config: {} }
const grant = { id: 'grant', instance: row, targetType: 'workspace', targetId: 'workspace' }
const context = { userId: 'actor', assistantId: 'assistant', workspaceId: 'workspace' } as ToolContext
beforeEach(() => { scope.allowed = true; scope.runtimeAllowed = true })
describe('[COMP:api/connector-context] invocation and return connector audience revalidation', () => {
  it.each([false, true])('checks actual current audience before effect and keeps denial sticky (grant=%s)', async granted => {
    const authority = (await createTurnAuthority({ assistantId: 'assistant', assistantTeamId: 'workspace',
      actorIdentity: { channel: 'web', userId: 'actor' }, unavailable: [],
      connectorInstanceStore: { getSystem: async () => row } as never,
      connectorGrantStore: { listForTargetSystem: async () => [grant] } as never }))!
    authority.exposureAllowed((granted ? grant : row) as never)
    const execute = vi.fn(async () => ({ data: 'not released' }))
    const tool = authority.wrapTool({ name: 'fixture', execute } as unknown as Tool)
    scope.allowed = false
    await expect(tool.execute({}, context)).rejects.toMatchObject({ operationMayHaveExecuted: false })
    scope.allowed = true
    await expect(tool.execute({}, context)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(execute).not.toHaveBeenCalled()
  })
  it.each(['ambient', 'runtime'] as const)('checks %s audience on return and marks uncertain execution', async which => {
    const authority = (await createTurnAuthority({ assistantId: 'assistant', assistantTeamId: 'workspace',
      actorIdentity: { channel: 'web', userId: 'actor' }, unavailable: [],
      connectorInstanceStore: { getSystem: async () => row } as never }))!
    authority.exposureAllowed(row as never)
    const tool = authority.wrapTool({ name: 'fixture', execute: async () => {
      if (which === 'ambient') scope.allowed = false; else scope.runtimeAllowed = false
      return { data: 'must not release' }
    } } as unknown as Tool)
    await expect(tool.execute({}, context)).rejects.toMatchObject({ operationMayHaveExecuted: true })
  })
})
