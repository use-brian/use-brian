import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import type { Block, Page } from '@use-brian/core/dist/views/blocks.js'
import { pageToYDoc, yDocToSnapshot, pageToYDocUpdate, yDocFromUpdate } from '../encode.js'
import { applyOpsToYDoc, type DocOp } from '../apply-ops.js'

const text = (id: string, t: string): Block => ({ kind: 'text', id, text: t }) as Block
const heading = (id: string, t: string): Block =>
  ({ kind: 'heading', id, level: 2, text: t }) as Block
const todo = (id: string, t: string): Block =>
  ({ kind: 'to_do', id, checked: false, richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] } }) as unknown as Block
const bullet = (id: string, t: string): Block =>
  ({ kind: 'bulleted_list_item', id, richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] } }) as unknown as Block
const numbered = (id: string, t: string): Block =>
  ({ kind: 'numbered_list_item', id, richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] } }) as unknown as Block

/** Top-level structure of the live doc: each node's wrapper name + child count.
 *  Reveals list grouping (which `blocksOf`'s flatten hides) — the thing Tab
 *  nesting and ordered-list numbering depend on. */
function topShape(doc: Y.Doc): { name: string; items: number }[] {
  return doc
    .getXmlFragment('default')
    .toArray()
    .map((n) => {
      const el = n as Y.XmlElement
      return { name: el.nodeName, items: el.length }
    })
}

function docFrom(blocks: Block[], title = ''): Y.Doc {
  return pageToYDoc({ blocks } as Page, title)
}
function blocksOf(doc: Y.Doc): Block[] {
  return yDocToSnapshot(doc).page.blocks
}

