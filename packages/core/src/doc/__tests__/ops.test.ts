/**
 * [COMP:doc/ops] Pure ops executor — `applyOps` / `invertOps` /
 * `validateOps`. Round-trip property: applying inverse after apply
 * returns the original page.
 */

import { describe, expect, it } from 'vitest'
import { applyOps, invertOps, validateOps } from '../ops.js'
import { opSchema } from '../page-schemas.js'
import type {
  Block,
  HeadingBlock,
  Op,
  Page,
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

/** Make a fresh sequential id generator for deterministic tests. */
const makeIdGen = (prefix = 'gen') => {
  let i = 0
  return () => `${prefix}-${++i}`
}

// ── applyOps ─────────────────────────────────────────────────────────

describe('[COMP:doc/ops] applyOps — add', () => {
  it('adds a block at start of empty page', () => {
    const page: Page = { blocks: [] }
    const { page: out, idMap } = applyOps(
      page,
      [{ op: 'add', after: 'start', block: headingBlock('tmp-1', 'Hi') }],
      makeIdGen(),
    )
    expect(out.blocks).toHaveLength(1)
    expect(out.blocks[0].id).toBe('gen-1')
    expect((out.blocks[0] as HeadingBlock).text).toBe('Hi')
    expect(idMap['tmp-1']).toBe('gen-1')
  })

  it('appends with after: end', () => {
    const page: Page = {
      blocks: [headingBlock('b1', 'one'), headingBlock('b2', 'two')],
    }
    const { page: out } = applyOps(
      page,
      [{ op: 'add', after: 'end', block: textBlock('tmp-1', 'tail') }],
      makeIdGen(),
    )
    expect(out.blocks.map(b => b.id)).toEqual(['b1', 'b2', 'gen-1'])
  })

  it('appends when after is omitted', () => {
    const page: Page = {
      blocks: [headingBlock('b1', 'one'), headingBlock('b2', 'two')],
    }
    const { page: out } = applyOps(
      page,
      // No `after` — should behave identically to `after: 'end'`.
      [{ op: 'add', block: textBlock('tmp-1', 'tail') }],
      makeIdGen(),
    )
    expect(out.blocks.map(b => b.id)).toEqual(['b1', 'b2', 'gen-1'])
  })

  it('a run of anchor-less adds lands in document order (scaffold path)', () => {
    // Regression for the production "anchor block tmp-* not found" storm: the
    // model emits a sequence of `add` ops with no `after` to build a page
    // top-to-bottom. Each appends at the current end, so order is preserved
    // without any tmp-anchor chaining.
    const page: Page = { blocks: [] }
    const { page: out } = applyOps(
      page,
      [
        { op: 'add', block: headingBlock('tmp-h', 'Title') },
        { op: 'add', block: textBlock('tmp-1', 'first') },
        { op: 'add', block: textBlock('tmp-2', 'second') },
        { op: 'add', block: textBlock('tmp-3', 'third') },
      ],
      makeIdGen(),
    )
    expect(out.blocks.map(b => (b as TextBlock).text)).toEqual([
      'Title',
      'first',
      'second',
      'third',
    ])
  })

  it('validateOps accepts anchor-less adds', () => {
    const page: Page = { blocks: [] }
    const ops: Op[] = [
      { op: 'add', block: headingBlock('tmp-h', 'Title') },
      { op: 'add', block: textBlock('tmp-1', 'body') },
    ]
    expect(validateOps(page, ops)).toEqual({ valid: true })
    // And the schema accepts the omitted-anchor shape at the tool boundary.
    expect(opSchema.safeParse(ops[0]).success).toBe(true)
  })

  it('inserts after a named block id', () => {
    const page: Page = {
      blocks: [headingBlock('b1', 'one'), headingBlock('b2', 'two')],
    }
    const { page: out } = applyOps(
      page,
      [{ op: 'add', after: 'b1', block: textBlock('tmp-1', 'middle') }],
      makeIdGen(),
    )
    expect(out.blocks.map(b => b.id)).toEqual(['b1', 'gen-1', 'b2'])
  })

  it('does not mutate the input page', () => {
    const page: Page = { blocks: [headingBlock('b1', 'one')] }
    const beforeLen = page.blocks.length
    applyOps(
      page,
      [{ op: 'add', after: 'end', block: textBlock('tmp-1', 'x') }],
      makeIdGen(),
    )
    expect(page.blocks.length).toBe(beforeLen)
  })

  it('appends at end when an add anchor block id is unknown (no throw)', () => {
    // A genuinely-missing `after` anchor degrades to append-at-end rather than
    // failing the whole patch — the block still lands on the page. Failing the
    // patch forced the model to re-send everything and retry (a major driver
    // of the 2026-06-04 doc token burst).
    const page: Page = { blocks: [headingBlock('b1', 'one')] }
    const { page: out } = applyOps(
      page,
      [{ op: 'add', after: 'nope', block: textBlock('tmp-1', 'x') }],
      makeIdGen(),
    )
    expect(out.blocks.map(b => b.id)).toEqual(['b1', 'gen-1'])
  })

  it('mints a real id when an add block carries no id', () => {
    // The model may omit `block.id` (the tool tells it the server will mint
    // one). applyOps assigns a real id directly — no tmp mapping needed.
    const page: Page = { blocks: [] }
    const { page: out, idMap } = applyOps(
      page,
      [{ op: 'add', after: 'end', block: { kind: 'text', text: 'x' } }] as never,
      makeIdGen(),
    )
    expect(out.blocks).toHaveLength(1)
    expect(out.blocks[0].id).toBe('gen-1')
    expect(Object.keys(idMap)).toHaveLength(0)
  })

  it('resolves a tmp-* after anchor minted earlier in the same patch', () => {
    // `add {id: tmp-h1}` then `add {after: tmp-h1}` must insert right after the
    // freshly-minted block. Previously the anchor looked up the literal
    // "tmp-h1" — which no longer existed once the block took its real id — so
    // every tmp-anchored insert failed with "anchor block not found".
    const page: Page = { blocks: [headingBlock('b1', 'one')] }
    const { page: out } = applyOps(
      page,
      [
        { op: 'add', after: 'start', block: headingBlock('tmp-h1', 'H') },
        { op: 'add', after: 'tmp-h1', block: textBlock('tmp-body', 'body') },
      ],
      makeIdGen(),
    )
    // tmp-h1 → gen-1 inserted at start; tmp-body → gen-2 inserted right after.
    expect(out.blocks.map(b => b.id)).toEqual(['gen-1', 'gen-2', 'b1'])
  })

  it('preserves the real id when add carries a non-tmp id', () => {
    const page: Page = { blocks: [] }
    const { page: out, idMap } = applyOps(
      page,
      [{ op: 'add', after: 'start', block: headingBlock('real-id', 'X') }],
      makeIdGen(),
    )
    expect(out.blocks[0].id).toBe('real-id')
    expect(idMap).toEqual({})
  })
})

describe('[COMP:doc/ops] applyOps — temp-id resolution within a patch', () => {
  it('an add followed by an edit on the same tmp id resolves the real id', () => {
    const page: Page = { blocks: [] }
    const ops: Op[] = [
      { op: 'add', after: 'start', block: textBlock('tmp-1', 'first') },
      { op: 'edit', blockId: 'tmp-1' as string, patch: { text: 'edited' } },
    ]
    const { page: out, idMap } = applyOps(page, ops, makeIdGen())
    expect(out.blocks).toHaveLength(1)
    expect(out.blocks[0].id).toBe('gen-1')
    expect((out.blocks[0] as TextBlock).text).toBe('edited')
    expect(idMap['tmp-1']).toBe('gen-1')
  })

  it('an add followed by a move on the same tmp id places the real block', () => {
    const page: Page = { blocks: [headingBlock('b1', 'first')] }
    const ops: Op[] = [
      { op: 'add', after: 'end', block: textBlock('tmp-1', 'new') },
      { op: 'move', blockId: 'tmp-1' as string, after: 'start' },
    ]
    const { page: out } = applyOps(page, ops, makeIdGen())
    expect(out.blocks.map(b => b.id)).toEqual(['gen-1', 'b1'])
  })

  it('an add followed by a delete on the same tmp id leaves the page unchanged', () => {
    const page: Page = { blocks: [headingBlock('b1', 'first')] }
    const ops: Op[] = [
      { op: 'add', after: 'end', block: textBlock('tmp-1', 'transient') },
      { op: 'delete', blockId: 'tmp-1' as string },
    ]
    const { page: out } = applyOps(page, ops, makeIdGen())
    expect(out.blocks).toHaveLength(1)
    expect(out.blocks[0].id).toBe('b1')
  })
})

describe('[COMP:doc/ops] applyOps — edit', () => {
  it('shallow-merges the patch onto the target block', () => {
    const page: Page = { blocks: [headingBlock('b1', 'old', 1)] }
    const { page: out } = applyOps(
      page,
      [{ op: 'edit', blockId: 'b1', patch: { text: 'new', level: 2 } }],
      makeIdGen(),
    )
    const merged = out.blocks[0] as HeadingBlock
    expect(merged.text).toBe('new')
    expect(merged.level).toBe(2)
  })

  it('preserves id and kind even when patch tries to override them', () => {
    const page: Page = { blocks: [headingBlock('b1', 'old')] }
    const { page: out } = applyOps(
      page,
      [
        {
          op: 'edit',
          blockId: 'b1',
          patch: { id: 'evil', kind: 'text' as const, text: 'shifted' },
        },
      ],
      makeIdGen(),
    )
    expect(out.blocks[0].id).toBe('b1')
    expect(out.blocks[0].kind).toBe('heading')
    expect((out.blocks[0] as HeadingBlock).text).toBe('shifted')
  })

  it('throws when edit target does not exist', () => {
    const page: Page = { blocks: [headingBlock('b1', 'x')] }
    expect(() =>
      applyOps(
        page,
        [{ op: 'edit', blockId: 'nope', patch: { text: 'y' } }],
        makeIdGen(),
      ),
    ).toThrow(/edit target block "nope" not found/)
  })

  it('rejects an edit that strips a chart to an empty shell (the open patch is re-validated)', () => {
    // Guards the 2026-06-10 "nothing here except a heading" path: an `edit`
    // patch is `z.record(z.unknown())` at the boundary, so without the merged-
    // chart re-validation a patch could empty a chart's points unchecked.
    const page: Page = {
      blocks: [
        {
          kind: 'chart',
          id: 'c1',
          chartType: 'bar',
          title: 'Fees',
          data: { points: [{ label: 'A', value: 1 }] },
        } as Block,
      ],
    }
    expect(() =>
      applyOps(
        page,
        [{ op: 'edit', blockId: 'c1', patch: { data: { points: [] } } }],
        makeIdGen(),
      ),
    ).toThrow(/invalid chart block/)
  })

  it('allows an edit that updates a chart with non-empty points', () => {
    const page: Page = {
      blocks: [
        {
          kind: 'chart',
          id: 'c1',
          chartType: 'bar',
          data: { points: [{ label: 'A', value: 1 }] },
        } as Block,
      ],
    }
    const { page: out } = applyOps(
      page,
      [{ op: 'edit', blockId: 'c1', patch: { data: { points: [{ label: 'A', value: 9 }] } } }],
      makeIdGen(),
    )
    const merged = out.blocks[0] as Extract<Block, { kind: 'chart' }>
    expect(merged.data?.points).toEqual([{ label: 'A', value: 9 }])
  })
})

describe('[COMP:doc/ops] applyOps — delete', () => {
  it('removes the named block', () => {
    const page: Page = {
      blocks: [headingBlock('b1', 'a'), headingBlock('b2', 'b')],
    }
    const { page: out } = applyOps(
      page,
      [{ op: 'delete', blockId: 'b1' }],
      makeIdGen(),
    )
    expect(out.blocks.map(b => b.id)).toEqual(['b2'])
  })

  it('throws when target block does not exist', () => {
    const page: Page = { blocks: [headingBlock('b1', 'x')] }
    expect(() =>
      applyOps(page, [{ op: 'delete', blockId: 'nope' }], makeIdGen()),
    ).toThrow(/delete target block "nope" not found/)
  })
})

describe('[COMP:doc/ops] applyOps — move', () => {
  it('moves a block to start', () => {
    const page: Page = {
      blocks: [
        headingBlock('b1', 'a'),
        headingBlock('b2', 'b'),
        headingBlock('b3', 'c'),
      ],
    }
    const { page: out } = applyOps(
      page,
      [{ op: 'move', blockId: 'b3', after: 'start' }],
      makeIdGen(),
    )
    expect(out.blocks.map(b => b.id)).toEqual(['b3', 'b1', 'b2'])
  })

  it('moves a block to end', () => {
    const page: Page = {
      blocks: [
        headingBlock('b1', 'a'),
        headingBlock('b2', 'b'),
        headingBlock('b3', 'c'),
      ],
    }
    const { page: out } = applyOps(
      page,
      [{ op: 'move', blockId: 'b1', after: 'end' }],
      makeIdGen(),
    )
    expect(out.blocks.map(b => b.id)).toEqual(['b2', 'b3', 'b1'])
  })

  it('moves a block after a named id', () => {
    const page: Page = {
      blocks: [
        headingBlock('b1', 'a'),
        headingBlock('b2', 'b'),
        headingBlock('b3', 'c'),
      ],
    }
    const { page: out } = applyOps(
      page,
      [{ op: 'move', blockId: 'b1', after: 'b2' }],
      makeIdGen(),
    )
    expect(out.blocks.map(b => b.id)).toEqual(['b2', 'b1', 'b3'])
  })

  it('throws when move target does not exist', () => {
    const page: Page = { blocks: [headingBlock('b1', 'x')] }
    expect(() =>
      applyOps(
        page,
        [{ op: 'move', blockId: 'nope', after: 'start' }],
        makeIdGen(),
      ),
    ).toThrow(/move target block "nope" not found/)
  })

  it('throws when move anchor does not exist', () => {
    const page: Page = {
      blocks: [headingBlock('b1', 'x'), headingBlock('b2', 'y')],
    }
    expect(() =>
      applyOps(
        page,
        [{ op: 'move', blockId: 'b1', after: 'nope' }],
        makeIdGen(),
      ),
    ).toThrow(/move anchor "nope" not found/)
  })
})

describe('[COMP:doc/ops] applyOps — setTitle', () => {
  it('updates the title on a VersionedPage', () => {
    const page: VersionedPage = {
      blocks: [],
      version: 3,
      title: 'old',
    }
    const { page: out } = applyOps(
      page,
      [{ op: 'setTitle', title: 'new' }],
      makeIdGen(),
    )
    expect((out as VersionedPage).title).toBe('new')
    expect((out as VersionedPage).version).toBe(3)
  })

  it('accepts setTitle even on a bare Page (no title field)', () => {
    const page: Page = { blocks: [] }
    const { page: out } = applyOps(
      page,
      [{ op: 'setTitle', title: 'fresh' }],
      makeIdGen(),
    )
    expect((out as { title?: string }).title).toBe('fresh')
  })
})

describe('[COMP:doc/ops] applyOps — setIcon', () => {
  it('sets the page icon on the working copy', () => {
    const page = { blocks: [], icon: null } as Page & { icon?: string | null }
    const { page: out } = applyOps(
      page,
      [{ op: 'setIcon', icon: '🌋' }],
      makeIdGen(),
    )
    expect((out as { icon?: string | null }).icon).toBe('🌋')
  })

  it('clears the icon when icon is null', () => {
    const page = { blocks: [], icon: '🌋' } as Page & { icon?: string | null }
    const { page: out } = applyOps(
      page,
      [{ op: 'setIcon', icon: null }],
      makeIdGen(),
    )
    expect((out as { icon?: string | null }).icon).toBeNull()
  })

  it('leaves blocks untouched (metadata-only op)', () => {
    const page: Page = { blocks: [headingBlock('b1', 'x')] }
    const { page: out } = applyOps(
      page,
      [{ op: 'setIcon', icon: '🌋' }],
      makeIdGen(),
    )
    expect(out.blocks).toEqual([headingBlock('b1', 'x')])
  })
})

// ── validateOps ──────────────────────────────────────────────────────

describe('[COMP:doc/ops] validateOps', () => {
  it('returns valid for a clean patch', () => {
    const page: Page = { blocks: [headingBlock('b1', 'x')] }
    const result = validateOps(page, [
      { op: 'edit', blockId: 'b1', patch: { text: 'y' } },
    ])
    expect(result).toEqual({ valid: true })
  })

  it('flags unknown edit target with opIndex', () => {
    const page: Page = { blocks: [headingBlock('b1', 'x')] }
    const result = validateOps(page, [
      { op: 'edit', blockId: 'b1', patch: { text: 'y' } },
      { op: 'edit', blockId: 'nope', patch: { text: 'z' } },
    ])
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error.opIndex).toBe(1)
      expect(result.error.reason).toMatch(/not found/)
    }
  })

  it('flags unknown move anchor', () => {
    const page: Page = { blocks: [headingBlock('b1', 'x')] }
    const result = validateOps(page, [
      { op: 'move', blockId: 'b1', after: 'nope' },
    ])
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error.opIndex).toBe(0)
    }
  })

  it('does not mutate the input page when patch fails', () => {
    const page: Page = { blocks: [headingBlock('b1', 'x')] }
    const snapshot = JSON.stringify(page)
    validateOps(page, [{ op: 'delete', blockId: 'nope' }])
    expect(JSON.stringify(page)).toBe(snapshot)
  })
})

