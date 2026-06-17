import { describe, it, expect } from 'vitest'
import { docSchema } from '../schema.js'

describe('[COMP:doc-model/comment-mark] comment mark', () => {
  it('is registered in the doc schema with a threadId attribute', () => {
    const schema = docSchema()
    const mark = schema.marks.comment
    expect(mark).toBeDefined()
    // The threadId attr is what anchors a human-range thread; without it
    // the highlight can't resolve which thread a clicked span belongs to.
    expect(mark.spec.attrs?.threadId).toBeDefined()
    // Non-inclusive so typing at the boundary doesn't extend the highlight.
    expect(mark.spec.inclusive).toBe(false)
  })

  it('round-trips threadId through ProseMirror JSON (the Yjs prerequisite)', () => {
    const schema = docSchema()
    // A paragraph with one commented word.
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('hello', [schema.marks.comment.create({ threadId: 'thr_123' })]),
      ]),
    ])

    // PM JSON is the representation y-prosemirror maps onto the CRDT, so a
    // mark + attr that survive a JSON round-trip survive the Yjs round-trip.
    const restored = schema.nodeFromJSON(doc.toJSON())
    let found: string | null = null
    restored.descendants((node) => {
      const m = node.marks.find((mk) => mk.type.name === 'comment')
      if (m) found = m.attrs.threadId as string
    })
    expect(found).toBe('thr_123')
  })
})
