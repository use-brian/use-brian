import { describe, it, expect } from 'vitest'
import {
  blocksToPMDoc,
  pmDocToBlocks,
  canonicalizeBlock,
  pageToPlaintext,
} from '../block-mapping.js'
import type { Block } from '@sidanclaw/core/dist/views/blocks.js'
import { ALL_KINDS } from './fixtures.js'

const cell = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

describe('[COMP:doc-model/mapping] block ↔ ProseMirror mapping', () => {
  it('round-trips all 19 block kinds to the canonical form', () => {
    const out = pmDocToBlocks(blocksToPMDoc(ALL_KINDS))
    expect(out).toEqual(ALL_KINDS.map(canonicalizeBlock))
  })

  it('round-trips a heading level 4 (Notion H4)', () => {
    const out = pmDocToBlocks(blocksToPMDoc(ALL_KINDS))
    const h4 = out.find((b) => b.id === 'h4') as { kind: string; level: number }
    expect(h4).toMatchObject({ kind: 'heading', level: 4 })
  })

  it('keeps video + audio embed payloads lossless (url survives)', () => {
    const out = pmDocToBlocks(blocksToPMDoc(ALL_KINDS))
    const video = out.find((b) => b.id === 'vid1') as { kind: string; url: string }
    const audio = out.find((b) => b.id === 'aud1') as { kind: string; url: string }
    expect(video).toMatchObject({ kind: 'video', url: 'https://example.com/clip.mp4' })
    expect(audio).toMatchObject({ kind: 'audio', url: 'https://example.com/voice.mp3' })
  })

  it('preserves every block id in order', () => {
    const out = pmDocToBlocks(blocksToPMDoc(ALL_KINDS))
    expect(out.map((b) => b.id)).toEqual(ALL_KINDS.map((b) => b.id))
  })

  it('groups consecutive same-kind list items into one list, splitting runs', () => {
    const doc = blocksToPMDoc(ALL_KINDS)
    const lists = doc.content.filter((n) =>
      ['bulletList', 'orderedList', 'taskList'].includes(n.type),
    )
    // 2 bulleted + 2 numbered + 2 todo → exactly 3 list wrappers.
    expect(lists.map((l) => l.type)).toEqual([
      'bulletList',
      'orderedList',
      'taskList',
    ])
    expect(lists[0].content).toHaveLength(2)
  })

  it('a paragraph between list items breaks the run', () => {
    const blocks = [
      { kind: 'bulleted_list_item', id: 'a', richText: undefined },
      { kind: 'text', id: 'mid', text: 'break' },
      { kind: 'bulleted_list_item', id: 'b', richText: undefined },
    ] as never[]
    const doc = blocksToPMDoc(blocks)
    expect(doc.content.map((n) => n.type)).toEqual([
      'bulletList',
      'paragraph',
      'bulletList',
    ])
  })

  it('keeps embed payloads lossless (data binding survives)', () => {
    const out = pmDocToBlocks(blocksToPMDoc(ALL_KINDS))
    const data = out.find((b) => b.id === 'data1') as { binding: unknown }
    expect(data.binding).toEqual({ entity: 'tasks', viewType: 'table' })
  })

  it('handles an empty page as a single empty paragraph', () => {
    const doc = blocksToPMDoc([])
    expect(doc.content).toHaveLength(1)
    expect(doc.content[0].type).toBe('paragraph')
  })

  it('maps a table block to native table/row/cell nodes (not an embed)', () => {
    const doc = blocksToPMDoc(ALL_KINDS)
    const table = doc.content.find((n) => n.type === 'table')
    expect(table).toBeDefined()
    // header row → tableHeader; body row → tableCell.
    const row0 = table!.content![0]
    const row1 = table!.content![1]
    expect(row0.content!.map((c) => c.type)).toEqual(['tableHeader', 'tableHeader'])
    expect(row1.content!.map((c) => c.type)).toEqual(['tableCell', 'tableCell'])
    // cells are real paragraph nodes (co-editable), not an opaque JSON string.
    expect(row0.content![0].content![0].type).toBe('paragraph')
  })

  it('recovers header-row + header-column flags on a 2-D table', () => {
    const block: Block = {
      kind: 'table',
      id: 'g',
      hasHeaderRow: true,
      hasHeaderColumn: true,
      rows: [
        [cell(''), cell('Q1'), cell('Q2')],
        [cell('Rev'), cell('10'), cell('20')],
      ],
    } as Block
    const out = pmDocToBlocks(blocksToPMDoc([block]))[0] as Block & {
      hasHeaderRow: boolean
      hasHeaderColumn: boolean
    }
    expect(out.hasHeaderRow).toBe(true)
    expect(out.hasHeaderColumn).toBe(true)
    expect(out).toEqual(canonicalizeBlock(block))
  })

  it('pads a ragged table to a rectangular grid', () => {
    const block: Block = {
      kind: 'table',
      id: 'r',
      rows: [[cell('a'), cell('b')], [cell('c')]],
    } as Block
    const out = pmDocToBlocks(blocksToPMDoc([block]))[0] as Block & {
      rows: unknown[][]
    }
    expect(out.rows.map((row) => row.length)).toEqual([2, 2])
  })

  it('pageToPlaintext emits every table cell, one row per line', () => {
    const text = pageToPlaintext({ blocks: ALL_KINDS })
    expect(text).toContain('Name Role')
    expect(text).toContain('Ana Eng')
  })
})

