/**
 * Pure converter for the hard-cutover migration of legacy block-JSON doc
 * pages (`saved_views.page`) into initial Y.Doc state rows (`documents`).
 * Kept here (not in the script) so it unit-tests without a DB.
 *
 * The id-preservation invariant is load-bearing: `child_page.childPageId`
 * references and `data`-block bindings must keep resolving after the cutover,
 * so a row whose ids don't survive the round-trip is reported and skipped
 * rather than written.
 *
 * [COMP:api/doc-migration]
 */

import {
  pageToYDocUpdate,
  snapshotFromUpdate,
  canonicalizePage,
} from '@sidanclaw/doc-model'
import type { Page } from '@sidanclaw/core/dist/views/blocks.js'

export type ConvertResult = {
  /** Encoded Y.Doc initial state for `documents.ydoc`. */
  ydoc: Buffer
  /** Derived block-list read model for `documents.snapshot_json`. */
  snapshotJson: string
  title: string
  /** Every original block id survived the round-trip (vacuously true for an empty page). */
  idsPreserved: boolean
  /** The decoded snapshot equals the documented canonical form of the input. */
  roundTripOk: boolean
}

export function convertPageToDocRow(page: Page, name: string): ConvertResult {
  const update = pageToYDocUpdate(page, name)
  const snap = snapshotFromUpdate(update)

  const originalIds = page.blocks.map((b) => b.id)
  const roundTripIds = snap.page.blocks.map((b) => b.id)
  const idsPreserved =
    originalIds.length === 0
      ? true
      : originalIds.length === roundTripIds.length &&
        originalIds.every((id, i) => id === roundTripIds[i])

  const roundTripOk =
    JSON.stringify(snap.page) === JSON.stringify(canonicalizePage(page))

  return {
    ydoc: Buffer.from(update),
    snapshotJson: JSON.stringify(snap.page),
    title: snap.title,
    idsPreserved,
    roundTripOk,
  }
}

const rich = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

/**
 * One block of every one of the 16 kinds (incl. consecutive list runs). The
 * `--dry-run` self-test + the unit test both convert this so "round-trips all
 * 16 block kinds with ids preserved" is demonstrable independent of local data.
 */
export const SELF_TEST_PAGE: Page = {
  blocks: [
    { kind: 'heading', id: 'h1', level: 1, text: 'Q3 pipeline' },
    { kind: 'text', id: 't1', text: 'Updated Mondays.' },
    { kind: 'text', id: 't2', text: 'Muted.', variant: 'muted' },
    { kind: 'divider', id: 'd1' },
    { kind: 'callout', id: 'c1', icon: '🔥', richText: rich('Heads up') as never },
    { kind: 'code', id: 'co1', language: 'ts', code: 'const x = 1' },
    { kind: 'quote', id: 'q1', richText: rich('A quote') as never },
    { kind: 'bulleted_list_item', id: 'b1', richText: rich('one') as never },
    { kind: 'bulleted_list_item', id: 'b2', richText: rich('two') as never },
    { kind: 'numbered_list_item', id: 'n1', richText: rich('first') as never },
    { kind: 'numbered_list_item', id: 'n2', richText: rich('second') as never },
    { kind: 'to_do', id: 'td1', checked: false, richText: rich('todo') as never },
    { kind: 'to_do', id: 'td2', checked: true, richText: rich('done') as never },
    { kind: 'toggle', id: 'tg1', expanded: true, richText: rich('body') as never },
    { kind: 'data', id: 'data1', binding: { entity: 'tasks', viewType: 'table' } as never },
    {
      kind: 'chart',
      id: 'chart1',
      chartType: 'bar',
      title: 'By status',
      binding: { op: 'count', groupBy: 'status' } as never,
    },
    {
      kind: 'image',
      id: 'img1',
      ref: { bucket: 'b', path: 'p.png', mimeType: 'image/png', sizeBytes: 1, name: 'p.png' },
    },
    {
      kind: 'file',
      id: 'f1',
      ref: { bucket: 'b', path: 'f.pdf', mimeType: 'application/pdf', sizeBytes: 2, name: 'f.pdf' },
    },
    { kind: 'bookmark', id: 'bm1', url: 'https://example.com', meta: { title: 'Example' } },
    { kind: 'child_page', id: 'cp1', childPageId: 'page-xyz' },
  ] as never,
}

export function runSelfTest(): { ok: boolean; idsPreserved: boolean; roundTripOk: boolean } {
  const r = convertPageToDocRow(SELF_TEST_PAGE, 'self-test')
  return { ok: r.idsPreserved && r.roundTripOk, idsPreserved: r.idsPreserved, roundTripOk: r.roundTripOk }
}
