/**
 * Page send ledger, backed by PostgreSQL (migration 321 `page_send_log`).
 *
 * The at-most-once substrate for `send_page`: a claim row is inserted BEFORE
 * any send. The partial unique index `page_send_log_page_live_idx`
 * (`ON (page_id) WHERE status IN ('claimed','sent')`) is the guarantee —
 * a page with a live claim or a completed send cannot be claimed again:
 *
 *   - existing `sent` row      → `already_sent` (the idempotent re-click no-op)
 *   - fresh `claimed` row      → `in_flight` (another run is mid-send)
 *   - stale `claimed` (>10 min) → taken over (the claimer crashed mid-send)
 *   - `failed` rows fall outside the index → a retry inserts a fresh claim
 *
 * Concurrency: the insert races through the unique index (one winner); the
 * stale takeover races through a guarded UPDATE (`claimed_at < cutoff`), so
 * two takeovers can't both win. RLS scopes rows to workspace membership.
 *
 * Spec: docs/architecture/features/page-actions.md → "Idempotency ledger".
 *
 * [COMP:api/page-send-ledger]
 */

import { queryWithRLS } from './client.js'

export const SEND_CLAIM_STALE_MINUTES = 10

export type PageSendClaim =
  | { outcome: 'claimed'; claimId: string }
  | { outcome: 'already_sent'; recipient: string | null; sentAt: string | null }
  | { outcome: 'in_flight' }

export type PageSendLogStore = {
  /** Insert-before-send claim. See module doc for the four outcomes. */
  claim(
    userId: string,
    input: {
      workspaceId: string
      pageId: string
      workflowId: string | null
      runId: string | null
      recipient: string
      subject: string
      bodyHash?: string | null
    },
  ): Promise<PageSendClaim>
  /** Flip a claim to `sent` (+ provider message id). */
  markSent(userId: string, claimId: string, externalId: string | null): Promise<void>
  /** Flip a claim to `failed` (falls outside the live index → retryable). */
  markFailed(userId: string, claimId: string, error: string): Promise<void>
}

type LiveRow = {
  id: string
  status: string
  recipient: string
  sent_at: Date | null
  claimed_at: Date
}

export function createDbPageSendLogStore(): PageSendLogStore {
  return {
    async claim(userId, input) {
      const inserted = await queryWithRLS<{ id: string }>(
        userId,
        `INSERT INTO page_send_log
           (workspace_id, page_id, workflow_id, run_id, recipient, subject, body_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (page_id) WHERE status IN ('claimed', 'sent') DO NOTHING
         RETURNING id`,
        [
          input.workspaceId,
          input.pageId,
          input.workflowId,
          input.runId,
          input.recipient,
          input.subject,
          input.bodyHash ?? null,
        ],
      )
      if (inserted.rows[0]) return { outcome: 'claimed', claimId: inserted.rows[0].id }

      // Lost the insert — inspect the live row.
      const live = await queryWithRLS<LiveRow>(
        userId,
        `SELECT id, status, recipient, sent_at, claimed_at FROM page_send_log
         WHERE page_id = $1 AND status IN ('claimed', 'sent')
         LIMIT 1`,
        [input.pageId],
      )
      const row = live.rows[0]
      // Row vanished between the conflict and the read (failed/deleted) —
      // surface in_flight; the caller's retry will win the fresh insert.
      if (!row) return { outcome: 'in_flight' }
      if (row.status === 'sent') {
        return {
          outcome: 'already_sent',
          recipient: row.recipient,
          sentAt: row.sent_at ? row.sent_at.toISOString() : null,
        }
      }
      // A stale claim means the claimer died mid-send; take it over. The
      // guarded UPDATE is the race arbiter — one takeover resets claimed_at,
      // the loser's WHERE no longer matches.
      const takeover = await queryWithRLS<{ id: string }>(
        userId,
        `UPDATE page_send_log
         SET workflow_id = $2, run_id = $3, recipient = $4, subject = $5,
             body_hash = $6, claimed_at = now(), error = NULL
         WHERE id = $1 AND status = 'claimed'
           AND claimed_at < now() - make_interval(mins => $7)
         RETURNING id`,
        [
          row.id,
          input.workflowId,
          input.runId,
          input.recipient,
          input.subject,
          input.bodyHash ?? null,
          SEND_CLAIM_STALE_MINUTES,
        ],
      )
      if (takeover.rows[0]) return { outcome: 'claimed', claimId: takeover.rows[0].id }
      return { outcome: 'in_flight' }
    },

    async markSent(userId, claimId, externalId) {
      await queryWithRLS(
        userId,
        `UPDATE page_send_log
         SET status = 'sent', sent_at = now(), external_id = $2, error = NULL
         WHERE id = $1 AND status = 'claimed'`,
        [claimId, externalId],
      )
    },

    async markFailed(userId, claimId, error) {
      await queryWithRLS(
        userId,
        `UPDATE page_send_log
         SET status = 'failed', error = $2
         WHERE id = $1 AND status = 'claimed'`,
        [claimId, error.slice(0, 2000)],
      )
    },
  }
}
