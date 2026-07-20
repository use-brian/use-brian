/**
 * Tests for the always-on `findPage` discovery/read tool.
 *
 * Covers the pure title ranker (tier ordering + tie-break + exclusion + limit)
 * and the tool's three modes: search-by-title, one-shot search+content, and
 * read-by-id, plus the guard rails (no workspace, no input, page-not-found).
 *
 * [COMP:doc/find-page]
 */

import { describe, it, expect } from 'vitest'
import {
  createFindPageTool,
  rankPagesByTitle,
  type FindPageToolDeps,
} from '../find-page.js'
import { markdownToBlocks } from '../markdown.js'
import type { SavedViewListRow } from '../../views/types.js'

const WS = 'ws-1'
const USER = 'user-1'

function row(name: string, id: string, updatedAt = new Date('2026-01-01T00:00:00Z')): SavedViewListRow {
  return {
    id,
    workspaceId: WS,
    name,
    nameOrigin: 'user',
    description: null,
    icon: null,
    entity: 'tasks',
    viewType: 'table',
    state: 'saved',
    nestParentId: null,
    position: 0,
    updatedAt,
  }
}

function ctx(overrides: { workspaceId?: string | null } = {}) {
  return {
    userId: USER,
    assistantId: 'a',
    sessionId: 's',
    appId: 'Use Brian',
    channelType: 'web',
    channelId: 'web-1',
    workspaceId: overrides.workspaceId === undefined ? WS : overrides.workspaceId,
    abortSignal: new AbortController().signal,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function deps(
  rows: SavedViewListRow[],
  pages: Record<string, { blocks: unknown[]; title: string }> = {},
): FindPageToolDeps {
  return {
    savedViewStore: { list: async () => rows },
    docPageStore: {
      getVersionedPage: async (_userId: string, id: string) =>
        pages[id]
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ({ page: { blocks: pages[id].blocks } as any, version: 1, title: pages[id].title, nameOrigin: 'user', icon: null } as any)
          : null,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('[COMP:doc/find-page] rankPagesByTitle', () => {
  it('orders exact > prefix > substring > token-overlap and excludes non-matches', () => {
    const rows = [
      row('Roadmap', 'unrelated'),
      row('Worker daily summary', 'token'),
      row('Archived: Worker Maintenance Log', 'substring'),
      row('Worker Maintenance Log v2', 'prefix'),
      row('Worker Maintenance Log', 'exact'),
    ]
    const ranked = rankPagesByTitle(rows, 'Worker Maintenance Log')
    expect(ranked.map((r) => r.id)).toEqual(['exact', 'prefix', 'substring', 'token'])
    // 'Roadmap' shares no token with the query → excluded entirely.
    expect(ranked.find((r) => r.id === 'unrelated')).toBeUndefined()
  })

  it('breaks ties toward the more recently updated page', () => {
    const older = row('Worker notes', 'older', new Date('2026-01-01T00:00:00Z'))
    const newer = row('Worker notes', 'newer', new Date('2026-06-01T00:00:00Z'))
    const ranked = rankPagesByTitle([older, newer], 'worker log')
    expect(ranked.map((r) => r.id)).toEqual(['newer', 'older'])
  })

  it('respects the limit and returns [] for an empty query', () => {
    const rows = [row('Worker one', 'a'), row('Worker two', 'b'), row('Worker three', 'c')]
    expect(rankPagesByTitle(rows, 'worker', 2)).toHaveLength(2)
    expect(rankPagesByTitle(rows, '   ')).toEqual([])
  })
})

describe('[COMP:doc/find-page] findPage tool', () => {
  it('search by title returns ranked matches with pageId + title', async () => {
    const tool = createFindPageTool(
      deps([row('Worker Maintenance Log', 'p1'), row('Roadmap', 'p2')]),
    )
    const res = await tool.execute({ title: 'Worker Maintenance Log' }, ctx())
    expect(res.isError).toBeFalsy()
    const data = res.data as { matches: { pageId: string; title: string }[] }
    expect(data.matches).toEqual([{ pageId: 'p1', title: 'Worker Maintenance Log', icon: null, state: 'saved', updatedAt: expect.any(String) }])
  })

  it('includeContent with exactly one match returns the page markdown', async () => {
    const blocks = markdownToBlocks('# BLOCKERS\n\nNeed the prod API key')
    const tool = createFindPageTool(
      deps([row('Worker Maintenance Log', 'p1')], {
        p1: { blocks, title: 'Worker Maintenance Log' },
      }),
    )
    const res = await tool.execute(
      { title: 'Worker Maintenance Log', includeContent: true },
      ctx(),
    )
    const data = res.data as { content?: { markdown: string; truncated: boolean } }
    expect(data.content?.markdown).toContain('BLOCKERS')
    expect(data.content?.truncated).toBe(false)
  })

  it('includeContent with multiple matches returns no content (disambiguate first)', async () => {
    const tool = createFindPageTool(
      deps([row('Worker log A', 'a'), row('Worker log B', 'b')]),
    )
    const res = await tool.execute({ title: 'Worker log', includeContent: true }, ctx())
    const data = res.data as { matches: unknown[]; content?: unknown }
    expect(data.matches.length).toBe(2)
    expect(data.content).toBeUndefined()
  })

  it('read by pageId returns the page content', async () => {
    const blocks = markdownToBlocks('# Notes\n\nbody text')
    const tool = createFindPageTool(deps([], { p9: { blocks, title: 'My Page' } }))
    const res = await tool.execute({ pageId: 'p9' }, ctx())
    const data = res.data as { match: { pageId: string; title: string }; content: { markdown: string } }
    expect(data.match).toEqual({ pageId: 'p9', title: 'My Page' })
    expect(data.content.markdown).toContain('body text')
  })

  it('read by unknown pageId is an error', async () => {
    const tool = createFindPageTool(deps([]))
    const res = await tool.execute({ pageId: 'missing' }, ctx())
    expect(res.isError).toBe(true)
  })

  it('errors when neither title nor pageId is given', async () => {
    const tool = createFindPageTool(deps([]))
    const res = await tool.execute({}, ctx())
    expect(res.isError).toBe(true)
  })

  it('errors when the turn has no workspace', async () => {
    const tool = createFindPageTool(deps([row('Worker Maintenance Log', 'p1')]))
    const res = await tool.execute({ title: 'Worker Maintenance Log' }, ctx({ workspaceId: null }))
    expect(res.isError).toBe(true)
  })
})
