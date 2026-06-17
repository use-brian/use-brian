/**
 * KB gap candidate routes — `/api/kb-gaps/*`.
 *
 * The user-facing surface for CL-9 retrieval-miss-as-a-signal. The
 * weekly aggregator worker writes `kb_gap_candidate` rows when a
 * cluster of retrieval misses crosses the spec gate. The chrome pill
 * polls `GET /api/kb-gaps?workspaceId=X` for the open-count badge; the
 * review page (`/knowledge-base/gaps`) lists the same set with full
 * cards. Each card resolves through `POST /:id/dismiss` (suppresses)
 * or `POST /:id/draft` (marks drafted + redirects to a pre-filled KB
 * editor).
 *
 * **No auto-write of KB rows from here.** The `draft` route only
 * stamps `drafted_at` — the actual KB entry creation happens in the
 * web client's KB editor with the pattern summary pre-filled via
 * query parameters.
 *
 * Spec: `docs/architecture/context-engine/memory-consolidation.md` → CL-9 lock →
 * User-in-the-loop drafting.
 *
 * Mounted at `/api/kb-gaps` behind `requireAuth`. Workspace
 * membership is enforced inline by `workspaceStore.getRole`.
 *
 * [COMP:api/kb-gaps-route]
 *
 *   GET  /api/kb-gaps?workspaceId=X              — list open candidates + count
 *   POST /api/kb-gaps/:id/dismiss                — mark dismissed (suppress N days)
 *   POST /api/kb-gaps/:id/draft                  — mark drafted (caller opens editor)
 */

import { Router } from 'express'
import type { KbGapCandidateStore } from '../db/kb-gap-candidate-store.js'
import type { WorkspaceStore } from '../db/workspace-store.js'

type KbGapsRouteOptions = {
  kbGapStore: KbGapCandidateStore
  workspaceStore: WorkspaceStore
}

export function kbGapsRoutes({
  kbGapStore,
  workspaceStore,
}: KbGapsRouteOptions): Router {
  const router = Router()

  // ── GET /api/kb-gaps ─────────────────────────────────────────
  //
  // List open candidates for `workspaceId` (query param). The active
  // workspace is selected by the chrome's WorkspaceSwitcher — the
  // client passes it through explicitly. Membership at any role is
  // sufficient; KB gaps surface to everyone who can read the KB.

  router.get('/', async (req, res) => {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const workspaceId = (req.query.workspaceId as string | undefined)?.trim()
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId is required' })
      return
    }
    const role = await workspaceStore.getRole(userId, workspaceId)
    if (!role) {
      res.status(403).json({ error: 'Not a member of this workspace' })
      return
    }

    try {
      // Pass the acting userId so RLS context is set on the read
      // (the store accepts `actingUserId` and routes through
      // `queryWithRLS` when present). Without this, a bare `query()`
      // would bypass the per-workspace RLS gate.
      const candidates = await kbGapStore.listOpen(workspaceId, {
        actingUserId: userId,
      })
      res.json({ candidates, count: candidates.length })
    } catch (err) {
      console.error('[kb-gaps] list failed:', err)
      res.status(500).json({ error: 'Failed to list KB gap candidates' })
    }
  })

  // ── POST /api/kb-gaps/:id/dismiss ────────────────────────────
  //
  // User dismisses a candidate. The store stamps `dismissed_at` +
  // `dismissed_by_user_id`. The aggregator's open-candidate match
  // check (see `workers/retrieval-miss-aggregator.ts`) will hide
  // similar clusters from re-emission while the dismissed row is
  // still visible to the suppression window.

  router.post('/:id/dismiss', async (req, res) => {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const id = req.params.id
    if (!id) {
      res.status(400).json({ error: 'id is required' })
      return
    }
    try {
      const ok = await kbGapStore.dismiss(userId, id)
      if (!ok) {
        res.status(404).json({ error: 'Candidate not found or already dismissed' })
        return
      }
      res.json({ ok: true })
    } catch (err) {
      console.error('[kb-gaps] dismiss failed:', err)
      res.status(500).json({ error: 'Failed to dismiss candidate' })
    }
  })

  // ── POST /api/kb-gaps/:id/draft ──────────────────────────────
  //
  // User opened the KB editor to draft an entry from this gap. The
  // store stamps `drafted_at` + `drafted_by_user_id`; the actual KB
  // entry write happens on the client side via the existing KB editor
  // flow (pattern summary is passed through query params for
  // pre-fill). Sequence:
  //   1. Client clicks "Draft KB entry" on a card
  //   2. POST /api/kb-gaps/:id/draft (this route)
  //   3. Client navigates to /knowledge-base/new?from-gap=:id&pattern=...
  //
  // The route is idempotent at the store layer — second call returns
  // 404 (already drafted) but that's a no-op for the UI.

  router.post('/:id/draft', async (req, res) => {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const id = req.params.id
    if (!id) {
      res.status(400).json({ error: 'id is required' })
      return
    }
    try {
      const ok = await kbGapStore.markDrafted(userId, id)
      if (!ok) {
        res.status(404).json({ error: 'Candidate not found or already drafted' })
        return
      }
      res.json({ ok: true })
    } catch (err) {
      console.error('[kb-gaps] draft failed:', err)
      res.status(500).json({ error: 'Failed to mark candidate drafted' })
    }
  })

  return router
}
