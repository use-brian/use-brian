import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createKnowledgeTools } from '../base/knowledge.js'
import type { KnowledgeStoreInterface, KnowledgeRepoWriter } from '../../knowledge/types.js'
import type { Tool, ToolContext } from '../types.js'

const mockStore: KnowledgeStoreInterface = {
  search: vi.fn(),
  listByPath: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  listSummaries: vi.fn(),
  updateManualEntryContent: vi.fn(),
  hasEntriesForAssistant: vi.fn(),
  listSourcesForAssistant: vi.fn(),
}

function makeWriter(): KnowledgeRepoWriter {
  return {
    commitEntryUpdate: vi.fn(async () => ({
      ok: true as const, entryId: 'e1', path: 'products/vault', sourceType: 'github' as const, commitSha: 'abc1234', commitUrl: 'https://github.com/o/r/commit/abc1234',
    })),
    commitEntryCreate: vi.fn(async () => ({
      ok: true as const, entryId: 'e2', path: 'docs/new', sourceType: 'github' as const, commitSha: 'def5678', commitUrl: null,
    })),
  }
}

function byName(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`tool ${name} not emitted`)
  return tool
}

const repoEntry = {
  id: 'e1',
  path: 'products/vault',
  title: 'Vault',
  content: 'Old body',
  summary: 'Vault product',
  tags: ['product'],
  relatedIds: [],
  sensitivity: 'internal' as const,
  metadata: {},
  sourceId: 'src1',
}

const ctx: ToolContext = {
  userId: 'u1',
  assistantId: 'a1',
  workspaceId: 't1',
  sessionId: 's1',
  appId: 'Use Brian',
  channelType: 'web',
  channelId: 'c1',
  abortSignal: new AbortController().signal,
}

beforeEach(() => { vi.clearAllMocks() })

