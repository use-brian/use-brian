/**
 * PostgreSQL store for canonical chat-authored CRM email drafts.
 *
 * The mutable draft row is a current projection; every save also inserts one
 * immutable numbered version and atomically moves the conversation anchor.
 * No row in this store carries provider/send authority.
 *
 * Membership is proven here, not only by the caller: `saveRevision` locks the
 * caller's `workspace_members` row FOR SHARE before any write and returns null
 * when there is none, and every read carries the same predicate. A session
 * anchor is moved only inside its own workspace; an anchor held by another
 * workspace is refused explicitly instead of being moved there (8293 retired
 * the default-true legs that used to admit either on a fresh connection).
 *
 * Spec: docs/architecture/features/crm.md -> "Chat-authored drafts".
 * [COMP:crm/email-drafts]
 */

import type { CrmEmailDraft, CrmEmailDraftStore } from '@use-brian/core/crm/email-drafts.js'
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

/** The acting user (`userParam`) is a current member of the workspace in `$1`. */
const actingMember = (userParam: string) =>
  `EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = $1 AND m.user_id = ${userParam})`

/** Thrown when a conversation's draft anchor belongs to a different workspace. */
export class CrmEmailDraftAnchorConflictError extends Error {
  readonly code = 'crm_email_draft_anchor_other_workspace'
  constructor() {
    super('This conversation already anchors an email draft in another workspace. Start the draft from a conversation in this workspace.')
    this.name = 'CrmEmailDraftAnchorConflictError'
  }
}

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
        const member = await client.query(
          'SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',
          [params.workspaceId, params.userId],
        )
        if (!member.rows[0]) {
          await client.query('ROLLBACK')
          return null
        }

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
        // An anchor never changes workspace. DO NOTHING plus a same-workspace
        // UPDATE replaces the earlier ON CONFLICT DO UPDATE: a WHERE guard on
        // DO UPDATE cannot help, because the existing row's RLS check runs first.
        const anchored = await client.query(
          `INSERT INTO crm_email_draft_session_anchors
             (session_id, workspace_id, draft_id)
           VALUES ($1,$2,$3)
           ON CONFLICT (session_id) DO NOTHING
           RETURNING session_id`,
          [params.sessionId, params.workspaceId, draftId],
        )
        if (!anchored.rows[0]) {
          const moved = await client.query(
            `UPDATE crm_email_draft_session_anchors
                SET draft_id = $3, updated_at = now()
              WHERE session_id = $1 AND workspace_id = $2
              RETURNING session_id`,
            [params.sessionId, params.workspaceId, draftId],
          )
          if (!moved.rows[0]) throw new CrmEmailDraftAnchorConflictError()
        }
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
          WHERE d.workspace_id = $1 AND d.id = $2 AND d.status = 'draft'
            AND ${actingMember('$3')}`,
        [params.workspaceId, params.draftId, params.userId],
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
            AND d.status = 'draft'
            AND ${actingMember('$3')}`,
        [params.workspaceId, params.sessionId, params.userId],
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
            AND ${actingMember('$3')}
          ORDER BY d.updated_at DESC, d.id DESC
          LIMIT $2`,
        [params.workspaceId, limit, params.userId],
      )
      return result.rows.map(toDraft)
    },
  }
}
