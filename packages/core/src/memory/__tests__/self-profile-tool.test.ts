import { describe, it, expect } from 'vitest'
import { createSelfProfileTool } from '../self-profile-tool.js'
import type { EntityStore, EntityRecord } from '../../entities/types.js'

// ── Fake EntityStore — only implements the calls the tool reaches ──

function makeFakeEntityStore(initialAttrs: Record<string, unknown> = {}): {
  store: EntityStore
  state: { attributes: Record<string, unknown>; lastDisplayName: string | null }
} {
  const state: { attributes: Record<string, unknown>; lastDisplayName: string | null } = {
    attributes: { self: true, ...initialAttrs },
    lastDisplayName: null,
  }
  const baseEntity = (): EntityRecord => ({
    id: 'self-entity-uuid',
    kind: 'person',
    displayName: state.lastDisplayName ?? 'You',
    canonicalId: null,
    aliases: [],
    sensitivity: 'internal',
    userId: 'u1',
    assistantId: null,
    workspaceId: 'ws1',
    createdByUserId: 'u1',
    createdByAssistantId: null,
    sourceEpisodeId: null,
    source: 'user',
    verifiedByUserId: null,
    verifiedAt: null,
    validFrom: new Date(),
    validTo: null,
    supersededBy: null,
    retractedAt: null,
    retractedReason: null,
    retractedBy: null,
    attributes: { ...state.attributes },
    centrality: 0,
    centralityComputedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  const store: Partial<EntityStore> = {
    async getOrCreateSelf(params) {
      state.lastDisplayName = params.displayName
      return baseEntity()
    },
    async updateSelfProfile(params) {
      state.lastDisplayName = params.displayName
      // Mirror the prod store: JSONB || means top-level keys overwrite.
      state.attributes = { ...state.attributes, ...params.attributes }
      return baseEntity()
    },
  }
  return { store: store as EntityStore, state }
}

const ctx = {
  userId: 'u1',
  assistantId: 'a1',
  sessionId: 's1',
  workspaceId: 'ws1',
  appId: 'sidanclaw',
  channelType: 'web' as const,
  channelId: 'c1',
  abortSignal: new AbortController().signal,
}

describe('[COMP:brain/self-profile-tool] updateSelfProfile', () => {
  it('writes named typed fields and extras to self entity attributes', async () => {
    const { store, state } = makeFakeEntityStore()
    const tool = createSelfProfileTool(store)
    const result = await tool.execute(
      { name: 'Hinson Wong', role: 'Co-founder/CEO', company: 'DeltaDeFi', extra: { handle: 'hinsonsidan' } },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    expect(state.attributes.name).toBe('Hinson Wong')
    expect(state.attributes.role).toBe('Co-founder/CEO')
    expect(state.attributes.company).toBe('DeltaDeFi')
    expect(state.attributes.handle).toBe('hinsonsidan')
  })

  it('rejects calls with no fields and no sources', async () => {
    const { store } = makeFakeEntityStore()
    const tool = createSelfProfileTool(store)
    const result = await tool.execute({}, ctx)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('No attributes provided')
  })

  it('appends + dedupes sources on the self entity', async () => {
    const { store, state } = makeFakeEntityStore({
      sources: ['https://github.com/HinsonSIDAN'],
    })
    const tool = createSelfProfileTool(store)
    const result = await tool.execute(
      {
        role: 'Co-founder/CEO',
        sources: [
          'https://github.com/HinsonSIDAN', // duplicate of existing
          'https://linkedin.com/in/hinson-wong-cfa',
          'https://x.com/sidan_lab',
        ],
      },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    expect(state.attributes.role).toBe('Co-founder/CEO')
    expect(state.attributes.sources).toEqual([
      'https://github.com/HinsonSIDAN',
      'https://linkedin.com/in/hinson-wong-cfa',
      'https://x.com/sidan_lab',
    ])
  })

  it('accepts a sources-only update — the research-provenance path', async () => {
    const { store, state } = makeFakeEntityStore()
    const tool = createSelfProfileTool(store)
    const result = await tool.execute(
      { sources: ['https://github.com/HinsonSIDAN'] },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    expect(state.attributes.sources).toEqual(['https://github.com/HinsonSIDAN'])
  })

  it('errors when workspace context is missing', async () => {
    const { store } = makeFakeEntityStore()
    const tool = createSelfProfileTool(store)
    const result = await tool.execute(
      { name: 'Hinson Wong' },
      { ...ctx, workspaceId: undefined as unknown as string },
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('workspace context')
  })
})
