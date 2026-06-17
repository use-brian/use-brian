/**
 * Lazy document persistence for the sync service. System-level (the per-user
 * authorization already happened at connect via the clearance gate), so the
 * injected query is the bare `query()` (system-bypass) shape.
 *
 *   - `loadPageUpdate` — read `documents.ydoc`; if absent (a page that
 *     predates collab or the migration missed), encode an initial Y.Doc from
 *     the legacy `saved_views.page` block JSON. Returns null only when the
 *     page row itself is gone.
 *   - `storePageSnapshot` — encode the live Y.Doc to the binary + a derived
 *     `snapshot_json` block list (so server reads never instantiate a Y.Doc),
 *     bump `seq`, and mirror the title to `saved_views.name`.
 *
 * [COMP:doc-sync/persistence]
 */

import * as Y from 'yjs'
import {
  FRAGMENT_FIELD,
  healBlockIds,
  pageToYDocUpdate,
  yDocToSnapshot,
} from '@sidanclaw/doc-model'
import type { Page } from '@sidanclaw/core/dist/views/blocks.js'

/** bare query()-shaped (system bypass). */
export type SysQuery = <T>(sql: string, params: unknown[]) => Promise<T[]>

export async function loadPageUpdate(params: {
  pageId: string
  query: SysQuery
}): Promise<Uint8Array | null> {
  const { pageId, query } = params
  const docRows = await query<{ ydoc: Buffer | null }>(
    `SELECT ydoc FROM documents WHERE page_id = $1`,
    [pageId],
  )
  const existing = docRows[0]?.ydoc
  if (existing) return new Uint8Array(existing)

  // Fallback: encode an initial Y.Doc from the legacy block JSON.
  const svRows = await query<{ page: Page | null; name: string | null }>(
    `SELECT page, name FROM saved_views WHERE id = $1`,
    [pageId],
  )
  const sv = svRows[0]
  if (!sv) return null
  return pageToYDocUpdate(sv.page ?? { blocks: [] }, sv.name ?? '')
}

export async function storePageSnapshot(params: {
  pageId: string
  ydoc: Y.Doc
  query: SysQuery
}): Promise<void> {
  const { pageId, ydoc, query } = params
  // Stamp a `blockId` onto any ID-carrying node missing one (and heal forks)
  // BEFORE deriving the snapshot, so every id `snapshot_json` surfaces is a
  // real, stable attribute. Without this, `pmDocToBlocks` fabricates a fresh
  // id for an editor-created (attr-less) node on every conversion — each
  // persist rotated the id, and every AI op targeting it missed (prod
  // incident 2026-06-11, page c4b01fe2 / session 81a56d8b). Idempotent: a
  // fully-stamped doc is untouched, so this can't re-trigger the store
  // debounce in a loop.
  ydoc.transact(() => healBlockIds(ydoc.getXmlFragment(FRAGMENT_FIELD)))
  const update = Buffer.from(Y.encodeStateAsUpdate(ydoc))
  const stateVector = Buffer.from(Y.encodeStateVector(ydoc))
  const { page, title } = yDocToSnapshot(ydoc)

  await query(
    `INSERT INTO documents
       (page_id, ydoc, state_vector, snapshot_json, snapshot_title, seq, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, 1, now())
     ON CONFLICT (page_id) DO UPDATE SET
       ydoc           = EXCLUDED.ydoc,
       state_vector   = EXCLUDED.state_vector,
       snapshot_json  = EXCLUDED.snapshot_json,
       snapshot_title = EXCLUDED.snapshot_title,
       seq            = documents.seq + 1,
       updated_at     = now()`,
    [pageId, update, stateVector, JSON.stringify(page), title],
  )

  // Mirror the collaborative title back to saved_views.name so the sidebar
  // listing (which reads saved_views, not the Y.Doc) stays current.
  //
  // Scoped to `name_origin = 'placeholder'` (migration 218): once a title is
  // auto-generated ('auto') or deliberately set ('user'), `saved_views.name`
  // is owned by those write paths, and the Y.Doc `meta.title` may be a stale
  // seed (the REST rename / auto-title paths don't push into the doc). Without
  // this guard a later body edit would mirror that stale title back over the
  // real name — the split-brain this column was added to close. See
  // docs/architecture/features/doc.md → "Auto-title".
  await query(
    `UPDATE saved_views
        SET name = $2
      WHERE id = $1
        AND name_origin = 'placeholder'
        AND name IS DISTINCT FROM $2`,
    [pageId, title || 'New draft'],
  )
}
