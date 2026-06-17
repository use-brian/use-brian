/**
 * [COMP:views/blocks] Page-block schemas — accept/reject + helpers.
 */

import { describe, expect, it } from 'vitest'
import type { AggregateBinding } from '../aggregations.js'
import { blockSchema, dataPage, emptyPage, pageSchema } from '../blocks.js'
import type { BindingConfig } from '../types.js'

const TASKS_TABLE: BindingConfig = { entity: 'tasks', viewType: 'table' }
const TASKS_COUNT_BY_STATUS: AggregateBinding = {
  entity: 'tasks',
  op: 'count_by',
  groupBy: 'status',
}

describe('[COMP:views/blocks] block schemas accept valid shapes', () => {
  it('accepts text block', () => {
    expect(blockSchema.safeParse({ kind: 'text', id: 'b1', text: 'hello' }).success).toBe(true)
  })

  it('accepts heading block', () => {
    expect(blockSchema.safeParse({ kind: 'heading', id: 'b1', level: 2, text: 'Title' }).success).toBe(true)
  })

  it('accepts a level-4 heading (Notion H4)', () => {
    expect(blockSchema.safeParse({ kind: 'heading', id: 'b1', level: 4, text: 'Title' }).success).toBe(true)
  })

  it('accepts video + audio blocks (url-based, empty url allowed)', () => {
    expect(
      blockSchema.safeParse({ kind: 'video', id: 'v1', url: 'https://x/clip.mp4', caption: 'c' }).success,
    ).toBe(true)
    expect(blockSchema.safeParse({ kind: 'audio', id: 'a1', url: '' }).success).toBe(true)
  })

  it('accepts divider block', () => {
    expect(blockSchema.safeParse({ kind: 'divider', id: 'b1' }).success).toBe(true)
  })

  it('accepts data block', () => {
    expect(blockSchema.safeParse({ kind: 'data', id: 'b1', binding: TASKS_TABLE }).success).toBe(true)
  })

  it('accepts chart block (Phase 4 aggregation binding)', () => {
    expect(
      blockSchema.safeParse({
        kind: 'chart',
        id: 'b1',
        chartType: 'bar',
        title: 'Tasks by status',
        binding: TASKS_COUNT_BY_STATUS,
      }).success,
    ).toBe(true)
  })

  it('rejects chart block with a non-aggregation (view-table) binding', () => {
    expect(
      blockSchema.safeParse({
        kind: 'chart',
        id: 'b1',
        chartType: 'bar',
        binding: TASKS_TABLE,
      }).success,
    ).toBe(false)
  })
})

describe('[COMP:views/blocks] model-authored chart data + diagram', () => {
  it('accepts a chart with inline bar data', () => {
    expect(
      blockSchema.safeParse({
        kind: 'chart',
        id: 'b1',
        chartType: 'bar',
        data: { points: [{ label: 'A', value: 3 }] },
      }).success,
    ).toBe(true)
  })

  it('accepts inline line + kpi data', () => {
    expect(
      blockSchema.safeParse({
        kind: 'chart',
        id: 'b1',
        chartType: 'line',
        data: { series: [{ name: 'r', points: [{ x: 'Q1', y: 1 }] }] },
      }).success,
    ).toBe(true)
    expect(
      blockSchema.safeParse({ kind: 'chart', id: 'b2', chartType: 'kpi', data: { value: 42 } }).success,
    ).toBe(true)
  })

  it('rejects a chart carrying BOTH data and binding', () => {
    expect(
      blockSchema.safeParse({
        kind: 'chart',
        id: 'b1',
        chartType: 'bar',
        data: { points: [{ label: 'A', value: 1 }] },
        binding: TASKS_COUNT_BY_STATUS,
      }).success,
    ).toBe(false)
  })

  it('rejects a chart carrying NEITHER data nor binding', () => {
    expect(blockSchema.safeParse({ kind: 'chart', id: 'b1', chartType: 'bar' }).success).toBe(false)
  })

  it('rejects a bar chart whose data has no points', () => {
    expect(
      blockSchema.safeParse({ kind: 'chart', id: 'b1', chartType: 'bar', data: { value: 3 } }).success,
    ).toBe(false)
  })

  it('rejects a kpi chart whose data has no value', () => {
    expect(
      blockSchema.safeParse({
        kind: 'chart',
        id: 'b1',
        chartType: 'kpi',
        data: { points: [{ label: 'A', value: 1 }] },
      }).success,
    ).toBe(false)
  })

  it('rejects a line chart whose series carry no points (lockstep with the render gate)', () => {
    // `series: [{ points: [] }]` passes "has a series" but the renderer can only
    // draw it as a placeholder, so the write boundary must reject it too.
    expect(
      blockSchema.safeParse({
        kind: 'chart',
        id: 'b1',
        chartType: 'line',
        data: { series: [{ name: 'r', points: [] }] },
      }).success,
    ).toBe(false)
  })

  it('nudges toward another block type when a chart has data but nothing to plot', () => {
    const result = blockSchema.safeParse({
      kind: 'chart',
      id: 'b1',
      chartType: 'bar',
      data: { value: 3 },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(' ')
      expect(msg).toMatch(/table, callout, or bulleted-list/)
    }
  })

  it('nudges toward another block type when a chart carries neither data nor binding', () => {
    const result = blockSchema.safeParse({ kind: 'chart', id: 'b1', chartType: 'bar' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message).join(' ')).toMatch(
        /table, callout, or bulleted-list/,
      )
    }
  })

  it('accepts a mermaid diagram block', () => {
    expect(
      blockSchema.safeParse({
        kind: 'diagram',
        id: 'd1',
        syntax: 'mermaid',
        code: 'graph TD; A-->B',
        title: 'Flow',
      }).success,
    ).toBe(true)
  })

  it('rejects a diagram with empty code', () => {
    expect(
      blockSchema.safeParse({ kind: 'diagram', id: 'd1', syntax: 'mermaid', code: '' }).success,
    ).toBe(false)
  })

  it('rejects a diagram with a non-mermaid syntax', () => {
    expect(
      blockSchema.safeParse({ kind: 'diagram', id: 'd1', syntax: 'dot', code: 'digraph{}' }).success,
    ).toBe(false)
  })
})

