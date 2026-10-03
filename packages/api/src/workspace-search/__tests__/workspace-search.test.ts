import { describe, expect, it } from 'vitest'
import { WORKSPACE_SEARCH_FAMILIES, classifyWorkspaceSearchMatch, type WorkspaceSearchFamily } from '@use-brian/shared'
import { createWorkspaceSearchService, compareSearchCandidates, parseSearchRequest, type SearchAdapter, type SearchAdapters, type SearchCandidate } from '../service.js'

const scope = { userId: 'viewer', workspaceId: 'workspace' }
const candidate = (id: string, kind: WorkspaceSearchFamily = 'pages', title = 'Atlas'): SearchCandidate => ({
  key: `${kind}:${id}`, id, kind, title, snippet: 'Example text', source: kind,
  match: 'exact', relevance: 1, target: { type: 'page', id }, updatedAt: '2026-01-01T00:00:00.000Z',
})
const adapters = (data: Partial<Record<WorkspaceSearchFamily, SearchCandidate[]>> = {}): SearchAdapters =>
  Object.fromEntries(WORKSPACE_SEARCH_FAMILIES.map(family => [family, async ({ offset, limit }: Parameters<SearchAdapter>[0]) =>
    [...(data[family] ?? [])].sort(compareSearchCandidates).slice(offset, offset + limit),
  ])) as SearchAdapters

describe('[COMP:search/workspace-service] Workspace lexical search', () => {
  it('normalizes Unicode and classifies exact, prefix, all-token, partial and body matches including CJK', () => {
    expect(classifyWorkspaceSearchMatch('ＡＴＬＡＳ  Plan', 'atlas plan')).toBe('exact')
    expect(classifyWorkspaceSearchMatch('Atlas roadmap', 'atlas')).toBe('prefix')
    expect(classifyWorkspaceSearchMatch('Quarterly atlas launch plan', 'atlas plan')).toBe('tokens')
    expect(classifyWorkspaceSearchMatch('Atlas roadmap', 'atlas budget')).toBe('partial')
    expect(classifyWorkspaceSearchMatch('Operations', 'atlas')).toBe('body')
    expect(classifyWorkspaceSearchMatch('季度產品計劃', '產品')).toBe('tokens')
    expect(classifyWorkspaceSearchMatch('Everything', ' ')).toBe('body')
  })

  it('enumerates all family pages with no omissions or repeated canonical artifacts', async () => {
    const data = Object.fromEntries(WORKSPACE_SEARCH_FAMILIES.map(family => [family,
      Array.from({ length: 17 }, (_, i) => candidate(String(i).padStart(3, '0'), family)),
    ]))
    const search = createWorkspaceSearchService(adapters(data))
    const keys: string[] = []
    let cursor: string | undefined
    do {
      const page = await search(scope, { q: 'Atlas', limit: 5, cursor })
      expect(page.completeness).toBe('complete')
      keys.push(...page.items.map(item => item.key))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(keys).toHaveLength(17 * WORKSPACE_SEARCH_FAMILIES.length)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual(Object.values(data).flat().sort(compareSearchCandidates).map(item => item.key))
  })

  it('binds signed progress to viewer, workspace, normalized query, and filter', async () => {
    const search = createWorkspaceSearchService(adapters({ pages: [candidate('1'), candidate('2')] }))
    const page = await search(scope, { q: 'Atlas', limit: 1 })
    const cursor = page.nextCursor!
    for (const changed of [{ ...scope, userId: 'other' }, { ...scope, workspaceId: 'other' }]) {
      await expect(search(changed, { q: 'Atlas', cursor })).rejects.toThrow('Invalid workspace search request')
    }
    await expect(search(scope, { q: 'secret', cursor })).rejects.toThrow()
    await expect(search(scope, { q: 'Atlas', kind: 'pages', cursor })).rejects.toThrow()
    await expect(search(scope, { q: 'Atlas', cursor: `${cursor}x` })).rejects.toThrow()
    expect(Buffer.from(cursor.split('.')[0]!, 'base64url').toString()).not.toContain('Atlas')
    expect((await search(scope, { q: ' ＡＴＬＡＳ ', cursor })).items[0]?.id).toBe('2')
  })

  it('bounds failed or non-cooperative sources, cancels work and keeps successful results partial', async () => {
    const sources = adapters({ pages: [candidate('1')] })
    let signal: AbortSignal | undefined
    sources.office = async input => { signal = input.signal; return new Promise(() => {}) }
    sources.files = async () => { throw new Error('source failure with private details') }
    const search = createWorkspaceSearchService(sources, { deadlineMs: 20 })
    const page = await search(scope, { q: 'Atlas' })
    expect(page.items).toHaveLength(1)
    expect(page).toMatchObject({ completeness: 'partial', unavailableFamilies: ['files', 'office'] })
    expect(signal?.aborted).toBe(true)
    expect(JSON.stringify(page)).not.toContain('private details')
  })

  it('caps snippets at 240 Unicode characters and omits internal scoring', async () => {
    const search = createWorkspaceSearchService(adapters({ pages: [{ ...candidate('1'), snippet: '界'.repeat(300) }] }))
    const page = await search(scope, { q: 'Atlas' })
    expect([...page.items[0]!.snippet]).toHaveLength(240)
    expect(page.items[0]).not.toHaveProperty('relevance')
  })

  it('rejects unbounded, malformed and unknown request fields', () => {
    for (const raw of [{}, { q: ' ' }, { q: 'a'.repeat(501) }, { q: ['a'] }, { q: 'a', kind: 'secrets' },
      { q: 'a', limit: '51' }, { q: 'a', limit: '0' }, { q: 'a', limit: '1.5' }, { q: 'a', extra: 'x' }]) {
      expect(() => parseSearchRequest(raw)).toThrow()
    }
    expect(parseSearchRequest({ q: ' 界 ' })).toEqual({ q: '界', limit: 30 })
  })
})