const rt = (t: string) =>
  ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] }) as never
const bul = (id: string, t: string, indent?: number): Block =>
  ({ kind: 'bulleted_list_item', id, richText: rt(t), ...(indent ? { indent } : {}) }) as Block
const num = (id: string, t: string, indent?: number): Block =>
  ({ kind: 'numbered_list_item', id, richText: rt(t), ...(indent ? { indent } : {}) }) as Block

describe('[COMP:doc-model/mapping] nested list nesting', () => {
  it('nests sub-bullets under their parent item in the PM tree', () => {
    const blocks = [
      bul('a', 'A'),
      bul('b', 'B', 1),
      bul('c', 'C', 1),
      bul('d', 'D'),
    ]
    const doc = blocksToPMDoc(blocks)
    // One top-level bulletList with TWO items (A, D); A carries a nested list.
    expect(doc.content).toHaveLength(1)
    const top = doc.content[0]
    expect(top.type).toBe('bulletList')
    expect(top.content).toHaveLength(2)
    const itemA = top.content![0]
    const nested = itemA.content!.find((n) => n.type === 'bulletList')
    expect(nested).toBeDefined()
    expect(nested!.content).toHaveLength(2) // B, C
  })

  it('round-trips indent depth through the PM tree', () => {
    const blocks = [bul('a', 'A'), bul('b', 'B', 1), num('c', 'C', 2), bul('d', 'D')]
    const out = pmDocToBlocks(blocksToPMDoc(blocks))
    expect(out).toEqual(blocks.map(canonicalizeBlock))
    expect(out.map((b) => (b as { indent?: number }).indent)).toEqual([
      undefined,
      1,
      2,
      undefined,
    ])
    // C is a numbered item nested under bullet B (kind change across depth).
    expect(out[2].kind).toBe('numbered_list_item')
  })

  it('clamps an orphan depth jump to one level under its predecessor', () => {
    // depth 0 then depth 5 → the deep item lands at depth 1, never floating.
    const out = pmDocToBlocks(blocksToPMDoc([bul('a', 'A'), bul('b', 'B', 5)]))
    expect((out[1] as { indent?: number }).indent).toBe(1)
  })

  it('keeps a flat list flat (no indent key) — pre-nesting shape preserved', () => {
    const out = pmDocToBlocks(blocksToPMDoc([bul('a', 'A'), bul('b', 'B')]))
    expect(out).toEqual([
      { kind: 'bulleted_list_item', id: 'a', richText: rt('A') },
      { kind: 'bulleted_list_item', id: 'b', richText: rt('B') },
    ])
  })

  it('pageToPlaintext emits one line per item across nesting', () => {
    const text = pageToPlaintext({ blocks: [bul('a', 'A'), bul('b', 'B', 1), bul('c', 'C')] })
    expect(text.split('\n')).toEqual(['A', 'B', 'C'])
  })
})