describe('[COMP:views/blocks] block schemas reject invalid shapes', () => {
  it('rejects unknown kind', () => {
    expect(blockSchema.safeParse({ kind: 'mystery', id: 'b1' }).success).toBe(false)
  })

  it('rejects missing id', () => {
    expect(blockSchema.safeParse({ kind: 'divider' }).success).toBe(false)
  })

  it('clamps an out-of-range numeric heading level instead of rejecting', () => {
    const res = blockSchema.safeParse({ kind: 'heading', id: 'b1', level: 5, text: 'X' })
    expect(res.success).toBe(true)
    if (res.success) expect((res.data as { level: number }).level).toBe(4)
  })

  it('rejects data block with bad binding', () => {
    expect(
      blockSchema.safeParse({ kind: 'data', id: 'b1', binding: { entity: 'companies', viewType: 'board' } }).success,
    ).toBe(false)
  })
})

describe('[COMP:views/blocks] discriminated union surfaces the failing field', () => {
  // A plain z.union reported a contentless "Invalid input" for any bad block,
  // so the chat model could not tell WHAT was wrong and retried patchPage
  // blindly (the 2026-06-04 token burst). discriminatedUnion('kind') routes to
  // the matching member and reports its real field issue.
  it('names `checked` when a to_do block omits it', () => {
    const res = blockSchema.safeParse({ kind: 'to_do', id: 'b1' })
    expect(res.success).toBe(false)
    if (!res.success) {
      const paths = res.error.issues.map(i => i.path.join('.'))
      expect(paths).toContain('checked')
      // ...and does NOT collapse to a top-level invalid_union on the block.
      expect(res.error.issues.every(i => i.code !== 'invalid_union')).toBe(true)
    }
  })

  it('coerces a model-friendly heading level into 1–4', () => {
    const cases: ReadonlyArray<[unknown, number]> = [
      ['1', 1],
      ['h2', 2],
      ['heading_3', 3],
      ['##', 2],
      [9, 4],
      [0, 1],
    ]
    for (const [level, want] of cases) {
      const res = blockSchema.safeParse({ kind: 'heading', id: 'b1', level, text: 'X' })
      expect(res.success).toBe(true)
      if (res.success) expect((res.data as { level: number }).level).toBe(want)
    }
  })

  it('still names `level` when a heading level is unparseable', () => {
    const res = blockSchema.safeParse({ kind: 'heading', id: 'b1', level: {}, text: 'X' })
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(res.error.issues.some(i => i.path.join('.') === 'level')).toBe(true)
    }
  })

  it('still enforces the chart data/binding xor via the union-level refine', () => {
    expect(blockSchema.safeParse({ kind: 'chart', id: 'b1', chartType: 'bar' }).success).toBe(false)
  })
})

describe('[COMP:views/blocks] pageSchema', () => {
  it('accepts empty page', () => {
    expect(pageSchema.safeParse(emptyPage).success).toBe(true)
  })

  it('accepts page with mixed blocks', () => {
    const parsed = pageSchema.safeParse({
      blocks: [
        { kind: 'heading', id: 'h1', level: 1, text: 'My Tasks' },
        { kind: 'text', id: 't1', text: 'Sub-heading paragraph.' },
        { kind: 'divider', id: 'd1' },
        { kind: 'data', id: 'd2', binding: TASKS_TABLE },
      ],
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects non-array blocks', () => {
    expect(pageSchema.safeParse({ blocks: 'not-an-array' }).success).toBe(false)
  })
})

describe('[COMP:views/blocks] dataPage helper', () => {
  it('builds a one-block data page', () => {
    const page = dataPage(TASKS_TABLE, 'block-1')
    expect(page.blocks).toHaveLength(1)
    expect(page.blocks[0]).toEqual({ kind: 'data', id: 'block-1', binding: TASKS_TABLE })
    expect(pageSchema.safeParse(page).success).toBe(true)
  })
})

describe('[COMP:views/blocks] container children (toggle/callout)', () => {
  it('accepts toggle children of any block kind, nested', () => {
    const result = blockSchema.safeParse({
      kind: 'toggle',
      id: 't1',
      expanded: false,
      children: [
        { kind: 'text', id: 'c1', text: 'inside' },
        { kind: 'bulleted_list_item', id: 'c2' },
        {
          kind: 'callout',
          id: 'c3',
          icon: '💡',
          children: [{ kind: 'text', id: 'c4', text: 'deep' }],
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects container nesting past MAX_CONTAINER_DEPTH', () => {
    let block: Record<string, unknown> = { kind: 'toggle', id: 'leaf' }
    for (let i = 0; i < 8; i++) {
      block = { kind: 'toggle', id: `t${i}`, children: [block] }
    }
    const result = blockSchema.safeParse(block)
    expect(result.success).toBe(false)
  })
})