// ── invertOps + round-trip ──────────────────────────────────────────

describe('[COMP:doc/ops] invertOps — single-op inverses', () => {
  it('inverts an add into a delete', () => {
    const page: Page = { blocks: [] }
    const ops: Op[] = [
      { op: 'add', after: 'start', block: headingBlock('real-1', 'hi') },
    ]
    const inverse = invertOps(page, ops)
    expect(inverse).toEqual([{ op: 'delete', blockId: 'real-1' }])
  })

  it('inverts an add of a tmp-id block into a delete of the resolved real id', () => {
    const page: Page = { blocks: [] }
    const ops: Op[] = [
      { op: 'add', after: 'start', block: headingBlock('tmp-1', 'hi') },
    ]
    // With an idMap from a paired applyOps, the inverse references
    // the real id assigned by applyOps.
    const inverse = invertOps(page, ops, { idMap: { 'tmp-1': 'real-id' } })
    expect(inverse).toEqual([{ op: 'delete', blockId: 'real-id' }])
  })

  it('falls back to a synthetic id for tmp-id adds when no idMap is supplied', () => {
    const page: Page = { blocks: [] }
    const ops: Op[] = [
      { op: 'add', after: 'start', block: headingBlock('tmp-1', 'hi') },
    ]
    const inverse = invertOps(page, ops)
    expect(inverse).toHaveLength(1)
    expect(inverse[0].op).toBe('delete')
    if (inverse[0].op === 'delete') {
      expect(inverse[0].blockId).toMatch(/^synth-/)
    }
  })

  it('inverts a delete into an add carrying the captured block', () => {
    const original: Block = headingBlock('b1', 'hi', 2)
    const page: Page = { blocks: [original] }
    const ops: Op[] = [{ op: 'delete', blockId: 'b1' }]
    const inverse = invertOps(page, ops)
    expect(inverse).toEqual([
      { op: 'add', after: 'start', block: original },
    ])
  })

  it('inverts an edit into an edit restoring prior values', () => {
    const page: Page = { blocks: [headingBlock('b1', 'old', 1)] }
    const ops: Op[] = [
      { op: 'edit', blockId: 'b1', patch: { text: 'new', level: 3 } },
    ]
    const inverse = invertOps(page, ops)
    expect(inverse).toEqual([
      {
        op: 'edit',
        blockId: 'b1',
        patch: { text: 'old', level: 1 },
      },
    ])
  })

  it('inverts a move into a move back to the prior anchor', () => {
    const page: Page = {
      blocks: [
        headingBlock('b1', 'a'),
        headingBlock('b2', 'b'),
        headingBlock('b3', 'c'),
      ],
    }
    const ops: Op[] = [{ op: 'move', blockId: 'b3', after: 'start' }]
    const inverse = invertOps(page, ops)
    expect(inverse).toEqual([{ op: 'move', blockId: 'b3', after: 'b2' }])
  })

  it('inverts setTitle into setTitle of the prior title', () => {
    const page: VersionedPage = { blocks: [], version: 1, title: 'old' }
    const ops: Op[] = [{ op: 'setTitle', title: 'new' }]
    const inverse = invertOps(page, ops)
    expect(inverse).toEqual([{ op: 'setTitle', title: 'old' }])
  })

  it('inverts setIcon into setIcon of the prior icon', () => {
    const page = { blocks: [], icon: '📄' } as Page & { icon?: string | null }
    const ops: Op[] = [{ op: 'setIcon', icon: '🌋' }]
    const inverse = invertOps(page, ops)
    expect(inverse).toEqual([{ op: 'setIcon', icon: '📄' }])
  })

  it('inverts setIcon on an icon-less page into a clear (null)', () => {
    const page: Page = { blocks: [] }
    const ops: Op[] = [{ op: 'setIcon', icon: '🌋' }]
    const inverse = invertOps(page, ops)
    expect(inverse).toEqual([{ op: 'setIcon', icon: null }])
  })
})

