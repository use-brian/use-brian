/**
 * Snapshot store — owner-reviewed data snapshots for sharing.
 *
 * Snapshots are frozen data blobs that external callers can access
 * without triggering a live query loop. The owner generates a draft,
 * reviews it, and publishes. Only one published snapshot per
 * (assistant, category) exists at a time.
 *
 * See docs/plans/inter-assistant-communication.md.
 */

import { query, queryWithRLS } from './client.js'

// ── Types ──────────────────────────────────────────────────────

export type Snapshot = {
  id: string
  assistantId: string
  category: string
  content: Record<string, unknown>
  status: 'draft' | 'published'
  generatedAt: Date
  publishedAt: Date | null
  reviewedBy: string | null
}

const SNAPSHOT_COLUMNS = `
  id,
  assistant_id AS "assistantId",
  category,
  content,
  status,
  generated_at AS "generatedAt",
  published_at AS "publishedAt",
  reviewed_by AS "reviewedBy"
` as const

// ── Store ──────────────────────────────────────────────────────

export type SnapshotStore = {
  /** Create a draft snapshot from generated content. */
  generateDraft(assistantId: string, category: string, content: Record<string, unknown>): Promise<Snapshot>

  /** List draft snapshots for an assistant. */
  listDrafts(userId: string, assistantId: string): Promise<Snapshot[]>

  /** Publish a snapshot (replaces any existing published snapshot for the category). */
  publish(userId: string, snapshotId: string, edits?: Record<string, unknown>): Promise<Snapshot | null>

  /** Get the published snapshot for a category (system-level, no RLS). */
  getPublished(assistantId: string, category: string): Promise<Snapshot | null>

  /** Get published snapshot with RLS for owner viewing. */
  getPublishedForOwner(userId: string, assistantId: string, category: string): Promise<Snapshot | null>
}

export function createSnapshotStore(): SnapshotStore {
  return {
    async generateDraft(assistantId, category, content) {
      // System-level — called from snapshot generation logic
      const result = await query<Snapshot>(
        `INSERT INTO sharing_snapshots (assistant_id, category, content)
         VALUES ($1, $2, $3)
         RETURNING ${SNAPSHOT_COLUMNS}`,
        [assistantId, category, JSON.stringify(content)],
      )
      return result.rows[0]
    },

    async listDrafts(userId, assistantId) {
      const result = await queryWithRLS<Snapshot>(
        userId,
        `SELECT ${SNAPSHOT_COLUMNS} FROM sharing_snapshots
         WHERE assistant_id = $1 AND status = 'draft'
         ORDER BY generated_at DESC`,
        [assistantId],
      )
      return result.rows
    },

    async publish(userId, snapshotId, edits) {
      // First, get the snapshot to find its assistant + category
      const snap = await queryWithRLS<Snapshot>(
        userId,
        `SELECT ${SNAPSHOT_COLUMNS} FROM sharing_snapshots WHERE id = $1`,
        [snapshotId],
      )
      if (!snap.rows[0]) return null

      const { assistantId, category } = snap.rows[0]

      // Unpublish any existing published snapshot for this category
      await queryWithRLS(
        userId,
        `UPDATE sharing_snapshots SET status = 'draft'
         WHERE assistant_id = $1 AND category = $2 AND status = 'published'`,
        [assistantId, category],
      )

      // Publish the target snapshot
      const result = await queryWithRLS<Snapshot>(
        userId,
        `UPDATE sharing_snapshots
         SET status = 'published',
             published_at = now(),
             reviewed_by = $2,
             content = COALESCE($3, content)
         WHERE id = $1
         RETURNING ${SNAPSHOT_COLUMNS}`,
        [snapshotId, userId, edits ? JSON.stringify(edits) : null],
      )
      return result.rows[0] ?? null
    },

    async getPublished(assistantId, category) {
      // System-level — used by the callee executor to serve snapshot data
      const result = await query<Snapshot>(
        `SELECT ${SNAPSHOT_COLUMNS} FROM sharing_snapshots
         WHERE assistant_id = $1 AND category = $2 AND status = 'published'
         LIMIT 1`,
        [assistantId, category],
      )
      return result.rows[0] ?? null
    },

    async getPublishedForOwner(userId, assistantId, category) {
      const result = await queryWithRLS<Snapshot>(
        userId,
        `SELECT ${SNAPSHOT_COLUMNS} FROM sharing_snapshots
         WHERE assistant_id = $1 AND category = $2 AND status = 'published'
         LIMIT 1`,
        [assistantId, category],
      )
      return result.rows[0] ?? null
    },
  }
}
