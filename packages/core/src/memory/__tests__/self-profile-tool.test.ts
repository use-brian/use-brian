import { describe, it, expect, vi } from 'vitest'
import { createSelfProfileTool } from '../self-profile-tool.js'
import type {
  EntityLinkCreateParams,
  EntityLinkRecord,
  EntityLinksStore,
  EntityRecord,
  EntityStore,
} from '../../entities/types.js'

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
    sourceSessionId: null,
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

// ── Fake EntityLinksStore — records edge creates ──────────────────

function makeFakeLinksStore(): Pick<EntityLinksStore, 'create' | 'walkOutbound'> & {
  create: ReturnType<typeof vi.fn>
} {
  return {
    create: vi.fn(
      async (params: EntityLinkCreateParams): Promise<EntityLinkRecord> =>
        ({
          id: 'edge-1',
          sourceKind: params.sourceKind,
          sourceId: params.sourceId,
          targetKind: params.targetKind,
          targetId: params.targetId,
          edgeType: params.edgeType,
        }) as unknown as EntityLinkRecord,
    ),
    walkOutbound: vi.fn(async () => []),
  }
}

const ctx = {
  userId: 'u1',
  assistantId: 'a1',
  sessionId: 's1',
  workspaceId: 'ws1',
  appId: 'Use Brian',
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

// ── Explicit-links path (self → entity edges) ─────────────────────
// Spec: docs/architecture/brain/explicit-links.md — `updateSelfProfile`
// carries the shared `links` / `closeLinks` fields; a self → org edge
// ("I work at SIDAN" → works_at) anchors from the self entity.

describe('[COMP:brain/self-profile-tool] explicit links', () => {
  const COMPANY_ID = '44444444-4444-4444-8444-444444444444'

  it('writes a self → entity edge anchored on the self entity id', async () => {
    const { store } = makeFakeEntityStore()
    const links = makeFakeLinksStore()
    const tool = createSelfProfileTool(store, links as unknown as EntityLinksStore)
    const result = await tool.execute(
      {
        role: 'Co-founder/CEO',
        links: [{ targetEntityId: COMPANY_ID, edgeType: 'works_at' }],
      },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    expect(links.create).toHaveBeenCalledTimes(1)
    const edge = links.create.mock.calls[0][0]
    expect(edge.sourceKind).toBe('entity')
    expect(edge.sourceId).toBe('self-entity-uuid')
    expect(edge.targetId).toBe(COMPANY_ID)
    expect(edge.edgeType).toBe('works_at')
    expect(String(result.data)).toContain('1 edge linked')
  })

  it('materialises the self entity for a links-only call without an attribute write', async () => {
    const { store } = makeFakeEntityStore()
    const getOrCreateSelf = vi.spyOn(store, 'getOrCreateSelf')
    const updateSelfProfile = vi.spyOn(store, 'updateSelfProfile')
    const links = makeFakeLinksStore()
    const tool = createSelfProfileTool(store, links as unknown as EntityLinksStore)
    const result = await tool.execute(
      { links: [{ targetEntityId: COMPANY_ID, edgeType: 'works_at' }] },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    // No attribute payload → getOrCreateSelf, never updateSelfProfile.
    expect(getOrCreateSelf).toHaveBeenCalledTimes(1)
    expect(updateSelfProfile).not.toHaveBeenCalled()
    expect(links.create).toHaveBeenCalledTimes(1)
    expect(links.create.mock.calls[0][0].sourceId).toBe('self-entity-uuid')
  })

  it('still writes attributes when a links store is absent (edge is a fire-and-forget no-op)', async () => {
    const { store, state } = makeFakeEntityStore()
    const tool = createSelfProfileTool(store)
    const result = await tool.execute(
      {
        role: 'Co-founder/CEO',
        links: [{ targetEntityId: COMPANY_ID, edgeType: 'works_at' }],
      },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    expect(state.attributes.role).toBe('Co-founder/CEO')
  })

  it('rejects a non-UUID link target at the Zod layer', () => {
    const { store } = makeFakeEntityStore()
    const tool = createSelfProfileTool(store)
    const parsed = tool.inputSchema.safeParse({
      name: 'Hinson Wong',
      links: [{ targetEntityId: 'not-a-uuid', edgeType: 'works_at' }],
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects an unknown edgeType at the Zod layer', () => {
    const { store } = makeFakeEntityStore()
    const tool = createSelfProfileTool(store)
    const parsed = tool.inputSchema.safeParse({
      name: 'Hinson Wong',
      links: [{ targetEntityId: COMPANY_ID, edgeType: 'invented_verb' }],
    })
    expect(parsed.success).toBe(false)
  })
})