describe('[COMP:doc/ops] invertOps — round-trip property', () => {
  it('round-trips empty → add heading → add paragraph → edit → revert', () => {
    const empty: VersionedPage = { blocks: [], version: 1, title: '' }
    const ops: Op[] = [
      { op: 'add', after: 'start', block: headingBlock('h1', 'Title') },
      { op: 'add', after: 'h1', block: textBlock('p1', 'Body') },
      { op: 'edit', blockId: 'h1', patch: { text: 'Updated Title' } },
    ]
    const { page: post, idMap } = applyOps(empty, ops, makeIdGen())
    const inverse = invertOps(empty, ops, { idMap })
    const { page: back } = applyOps(post, inverse, makeIdGen('inv'))
    // Blocks should match pre-state.
    expect(back.blocks).toEqual(empty.blocks)
  })

  it('round-trips a complex multi-op patch with tmp ids', () => {
    const pre: VersionedPage = {
      blocks: [headingBlock('h1', 'Top')],
      version: 1,
      title: 'Page',
    }
    const ops: Op[] = [
      { op: 'add', after: 'h1', block: textBlock('tmp-1', 'new para') },
      { op: 'edit', blockId: 'h1', patch: { text: 'New top', level: 2 } },
      { op: 'move', blockId: 'h1', after: 'end' },
      { op: 'setTitle', title: 'Renamed' },
    ]
    const { page: post, idMap } = applyOps(pre, ops, makeIdGen())
    const inverse = invertOps(pre, ops, { idMap })
    const { page: back } = applyOps(post, inverse, makeIdGen('inv'))
    expect(back.blocks).toEqual(pre.blocks)
    expect((back as VersionedPage).title).toBe(pre.title)
  })

  it('round-trips delete + add', () => {
    const pre: Page = {
      blocks: [headingBlock('b1', 'a'), headingBlock('b2', 'b')],
    }
    const ops: Op[] = [{ op: 'delete', blockId: 'b1' }]
    const { page: post, idMap } = applyOps(pre, ops, makeIdGen())
    const inverse = invertOps(pre, ops, { idMap })
    const { page: back } = applyOps(post, inverse, makeIdGen('inv'))
    expect(back.blocks).toEqual(pre.blocks)
  })

  it('round-trips a setIcon op back to the prior icon', () => {
    const pre = {
      blocks: [headingBlock('h1', 'Top')],
      icon: '📄',
    } as Page & { icon?: string | null }
    const ops: Op[] = [{ op: 'setIcon', icon: '🌋' }]
    const { page: post, idMap } = applyOps(pre, ops, makeIdGen())
    expect((post as { icon?: string | null }).icon).toBe('🌋')
    const inverse = invertOps(pre, ops, { idMap })
    const { page: back } = applyOps(post, inverse, makeIdGen('inv'))
    expect((back as { icon?: string | null }).icon).toBe('📄')
  })
})

