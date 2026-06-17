import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { planEdit, commitEdit } from '../reconcile.js'

function docWith(text: string): Y.Doc {
  const doc = new Y.Doc()
  doc.getText('content').insert(0, text)
  return doc
}

describe('[COMP:doc/reconcile] observe-then-reconcile guard', () => {
  it('applies a planned edit when nothing changed underneath', () => {
    const doc = docWith('Hello world')
    const plan = planEdit(doc, 'content', { from: 6, to: 11, insert: 'there' })
    const result = commitEdit(doc, 'content', plan)
    expect(result.applied).toBe(true)
    expect(doc.getText('content').toString()).toBe('Hello there')
  })

  it('still applies after a concurrent edit *elsewhere* (relative anchors track the span)', () => {
    const doc = docWith('Hello world')
    const plan = planEdit(doc, 'content', { from: 6, to: 11, insert: 'there' })
    // A human inserts before the target span, shifting its absolute index.
    doc.getText('content').insert(0, 'Big ')
    const result = commitEdit(doc, 'content', plan)
    expect(result.applied).toBe(true)
    expect(doc.getText('content').toString()).toBe('Big Hello there')
  })

  it('re-plans (does not clobber) when the target span itself changed', () => {
    const doc = docWith('Hello world')
    const plan = planEdit(doc, 'content', { from: 6, to: 11, insert: 'there' })
    // A human rewrites the same span the AI targeted.
    const ytext = doc.getText('content')
    ytext.delete(6, 5)
    ytext.insert(6, 'earth')
    const result = commitEdit(doc, 'content', plan)
    expect(result.applied).toBe(false)
    if (!result.applied) {
      expect(result.reason).toBe('span-changed')
      expect(result.freshText).toBe('earth')
    }
    // The human's edit is preserved — the AI did not overwrite it.
    expect(doc.getText('content').toString()).toBe('Hello earth')
  })

  it('supports a pure insertion (empty target span)', () => {
    const doc = docWith('ab')
    const plan = planEdit(doc, 'content', { from: 1, to: 1, insert: 'X' })
    const result = commitEdit(doc, 'content', plan)
    expect(result.applied).toBe(true)
    expect(doc.getText('content').toString()).toBe('aXb')
  })
})
