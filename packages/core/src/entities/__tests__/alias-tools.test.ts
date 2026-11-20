import { describe, expect, it, vi } from 'vitest'
import { createEntityAliasTools } from '../alias-tools.js'
import type { EntityRecord } from '../types.js'
import type { ToolContext } from '@use-brian/agent-runtime/tools/types.js'

const context: ToolContext = {
  userId: 'user-1', assistantId: 'assistant-1', workspaceId: 'workspace-1',
  assistantKind: 'standard', sessionId: 'session-1', channelType: 'web',
  clearance: 'internal', compartments: ['team'], projectIds: [],
  appId: 'test-app', channelId: 'chat-1', abortSignal: new AbortController().signal,
}
const entity = {
  id: 'entity-1', displayName: 'Morgan Vale', aliases: ['momo'],
} as EntityRecord

function setup() {
  const store = {
    addAlias: vi.fn().mockResolvedValue({ kind: 'ok', entity }),
    removeAlias: vi.fn().mockResolvedValue({ ...entity, aliases: [] }),
  }
  const tools = Object.fromEntries(createEntityAliasTools(store).map((tool) => [tool.name, tool]))
  return { store, tools }
}

describe('[COMP:crm/native-aliases] native alias tools without reclassification', () => {
  it('needs only native alias storage and returns persisted fields without renaming', async () => {
    const { store, tools } = setup()
    const result = await tools.noteAlias!.execute({ entity_id: entity.id, alias: 'Momo' }, context)
    expect(result.isError).not.toBe(true)
    expect(result.data).toEqual({ entityId: entity.id, displayName: 'Morgan Vale', aliases: ['momo'] })
    expect(store.addAlias).toHaveBeenCalledWith(context.userId, entity.id, 'Momo', {
      workspaceId: context.workspaceId, userId: context.userId, assistantId: context.assistantId,
      assistantKind: 'standard', clearance: 'internal', compartments: ['team'], projectIds: [],
    })
    expect(tools.noteAlias!.description).toContain('CRM contact')
    expect(tools.noteAlias!.description).toContain('never append an alias')
  })

  it('removes only the alias through the same access projection', async () => {
    const { store, tools } = setup()
    const result = await tools.splitAlias!.execute({ entity_id: entity.id, alias: 'Momo' }, context)
    expect(result.data).toEqual({ entityId: entity.id, displayName: 'Morgan Vale', aliases: [] })
    expect(store.removeAlias.mock.calls[0]?.[3]).toMatchObject({ workspaceId: 'workspace-1', clearance: 'internal' })
  })

  it('reports conflict as a decision, never a successful update or automatic merge', async () => {
    const { store, tools } = setup()
    store.addAlias.mockResolvedValue({ kind: 'conflict', conflictingEntityId: 'entity-2' })
    const result = await tools.noteAlias!.execute({ entity_id: entity.id, alias: 'Momo' }, context)
    expect(result.isError).toBe(true)
    expect(result.data).toContain('Nothing was changed')
    expect(result.data).toContain('Ask the user whether these are the same entity')
    expect(store.removeAlias).not.toHaveBeenCalled()
  })

  it('does not claim success on an inaccessible target or failed persistence', async () => {
    const { store, tools } = setup()
    store.addAlias.mockResolvedValueOnce({ kind: 'not_found' })
    expect((await tools.noteAlias!.execute({ entity_id: entity.id, alias: 'Momo' }, context)).isError).toBe(true)
    store.addAlias.mockRejectedValueOnce(new Error('storage unavailable'))
    expect((await tools.noteAlias!.execute({ entity_id: entity.id, alias: 'Momo' }, context)).isError).toBe(true)
  })

  it('requires a workspace before either mutation', async () => {
    const { store, tools } = setup()
    for (const tool of Object.values(tools)) {
      expect((await tool.execute({ entity_id: entity.id, alias: 'Momo' }, { ...context, workspaceId: null })).isError).toBe(true)
    }
    expect(store.addAlias).not.toHaveBeenCalled()
    expect(store.removeAlias).not.toHaveBeenCalled()
  })
})
