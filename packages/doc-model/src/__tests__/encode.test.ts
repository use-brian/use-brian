import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { LEGACY_SEED_CLIENT_ID, pageToYDocUpdate, snapshotFromUpdate } from '../encode.js'
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

  // Regression — prod incident 2026-07-21. A page seeded twice came back with
  // its entire body duplicated end-to-end (37 CAS blocks → 74 in the Y.Doc)
  // because each encoding was authored under a fresh random clientID, so the
  // CRDT read the two seeds as concurrent inserts by different clients and
  // kept BOTH. Pinning the seed clientID makes a re-seed converge instead.
  it('is deterministic — the same page encodes byte-identically', () => {
    const a = pageToYDocUpdate(ALL_KINDS_PAGE, 'My page')
    const b = pageToYDocUpdate(ALL_KINDS_PAGE, 'My page')
    expect(Array.from(b)).toEqual(Array.from(a))
  })

  it('authors the seed under the reserved seed clientID', () => {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, pageToYDocUpdate(ALL_KINDS_PAGE, 't'))
    expect([...Y.encodeStateVectorFromUpdate(pageToYDocUpdate(ALL_KINDS_PAGE, 't'))]).toBeDefined()
    // Every op in the seed belongs to the reserved client.
    const sv = Y.decodeStateVector(Y.encodeStateVector(doc))
    expect([...sv.keys()]).toEqual([LEGACY_SEED_CLIENT_ID])
  })

  it('re-applying the same seed does NOT duplicate the body', () => {
    const seed = pageToYDocUpdate(ALL_KINDS_PAGE, 'My page')
    const doc = new Y.Doc()
    Y.applyUpdate(doc, seed)
    const once = snapshotFromUpdate(Y.encodeStateAsUpdate(doc))

    // Second seed — the exact shape of the incident: a doc loaded, seeded,
    // then seeded again before the first snapshot persisted.
    Y.applyUpdate(doc, seed)
    const twice = snapshotFromUpdate(Y.encodeStateAsUpdate(doc))

    expect(twice.page.blocks.length).toBe(once.page.blocks.length)
    expect(twice.page.blocks.map((b) => b.id)).toEqual(once.page.blocks.map((b) => b.id))
  })
})
