import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createKnowledgeTools } from '../base/knowledge.js'
import type { KnowledgeStoreInterface } from '../../knowledge/types.js'
import type { ToolContext } from '../types.js'

const mockStore: KnowledgeStoreInterface = {
  search: vi.fn(),
  listByPath: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  listSummaries: vi.fn(),
  hasEntriesForAssistant: vi.fn(),
  listSourcesForAssistant: vi.fn(),
}

const ctx: ToolContext = {
  userId: 'u1',
  assistantId: 'a1',
  workspaceId: 't1',
  sessionId: 's1',
  appId: 'sidanclaw',
  channelType: 'web',
  channelId: 'c1',
  abortSignal: new AbortController().signal,
}

beforeEach(() => { vi.clearAllMocks() })

describe('[COMP:tools/knowledge] createKnowledgeTools', () => {
  it('returns 4 tools', () => {
    const tools = createKnowledgeTools(mockStore)
    expect(tools).toHaveLength(4)
    expect(tools.map((t) => t.name)).toEqual([
      'searchKnowledge',
      'browseKnowledge',
      'readKnowledgeEntry',
      'addKnowledgeEntry',
    ])
  })

  describe('searchKnowledge', () => {
    it('calls store.search with AccessContext built from tool context', async () => {
      vi.mocked(mockStore.search).mockResolvedValueOnce([
        { id: '12345678-abcd', path: 'products/vault', title: 'Vault', summary: 'Vault product', tags: ['product'], sensitivity: 'internal' },
      ])

      const tools = createKnowledgeTools(mockStore)
      const result = await tools[0].execute({ query: 'vault' }, ctx)

      expect(mockStore.search).toHaveBeenCalledWith(
        { workspaceId: 't1', userId: 'u1', assistantId: 'a1', assistantKind: 'standard', clearance: undefined },
        'vault',
        10,
      )
      expect(result.data).toEqual([
        { id: '12345678-abcd', path: 'products/vault', title: 'Vault', summary: 'Vault product', tags: ['product'] },
      ])
    })

    it('returns guidance when no results found', async () => {
      vi.mocked(mockStore.search).mockResolvedValueOnce([])

      const tools = createKnowledgeTools(mockStore)
      const result = await tools[0].execute({ query: 'nonexistent' }, ctx)

      expect(result.data).toContain('No knowledge entries found')
    })

    it('short-circuits when assistant has no team', async () => {
      const tools = createKnowledgeTools(mockStore)
      const result = await tools[0].execute({ query: 'anything' }, { ...ctx, workspaceId: null })

      expect(result.data).toContain('not in a team')
      expect(mockStore.search).not.toHaveBeenCalled()
    })
  })

  describe('browseKnowledge', () => {
    it('lists top-level when no path given', async () => {
      vi.mocked(mockStore.listByPath).mockResolvedValueOnce([
        { id: 'id1', path: 'products', title: 'Products', summary: 'All products', tags: [], sensitivity: 'internal' },
      ])

      const tools = createKnowledgeTools(mockStore)
      const result = await tools[1].execute({}, ctx)

      expect(mockStore.listByPath).toHaveBeenCalledWith(
        { workspaceId: 't1', userId: 'u1', assistantId: 'a1', assistantKind: 'standard', clearance: undefined },
        '',
      )
      expect(result.data).toHaveLength(1)
    })

    it('drills into a specific path', async () => {
      vi.mocked(mockStore.listByPath).mockResolvedValueOnce([
        { id: 'id2', path: 'products/vault', title: 'Vault', summary: 'Vault desc', tags: [], sensitivity: 'internal' },
      ])

      const tools = createKnowledgeTools(mockStore)
      await tools[1].execute({ path: 'products' }, ctx)

      expect(mockStore.listByPath).toHaveBeenCalledWith(
        { workspaceId: 't1', userId: 'u1', assistantId: 'a1', assistantKind: 'standard', clearance: undefined },
        'products',
      )
    })
  })

  describe('readKnowledgeEntry', () => {
    it('returns full content for an entry', async () => {
      vi.mocked(mockStore.getById).mockResolvedValueOnce({
        id: 'id1',
        path: 'products/vault/fees',
        title: 'Fee Structure',
        content: '# Fees\n2% management + 20% performance',
        summary: 'Vault fee structure',
        tags: ['vault', 'fees'],
        relatedIds: ['id2'],
        sensitivity: 'internal',
        metadata: { status: 'current' },
      })

      const tools = createKnowledgeTools(mockStore)
      const result = await tools[2].execute({ id: 'id1' }, ctx)

      expect(result.data).toMatchObject({
        path: 'products/vault/fees',
        title: 'Fee Structure',
        content: '# Fees\n2% management + 20% performance',
      })
    })

    it('returns error for missing entry', async () => {
      vi.mocked(mockStore.getById).mockResolvedValueOnce(null)

      const tools = createKnowledgeTools(mockStore)
      const result = await tools[2].execute({ id: 'missing' }, ctx)

      expect(result.isError).toBe(true)
    })
  })

  describe('addKnowledgeEntry', () => {
    it('creates an entry when no repo connected, using workspaceId from context', async () => {
      vi.mocked(mockStore.create).mockResolvedValueOnce({ id: 'new1', path: 'docs/new' })

      const tools = createKnowledgeTools(mockStore, { repoConnected: false })
      const result = await tools[3].execute(
        { path: 'docs/new', title: 'New Doc', content: 'Content here' },
        ctx,
      )

      expect(result.data).toMatchObject({ id: 'new1', path: 'docs/new', sensitivity: 'internal' })
      expect(mockStore.create).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 't1', sensitivity: 'internal' }))
    })

    it('stamps the entry at the accumulator max when it exceeds the requested tier', async () => {
      const { SensitivityAccumulator } = await import('../../security/sensitivity.js')
      const accumulator = new SensitivityAccumulator()
      accumulator.note('confidential')

      vi.mocked(mockStore.create).mockResolvedValueOnce({ id: 'new2', path: 'docs/x' })

      const tools = createKnowledgeTools(mockStore, { repoConnected: false })
      await tools[3].execute(
        { path: 'docs/x', title: 'X', content: 'Body', sensitivity: 'public' },
        { ...ctx, sensitivity: accumulator },
      )

      expect(mockStore.create).toHaveBeenCalledWith(expect.objectContaining({ sensitivity: 'confidential' }))
    })

    it('stamps research-mode findings public despite internal brain-first reads', async () => {
      // Research provenance is the public web. The brain-first orientation
      // reads (default internal) must not over-restrict the finding.
      const { SensitivityAccumulator } = await import('../../security/sensitivity.js')
      const accumulator = new SensitivityAccumulator()
      accumulator.note('internal')

      vi.mocked(mockStore.create).mockResolvedValueOnce({ id: 'new3', path: 'docs/r' })

      const tools = createKnowledgeTools(mockStore, { repoConnected: false })
      await tools[3].execute(
        { path: 'docs/r', title: 'R', content: 'Body' },
        { ...ctx, sensitivity: accumulator, researchMode: true },
      )

      expect(mockStore.create).toHaveBeenCalledWith(expect.objectContaining({ sensitivity: 'public' }))
    })

    it('keeps confidential a hard floor even in research mode', async () => {
      const { SensitivityAccumulator } = await import('../../security/sensitivity.js')
      const accumulator = new SensitivityAccumulator()
      accumulator.note('confidential')

      vi.mocked(mockStore.create).mockResolvedValueOnce({ id: 'new4', path: 'docs/c' })

      const tools = createKnowledgeTools(mockStore, { repoConnected: false })
      await tools[3].execute(
        { path: 'docs/c', title: 'C', content: 'Body' },
        { ...ctx, sensitivity: accumulator, researchMode: true },
      )

      expect(mockStore.create).toHaveBeenCalledWith(expect.objectContaining({ sensitivity: 'confidential' }))
    })

    it('rejects writes when repo is connected', async () => {
      const tools = createKnowledgeTools(mockStore, { repoConnected: true })
      const result = await tools[3].execute(
        { path: 'docs/new', title: 'New', content: 'Body' },
        ctx,
      )

      expect(result.isError).toBe(true)
      expect(result.data).toContain('synced from a GitHub repository')
      expect(mockStore.create).not.toHaveBeenCalled()
    })

    it('rejects writes when assistant has no team', async () => {
      const tools = createKnowledgeTools(mockStore, { repoConnected: false })
      const result = await tools[3].execute(
        { path: 'docs/new', title: 'New', content: 'Body' },
        { ...ctx, workspaceId: null },
      )

      expect(result.isError).toBe(true)
      expect(result.data).toContain('not in a team')
      expect(mockStore.create).not.toHaveBeenCalled()
    })
  })
})