describe('[COMP:doc-model/apply-ops] AI ops on a live Y.Doc', () => {
  it('adds a block at end and preserves the given id', () => {
    const doc = docFrom([text('a', 'first')])
    const { idMap, skipped } = applyOpsToYDoc(doc, [
      { op: 'add', after: 'end', block: text('b', 'second') },
    ])
    expect(skipped).toHaveLength(0)
    expect(idMap).toEqual({})
    const out = blocksOf(doc)
    expect(out.map((b) => (b as { text: string }).text)).toEqual(['first', 'second'])
    expect(out[1].id).toBe('b')
  })

  it('mints a real id for a tmp-id add and resolves later refs to it', () => {
    const doc = docFrom([text('a', 'first')])
    const { idMap, skipped } = applyOpsToYDoc(doc, [
      { op: 'add', after: 'a', block: heading('tmp-1', 'New section') },
      { op: 'add', after: 'tmp-1', block: text('tmp-2', 'body') },
    ])
    expect(skipped).toHaveLength(0)
    expect(idMap['tmp-1']).toBeTruthy()
    expect(idMap['tmp-1']).not.toBe('tmp-1')
    const out = blocksOf(doc)
    // order: a, heading(tmp-1), text(tmp-2)
    expect(out.map((b) => b.kind)).toEqual(['text', 'heading', 'text'])
    expect(out[1].id).toBe(idMap['tmp-1'])
    expect(out[2].id).toBe(idMap['tmp-2'])
  })

  it('inserts after a named anchor', () => {
    const doc = docFrom([text('a', 'A'), text('c', 'C')])
    applyOpsToYDoc(doc, [{ op: 'add', after: 'a', block: text('b', 'B') }])
    expect(blocksOf(doc).map((b) => (b as { text: string }).text)).toEqual(['A', 'B', 'C'])
  })

  it('edits a block in place (text replaced, id stable)', () => {
    const doc = docFrom([text('a', 'old'), text('b', 'keep')])
    const { skipped } = applyOpsToYDoc(doc, [
      { op: 'edit', blockId: 'a', patch: { text: 'new' } as Partial<Block> },
    ])
    expect(skipped).toHaveLength(0)
    const out = blocksOf(doc)
    expect(out[0].id).toBe('a')
    expect((out[0] as { text: string }).text).toBe('new')
    expect((out[1] as { text: string }).text).toBe('keep')
  })

  it('deletes a block', () => {
    const doc = docFrom([text('a', 'A'), text('b', 'B'), text('c', 'C')])
    applyOpsToYDoc(doc, [{ op: 'delete', blockId: 'b' }])
    expect(blocksOf(doc).map((b) => b.id)).toEqual(['a', 'c'])
  })

  // blockId-uniqueness heal. A Yjs element's identity is its internal
  // ID, not its `blockId` attribute, so a whole-node edit-rebuild merging with a
  // concurrent same-block edit (or a multi-node buildBlockNodes) can leave two
  // nodes sharing one id. `locate`/the edit `find` are first-match, so the dup is
  // an unrepairable trap: every id-keyed op hits copy #1 and the block the model
  // wants is unreachable forever (prod 2026-06-11, page c4b01fe2 / session d98e2acd).
  it('heals a forked blockId — reassigns the later copy, non-destructively', () => {
    const doc = docFrom([text('a', 'first'), text('b', 'second')])
    const frag = doc.getXmlFragment('default')
    // The fork a whole-node edit-rebuild leaves: a 2nd top-level node carrying id 'a'.
    const forked = (frag.get(0) as Y.XmlElement).clone()
    frag.insert(2, [forked])
    expect(blocksOf(doc).map((b) => b.id).filter((id) => id === 'a')).toHaveLength(2)

    // Any apply runs the heal. Edit 'b' (untouched) to prove the batch still lands.
    const { skipped } = applyOpsToYDoc(doc, [
      { op: 'edit', blockId: 'b', patch: { text: 'second!' } as Partial<Block> },
    ])
    expect(skipped).toHaveLength(0)

    const out = blocksOf(doc)
    const ids = out.map((b) => b.id)
    expect(ids.filter((id) => id === 'a')).toHaveLength(1) // unique again
    expect(new Set(ids).size).toBe(ids.length) // every id distinct
    expect(out).toHaveLength(3) // non-destructive — forked content kept under a fresh id
    expect((out[0] as { text: string }).text).toBe('first') // first copy keeps the id + content
    expect((out.find((b) => b.id === 'b') as { text: string }).text).toBe('second!')
  })

  // Missing-id heal. The editor creates nodes with `blockId: null` (the schema
  // default — nothing client-side assigns one), and `pmDocToBlocks` fabricates
  // a fresh genId() for an attr-less node on EVERY conversion — so each
  // outline read showed the model a different id for the same human-typed
  // block, and every id-keyed op against it missed forever (prod 2026-06-11,
  // page c4b01fe2 / session 81a56d8b: the "Track 3" toggle, 17 failed patches).
  it('stamps a stable blockId onto an editor-created (attr-less) node', () => {
    const doc = docFrom([text('a', 'intro'), text('b', 'human-typed')])
    const frag = doc.getXmlFragment('default')
    // Simulate the editor-created node: strip the attr the encoder set.
    ;(frag.get(1) as Y.XmlElement).removeAttribute('blockId')

    // Document the trap: without the heal, every conversion mints a new id.
    expect(blocksOf(doc)[1].id).not.toBe(blocksOf(doc)[1].id)

    applyOpsToYDoc(doc, []) // any apply heals, even an empty batch

    const stamped = blocksOf(doc)[1].id
    expect(blocksOf(doc)[1].id).toBe(stamped) // stable across conversions
    expect((frag.get(1) as Y.XmlElement).getAttribute('blockId')).toBe(stamped)

    // And the stamped id is a real target — the retry the model makes after
    // one failed patch now lands instead of looping on a re-minted id.
    const { skipped } = applyOpsToYDoc(doc, [
      { op: 'edit', blockId: stamped, patch: { text: 'edited' } as Partial<Block> },
    ])
    expect(skipped).toHaveLength(0)
    expect((blocksOf(doc)[1] as { text: string }).text).toBe('edited')
  })

  it('stamps attr-less container children too (toggle summary + body)', () => {
    const toggle = {
      kind: 'toggle',
      id: 't',
      expanded: true,
      richText: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Track 3' }] }],
      },
      children: [bullet('c1', 'TAM + Source')],
    } as unknown as Block
    const doc = docFrom([toggle])
    const frag = doc.getXmlFragment('default')
    const toggleEl = frag.get(0) as Y.XmlElement
    toggleEl.removeAttribute('blockId')
    for (const kid of toggleEl.toArray()) {
      if (kid instanceof Y.XmlElement) kid.removeAttribute('blockId')
    }

    applyOpsToYDoc(doc, [])

    expect(toggleEl.getAttribute('blockId')).toBeTruthy()
    const attrLess: string[] = []
    const walk = (el: Y.XmlElement): void => {
      for (const kid of el.toArray()) {
        if (!(kid instanceof Y.XmlElement)) continue
        if (
          ['paragraph', 'bulletList', 'listItem'].includes(kid.nodeName) &&
          !kid.getAttribute('blockId')
        ) {
          attrLess.push(kid.nodeName)
        }
        walk(kid)
      }
    }
    walk(toggleEl)
    expect(attrLess).toEqual([]) // every ID-carrying child stamped
  })

  it('a forked block is editable again after the heal (no first-match trap)', () => {
    const doc = docFrom([text('a', 'keep'), text('target', 'edit me')])
    const frag = doc.getXmlFragment('default')
    const forked = (frag.get(1) as Y.XmlElement).clone()
    frag.insert(2, [forked]) // ['a','target','target']

    applyOpsToYDoc(doc, []) // empty batch still heals
    expect(blocksOf(doc).map((b) => b.id).filter((id) => id === 'target')).toHaveLength(1)

    // The edit now lands on the single surviving node instead of vanishing into a phantom.
    const { skipped } = applyOpsToYDoc(doc, [
      { op: 'edit', blockId: 'target', patch: { text: 'edited' } as Partial<Block> },
    ])
    expect(skipped).toHaveLength(0)
    expect(
      (blocksOf(doc).find((b) => b.id === 'target') as { text: string }).text,
    ).toBe('edited')
  })

  it('moves a top-level block', () => {
    const doc = docFrom([text('a', 'A'), text('b', 'B'), text('c', 'C')])
    applyOpsToYDoc(doc, [{ op: 'move', blockId: 'a', after: 'c' }])
    expect(blocksOf(doc).map((b) => b.id)).toEqual(['b', 'c', 'a'])
  })

  it('sets the title in the meta map', () => {
    const doc = docFrom([text('a', 'A')], 'Old title')
    applyOpsToYDoc(doc, [{ op: 'setTitle', title: 'New title' }])
    expect(yDocToSnapshot(doc).title).toBe('New title')
  })

  it('skips (does not resurrect) an op whose target was deleted', () => {
    const doc = docFrom([text('a', 'A')])
    const { skipped } = applyOpsToYDoc(doc, [
      { op: 'edit', blockId: 'ghost', patch: { text: 'x' } as Partial<Block> },
      { op: 'delete', blockId: 'ghost' },
    ])
    expect(skipped.map((s) => s.reason)).toEqual([
      'edit-target-missing',
      'delete-target-missing',
    ])
    expect(blocksOf(doc)).toHaveLength(1)
  })

  // A block whose model-authored rich text the shared schema can't represent
  // makes `Node.fromJSON` throw ("Unknown node type: text" when an inline
  // `text` node's type carries a stray char). That throw must NOT sink the
  // whole patch: it is isolated per op, recorded in `skipped[]`, and every
  // valid neighbour still lands. This is the 2026-06-09 "stacked empty Sources
  // headings" incident — a malformed citation bullet 500'd the batch, the
  // heading + divider that ran before it committed, and the model retried
  // blindly. Regression: the heading lands, the bad bullet is skipped, no throw.
  it('skips a block with unrepresentable rich text, applying its neighbours', () => {
    const badBullet: Block = {
      kind: 'bulleted_list_item',
      id: 'bad',
      // `'text '` (trailing space) ≠ `'text'`, so ProseMirror's text fast-path
      // misses it and `schema.nodeType` rejects it — exactly the prod throw.
      richText: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text ', text: 'Source A' }] }],
      },
    } as unknown as Block
    const doc = docFrom([heading('h0', 'Intro')])
    let result!: ReturnType<typeof applyOpsToYDoc>
    expect(() => {
      result = applyOpsToYDoc(doc, [
        { op: 'add', after: 'end', block: heading('h1', 'Sources') },
        { op: 'add', after: 'end', block: badBullet },
        { op: 'add', after: 'end', block: text('t1', 'after') },
      ])
    }).not.toThrow()
    // The malformed bullet is the only casualty; it names a reason.
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].opIndex).toBe(1)
    expect(result.skipped[0].reason).toMatch(/apply-threw|Unknown node type/)
    // Both valid blocks landed; the bullet did not.
    const out = blocksOf(doc)
    expect(out.map((b) => b.kind)).toEqual(['heading', 'heading', 'text'])
    expect((out[1] as { text: string }).text).toBe('Sources')
    expect((out[2] as { text: string }).text).toBe('after')
  })

  // Consecutive list-item `add`s must fold into ONE wrapper (like the full-page
  // `blocksToPMDoc` conversion) — not a stack of one-item sibling lists. The
  // editor renders the live doc 1:1, so separate wrappers were un-nestable by
  // Tab and made ordered lists restart at 1. This is the root-cause fix for the
  // doc bullet-indent bug.
  it('folds consecutive bullet adds into a single bulletList', () => {
    const doc = docFrom([text('a', 'intro')])
    applyOpsToYDoc(doc, [
      { op: 'add', after: 'a', block: bullet('b1', 'one') },
      { op: 'add', after: 'b1', block: bullet('b2', 'two') },
      { op: 'add', after: 'b2', block: bullet('b3', 'three') },
    ])
    expect(topShape(doc)).toEqual([
      { name: 'paragraph', items: 1 },
      { name: 'bulletList', items: 3 },
    ])
    // Block round-trip still yields three flat bullets, ids preserved + ordered.
    const out = blocksOf(doc)
    expect(out.map((b) => b.id)).toEqual(['a', 'b1', 'b2', 'b3'])
    expect(out.slice(1).every((b) => b.kind === 'bulleted_list_item')).toBe(true)
  })

  it('folds numbered adds into one orderedList (so it keeps counting)', () => {
    const doc = docFrom([numbered('n1', 'one')])
    applyOpsToYDoc(doc, [
      { op: 'add', after: 'n1', block: numbered('n2', 'two') },
      { op: 'add', after: 'end', block: numbered('n3', 'three') },
    ])
    expect(topShape(doc)).toEqual([{ name: 'orderedList', items: 3 }])
  })

  it('keeps a different-kind list as a separate wrapper (no cross-kind merge)', () => {
    const doc = docFrom([bullet('b1', 'bullet')])
    applyOpsToYDoc(doc, [{ op: 'add', after: 'b1', block: numbered('n1', 'number') }])
    expect(topShape(doc)).toEqual([
      { name: 'bulletList', items: 1 },
      { name: 'orderedList', items: 1 },
    ])
  })

  it('starts a fresh list when a non-list block separates two runs', () => {
    const doc = docFrom([bullet('b1', 'one')])
    applyOpsToYDoc(doc, [
      { op: 'add', after: 'b1', block: text('p', 'divider') },
      { op: 'add', after: 'p', block: bullet('b2', 'two') },
    ])
    expect(topShape(doc)).toEqual([
      { name: 'bulletList', items: 1 },
      { name: 'paragraph', items: 1 },
      { name: 'bulletList', items: 1 },
    ])
  })

  it('edits a nested list item without dropping its siblings', () => {
    const doc = docFrom([todo('t1', 'one'), todo('t2', 'two')])
    const { skipped } = applyOpsToYDoc(doc, [
      { op: 'edit', blockId: 't1', patch: { checked: true } as Partial<Block> },
    ])
    expect(skipped).toHaveLength(0)
    const out = blocksOf(doc)
    expect(out).toHaveLength(2)
    expect(out.map((b) => b.id)).toEqual(['t1', 't2'])
    expect((out[0] as { checked: boolean }).checked).toBe(true)
  })

  // ── Nested list items (sub-bullets) ────────────────────────────────────
  // The patchPage half of the bullet-indent fix: an `add` carrying `indent`
  // nests the new item under the row above in the live Y.Doc, exactly as the
  // full-page `blocksToPMDoc` conversion does for `renderPage`.

  const bulletAt = (id: string, t: string, indent: number): Block =>
    ({ ...(bullet(id, t) as object), indent }) as Block

  it('nests sub-bullets under the row above (the patchPage repro)', () => {
    const doc = docFrom([text('intro', 'Competitors')])
    applyOpsToYDoc(doc, [
      { op: 'add', after: 'intro', block: bullet('p1', 'Current') },
      { op: 'add', after: 'p1', block: bulletAt('v1', 'Vertical', 1) },
      { op: 'add', after: 'v1', block: bulletAt('t1', 'TAM', 1) },
      { op: 'add', after: 't1', block: bullet('p2', 'Modus') },
      { op: 'add', after: 'p2', block: bulletAt('v2', 'Vertical', 1) },
    ])
    // Top level: the intro paragraph + ONE bulletList holding the two parents.
    expect(topShape(doc)).toEqual([
      { name: 'paragraph', items: 1 },
      { name: 'bulletList', items: 2 },
    ])
    const out = blocksOf(doc)
    expect(out.map((b) => b.id)).toEqual(['intro', 'p1', 'v1', 't1', 'p2', 'v2'])
    expect(out.map((b) => (b as { indent?: number }).indent)).toEqual([
      undefined,
      undefined,
      1,
      1,
      undefined,
      1,
    ])
  })

  it('nests a numbered sub-list under a bullet (kind change across depth)', () => {
    const doc = docFrom([bullet('p', 'Parent')])
    applyOpsToYDoc(doc, [
      { op: 'add', after: 'p', block: { ...(numbered('s1', 'one') as object), indent: 1 } as Block },
      { op: 'add', after: 's1', block: { ...(numbered('s2', 'two') as object), indent: 1 } as Block },
    ])
    const out = blocksOf(doc)
    expect(out.map((b) => b.kind)).toEqual([
      'bulleted_list_item',
      'numbered_list_item',
      'numbered_list_item',
    ])
    expect(out.slice(1).map((b) => (b as { indent?: number }).indent)).toEqual([1, 1])
  })

  it('edits a parent without dropping its nested sub-items', () => {
    const doc = docFrom([bullet('p', 'Parent')])
    applyOpsToYDoc(doc, [{ op: 'add', after: 'p', block: bulletAt('c', 'Child', 1) }])
    const editedRich = (bullet('p', 'Parent edited') as { richText: unknown }).richText
    const { skipped } = applyOpsToYDoc(doc, [
      { op: 'edit', blockId: 'p', patch: { richText: editedRich } as Partial<Block> },
    ])
    expect(skipped).toHaveLength(0)
    const out = blocksOf(doc)
    expect(out.map((b) => b.id)).toEqual(['p', 'c']) // child survived the parent edit
    expect((out[1] as { indent?: number }).indent).toBe(1)
  })

  it('deletes a parent and its whole sub-tree', () => {
    const doc = docFrom([bullet('p1', 'one')])
    applyOpsToYDoc(doc, [
      { op: 'add', after: 'p1', block: bulletAt('c1', 'sub', 1) },
      { op: 'add', after: 'p1', block: bullet('p2', 'two') },
    ])
    applyOpsToYDoc(doc, [{ op: 'delete', blockId: 'p1' }])
    const out = blocksOf(doc)
    expect(out.map((b) => b.id)).toEqual(['p2']) // p1 + its nested c1 both gone
  })

  // The load-bearing property: an AI write and a concurrent human edit on
  // the SAME doc both survive the CRDT merge — no clobber. This is the whole
  // reason the AI path moved onto Yjs.
  it('merges an AI add with a concurrent human edit (no clobber)', () => {
    const initial = pageToYDocUpdate({ blocks: [text('a', 'human text'), text('b', 'keep')] } as Page, 't')
    const aiDoc = yDocFromUpdate(initial)
    const humanDoc = yDocFromUpdate(initial)

    // AI appends a block on its replica…
    applyOpsToYDoc(aiDoc, [{ op: 'add', after: 'end', block: text('c', 'added by AI') }])
    // …while the human edits an existing block on theirs.
    applyOpsToYDoc(humanDoc, [
      { op: 'edit', blockId: 'a', patch: { text: 'edited by human' } as Partial<Block> },
    ])

    // Exchange updates both ways (what Hocuspocus does over the wire).
    Y.applyUpdate(humanDoc, Y.encodeStateAsUpdate(aiDoc))
    Y.applyUpdate(aiDoc, Y.encodeStateAsUpdate(humanDoc))

    for (const doc of [aiDoc, humanDoc]) {
      const out = blocksOf(doc)
      const byText = out.map((b) => (b as { text?: string }).text)
      expect(byText).toContain('edited by human') // human edit survived
      expect(byText).toContain('added by AI') // AI add survived
      expect(byText).toContain('keep')
    }
  })
})
