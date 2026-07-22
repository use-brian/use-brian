/**
 * Lazy document persistence for the sync service. System-level (the per-user
 * authorization already happened at connect via the clearance gate), so the
 * injected query is the bare `query()` (system-bypass) shape.
 *
 *   - `loadPageUpdate` — read `documents.ydoc`; if absent (a page that
 *     predates collab, the migration missed, or a server-side CAS write
 *     created), encode an initial Y.Doc from the legacy `saved_views.page`
 *     block JSON. Returns null only when the page row itself is gone, and
 *     tags which of the two it returned (`origin`) — the caller must never
 *     stack a `legacy-seed` onto a doc that already holds body content.
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
} from '@use-brian/doc-model'
import type { Page } from '@use-brian/core/dist/views/blocks.js'
import { hashAuthoredContent } from '@use-brian/core/dist/ingest/ingest-page.js'

/** bare query()-shaped (system bypass). */
export type SysQuery = <T>(sql: string, params: unknown[]) => Promise<T[]>

/**
 * Auto-on-save brain-ingest enqueue (canvas-brain-distillation.md, the
 * user-requested deviation). doc-sync stays THIN — it never runs Pipeline B
 * (no ingest deps). On a debounced settle it: (a) checks the per-page "Sync to
 * brain" toggle, (b) dedups against the last-ingested authored hash, (c) waits
 * a cooldown since the last ingest — then fires a best-effort, FIRE-AND-FORGET
 * POST to the API's `/internal/ingest-page`. Every step swallows its own error
 * so a failed enqueue never breaks the snapshot write.
 *
 * The hash + cooldown gate here is the FIRST line of the re-ingest-storm guard
 * (the API re-gates authoritatively). Without it, every 2s debounce while a
 * human types would POST.
 */
export type BrainIngestEnqueueConfig = {
  /** The API base (http) — `process.env.API_INTERNAL_URL`. */
  apiBaseUrl: string
  /** Shared secret — same `DOC_SYNC_SECRET` the API→doc-sync direction uses. */
  syncSecret: string
  /** Cooldown ms between auto-enqueues for one page (mirror the API constant). */
  cooldownMs: number
  /** Injectable fetch/clock for tests. */
  doFetch?: typeof fetch
  now?: () => number
}

type BrainSyncRow = {
  brainSyncEnabled: boolean
  brainLastIngestHash: string | null
  brainLastIngestAt: Date | null
}

/**
 * Best-effort: enqueue a brain ingest for a just-persisted page if its toggle is
 * on and the dedup/cooldown gate passes. Returns the outcome for tests; the
 * production caller ignores it. NEVER throws.
 */