describe('[COMP:doc-model/mapping] container children (toggle/callout)', () => {
  it('emits toggle children as trailing node content and recovers them', () => {
    const blocks: Block[] = [
      {
        kind: 'toggle',
        id: 't1',
        expanded: true,
        richText: cell('Summary'),
        children: [
          { kind: 'text', id: 'c1', text: 'inside' },
          { kind: 'bulleted_list_item', id: 'c2', richText: cell('point') },
        ],
      } as Block,
    ]
    const doc = blocksToPMDoc(blocks)
    expect(doc.content[0].type).toBe('toggle')
    // summary paragraph + text paragraph + bulletList
    expect(doc.content[0].content).toHaveLength(3)
    const out = pmDocToBlocks(doc)
    expect(out).toEqual(blocks.map(canonicalizeBlock))
    const children = (out[0] as { children?: Block[] }).children
    expect(children?.map((c) => c.id)).toEqual(['c1', 'c2'])
  })

  it('same for callout children', () => {
    const blocks: Block[] = [
      {
        kind: 'callout',
        id: 'co1',
        icon: '💡',
        richText: cell('Lead'),
        children: [{ kind: 'text', id: 'c1', text: 'detail' }],
      } as Block,
    ]
    const out = pmDocToBlocks(blocksToPMDoc(blocks))
    expect(out).toEqual(blocks.map(canonicalizeBlock))
    expect((out[0] as { children?: Block[] }).children).toHaveLength(1)
  })

  it('a nested toggle inside toggle children round-trips', () => {
    const blocks: Block[] = [
      {
        kind: 'toggle',
        id: 'outer',
        richText: cell('Outer'),
        children: [
          {
            kind: 'toggle',
            id: 'inner',
            richText: cell('Inner'),
            children: [{ kind: 'text', id: 'leaf', text: 'deep' }],
          },
        ],
      } as Block,
    ]
    const out = pmDocToBlocks(blocksToPMDoc(blocks))
    expect(out).toEqual(blocks.map(canonicalizeBlock))
    const outer = out[0] as { children?: Block[] }
    const inner = outer.children?.[0] as { id: string; children?: Block[] }
    expect(inner.id).toBe('inner')
    expect(inner.children?.[0].id).toBe('leaf')
  })

  it('legacy multi-node richText splits: first node stays the summary, the rest derive children', () => {
    const legacy: Block[] = [
      {
        kind: 'toggle',
        id: 't1',
        richText: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Summary' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'body' }] },
          ],
        },
      } as Block,
    ]
    const out = pmDocToBlocks(blocksToPMDoc(legacy))
    const toggle = out[0] as { richText?: { content?: unknown[] }; children?: Block[] }
    expect(toggle.richText?.content).toHaveLength(1)
    expect(toggle.children).toHaveLength(1)
    expect(toggle.children?.[0]).toMatchObject({ kind: 'text', text: 'body' })
  })

  it('a childless toggle keeps its pre-children canonical shape (no children key)', () => {
    const blocks: Block[] = [
      { kind: 'toggle', id: 't1', richText: cell('Only summary') } as Block,
    ]
    const out = pmDocToBlocks(blocksToPMDoc(blocks))
    expect(out).toEqual(blocks.map(canonicalizeBlock))
    expect('children' in (out[0] as object)).toBe(false)
  })

  it('pageToPlaintext gives toggle summary + each child its own line', () => {
    const text = pageToPlaintext({
      blocks: [
        {
          kind: 'toggle',
          id: 't1',
          richText: cell('Summary'),
          children: [{ kind: 'text', id: 'c1', text: 'body' }],
        } as Block,
      ],
    })
    expect(text.split('\n')).toEqual(['Summary', 'body'])
  })
})

describe('[COMP:doc-model/mapping] nested to-dos (TaskItem nested:true)', () => {
  const todo = (id: string, text: string, indent?: number): Block =>
    ({
      kind: 'to_do',
      id,
      checked: false,
      richText: cell(text),
      ...(indent ? { indent } : {}),
    }) as Block

  it('round-trips an indent-tagged to-do run to a nested taskList tree', () => {
    const blocks = [todo('a', 'parent'), todo('b', 'child', 1), todo('c', 'sibling')]
    const doc = blocksToPMDoc(blocks)
    expect(doc.content).toHaveLength(1)
    expect(doc.content[0].type).toBe('taskList')
    // "child" nests as a sub-taskList inside item "a".
    const first = doc.content[0].content![0]
    expect(first.content![1].type).toBe('taskList')
    const out = pmDocToBlocks(doc)
    expect(out).toEqual(blocks.map(canonicalizeBlock))
    expect((out[1] as { indent?: number }).indent).toBe(1)
  })
})
