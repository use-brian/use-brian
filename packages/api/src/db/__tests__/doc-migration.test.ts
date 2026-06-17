import { describe, it, expect } from 'vitest'
import {
  convertPageToDocRow,
  runSelfTest,
  SELF_TEST_PAGE,
} from '../doc-migration.js'
import { snapshotFromUpdate, canonicalizePage } from '@sidanclaw/doc-model'

describe('[COMP:api/doc-migration] block-page → Y.Doc converter', () => {
  it('round-trips all 16 block kinds with every id preserved', () => {
    const r = convertPageToDocRow(SELF_TEST_PAGE, 'My page')
    expect(r.idsPreserved).toBe(true)
    expect(r.roundTripOk).toBe(true)
    expect(r.ydoc.byteLength).toBeGreaterThan(0)
    expect(r.title).toBe('My page')
  })

  it('snapshotJson decodes to the documented canonical page', () => {
    const r = convertPageToDocRow(SELF_TEST_PAGE, 't')
    expect(JSON.parse(r.snapshotJson)).toEqual(canonicalizePage(SELF_TEST_PAGE))
  })

  it('produces a ydoc that decodes back to the same block ids', () => {
    const r = convertPageToDocRow(SELF_TEST_PAGE, 't')
    const decoded = snapshotFromUpdate(new Uint8Array(r.ydoc))
    expect(decoded.page.blocks.map((b) => b.id)).toEqual(
      SELF_TEST_PAGE.blocks.map((b) => b.id),
    )
  })

  it('runSelfTest passes', () => {
    expect(runSelfTest()).toEqual({ ok: true, idsPreserved: true, roundTripOk: true })
  })

  it('treats an empty page as vacuously id-preserving', () => {
    const r = convertPageToDocRow({ blocks: [] }, '')
    expect(r.idsPreserved).toBe(true)
  })
})
