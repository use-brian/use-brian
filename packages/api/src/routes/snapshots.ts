/**
 * Snapshot management routes.
 *
 * Mounted at `/api/snapshots` behind requireAuth.
 *
 * [COMP:api/snapshots-route]
 *
 *   POST   /auto-generate/:assistantId/:category — auto-generate + publish snapshot
 *   POST   /generate/:assistantId/:category      — manual draft from provided content
 *   GET    /drafts/:assistantId                   — list draft snapshots
 *   POST   /:snapshotId/publish                   — publish a snapshot
 *   GET    /:assistantId/:category                — get published snapshot
 */

import { Router } from 'express'
import type { SnapshotStore } from '../db/snapshot-store.js'
import { requireAssistantMember } from './route-helpers.js'

export type SnapshotGenerator = (assistantId: string, userId: string, category: string) => Promise<string>

type SnapshotRouteOptions = {
  snapshotStore: SnapshotStore
  /** Headless query loop that generates snapshot content for a category. */
  generateSnapshot?: SnapshotGenerator
}

const VALID_CATEGORIES = ['calendar', 'knowledge', 'tasks', 'memories'] as const

export function snapshotRoutes({ snapshotStore, generateSnapshot }: SnapshotRouteOptions): Router {
  const router = Router()

  // ── POST /auto-generate/:assistantId/:category — auto-generate + publish ──

  router.post('/auto-generate/:assistantId/:category', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const { assistantId, category } = req.params
    if (!VALID_CATEGORIES.includes(category as any)) {
      res.status(400).json({ error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` })
      return
    }

    if (!(await requireAssistantMember(userId, assistantId, res))) return

    if (!generateSnapshot) {
      res.status(501).json({ error: 'Snapshot generation not configured' })
      return
    }

    try {
      const summary = await generateSnapshot(assistantId, userId, category)
      res.json({ ok: true, summary })
    } catch (err) {
      console.error('[snapshots] auto-generate failed:', err)
      res.status(500).json({ error: 'Failed to generate snapshot' })
    }
  })

  // ── POST /generate/:assistantId/:category — manual draft ────

  router.post('/generate/:assistantId/:category', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const { assistantId, category } = req.params
    if (!VALID_CATEGORIES.includes(category as any)) {
      res.status(400).json({ error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` })
      return
    }

    if (!(await requireAssistantMember(userId, assistantId, res))) return

    const { content } = req.body as { content?: Record<string, unknown> }
    if (!content || typeof content !== 'object') {
      res.status(400).json({ error: 'content (JSON object) is required' })
      return
    }

    try {
      const snapshot = await snapshotStore.generateDraft(assistantId, category, content)
      res.status(201).json(snapshot)
    } catch (err) {
      console.error('[snapshots] generate failed:', err)
      res.status(500).json({ error: 'Failed to generate snapshot' })
    }
  })

  // ── GET /drafts/:assistantId — list draft snapshots ────────────

  router.get('/drafts/:assistantId', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const { assistantId } = req.params
    if (!(await requireAssistantMember(userId, assistantId, res))) return

    try {
      const drafts = await snapshotStore.listDrafts(userId, assistantId)
      res.json({ drafts })
    } catch (err) {
      console.error('[snapshots] list drafts failed:', err)
      res.status(500).json({ error: 'Failed to list drafts' })
    }
  })

  // ── POST /:snapshotId/publish — publish a snapshot ─────────────

  router.post('/:snapshotId/publish', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const { snapshotId } = req.params
    const { edits } = req.body as { edits?: Record<string, unknown> }

    try {
      const snapshot = await snapshotStore.publish(userId, snapshotId, edits)
      if (!snapshot) {
        res.status(404).json({ error: 'Snapshot not found' })
        return
      }
      res.json(snapshot)
    } catch (err) {
      console.error('[snapshots] publish failed:', err)
      res.status(500).json({ error: 'Failed to publish snapshot' })
    }
  })

  // ── GET /:assistantId/:category — get published snapshot ───────

  router.get('/:assistantId/:category', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const { assistantId, category } = req.params
    if (!VALID_CATEGORIES.includes(category as any)) {
      res.status(400).json({ error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` })
      return
    }

    if (!(await requireAssistantMember(userId, assistantId, res))) return

    try {
      const snapshot = await snapshotStore.getPublishedForOwner(userId, assistantId, category)
      if (!snapshot) {
        res.status(404).json({ error: 'No published snapshot found' })
        return
      }
      res.json(snapshot)
    } catch (err) {
      console.error('[snapshots] get published failed:', err)
      res.status(500).json({ error: 'Failed to get snapshot' })
    }
  })

  return router
}
