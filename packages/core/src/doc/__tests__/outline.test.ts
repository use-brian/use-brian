/**
 * [COMP:doc/outline] Pure outline builder — projects a page into
 * the compact `Outline` shape the chat envelope embeds.
 */

import { describe, expect, it } from 'vitest'
import { buildOutline, computePatchDelta } from '../outline.js'
import { outlineSchema } from '../page-schemas.js'
import type {
  Block,
  ChartBlock,
  DataBlock,
  HeadingBlock,
  TextBlock,
  VersionedPage,
} from '../page-types.js'

// ── helpers ──────────────────────────────────────────────────────────

const headingBlock = (id: string, text: string, level: 1 | 2 | 3 = 1): HeadingBlock => ({
  kind: 'heading',
  id,
  level,
  text,
})

const textBlock = (id: string, text: string): TextBlock => ({
  kind: 'text',
  id,
  text,
})

const dataBlock = (id: string, columns?: string[]): DataBlock =>
  ({
    kind: 'data',
    id,
    binding: {
      entity: 'tasks',
      viewType: 'table',
      ...(columns ? { columns: columns as DataBlock['binding']['columns'] } : {}),
    } as DataBlock['binding'],
  }) as DataBlock

const chartBlock = (id: string, title?: string): ChartBlock => ({
  kind: 'chart',
  id,
  chartType: 'bar',
  ...(title ? { title } : {}),
  binding: {
    entity: 'tasks',
    op: 'count_by',
    groupBy: 'status',
  },
})

// ── tests ────────────────────────────────────────────────────────────

describe('[COMP:doc/outline] empty page', () => {
  it('returns an outline with zero entries', () => {
    const page: VersionedPage = { blocks: [], version: 1, title: 'Untitled' }
    const out = buildOutline(page, { pageId: 'page-1' })
    expect(out.pageId).toBe('page-1')
    expect(out.pageVersion).toBe(1)
    expect(out.title).toBe('Untitled')
    expect(out.blocks).toEqual([])
  })

  it('round-trips through outlineSchema', () => {
    const page: VersionedPage = { blocks: [], version: 1, title: '' }
    const out = buildOutline(page, { pageId: 'page-1' })
    const parsed = outlineSchema.parse(out)
    expect(parsed).toEqual(out)
  })
})

describe('[COMP:doc/outline] single block — position label + preview', () => {
  it('labels the only heading as "heading #1"', () => {
    const page: VersionedPage = {
      blocks: [headingBlock('h1', 'Welcome')],
      version: 1,
      title: '',
    }
    const out = buildOutline(page, { pageId: 'p' })
    expect(out.blocks).toHaveLength(1)
    expect(out.blocks[0]).toMatchObject({
      id: 'h1',
      kind: 'heading',
      positionLabel: 'heading #1',
    })
    expect(out.blocks[0].preview).toContain('Welcome')
  })

  it('labels a text block as "text #1"', () => {
    const page: VersionedPage = {
      blocks: [textBlock('p1', 'Hello world')],
      version: 1,
      title: '',
    }
    const out = buildOutline(page, { pageId: 'p' })
    expect(out.blocks[0]).toMatchObject({
      id: 'p1',
      kind: 'text',
      positionLabel: 'text #1',
      preview: 'Hello world',
    })
  })
})

describe('[COMP:doc/outline] multiple blocks of same kind', () => {
  it('increments position counters per kind independently', () => {
    const page: VersionedPage = {
      blocks: [
        headingBlock('h1', 'First'),
        textBlock('p1', 'p one'),
        headingBlock('h2', 'Second'),
        textBlock('p2', 'p two'),
        textBlock('p3', 'p three'),
      ],
      version: 1,
      title: '',
    }
    const out = buildOutline(page, { pageId: 'p' })
    expect(out.blocks.map(e => e.positionLabel)).toEqual([
      'heading #1',
      'text #1',
      'heading #2',
      'text #2',
      'text #3',
    ])
  })
})

describe('[COMP:doc/outline] data block — dataMeta', () => {
  it('populates dataMeta with entityTypeRef', () => {
    const page: VersionedPage = {
      blocks: [dataBlock('d1')],
      version: 1,
      title: '',
    }
    const out = buildOutline(page, { pageId: 'p' })
    expect(out.blocks[0].kind).toBe('data')
    expect(out.blocks[0].dataMeta).toEqual({ entityTypeRef: 'tasks' })
  })

  it('populates dataMeta.propertyList when binding has columns', () => {
    const page: VersionedPage = {
      blocks: [dataBlock('d1', ['title', 'status', 'due'])],
      version: 1,
      title: '',
    }
    const out = buildOutline(page, { pageId: 'p' })
    expect(out.blocks[0].dataMeta?.propertyList).toEqual([
      'title',
      'status',
      'due',
    ])
  })

  it('preview names the entity and view type', () => {
    const page: VersionedPage = {
      blocks: [dataBlock('d1')],
      version: 1,
      title: '',
    }
    const out = buildOutline(page, { pageId: 'p' })
    expect(out.blocks[0].preview).toContain('tasks')
    expect(out.blocks[0].preview).toContain('table')
  })
})

