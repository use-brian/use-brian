/**
 * [COMP:doc/ops] Regression — editing a block whose *canonical* id is `tmp-*`.
 *
 * Some pages were seeded into the live Yjs doc with their authoring `tmp-*`
 * ids verbatim (the seed path didn't mint real ids the way the `add` path
 * does). `patchPage` must still be able to edit / delete / move those blocks
 * — previously `validateOps` rejected every such op with
 * "edit references unresolved temp id", because `resolveId` assumed any
 * `tmp-*` id is a within-patch placeholder. The fix: an unmapped `tmp-*` id
 * falls back to the literal id, mirroring the live write path
 * (`packages/doc-model/src/apply-ops.ts`: `idMap[op.blockId] ?? id`).
 */
import { describe, it, expect } from 'vitest'
import { applyOps, validateOps } from '../ops.js'
import type { Page, Ops } from '../page-types.js'

function makePage(): Page {
  return {
    blocks: [
      { id: 'tmp-h4', kind: 'heading', text: 'Technical Infrastructure', level: 2 },
      {
        id: 'tmp-l1',
        kind: 'bulleted_list_item',
        richText: { type: 'doc', content: [{ type: 'paragraph' }] },
      },
      { id: 'real-1', kind: 'text', text: 'keep' },
    ],
  } as unknown as Page
}

describe('[COMP:doc/ops] tmp-* canonical block ids are editable', () => {
  it('validateOps accepts an edit whose target real id starts with tmp-', () => {
    const ops = [{ op: 'edit', blockId: 'tmp-l1', patch: { text: 'Khor' } }] as unknown as Ops
    expect(validateOps(makePage(), ops)).toEqual({ valid: true })
  })

  it('applyOps applies the edit and preserves the tmp- id + kind', () => {
    const ops = [{ op: 'edit', blockId: 'tmp-l1', patch: { text: 'Khor' } }] as unknown as Ops
    const { page: out } = applyOps(makePage(), ops)
    const blk = out.blocks.find((b) => b.id === 'tmp-l1') as {
      id: string
      kind: string
      text?: string
    }
    expect(blk.id).toBe('tmp-l1')
    expect(blk.kind).toBe('bulleted_list_item')
    expect(blk.text).toBe('Khor')
  })

  it('delete targeting a tmp- real block removes it', () => {
    const ops = [{ op: 'delete', blockId: 'tmp-h4' }] as unknown as Ops
    const { page: out } = applyOps(makePage(), ops)
    expect(out.blocks.some((b) => b.id === 'tmp-h4')).toBe(false)
    expect(out.blocks).toHaveLength(2)
  })

  it('still reports invalid when a tmp- id is neither a same-patch add nor an existing block', () => {
    const ops = [{ op: 'edit', blockId: 'tmp-nope', patch: { text: 'x' } }] as unknown as Ops
    const res = validateOps(makePage(), ops)
    expect(res.valid).toBe(false)
  })

  it('same-patch add+edit by tmp id still resolves via the id map (no regression)', () => {
    const ops = [
      { op: 'add', after: 'end', block: { id: 'tmp-new', kind: 'text', text: 'a' } },
      { op: 'edit', blockId: 'tmp-new', patch: { text: 'b' } },
    ] as unknown as Ops
    const { page: out, idMap } = applyOps(makePage(), ops, () => 'minted-1')
    expect(idMap['tmp-new']).toBe('minted-1')
    const blk = out.blocks.find((b) => b.id === 'minted-1') as { text?: string }
    expect(blk.text).toBe('b')
  })
})