describe('[COMP:tools/knowledge] createKnowledgeTools', () => {
  it('returns only the 3 read tools by default', () => {
    const tools = createKnowledgeTools(mockStore)
    expect(tools).toHaveLength(3)
    expect(tools.map((t) => t.name)).toEqual([
      'searchKnowledge',
      'browseKnowledge',
      'readKnowledgeEntry',
    ])
  })

  it('labels the search surface as workspace knowledge base / KB', () => {
    const tools = createKnowledgeTools(mockStore)
    expect(byName(tools, 'searchKnowledge').description).toContain('workspace knowledge base (KB)')
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

    it('a failed search is never reported as an empty knowledge base', async () => {
      vi.mocked(mockStore.search).mockRejectedValueOnce(new Error('ETIMEDOUT'))

      const tools = createKnowledgeTools(mockStore)
      const result = await tools[0].execute({ query: 'vault fees' }, ctx)

      expect(result.isError).toBe(true)
      const data = String(result.data)
      expect(data).toContain('searchKnowledge')
      expect(data).toContain('vault fees')
      expect(data).toMatch(/NOT an empty knowledge base/i)
      expect(data).toMatch(/Retry once/i)
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

      // A real failure (isError), not an empty-result success the model would
      // report as "the knowledge base is empty".
      expect(result.isError).toBe(true)
      expect(result.data).toContain('not attached to a workspace')
      expect(result.data).toContain('do not retry')
      expect(mockStore.search).not.toHaveBeenCalled()
    })
  })

  describe('browseKnowledge', () => {
    it('a failed listing is never reported as an empty knowledge base', async () => {
      vi.mocked(mockStore.listByPath).mockRejectedValueOnce(new Error('ECONNREFUSED'))

      const tools = createKnowledgeTools(mockStore)
      const result = await tools[1].execute({ path: 'products' }, ctx)

      expect(result.isError).toBe(true)
      const data = String(result.data)
      expect(data).toContain('browseKnowledge')
      expect(data).toContain('products')
      expect(data).toMatch(/NOT an empty knowledge base/i)
      expect(data).toMatch(/Retry once/i)
      // The raw client message is kept, but never alone.
      expect(data).toContain('ECONNREFUSED')
    })

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
        sourceId: null,
      })

      const tools = createKnowledgeTools(mockStore)
      const result = await tools[2].execute({ id: 'id1' }, ctx)

      expect(result.data).toMatchObject({
        path: 'products/vault/fees',
        title: 'Fee Structure',
        content: '# Fees\n2% management + 20% performance',
      })
    })

    it('returns error for missing entry, naming the id and how to re-resolve it', async () => {
      vi.mocked(mockStore.getById).mockResolvedValueOnce(null)

      const tools = createKnowledgeTools(mockStore)
      const result = await tools[2].execute({ id: 'missing' }, ctx)

      expect(result.isError).toBe(true)
      const data = String(result.data)
      expect(data).toContain('missing')
      expect(data).toContain('searchKnowledge or browseKnowledge')
      expect(data).toMatch(/above your clearance/i)
      expect(data).toMatch(/Do NOT retry this exact id/i)
    })

    it('a read failure is not reported as a missing entry', async () => {
      vi.mocked(mockStore.getById).mockRejectedValueOnce(new Error('ECONNRESET'))

      const tools = createKnowledgeTools(mockStore)
      const result = await tools[2].execute({ id: 'e1' }, ctx)

      expect(result.isError).toBe(true)
      const data = String(result.data)
      expect(data).toContain('readKnowledgeEntry')
      expect(data).toMatch(/read failure, not a missing entry/i)
      expect(data).toMatch(/Retry once/i)
      expect(data).not.toMatch(/not found/i)
    })
  })

  describe('addKnowledgeEntry', () => {
    const manualCaptureRule = {
      id: 'rule-manual',
      name: 'Pricing research',
      instructions: 'Capture verified pricing changes.',
      targetSourceId: null,
      targetLabel: 'Manual entries',
      pathPrefix: 'research/offers',
      defaultSensitivity: 'public' as const,
    }

    it('keeps both mutation tools absent without write authorization', () => {
      const names = createKnowledgeTools(mockStore, {
        repoConnected: true,
        captureRules: [manualCaptureRule],
      }).map((tool) => tool.name)
      expect(names).not.toContain('addKnowledgeEntry')
      expect(names).not.toContain('updateKnowledgeEntry')
    })

    it('writes to Manual entries even when sources are connected when the matched rule targets manual', async () => {
      vi.mocked(mockStore.create).mockResolvedValueOnce({ id: 'manual-new', path: 'research/offers/student' })
      const tools = createKnowledgeTools(mockStore, {
        repoConnected: true,
        allowWrites: true,
        captureRules: [manualCaptureRule],
      })
      const result = await byName(tools, 'addKnowledgeEntry').execute({
        path: 'research/offers/student',
        title: 'Student offer',
        content: 'Verified offer.',
        captureRuleId: manualCaptureRule.id,
      }, ctx)

      expect(result.isError).toBeUndefined()
      expect(mockStore.create).toHaveBeenCalledWith(expect.objectContaining({
        path: 'research/offers/student',
        sensitivity: 'public',
      }))
    })

    it('rejects an unmatched rule id and an out-of-scope path', async () => {
      const tool = byName(createKnowledgeTools(mockStore, {
        repoConnected: true,
        allowWrites: true,
        captureRules: [manualCaptureRule],
      }), 'addKnowledgeEntry')

      const wrongRule = await tool.execute({
        path: 'research/offers/student', title: 'Student', content: 'Body', captureRuleId: 'other',
      }, ctx)
      expect(wrongRule.isError).toBe(true)
      expect(String(wrongRule.data)).toContain('did not match this turn')

      const wrongPath = await tool.execute({
        path: 'sales/student', title: 'Student', content: 'Body', captureRuleId: manualCaptureRule.id,
      }, ctx)
      expect(wrongPath.isError).toBe(true)
      expect(String(wrongPath.data)).toContain('outside that scope')
      expect(mockStore.create).not.toHaveBeenCalled()
    })

    it('creates an entry when no repo connected, using workspaceId from context', async () => {
      vi.mocked(mockStore.create).mockResolvedValueOnce({ id: 'new1', path: 'docs/new' })

      const tools = createKnowledgeTools(mockStore, { repoConnected: false, allowWrites: true })
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

      const tools = createKnowledgeTools(mockStore, { repoConnected: false, allowWrites: true })
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

      const tools = createKnowledgeTools(mockStore, { repoConnected: false, allowWrites: true })
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

      const tools = createKnowledgeTools(mockStore, { repoConnected: false, allowWrites: true })
      await tools[3].execute(
        { path: 'docs/c', title: 'C', content: 'Body' },
        { ...ctx, sensitivity: accumulator, researchMode: true },
      )

      expect(mockStore.create).toHaveBeenCalledWith(expect.objectContaining({ sensitivity: 'confidential' }))
    })

    it('a create rejected by the source carries its reason verdict', async () => {
      const writer = makeWriter()
      vi.mocked(writer.commitEntryCreate).mockResolvedValueOnce({
        ok: false, reason: 'file_exists', message: 'A file already exists at docs/new.',
      })
      const tools = createKnowledgeTools(mockStore, {
        repoConnected: true,
        allowWrites: true,
        repoWriter: writer,
        writableSources: [{ id: 'src1', repo: 'acme/kb', sourceType: 'github' }],
      })
      const result = await byName(tools, 'addKnowledgeEntry').execute(
        { path: 'docs/new', title: 'New', content: 'Body' },
        ctx,
      )
      expect(result.isError).toBe(true)
      const data = String(result.data)
      expect(data).toContain('(file_exists)')
      expect(data).toMatch(/Do NOT retry the same path/i)
      expect(data).toContain('updateKnowledgeEntry')
    })

    it('a store failure on create says nothing was saved', async () => {
      vi.mocked(mockStore.create).mockRejectedValueOnce(new Error('violates unique constraint'))

      const tools = createKnowledgeTools(mockStore, { repoConnected: false, allowWrites: true })
      const result = await tools[3].execute(
        { path: 'docs/new', title: 'New', content: 'Body' },
        ctx,
      )

      expect(result.isError).toBe(true)
      const data = String(result.data)
      expect(data).toContain('addKnowledgeEntry')
      expect(data).toContain('docs/new')
      expect(data).toContain('violates unique constraint')
      expect(data).toMatch(/Nothing was saved or changed/)
      expect(data).toMatch(/do not tell the user it was saved/i)
    })

    it('does not expose either write tool when repo is connected without authorization', async () => {
      const tools = createKnowledgeTools(mockStore, { repoConnected: true })
      expect(tools.map((tool) => tool.name)).not.toContain('addKnowledgeEntry')
      expect(tools.map((tool) => tool.name)).not.toContain('updateKnowledgeEntry')
      expect(mockStore.create).not.toHaveBeenCalled()
    })

    it('rejects writes when assistant has no team', async () => {
      const tools = createKnowledgeTools(mockStore, { repoConnected: false, allowWrites: true })
      const result = await tools[3].execute(
        { path: 'docs/new', title: 'New', content: 'Body' },
        { ...ctx, workspaceId: null },
      )

      expect(result.isError).toBe(true)
      expect(result.data).toContain('not attached to a workspace')
      expect(mockStore.create).not.toHaveBeenCalled()
    })

    it('commits through the repo writer when a writable source is passed', async () => {
      const writer = makeWriter()
      const tools = createKnowledgeTools(mockStore, {
        repoConnected: true,
        allowWrites: true,
        repoWriter: writer,
        writableSources: [{ id: 'src1', repo: 'acme/kb', sourceType: 'github' }],
        requesterLabel: 'neal@example.com',
      })
      const result = await byName(tools, 'addKnowledgeEntry').execute(
        { path: 'docs/new', title: 'New Doc', content: 'First paragraph of the body.', tags: ['a'] },
        ctx,
      )

      expect(writer.commitEntryCreate).toHaveBeenCalledTimes(1)
      const call = vi.mocked(writer.commitEntryCreate).mock.calls[0][0]
      expect(call).toMatchObject({
        workspaceId: 't1',
        sourceId: 'src1',
        path: 'docs/new',
        requestedBy: { userId: 'u1', label: 'neal@example.com' },
      })
      // Generated frontmatter carries title / description / tags / sensitivity.
      expect(call.fileContent).toContain('title: "New Doc"')
      expect(call.fileContent).toContain('description: "First paragraph of the body."')
      expect(call.fileContent).toContain('tags: ["a"]')
      expect(call.fileContent).toContain('sensitivity: internal')
      expect(call.fileContent).toContain('First paragraph of the body.')
      expect(result.data).toMatchObject({ id: 'e2', commit: 'def5678' })
      expect(mockStore.create).not.toHaveBeenCalled()
    })

    it('writes through the same tool for a local source without commit metadata', async () => {
      const writer = makeWriter()
      vi.mocked(writer.commitEntryCreate).mockResolvedValueOnce({
        ok: true, entryId: 'e-local', path: 'docs/local', sourceType: 'local', commitSha: null, commitUrl: null,
      })
      const tools = createKnowledgeTools(mockStore, {
        repoConnected: true,
        allowWrites: true,
        repoWriter: writer,
        writableSources: [{ id: 'local1', repo: '/srv/kb', sourceType: 'local' }],
      })

      const result = await byName(tools, 'addKnowledgeEntry').execute(
        { path: 'docs/local', title: 'Local', content: 'Body' },
        ctx,
      )

      expect(writer.commitEntryCreate).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'local1' }))
      expect(result.data).toMatchObject({ id: 'e-local', message: 'Knowledge entry created in the local source directory.' })
    })

    it('requires a repo argument when several sources are writable', async () => {
      const writer = makeWriter()
      const tools = createKnowledgeTools(mockStore, {
        repoConnected: true,
        allowWrites: true,
        repoWriter: writer,
        writableSources: [
          { id: 'src1', repo: 'acme/kb', sourceType: 'github' },
          { id: 'src2', repo: 'acme/kb-two', sourceType: 'github' },
        ],
      })
      const missing = await byName(tools, 'addKnowledgeEntry').execute(
        { path: 'docs/new', title: 'New', content: 'Body' },
        ctx,
      )
      expect(missing.isError).toBe(true)
      expect(missing.data).toContain('acme/kb-two')

      const picked = await byName(tools, 'addKnowledgeEntry').execute(
        { path: 'docs/new', title: 'New', content: 'Body', repo: 'acme/kb-two' },
        ctx,
      )
      expect(picked.isError).toBeUndefined()
      expect(vi.mocked(writer.commitEntryCreate).mock.calls[0][0].sourceId).toBe('src2')
    })

    it('stamps the accumulator max into the generated frontmatter', async () => {
      const { SensitivityAccumulator } = await import('../../security/sensitivity.js')
      const accumulator = new SensitivityAccumulator()
      accumulator.note('confidential')

      const writer = makeWriter()
      const tools = createKnowledgeTools(mockStore, {
        repoConnected: true,
        allowWrites: true,
        repoWriter: writer,
        writableSources: [{ id: 'src1', repo: 'acme/kb', sourceType: 'github' }],
      })
      await byName(tools, 'addKnowledgeEntry').execute(
        { path: 'docs/x', title: 'X', content: 'Body', sensitivity: 'public' },
        { ...ctx, sensitivity: accumulator },
      )

      expect(vi.mocked(writer.commitEntryCreate).mock.calls[0][0].fileContent).toContain('sensitivity: confidential')
    })
  })

  describe('updateKnowledgeEntry', () => {
    const writeOpts = () => ({
      repoConnected: true,
      allowWrites: true,
      repoWriter: makeWriter(),
      writableSources: [{ id: 'src1', repo: 'acme/kb', sourceType: 'github' as const }],
      requesterLabel: 'neal@example.com',
    })

    it('is emitted only on interactive surfaces', () => {
      // Interactive + writable repo source → present.
      expect(createKnowledgeTools(mockStore, writeOpts()).map((t) => t.name)).toContain('updateKnowledgeEntry')
      // Interactive + manual-only KB → present (store-side updates).
      expect(createKnowledgeTools(mockStore, { repoConnected: false, allowWrites: true }).map((t) => t.name)).toContain('updateKnowledgeEntry')
      // Non-interactive surface → absent, even with a writer.
      expect(createKnowledgeTools(mockStore, { ...writeOpts(), allowWrites: false }).map((t) => t.name)).not.toContain('updateKnowledgeEntry')
      // Interactive but repo-synced with no writable source → absent.
      expect(createKnowledgeTools(mockStore, { repoConnected: true, allowWrites: true }).map((t) => t.name)).not.toContain('updateKnowledgeEntry')
      // No opts at all (legacy call shape) → absent.
      expect(createKnowledgeTools(mockStore).map((t) => t.name)).not.toContain('updateKnowledgeEntry')
    })

    it('requires confirmation and describes explicit workflow governance', () => {
      const tool = byName(createKnowledgeTools(mockStore, writeOpts()), 'updateKnowledgeEntry')
      expect(tool.requiresConfirmation).toBe(true)
      expect(tool.description).toContain('explicitly configured workflow')
      const add = byName(createKnowledgeTools(mockStore, writeOpts()), 'addKnowledgeEntry')
      expect(add.requiresConfirmation).toBe(true)
      expect(add.description).toContain('explicitly configured workflow')
    })

    it('routes a repo-synced entry through the writer', async () => {
      vi.mocked(mockStore.getById).mockResolvedValueOnce(repoEntry)
      const opts = writeOpts()
      const tools = createKnowledgeTools(mockStore, opts)
      const result = await byName(tools, 'updateKnowledgeEntry').execute(
        { id: 'e1', content: 'New body', changeSummary: 'clarify fees' },
        ctx,
      )

      expect(opts.repoWriter.commitEntryUpdate).toHaveBeenCalledWith({
        workspaceId: 't1',
        entry: { id: 'e1', path: 'products/vault', content: 'Old body', sourceId: 'src1' },
        newBody: 'New body',
        changeSummary: 'clarify fees',
        compartments: [],
        projectIds: [],
        requestedBy: { userId: 'u1', label: 'neal@example.com' },
      })
      expect(result.data).toMatchObject({ id: 'e1', commit: 'abc1234' })
      expect(mockStore.updateManualEntryContent).not.toHaveBeenCalled()
    })

    it('rejects an update whose entry belongs to another capture destination', async () => {
      vi.mocked(mockStore.getById).mockResolvedValueOnce(repoEntry)
      const tools = createKnowledgeTools(mockStore, {
        repoConnected: true,
        allowWrites: true,
        captureRules: [{
          id: 'manual-rule',
          name: 'Manual decisions',
          instructions: 'Capture decisions.',
          targetSourceId: null,
          targetLabel: 'Manual entries',
          pathPrefix: '',
          defaultSensitivity: 'internal',
        }],
      })
      const result = await byName(tools, 'updateKnowledgeEntry').execute({
        id: 'e1', content: 'New body', changeSummary: 'x', captureRuleId: 'manual-rule',
      }, ctx)
      expect(result.isError).toBe(true)
      expect(String(result.data)).toContain('another knowledge destination')
    })

    it('relays writer failures (e.g. staleness) with the reason-specific retry verdict', async () => {
      vi.mocked(mockStore.getById).mockResolvedValueOnce(repoEntry)
      const opts = writeOpts()
      vi.mocked(opts.repoWriter.commitEntryUpdate).mockResolvedValueOnce({
        ok: false, reason: 'stale_entry', message: 'The repository moved ahead of the synced copy.',
      })
      const tools = createKnowledgeTools(mockStore, opts)
      const result = await byName(tools, 'updateKnowledgeEntry').execute(
        { id: 'e1', content: 'New body', changeSummary: 'x' },
        ctx,
      )
      expect(result.isError).toBe(true)
      const data = String(result.data)
      expect(data).toContain('moved ahead')
      expect(data).toContain('(stale_entry)')
      expect(data).toContain('re-read it after the next sync')
      expect(data).toContain('readKnowledgeEntry')
      expect(data).toMatch(/retry once with current content/i)
    })

    it('a push_denied is never retried; an error is retried once', async () => {
      const run = async (reason: 'push_denied' | 'error', message: string) => {
        vi.mocked(mockStore.getById).mockResolvedValueOnce(repoEntry)
        const opts = writeOpts()
        vi.mocked(opts.repoWriter.commitEntryUpdate).mockResolvedValueOnce({ ok: false, reason, message })
        const tools = createKnowledgeTools(mockStore, opts)
        return await byName(tools, 'updateKnowledgeEntry').execute(
          { id: 'e1', content: 'New body', changeSummary: 'x' },
          ctx,
        )
      }

      const denied = await run('push_denied', 'GitHub rejected the write.')
      expect(denied.isError).toBe(true)
      expect(String(denied.data)).toContain('(push_denied)')
      expect(String(denied.data)).toMatch(/never retry/i)
      expect(String(denied.data)).toMatch(/tell the user/i)

      const transient = await run('error', 'GitHub returned 502.')
      expect(transient.isError).toBe(true)
      expect(String(transient.data)).toContain('(error)')
      expect(String(transient.data)).toMatch(/transient/i)
      expect(String(transient.data)).toMatch(/Retry once/i)
      // The two must not read the same way to the model.
      expect(String(transient.data)).not.toBe(String(denied.data))
    })

    it('refuses to update a lower-tier entry after higher-tier reads (no laundering)', async () => {
      const { SensitivityAccumulator } = await import('../../security/sensitivity.js')
      const accumulator = new SensitivityAccumulator()
      accumulator.note('confidential')

      vi.mocked(mockStore.getById).mockResolvedValueOnce(repoEntry) // internal entry
      const opts = writeOpts()
      const tools = createKnowledgeTools(mockStore, opts)
      const result = await byName(tools, 'updateKnowledgeEntry').execute(
        { id: 'e1', content: 'New body', changeSummary: 'x' },
        { ...ctx, sensitivity: accumulator },
      )

      expect(result.isError).toBe(true)
      expect(result.data).toContain('confidential')
      expect(opts.repoWriter.commitEntryUpdate).not.toHaveBeenCalled()
    })

    it('updates a manual entry through the store, body-only', async () => {
      vi.mocked(mockStore.getById).mockResolvedValueOnce({ ...repoEntry, id: 'm1', sourceId: null })
      vi.mocked(mockStore.updateManualEntryContent).mockResolvedValueOnce({ id: 'm1', path: 'products/vault' })

      const tools = createKnowledgeTools(mockStore, { repoConnected: false, allowWrites: true })
      const result = await byName(tools, 'updateKnowledgeEntry').execute(
        { id: 'm1', content: 'New body', changeSummary: 'x' },
        ctx,
      )

      expect(mockStore.updateManualEntryContent).toHaveBeenCalledWith(
        't1',
        'm1',
        'New body',
        { compartments: [], projectIds: [] },
      )
      expect(result.data).toMatchObject({ id: 'm1', path: 'products/vault' })
    })

    it('errors cleanly when the repo entry has no writer on this surface', async () => {
      vi.mocked(mockStore.getById).mockResolvedValueOnce(repoEntry)
      // Manual-only emission (no writer), but the entry turns out repo-synced.
      const tools = createKnowledgeTools(mockStore, { repoConnected: false, allowWrites: true })
      const result = await byName(tools, 'updateKnowledgeEntry').execute(
        { id: 'e1', content: 'New body', changeSummary: 'x' },
        ctx,
      )
      expect(result.isError).toBe(true)
      expect(result.data).toContain('source write-back is unavailable')
    })

    it('a failed pre-read is not reported as a missing entry, and says nothing was written', async () => {
      vi.mocked(mockStore.getById).mockRejectedValueOnce(new Error('ETIMEDOUT'))

      const tools = createKnowledgeTools(mockStore, { repoConnected: false, allowWrites: true })
      const result = await byName(tools, 'updateKnowledgeEntry').execute(
        { id: 'e1', content: 'New body', changeSummary: 'x' },
        ctx,
      )

      expect(result.isError).toBe(true)
      const data = String(result.data)
      expect(data).toContain('updateKnowledgeEntry')
      expect(data).toContain('e1')
      expect(data).toMatch(/Nothing was written/i)
      expect(data).toMatch(/never got as far as the write/i)
      expect(data).not.toMatch(/not found/i)
      // The pre-read runs BEFORE any write, so the mutating-transient line
      // ("the write may or may not have been applied") must never appear.
      expect(data).not.toMatch(/may or may not have been applied/i)
      expect(mockStore.updateManualEntryContent).not.toHaveBeenCalled()
    })

    it('a manual-update store failure says the previous body still stands', async () => {
      vi.mocked(mockStore.getById).mockResolvedValueOnce({ ...repoEntry, id: 'm1', sourceId: null })
      vi.mocked(mockStore.updateManualEntryContent).mockRejectedValueOnce(new Error('deadlock detected'))

      const tools = createKnowledgeTools(mockStore, { repoConnected: false, allowWrites: true })
      const result = await byName(tools, 'updateKnowledgeEntry').execute(
        { id: 'm1', content: 'New body', changeSummary: 'x' },
        ctx,
      )

      expect(result.isError).toBe(true)
      const data = String(result.data)
      expect(data).toContain('updateKnowledgeEntry')
      expect(data).toContain('m1')
      expect(data).toContain('deadlock detected')
      expect(data).toMatch(/still holds its previous body/i)
      expect(data).toMatch(/do not tell the user the change was saved/i)
    })

    it('describes the confirmation with entry title, repo, and preview', async () => {
      vi.mocked(mockStore.getById).mockResolvedValueOnce(repoEntry)
      const tools = createKnowledgeTools(mockStore, writeOpts())
      const lines = await byName(tools, 'updateKnowledgeEntry').describeConfirmation!(
        { id: 'e1', content: 'New body text', changeSummary: 'clarify fees' },
        ctx,
      )
      expect(lines?.join('\n')).toContain('Vault')
      expect(lines?.join('\n')).toContain('acme/kb')
      expect(lines?.join('\n')).toContain('clarify fees')
    })
  })
})