describe('[COMP:doc/outline] preview truncation', () => {
  it('truncates a long text block preview at 80 chars and ends with ellipsis', () => {
    const long = 'a'.repeat(200)
    const page: VersionedPage = {
      blocks: [textBlock('p1', long)],
      version: 1,
      title: '',
    }
    const out = buildOutline(page, { pageId: 'p' })
    expect(out.blocks[0].preview.length).toBeLessThanOrEqual(80)
    expect(out.blocks[0].preview.endsWith('…')).toBe(true)
  })

  it('does not truncate strings at or below the limit', () => {
    const exact = 'x'.repeat(80)
    const page: VersionedPage = {
      blocks: [textBlock('p1', exact)],
      version: 1,
      title: '',
    }
    const out = buildOutline(page, { pageId: 'p' })
    expect(out.blocks[0].preview).toBe(exact)
    expect(out.blocks[0].preview.endsWith('…')).toBe(false)
  })

  it('uses only the first line of multiline text', () => {
    const page: VersionedPage = {
      blocks: [textBlock('p1', 'first line\nsecond line\nthird')],
      version: 1,
      title: '',
    }
    const out = buildOutline(page, { pageId: 'p' })
    expect(out.blocks[0].preview).toBe('first line')
  })
})

describe('[COMP:doc/outline] non-text block previews', () => {
  it('emits empty preview for divider', () => {
    const page: VersionedPage = {
      blocks: [{ kind: 'divider', id: 'd1' } as Block],
      version: 1,
      title: '',
    }
    const out = buildOutline(page, { pageId: 'p' })
    expect(out.blocks[0].preview).toBe('')
  })

  it('emits chart-shaped preview for chart blocks', () => {
    const page: VersionedPage = {
      blocks: [chartBlock('c1', 'Counts')],
      version: 1,
      title: '',
    }
    const out = buildOutline(page, { pageId: 'p' })
    expect(out.blocks[0].preview).toMatch(/chart/)
    expect(out.blocks[0].preview).toMatch(/tasks/)
    expect(out.blocks[0].preview).toMatch(/Counts/)
  })
})

describe('[COMP:doc/outline] metadata defaults + overrides', () => {
  it('reads pageVersion / title from a VersionedPage when meta omits them', () => {
    const page: VersionedPage = {
      blocks: [headingBlock('h1', 'X')],
      version: 7,
      title: 'From Page',
    }
    const out = buildOutline(page)
    expect(out.pageVersion).toBe(7)
    expect(out.title).toBe('From Page')
  })

  it('meta overrides take priority over page fields', () => {
    const page: VersionedPage = {
      blocks: [],
      version: 1,
      title: 'Page Title',
    }
    const out = buildOutline(page, {
      pageId: 'p',
      pageVersion: 99,
      title: 'Override',
    })
    expect(out.pageVersion).toBe(99)
    expect(out.title).toBe('Override')
  })
})

describe('[COMP:doc/outline] child_page block', () => {
  it('labels and previews a child_page block', () => {
    const page: VersionedPage = {
      blocks: [
        { kind: 'child_page', id: 'cp1', childPageId: 'child-123' } as Block,
      ],
      version: 1,
      title: '',
    }
    const out = buildOutline(page, { pageId: 'p' })
    expect(out.blocks[0]).toMatchObject({
      id: 'cp1',
      kind: 'child_page',
      positionLabel: 'child_page #1',
    })
    expect(out.blocks[0].preview).toContain('child page')
    expect(out.blocks[0].preview).toContain('child-123')
  })
})

