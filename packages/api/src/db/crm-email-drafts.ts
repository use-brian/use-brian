/**
 * PostgreSQL store for canonical chat-authored CRM email drafts.
 *
 * The mutable draft row is a current projection; every save also inserts one
 * immutable numbered version and atomically moves the conversation anchor.
 * No row in this store carries provider/send authority.
 *
 * Spec: docs/architecture/features/crm.md -> "Chat-authored drafts".
 * [COMP:crm/email-drafts]
 */

import type { CrmEmailDraft, CrmEmailDraftStore } from '@use-brian/core'
import { applyRLSGucs, getAppPool, queryWithRLS } from './client.js'

type DraftRow = {
  id: string
  workspaceId: string
  status: 'draft' | 'discarded'
  revision: number
  from: string | null
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
  attachments: string[]
  createdByUserId: string | null
  createdByAssistantId: string | null
  sourceSessionId: string | null
  createdAt: Date
  updatedAt: Date
}

const DRAFT_COLUMNS = `
  d.id,
  d.workspace_id AS "workspaceId",
  d.status,
  d.revision,
  d.from_address AS "from",
  d.to_addresses AS "to",
  d.cc_addresses AS "cc",
  d.bcc_addresses AS "bcc",
  d.subject,
  d.body,
  d.attachment_refs AS "attachments",
  d.created_by_user_id AS "createdByUserId",
  d.created_by_assistant_id AS "createdByAssistantId",
  d.source_session_id AS "sourceSessionId",
  d.created_at AS "createdAt",
  d.updated_at AS "updatedAt"
`

function toDraft(row: DraftRow): CrmEmailDraft {
  return {
    ...row,
    to: row.to ?? [],
    cc: row.cc ?? [],
    bcc: row.bcc ?? [],
    attachments: row.attachments ?? [],
  }
}

export function createDbCrmEmailDraftStore(): CrmEmailDraftStore {
  return {
    async saveRevision(params) {
      const client = await getAppPool().connect()
      try {
        await client.query('BEGIN')
        await applyRLSGucs(client, params.userId)

        let draftId = params.draftId ?? null
        let revision = 1
        if (draftId) {
          const locked = await client.query<{ revision: number }>(
            `SELECT revision
               FROM crm_email_drafts
              WHERE workspace_id = $1 AND id = $2 AND status = 'draft'
              FOR UPDATE`,
            [params.workspaceId, draftId],
          )
          if (!locked.rows[0]) {
            await client.query('ROLLBACK')
            return null
          }
          revision = locked.rows[0].revision + 1
          await client.query(
            `UPDATE crm_email_drafts d SET
               revision = $3,
               from_address = $4,
               to_addresses = $5,
               cc_addresses = $6,
               bcc_addresses = $7,
               subject = $8,
               body = $9,
               attachment_refs = $10,
               created_by_assistant_id = $11,
               source_session_id = $12,
               updated_at = now()
             WHERE d.workspace_id = $1 AND d.id = $2`,
            [params.workspaceId, draftId, revision, params.from ?? null,
              params.to, params.cc ?? [], params.bcc ?? [], params.subject,
              params.body, params.attachments ?? [], params.assistantId, params.sessionId],
          )
        } else {
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO crm_email_drafts
               (workspace_id, revision, from_address, to_addresses, cc_addresses,
                bcc_addresses, subject, body, attachment_refs, created_by_user_id,
                created_by_assistant_id, source_session_id)
             VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             RETURNING id`,
            [params.workspaceId, params.from ?? null, params.to, params.cc ?? [],
              params.bcc ?? [], params.subject, params.body, params.attachments ?? [],
              params.userId, params.assistantId, params.sessionId],
          )
          draftId = inserted.rows[0].id
        }

        await client.query(
          `INSERT INTO crm_email_draft_versions
             (workspace_id, draft_id, revision, from_address, to_addresses,
              cc_addresses, bcc_addresses, subject, body, attachment_refs, created_by_user_id,
              created_by_assistant_id, source_session_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [params.workspaceId, draftId, revision, params.from ?? null, params.to,
            params.cc ?? [], params.bcc ?? [], params.subject, params.body,
            params.attachments ?? [], params.userId, params.assistantId, params.sessionId],
        )
        await client.query(
          `INSERT INTO crm_email_draft_session_anchors
             (session_id, workspace_id, draft_id)
           VALUES ($1,$2,$3)
           ON CONFLICT (session_id) DO UPDATE SET
             workspace_id = EXCLUDED.workspace_id,
             draft_id = EXCLUDED.draft_id,
             updated_at = now()`,
          [params.sessionId, params.workspaceId, draftId],
        )
        const saved = await client.query<DraftRow>(
          `SELECT ${DRAFT_COLUMNS}
             FROM crm_email_drafts d
            WHERE d.workspace_id = $1 AND d.id = $2`,
          [params.workspaceId, draftId],
        )
        await client.query('COMMIT')
        return saved.rows[0] ? toDraft(saved.rows[0]) : null
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      } finally {
        client.release()
      }
    },

    async getById(params) {
      const result = await queryWithRLS<DraftRow>(
        params.userId,
        `SELECT ${DRAFT_COLUMNS}
           FROM crm_email_drafts d
          WHERE d.workspace_id = $1 AND d.id = $2 AND d.status = 'draft'`,
        [params.workspaceId, params.draftId],
      )
      return result.rows[0] ? toDraft(result.rows[0]) : null
    },

    async getActiveForSession(params) {
      const result = await queryWithRLS<DraftRow>(
        params.userId,
        `SELECT ${DRAFT_COLUMNS}
           FROM crm_email_draft_session_anchors a
           JOIN crm_email_drafts d
             ON d.workspace_id = a.workspace_id AND d.id = a.draft_id
          WHERE a.workspace_id = $1
            AND a.session_id = $2
            AND d.status = 'draft'`,
        [params.workspaceId, params.sessionId],
      )
      return result.rows[0] ? toDraft(result.rows[0]) : null
    },

    async list(params) {
      const limit = Math.max(1, Math.min(params.limit ?? 25, 100))
      const result = await queryWithRLS<DraftRow>(
        params.userId,
        `SELECT ${DRAFT_COLUMNS}
           FROM crm_email_drafts d
          WHERE d.workspace_id = $1 AND d.status = 'draft'
          ORDER BY d.updated_at DESC, d.id DESC
          LIMIT $2`,
        [params.workspaceId, limit],
      )
      return result.rows.map(toDraft)
    },
  }
}