export async function maybeEnqueueBrainIngest(params: {
  pageId: string
  page: Page
  query: SysQuery
  config: BrainIngestEnqueueConfig
}): Promise<'enqueued' | 'disabled' | 'unchanged' | 'cooldown' | 'error'> {
  const { pageId, page, query, config } = params
  const now = config.now ?? (() => Date.now())
  const doFetch = config.doFetch ?? fetch
  try {
    const rows = await query<BrainSyncRow>(
      `SELECT brain_sync_enabled     AS "brainSyncEnabled",
              brain_last_ingest_hash AS "brainLastIngestHash",
              brain_last_ingest_at   AS "brainLastIngestAt"
         FROM saved_views WHERE id = $1`,
      [pageId],
    )
    const row = rows[0]
    if (!row || !row.brainSyncEnabled) return 'disabled'

    // Dedup — an authored-content hash equal to the last ingest's is a no-op.
    const hash = hashAuthoredContent(page.blocks)
    if (row.brainLastIngestHash && row.brainLastIngestHash === hash) return 'unchanged'

    // Cooldown — collapse a save burst into at most one enqueue.
    if (
      row.brainLastIngestAt &&
      now() - new Date(row.brainLastIngestAt).getTime() < config.cooldownMs
    ) {
      return 'cooldown'
    }

    // Fire-and-forget POST. A non-2xx / network error is swallowed (logged) so
    // the snapshot write is never affected. We DO log the response status so an
    // auth (403) / routing (404 — route not mounted) failure is visible.
    const res = await doFetch(`${config.apiBaseUrl.replace(/\/+$/, '')}/internal/ingest-page`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-doc-sync-secret': config.syncSecret,
      },
      body: JSON.stringify({ pageId }),
    })
    console.log(`[doc-sync] brain-ingest enqueued for ${pageId} → POST /internal/ingest-page ${res.status}`)
    return 'enqueued'
  } catch (err) {
    console.error(
      `[doc-sync] brain-ingest enqueue failed for ${pageId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return 'error'
  }
}

/**
 * Content-edit page-event signal (the `page` workflow-trigger source). A
 * block-content edit lives in the collaborative Y.Doc, not the saved-views
 * store's metadata `update` method, so it has no path to `publishPageLifecycle`
 * inside the API process. On a debounced settle doc-sync fires this best-effort,
 * FIRE-AND-FORGET POST to the API's `/internal/page-event`, which resolves the
 * page's workspace / parent / title and dispatches an `updated` event to the
 * workspace's `event`-trigger workflows.
 *
 * Reuses the SAME `DOC_SYNC_SECRET` + `x-doc-sync-secret` header as the
 * brain-ingest signal. `isSystem` marks an AI-`patchPage`-authored settle (vs a
 * human edit) so a workflow that edits a page it watches doesn't self-loop.
 * Swallows every error — a failed dispatch never breaks the snapshot write. Off
 * (a no-op) unless both the API URL and the shared secret are configured.
 */
export async function notifyPageUpdated(params: {
  pageId: string
  isSystem: boolean
  config: {
    apiBaseUrl: string
    syncSecret: string
    doFetch?: typeof fetch
  }
}): Promise<'dispatched' | 'error'> {
  const { pageId, isSystem, config } = params
  const doFetch = config.doFetch ?? fetch
  try {
    const res = await doFetch(
      `${config.apiBaseUrl.replace(/\/+$/, '')}/internal/page-event`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-doc-sync-secret': config.syncSecret,
        },
        body: JSON.stringify({ pageId, action: 'updated', isSystem }),
      },
    )
    console.log(
      `[doc-sync] page-event dispatched for ${pageId} (isSystem=${isSystem}) → POST /internal/page-event ${res.status}`,
    )
    return 'dispatched'
  } catch (err) {
    console.error(
      `[doc-sync] page-event dispatch failed for ${pageId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return 'error'
  }
}

/**
 * What `loadPageUpdate` found. The caller MUST distinguish the two: a
 * `persisted` update is the doc's own history and is always safe to apply,
 * while a `legacy-seed` is a fresh encoding of `saved_views.page` that must
 * never stack onto a doc that already holds body content. See `onLoadDocument`.
 */
export type LoadedPageUpdate = {
  update: Uint8Array
  origin: 'persisted' | 'legacy-seed'
}

export async function loadPageUpdate(params: {
  pageId: string
  query: SysQuery
}): Promise<LoadedPageUpdate | null> {
  const { pageId, query } = params
  const docRows = await query<{ ydoc: Buffer | null }>(
    `SELECT ydoc FROM documents WHERE page_id = $1`,
    [pageId],
  )
  const existing = docRows[0]?.ydoc
  if (existing) return { update: new Uint8Array(existing), origin: 'persisted' }

  // Fallback: encode an initial Y.Doc from the legacy block JSON.
  const svRows = await query<{ page: Page | null; name: string | null }>(
    `SELECT page, name FROM saved_views WHERE id = $1`,
    [pageId],
  )
  const sv = svRows[0]
  if (!sv) return null
  return {
    update: pageToYDocUpdate(sv.page ?? { blocks: [] }, sv.name ?? ''),
    origin: 'legacy-seed',
  }
}

export async function storePageSnapshot(params: {
  pageId: string
  ydoc: Y.Doc
  query: SysQuery
}): Promise<{ page: Page; title: string }> {
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

  // Hand the derived snapshot back so the caller can feed the auto-on-save
  // brain-ingest enqueue without re-deriving the page from the Y.Doc.
  return { page, title }
}