describe('[COMP:doc/outline] schema round-trip on mixed page', () => {
  it('result of buildOutline parses through outlineSchema', () => {
    const page: VersionedPage = {
      blocks: [
        headingBlock('h1', 'Top'),
        textBlock('p1', 'paragraph'),
        dataBlock('d1', ['title', 'status']),
        chartBlock('c1', 'My chart'),
        { kind: 'divider', id: 'div1' } as Block,
      ],
      version: 2,
      title: 'Mixed',
    }
    const out = buildOutline(page, { pageId: 'page-1' })
    const parsed = outlineSchema.parse(out)
    expect(parsed).toEqual(out)
  })

  // Regression: `outlineEntrySchema` must enumerate EVERY Block kind that
  // `buildOutline` can emit. It previously dropped image/file/bookmark/
  // child_page, so an outline containing them failed the round-trip even
  // though buildOutline produced it. Cover all kinds here.
  it('round-trips an outline that contains every block kind', () => {
    const page: VersionedPage = {
      blocks: [
        { kind: 'text', id: 'b-text', text: 'x' },
        { kind: 'heading', id: 'b-head', level: 1, text: 'x' },
        { kind: 'divider', id: 'b-div' },
        dataBlock('b-data'),
        chartBlock('b-chart'),
        { kind: 'callout', id: 'b-callout', icon: '💡' },
        { kind: 'code', id: 'b-code', language: 'ts', code: 'const x = 1' },
        { kind: 'quote', id: 'b-quote' },
        { kind: 'bulleted_list_item', id: 'b-bul' },
        { kind: 'numbered_list_item', id: 'b-num' },
        { kind: 'to_do', id: 'b-todo', checked: false },
        { kind: 'toggle', id: 'b-toggle' },
        { kind: 'image', id: 'b-img', ref: null },
        { kind: 'file', id: 'b-file', ref: null },
        { kind: 'bookmark', id: 'b-book', url: 'https://example.com' },
        { kind: 'video', id: 'b-video', url: 'https://example.com/c.mp4', caption: 'demo' },
        { kind: 'audio', id: 'b-audio', url: 'https://example.com/v.mp3' },
        { kind: 'heading', id: 'b-head4', level: 4, text: 'deep' },
        { kind: 'child_page', id: 'b-child', childPageId: 'child-1' },
      ] as Block[],
      version: 3,
      title: 'All kinds',
    }
    const out = buildOutline(page, { pageId: 'page-all' })
    expect(out.blocks).toHaveLength(19)
    const video = out.blocks.find((b) => b.id === 'b-video')
    expect(video?.preview).toContain('video')
    expect(video?.preview).toContain('demo')
    const parsed = outlineSchema.parse(out)
    expect(parsed).toEqual(out)
  })
})

describe('[COMP:doc/outline] computePatchDelta — only touched blocks', () => {
  // The delta is filtered out of the COMMITTED outline (so positionLabels stay
  // correct over the whole page), not rebuilt from a subset of blocks.
  const committedOutline = (blocks: Block[]) =>
    buildOutline({ blocks, version: 2, title: 't' }, { pageId: 'p', pageVersion: 2 })

  it('reports an added block in changed (absent pre, present post)', () => {
    const pre = [textBlock('a', 'one')]
    const post = [textBlock('a', 'one'), textBlock('b', 'two')]
    const delta = computePatchDelta(pre, post, committedOutline(post))
    expect(delta.changed.map((e) => e.id)).toEqual(['b'])
    expect(delta.removed).toEqual([])
  })

  it('reports an edited block in changed (content changed) with correct positionLabel', () => {
    const pre = [headingBlock('h', 'Old'), textBlock('a', 'one'), textBlock('b', 'two')]
    const post = [headingBlock('h', 'Old'), textBlock('a', 'one'), textBlock('b', 'EDITED')]
    const delta = computePatchDelta(pre, post, committedOutline(post))
    expect(delta.changed.map((e) => e.id)).toEqual(['b'])
    // positionLabel reflects the block's position in the WHOLE page (text #2),
    // not a subset rebuilt in isolation (which would mislabel it text #1).
    expect(delta.changed[0].positionLabel).toBe('text #2')
    expect(delta.removed).toEqual([])
  })

  it('reports a removed block in removed (present pre, absent post)', () => {
    const pre = [textBlock('a', 'one'), textBlock('b', 'two')]
    const post = [textBlock('a', 'one')]
    const delta = computePatchDelta(pre, post, committedOutline(post))
    expect(delta.changed).toEqual([])
    expect(delta.removed).toEqual(['b'])
  })

  it('handles a combined add + edit + delete in one patch', () => {
    const pre = [textBlock('a', 'one'), textBlock('b', 'two')]
    const post = [textBlock('a', 'ONE'), textBlock('c', 'three')] // a edited, b removed, c added
    const delta = computePatchDelta(pre, post, committedOutline(post))
    expect(new Set(delta.changed.map((e) => e.id))).toEqual(new Set(['a', 'c']))
    expect(delta.removed).toEqual(['b'])
  })

  it('a pure no-op (identical pre/post) yields an empty delta', () => {
    const blocks = [textBlock('a', 'one'), headingBlock('h', 'H')]
    const delta = computePatchDelta(blocks, blocks, committedOutline(blocks))
    expect(delta.changed).toEqual([])
    expect(delta.removed).toEqual([])
  })

  it('a pure move (same ids + content, reordered) yields an empty delta', () => {
    // Order changes but no block was added/edited/deleted — the live outline
    // reflects the new order next turn, so the delta carries nothing.
    const pre = [textBlock('a', 'one'), textBlock('b', 'two')]
    const post = [textBlock('b', 'two'), textBlock('a', 'one')]
    const delta = computePatchDelta(pre, post, committedOutline(post))
    expect(delta.changed).toEqual([])
    expect(delta.removed).toEqual([])
  })
})
