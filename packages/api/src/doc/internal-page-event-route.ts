/**
 * Internal doc-page lifecycle endpoint — `POST /internal/page-event`.
 *
 * The content-edit half of the `page` workflow-event source. Metadata writes
 * (rename / icon / clearance / binding / brain-sync) emit their `updated` event
 * straight from the saved-views store's `update` method, but **block-content**
 * edits never touch that method — they live in the collaborative Y.Doc and are
 * persisted by the separate `apps/doc-sync` service, out of the API process. So
 * a body edit had no path to `publishPageLifecycle` and never fired a
 * `page`-source `updated` workflow (the reported bug).
 *
 * doc-sync closes the gap the same way it does for auto-on-save brain ingest:
 * on its debounced Yjs settle it fires a best-effort, fire-and-forget POST here.
 * This endpoint resolves the page's workspace / parent / title system-side and
 * hands a `PageLifecycleEvent` to the injected `publish` sink (the late-bound
 * `publishPageLifecycle` seam in production), which fans out to the workspace's
 * `event`-trigger workflows.
 *
 * # Auth — the shared secret (same as `/internal/ingest-page`)
 *
 * The API↔doc-sync pair already shares `DOC_SYNC_SECRET` via the
 * `x-doc-sync-secret` header (both the API→doc-sync `/internal/apply` and the
 * doc-sync→API `/internal/ingest-page` directions). We reuse it here — no new
 * secret. If `DOC_SYNC_SECRET` is unset the endpoint refuses every request (the
 * content-edit trigger is simply off in that deploy), exactly like the ingest
 * route.
 *
 * # isSystem (the self-loop guard)
 *
 * doc-sync sets `isSystem` from whether the writes in the debounce window came
 * through its trusted `/internal/apply` path (an AI `patchPage` apply) rather
 * than a human WebSocket edit. It rides through to `PageLifecycleEvent.isSystem`
 * → `DispatchEvent.isBot`, so a workflow whose own step edits a page it watches
 * does not re-trigger itself (default `match.fromBots: false`). See
 * docs/architecture/features/workflow.md → "Page event source".
 *
 * Mounted unconditionally in `bootOpenApi` (no Pipeline B dependency, unlike the
 * ingest route), so **both editions** — OSS and closed — get content-edit page
 * triggers. NB: NO requireAuth — it authenticates via the shared secret header,
 * not a user JWT (doc-sync has no member context).
 *
 * Spec: docs/architecture/features/workflow.md → "Page event source".
 *
 * [COMP:api/internal-page-event-route]
 */

import { Router } from 'express'
import {
  PAGE_LIFECYCLE_ACTIONS,
  type PageLifecycleAction,
  type PageLifecycleEvent,
  type SavedViewStore,
} from '@sidanclaw/core'

export type InternalPageEventRouteOptions = {
  savedViewStore: SavedViewStore
  /**
   * The lifecycle sink — `publishPageLifecycle` (`../page-event-fanout.ts`) in
   * production; injected for tests. Best-effort and synchronous (fire-and-forget
   * inside), so the endpoint acks immediately.
   */
  publish: (event: PageLifecycleEvent) => void
  /** The shared secret (default `process.env.DOC_SYNC_SECRET`). */
  sharedSecret?: string
}

function isPageLifecycleAction(v: unknown): v is PageLifecycleAction {
  return (
    typeof v === 'string' &&
    (PAGE_LIFECYCLE_ACTIONS as readonly string[]).includes(v)
  )
}

export function internalPageEventRoutes(
  opts: InternalPageEventRouteOptions,
): Router {
  const router = Router()
  const sharedSecret = opts.sharedSecret ?? process.env.DOC_SYNC_SECRET

  router.post('/internal/page-event', async (req, res) => {
    // Auth — same shared secret + header as the other API↔doc-sync routes.
    if (!sharedSecret || req.headers['x-doc-sync-secret'] !== sharedSecret) {
      return res.status(403).json({ error: 'forbidden' })
    }
    const body = (req.body ?? {}) as {
      pageId?: unknown
      action?: unknown
      isSystem?: unknown
    }
    const pageId = body.pageId
    if (typeof pageId !== 'string' || !pageId) {
      return res.status(400).json({ error: 'pageId required' })
    }
    // doc-sync only signals content edits today; default to `updated`. Reject an
    // explicitly-supplied bad action rather than silently coercing it.
    const action: PageLifecycleAction =
      body.action === undefined ? 'updated' : body.action as PageLifecycleAction
    if (!isPageLifecycleAction(action)) {
      return res.status(400).json({ error: 'invalid action' })
    }
    const isSystem = body.isSystem === true

    // System-side read — doc-sync has no member context; resolve the page's
    // workspace / parent / title.
    const ctx = await opts.savedViewStore.getPageEventContextSystem(pageId)
    if (!ctx) {
      // Page gone — ack so doc-sync never retries a dead page.
      return res.status(200).json({ skipped: 'not_found' })
    }

    // Best-effort fan-out. `publish` swallows its own errors (fire-and-forget),
    // so the ack never depends on a workflow start. `actorId` is null: a
    // debounced content snapshot can aggregate several editors and has no single
    // acting user — the honest value for an out-of-band content-edit event.
    opts.publish({
      workspaceId: ctx.workspaceId,
      pageId,
      parentId: ctx.parentId,
      title: ctx.title,
      actorId: null,
      action,
      isSystem,
    })

    return res.status(202).json({ dispatched: true })
  })

  return router
}
