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
import {
  prosemirrorJSONToYDoc,
  prosemirrorJSONToYXmlFragment,
  yDocToProsemirrorJSON,
} from 'y-prosemirror'
import type { Page } from '@use-brian/core/dist/views/blocks.js'
import { docSchema, FRAGMENT_FIELD, META_MAP } from './schema.js'
import { blocksToPMDoc, pageToPlaintext, pmDocToBlocks, type PMDoc } from './block-mapping.js'

/**
 * The fixed Yjs `clientID` every legacy-page seed is authored under.
 *
 * A Y.Doc built by `new Y.Doc()` picks a RANDOM clientID, so two encodings of
 * the same page are two different CRDT *authors* writing the same text — and
 * `Y.applyUpdate`ing both into one doc keeps BOTH (that is the whole point of a
 * CRDT: concurrent inserts by distinct clients never dedupe). That is how a
 * page seeded twice ends up with its entire body duplicated end-to-end
 * (prod incident 2026-07-21, pages fdd1b6eb / b2e1f6ef — `saved_views.page`
 * held 37 blocks while `documents.snapshot_json` held 74).
 *
 * Pinning the seed to ONE clientID makes re-seeding idempotent: the second
 * update carries the same `(client, clock)` pairs as the first, so Yjs
 * recognizes them as already-integrated and drops them. The seed becomes
 * convergent no matter how many times, or from how many processes, it runs.
 *
 * Reserved for seeds only — live editors keep their random ids. See
 * `docs/architecture/features/doc.md` → "Real-time collaboration".
 */
export const LEGACY_SEED_CLIENT_ID = 1

/** Build a fresh Y.Doc from a page (body fragment + title in meta). */
export function pageToYDoc(page: Page, title: string): Y.Doc {
  const docJSON = blocksToPMDoc(page.blocks)
  const ydoc = prosemirrorJSONToYDoc(docSchema(), docJSON, FRAGMENT_FIELD)
  ydoc.getMap(META_MAP).set('title', title)
  return ydoc
}

/**
 * Encoded initial state for a page — what the sync service seeds + persists.
 *
 * Deterministic: same `(page, title)` in, byte-identical update out, authored
 * under `LEGACY_SEED_CLIENT_ID`. Applying it to a doc that already holds this
 * seed is a no-op. Built fragment-first (rather than via `pageToYDoc`) because
 * the clientID must be pinned BEFORE any content is written — ops are stamped
 * with the doc's clientID as they are created.
 */
export function pageToYDocUpdate(page: Page, title: string): Uint8Array {
  const ydoc = new Y.Doc()
  ydoc.clientID = LEGACY_SEED_CLIENT_ID
  prosemirrorJSONToYXmlFragment(
    docSchema(),
    blocksToPMDoc(page.blocks),
    ydoc.getXmlFragment(FRAGMENT_FIELD),
  )
  ydoc.getMap(META_MAP).set('title', title)
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
