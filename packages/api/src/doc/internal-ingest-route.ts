/**
 * Internal doc-page ingest endpoint — `POST /internal/ingest-page`.
 *
 * The auto-on-save seam. `apps/doc-sync` persists a page snapshot on its
 * debounced Yjs settle, then fires a best-effort, fire-and-forget POST here when
 * the page's "Sync to brain" toggle is on. doc-sync is deliberately THIN (only a
 * system `query` port, no Pipeline B deps), so it never runs ingestion itself —
 * it just signals this endpoint, which runs the same runner the manual route +
 * chat tool use, in the BACKGROUND.
 *
 * # Auth — shared secret (the established cross-app pattern)
 *
 * The API↔doc-sync pair already shares `DOC_SYNC_SECRET` (API → doc-sync's
 * `/internal/apply` uses the `x-doc-sync-secret` header; see
 * `packages/api/src/doc/doc-gateway.ts` + `apps/doc-sync/src/index.ts`). We
 * reuse the SAME secret + header in the reverse direction here — no new secret
 * to provision. If `DOC_SYNC_SECRET` is unset, the endpoint refuses every
 * request (the feature is simply off in that deploy), exactly like doc-sync's
 * own internal routes refuse when the secret is absent.
 *
 * # The dedup + cooldown gate (re-ingest-storm guard)
 *
 * doc-sync gates BEFORE firing (it has the live authored hash); this endpoint
 * RE-GATES authoritatively against the persisted `saved_views` row:
 *   - the toggle must still be on (`brain_sync_enabled`),
 *   - a cooldown must have elapsed since `brain_last_ingest_at`
 *     (`INGEST_COOLDOWN_MS`), and
 *   - the runner itself skips when the authored hash equals
 *     `brain_last_ingest_hash` (passed as `skipIfHashUnchanged`).
 * All three are REQUIRED so a burst of debounced saves collapses to at most one
 * ingest. The runner runs in the background; the endpoint acks immediately.
 *
 * Spec: docs/plans/canvas-brain-distillation.md (the auto-on-save deviation).
 *
 * [COMP:api/internal-ingest-route]
 */

import { Router } from 'express'
import type { SavedViewStore } from '@sidanclaw/core'

/**
 * Cooldown between auto-ingests of the same page. A debounced Yjs save fires
 * every couple of seconds while a human types; without this a long editing
 * session would re-ingest dozens of times. Five minutes collapses an editing
 * burst into one ingest while still picking up a "settled" page promptly. The
 * manual route + chat tool bypass this gate (an explicit request is "now").
 */
export const INGEST_COOLDOWN_MS = 5 * 60 * 1000

export type InternalIngestRouteOptions = {
  savedViewStore: SavedViewStore
  /** The runner — RLS-scoped to the page owner the endpoint resolves. */
  ingestPage: (args: {
    userId: string
    pageId: string
    skipIfHashUnchanged?: string | null
  }) => Promise<void>
  /** The shared secret (default `process.env.DOC_SYNC_SECRET`). */
  sharedSecret?: string
  /** Injectable clock for tests. */
  now?: () => number
}

export function internalIngestRoutes(opts: InternalIngestRouteOptions): Router {
  const router = Router()
  const sharedSecret = opts.sharedSecret ?? process.env.DOC_SYNC_SECRET
  const now = opts.now ?? (() => Date.now())

  router.post('/internal/ingest-page', async (req, res) => {
    // Auth — same shared secret + header as the API→doc-sync direction.
    if (!sharedSecret || req.headers['x-doc-sync-secret'] !== sharedSecret) {
      return res.status(403).json({ error: 'forbidden' })
    }
    const pageId = (req.body as { pageId?: unknown } | undefined)?.pageId
    if (typeof pageId !== 'string' || !pageId) {
      return res.status(400).json({ error: 'pageId required' })
    }

    // System-side read — doc-sync has no member context; resolve the page owner.
    const state = await opts.savedViewStore.getBrainSyncStateSystem(pageId)
    if (!state) {
      // Page gone — ack so doc-sync never retries a dead page.
      console.warn(`[internal-ingest] ${pageId}: skipped — page not found`)
      return res.status(200).json({ skipped: 'not_found' })
    }
    if (!state.brainSyncEnabled) {
      console.log(`[internal-ingest] ${pageId}: skipped — "Sync to brain" toggle is off`)
      return res.status(200).json({ skipped: 'disabled' })
    }
    // Cooldown gate — collapse a save burst into at most one ingest.
    if (
      state.brainLastIngestAt &&
      now() - state.brainLastIngestAt.getTime() < INGEST_COOLDOWN_MS
    ) {
      console.log(`[internal-ingest] ${pageId}: skipped — cooldown (last ingest <5min ago)`)
      return res.status(200).json({ skipped: 'cooldown' })
    }
    console.log(`[internal-ingest] ${pageId}: queued background ingest`)

    // Background runner. The runner's own content-hash skip is the third gate
    // (an unchanged authored layer re-ingests nothing). Acked immediately — a
    // failed ingest is logged, never bubbled to doc-sync (which must not block
    // its snapshot write on us).
    void opts
      .ingestPage({
        userId: state.createdBy,
        pageId,
        skipIfHashUnchanged: state.brainLastIngestHash,
      })
      .catch((err: unknown) => {
        console.error(
          `[internal-ingest] background ingestPage failed for ${pageId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      })

    return res.status(202).json({ queued: true })
  })

  return router
}
