/**
 * Y.Doc ↔ doc `Page` bridge. Wraps y-prosemirror's JSON converters with
 * the shared schema + block mapping so all four consumers (browser, sync
 * server, AI client, migration) encode/decode a page identically.
 *
 * Title lives in a Y.Map ('meta') alongside the body XML fragment ('default')
 * so it co-syncs with the doc and survives a snapshot round-trip.
 *
 * [COMP:doc-model/encode]
 */

import * as Y from 'yjs'
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from 'y-prosemirror'
import type { Page } from '@sidanclaw/core/dist/views/blocks.js'
import { docSchema, FRAGMENT_FIELD, META_MAP } from './schema.js'
import { blocksToPMDoc, pageToPlaintext, pmDocToBlocks, type PMDoc } from './block-mapping.js'

/** Build a fresh Y.Doc from a page (body fragment + title in meta). */
export function pageToYDoc(page: Page, title: string): Y.Doc {
  const docJSON = blocksToPMDoc(page.blocks)
  const ydoc = prosemirrorJSONToYDoc(docSchema(), docJSON, FRAGMENT_FIELD)
  ydoc.getMap(META_MAP).set('title', title)
  return ydoc
}

/** Encoded initial state for a page — what the sync service seeds + persists. */
export function pageToYDocUpdate(page: Page, title: string): Uint8Array {
  const ydoc = pageToYDoc(page, title)
  const update = Y.encodeStateAsUpdate(ydoc)
  ydoc.destroy()
  return update
}

/** Derive the block-JSON snapshot + title from a live Y.Doc. */
export function yDocToSnapshot(ydoc: Y.Doc): { page: Page; title: string } {
  const docJSON = yDocToProsemirrorJSON(ydoc, FRAGMENT_FIELD) as PMDoc
  const blocks = pmDocToBlocks(docJSON)
  const title = (ydoc.getMap(META_MAP).get('title') as string | undefined) ?? ''
  return { page: { blocks }, title }
}

export function yDocFromUpdate(update: Uint8Array): Y.Doc {
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, update)
  return ydoc
}

/** Decode a persisted update straight to a snapshot (server read path). */
export function snapshotFromUpdate(update: Uint8Array): { page: Page; title: string } {
  const ydoc = yDocFromUpdate(update)
  const snap = yDocToSnapshot(ydoc)
  ydoc.destroy()
  return snap
}

/**
 * Plaintext of a live Y.Doc's body — the client-side auto-title source. Decodes
 * the doc to a snapshot, then flattens via `pageToPlaintext`. The browser
 * editor calls this on (debounced) doc updates to measure body size and feed
 * the title generator. See docs/architecture/features/doc.md → "Auto-title".
 */
export function yDocToPlaintext(ydoc: Y.Doc): string {
  return pageToPlaintext(yDocToSnapshot(ydoc).page)
}
