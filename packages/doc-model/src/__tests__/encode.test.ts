import { describe, it, expect } from 'vitest'
import { pageToYDocUpdate, snapshotFromUpdate } from '../encode.js'
import { canonicalizePage } from '../block-mapping.js'
import { ALL_KINDS_PAGE } from './fixtures.js'

describe('[COMP:doc-model/encode] Page ↔ Y.Doc round-trip', () => {
  it('encodes a page to a Y.Doc update and decodes the same snapshot', () => {
    const update = pageToYDocUpdate(ALL_KINDS_PAGE, 'My page')
    expect(update).toBeInstanceOf(Uint8Array)
    expect(update.byteLength).toBeGreaterThan(0)

    const snap = snapshotFromUpdate(update)
    expect(snap.title).toBe('My page')
    expect(snap.page).toEqual(canonicalizePage(ALL_KINDS_PAGE))
  })

  it('preserves block ids through the CRDT encode/decode', () => {
    const update = pageToYDocUpdate(ALL_KINDS_PAGE, 't')
    const snap = snapshotFromUpdate(update)
    expect(snap.page.blocks.map((b) => b.id)).toEqual(
      ALL_KINDS_PAGE.blocks.map((b) => b.id),
    )
  })

  it('round-trips an empty page without throwing', () => {
    const update = pageToYDocUpdate({ blocks: [] }, '')
    const snap = snapshotFromUpdate(update)
    expect(snap.page.blocks.length).toBe(1)
    expect(snap.page.blocks[0].kind).toBe('text')
  })
})
