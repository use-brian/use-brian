/**
 * Workspace invitation store — issue, list, revoke, and accept email
 * invitations to a workspace.
 *
 * Tokens are random 32-byte hex strings; only their SHA-256 hash is stored
 * (mirrors `magic-link-store.ts`), so a database read cannot mint a working
 * accept link. Acceptance is atomic (single UPDATE ... RETURNING guarded by
 * `accepted_at IS NULL AND expires_at > now()`) so a token can't be redeemed
 * twice in a race.
 *
 * All methods use the system-level `query()` helper: the route layer gates
 * create/list/revoke on workspace-admin role, and accept runs before the
 * caller is a member (so there is no RLS context to lean on).
 *
 * Spec: docs/architecture/platform/workspaces.md → "Member invitation".
 * Migration: 216_workspace_invitations.sql.
 */

import { randomBytes, createHash } from 'node:crypto'
import { query } from './client.js'

export type WorkspaceInvitationRole = 'admin' | 'member'

export type WorkspaceInvitation = {
  id: string
  workspaceId: string
  email: string
  role: WorkspaceInvitationRole
  message: string | null
  invitedByUserId: string | null
  createdAt: Date
  expiresAt: Date
  acceptedAt: Date | null
}

/** A single invitation enriched with the joins needed to render the accept
 *  page and the invitation email. */
export type WorkspaceInvitationDetail = WorkspaceInvitation & {
  workspaceName: string
  inviterName: string | null
}

export type WorkspaceInvitationStore = {
  /**
   * Issue (or re-issue) an invitation for an email. Returns the raw token —
   * the DB only ever sees its hash. Upserts on (workspace_id, email): a
   * re-invite mints a fresh token + expiry and clears any prior accepted
   * state.
   */
  create(input: {
    workspaceId: string
    email: string
    role: WorkspaceInvitationRole
    message?: string | null
    invitedByUserId: string | null
    ttlHours?: number
  }): Promise<{ invitation: WorkspaceInvitation; token: string }>
  /** Outstanding (not accepted, not expired) invitations for a workspace. */
  listPending(workspaceId: string): Promise<WorkspaceInvitation[]>
  /** Hard-delete a pending invitation. Returns false if not found. */
  revoke(workspaceId: string, invitationId: string): Promise<boolean>
  /** Look up an invitation by raw token (any state) for preview + accept. */
  getByToken(rawToken: string): Promise<WorkspaceInvitationDetail | null>
  /**
   * Atomically mark an invitation accepted. Returns the workspace/role/email
   * to act on, or null if the token is unknown, already accepted, or expired.
   */
  markAccepted(
    rawToken: string,
    acceptedByUserId: string,
  ): Promise<{ workspaceId: string; email: string; role: WorkspaceInvitationRole } | null>
}

/** Default invitation lifetime — 14 days (in hours). */
export const INVITATION_TTL_HOURS = 14 * 24

const hashToken = (raw: string): string =>
  createHash('sha256').update(raw).digest('hex')

const INVITATION_COLUMNS = `
  id, workspace_id AS "workspaceId", email, role, message,
  invited_by_user_id AS "invitedByUserId",
  created_at AS "createdAt", expires_at AS "expiresAt",
  accepted_at AS "acceptedAt"
` as const

export function createWorkspaceInvitationStore(): WorkspaceInvitationStore {
  return {
    async create({ workspaceId, email, role, message, invitedByUserId, ttlHours }) {
      const raw = randomBytes(32).toString('hex')
      const tokenHash = hashToken(raw)
      const result = await query<WorkspaceInvitation>(
        `INSERT INTO workspace_invitations
           (workspace_id, email, role, token_hash, message, invited_by_user_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' hours')::interval)
         ON CONFLICT (workspace_id, email) DO UPDATE SET
           role = EXCLUDED.role,
           token_hash = EXCLUDED.token_hash,
           message = EXCLUDED.message,
           invited_by_user_id = EXCLUDED.invited_by_user_id,
           created_at = now(),
           expires_at = EXCLUDED.expires_at,
           accepted_at = NULL,
           accepted_by_user_id = NULL
         RETURNING ${INVITATION_COLUMNS}`,
        [
          workspaceId,
          email.toLowerCase().trim(),
          role,
          tokenHash,
          message ?? null,
          invitedByUserId,
          String(ttlHours ?? INVITATION_TTL_HOURS),
        ],
      )
      return { invitation: result.rows[0], token: raw }
    },

    async listPending(workspaceId) {
      const result = await query<WorkspaceInvitation>(
        `SELECT ${INVITATION_COLUMNS}
           FROM workspace_invitations
          WHERE workspace_id = $1
            AND accepted_at IS NULL
            AND expires_at > now()
          ORDER BY created_at DESC`,
        [workspaceId],
      )
      return result.rows
    },

    async revoke(workspaceId, invitationId) {
      const result = await query(
        `DELETE FROM workspace_invitations WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, invitationId],
      )
      return (result.rowCount ?? 0) > 0
    },

    async getByToken(rawToken) {
      if (!rawToken) return null
      const result = await query<WorkspaceInvitationDetail>(
        `SELECT i.id, i.workspace_id AS "workspaceId", i.email, i.role, i.message,
                i.invited_by_user_id AS "invitedByUserId",
                i.created_at AS "createdAt", i.expires_at AS "expiresAt",
                i.accepted_at AS "acceptedAt",
                w.name AS "workspaceName", u.name AS "inviterName"
           FROM workspace_invitations i
           JOIN workspaces w ON w.id = i.workspace_id
           LEFT JOIN users u ON u.id = i.invited_by_user_id
          WHERE i.token_hash = $1`,
        [hashToken(rawToken)],
      )
      return result.rows[0] ?? null
    },

    async markAccepted(rawToken, acceptedByUserId) {
      if (!rawToken) return null
      const result = await query<{
        workspaceId: string
        email: string
        role: WorkspaceInvitationRole
      }>(
        `UPDATE workspace_invitations
            SET accepted_at = now(), accepted_by_user_id = $2
          WHERE token_hash = $1
            AND accepted_at IS NULL
            AND expires_at > now()
          RETURNING workspace_id AS "workspaceId", email, role`,
        [hashToken(rawToken), acceptedByUserId],
      )
      return result.rows[0] ?? null
    },
  }
}