// ── Zod round-trip ───────────────────────────────────────────────────

describe('[COMP:doc/ops] opSchema round-trips Op values', () => {
  it('round-trips an add op', () => {
    const op: Op = {
      op: 'add',
      after: 'start',
      block: headingBlock('b1', 'x'),
    }
    expect(opSchema.parse(JSON.parse(JSON.stringify(op)))).toEqual(op)
  })

  it('round-trips an edit op', () => {
    const op: Op = {
      op: 'edit',
      blockId: 'b1',
      patch: { text: 'new' },
    }
    expect(opSchema.parse(JSON.parse(JSON.stringify(op)))).toEqual(op)
  })

  it('round-trips a delete op', () => {
    const op: Op = { op: 'delete', blockId: 'b1' }
    expect(opSchema.parse(JSON.parse(JSON.stringify(op)))).toEqual(op)
  })

  it('round-trips a move op', () => {
    const op: Op = { op: 'move', blockId: 'b1', after: 'end' }
    expect(opSchema.parse(JSON.parse(JSON.stringify(op)))).toEqual(op)
  })

  it('round-trips a setTitle op', () => {
    const op: Op = { op: 'setTitle', title: 'Hello' }
    expect(opSchema.parse(JSON.parse(JSON.stringify(op)))).toEqual(op)
  })

  it('round-trips a setIcon op (emoji)', () => {
    const op: Op = { op: 'setIcon', icon: '🌋' }
    expect(opSchema.parse(JSON.parse(JSON.stringify(op)))).toEqual(op)
  })

  it('round-trips a setIcon op that clears (null)', () => {
    const op: Op = { op: 'setIcon', icon: null }
    expect(opSchema.parse(JSON.parse(JSON.stringify(op)))).toEqual(op)
  })
})

// ── id-optional add (server-mint) ────────────────────────────────────

describe('[COMP:doc/ops] add op accepts an id-less block (server mints)', () => {
  it('parses an add whose block omits id, injecting a tmp-auto placeholder', () => {
    // The tool description tells the model it may omit block.id; the schema
    // must then accept it (server mints later). Before the fix this failed
    // with a content-less `block: Invalid input` and the model retried blind.
    const parsed = opSchema.safeParse({
      op: 'add',
      block: { kind: 'heading', level: 2, text: 'Hello' },
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      const block = (parsed.data as Extract<Op, { op: 'add' }>).block
      expect(block.id).toMatch(/^tmp-auto-/)
    }
  })

  it('still parses an add that supplies its own tmp id', () => {
    const parsed = opSchema.safeParse({
      op: 'add',
      block: { id: 'tmp-h1', kind: 'heading', level: 2, text: 'Hello' },
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect((parsed.data as Extract<Op, { op: 'add' }>).block.id).toBe('tmp-h1')
    }
  })
})
