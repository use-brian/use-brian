/**
 * Token-based workspace invitation routes — preview + accept.
 *
 * Mounted at `/api/invitations` with `optionalAuth`, because the preview
 * must work for a signed-out invitee (so the accept page can render the
 * workspace name before they sign in). The accept route self-guards on
 * `req.userId`.
 *
 * The admin-side create / list / revoke routes live in `routes/workspaces.ts`
 * (they need workspace-admin gating and a `:workspaceId` in the path). These
 * two are keyed only by the secret token.
 *
 * [COMP:api/invitations-route]
 *
 *   GET  /:token   — preview an invitation (workspace name, inviter, role, status)
 *   POST /accept   — accept an invitation (auth required); joins the workspace
 *
 * Spec: docs/architecture/platform/workspaces.md → "Member invitation".
 */

import { Router } from 'express'
import { query } from '../db/client.js'
import type { WorkspaceInvitationStore } from '../db/workspace-invitation-store.js'
import type { WorkspaceStore } from '../db/workspace-store.js'
import type { WorkspaceAuditStore } from '../db/workspace-audit-store.js'

type InvitationRouteOptions = {
  invitationStore: WorkspaceInvitationStore
  workspaceStore: WorkspaceStore
  /** Optional — when provided, acceptance appends to the §6 audit feed. */
  auditStore?: WorkspaceAuditStore
}

type InvitationStatus = 'pending' | 'expired' | 'accepted'

function statusOf(expiresAt: Date, acceptedAt: Date | null): InvitationStatus {
  if (acceptedAt) return 'accepted'
  if (+new Date(expiresAt) < Date.now()) return 'expired'
  return 'pending'
}

export function invitationRoutes({
  invitationStore,
  workspaceStore,
  auditStore,
}: InvitationRouteOptions): Router {
  const router = Router()

  // ── GET /:token — preview ──────────────────────────────────────
  // No membership required; the secret token is the authorization. Returns
  // only the minimum needed to render the accept page.
  router.get('/:token', async (req, res) => {
    const token = req.params.token
    if (!token || token.length < 16) {
      res.status(404).json({ error: 'invitation_not_found' })
      return
    }
    try {
      const inv = await invitationStore.getByToken(token)
      if (!inv) {
        res.status(404).json({ error: 'invitation_not_found' })
        return
      }
      res.json({
        workspaceName: inv.workspaceName,
        inviterName: inv.inviterName,
        role: inv.role,
        email: inv.email,
        status: statusOf(inv.expiresAt, inv.acceptedAt),
      })
    } catch (err) {
      console.error('[invitations] preview failed:', err)
      res.status(500).json({ error: 'Failed to load invitation' })
    }
  })

  // ── POST /accept — accept ──────────────────────────────────────
  // Requires a signed-in account whose email matches the invited address.
  // The token is a bearer secret, so the email match is the second factor
  // that stops a forwarded link from landing the wrong person in the brain.
  router.post('/accept', async (req, res) => {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const { token } = req.body as { token?: string }
    if (!token) {
      res.status(400).json({ error: 'token is required' })
      return
    }
    try {
      const inv = await invitationStore.getByToken(token)
      if (!inv) {
        res.status(404).json({ error: 'invitation_not_found' })
        return
      }
      const status = statusOf(inv.expiresAt, inv.acceptedAt)
      if (status === 'accepted') {
        res.status(409).json({ error: 'already_accepted' })
        return
      }
      if (status === 'expired') {
        res.status(410).json({ error: 'expired' })
        return
      }

      // Email must match the signed-in account. The workspace switcher
      // supports multiple signed-in accounts, so the UI can prompt the user
      // to switch to the invited address rather than dead-end.
      const u = await query<{ email: string | null }>(
        `SELECT email FROM users WHERE id = $1`,
        [userId],
      )
      const myEmail = (u.rows[0]?.email ?? '').toLowerCase()
      if (!myEmail || myEmail !== inv.email.toLowerCase()) {
        res.status(403).json({ error: 'email_mismatch', invitedEmail: inv.email })
        return
      }

      const accepted = await invitationStore.markAccepted(token, userId)
      if (!accepted) {
        // Lost the accept race, or it expired between read and write.
        res.status(409).json({ error: 'already_accepted' })
        return
      }

      try {
        await workspaceStore.addMember(userId, accepted.workspaceId, userId, accepted.role)
      } catch (err: unknown) {
        // 23505 = unique violation: the account was already a member (e.g.
        // a double-accept where the membership landed first). Treat as success.
        if ((err as { code?: string })?.code !== '23505') throw err
      }

      if (auditStore) {
        void auditStore.append({
          workspaceId: accepted.workspaceId,
          actorUserId: userId,
          eventType: 'member.invite_accepted',
          subjectId: userId,
          details: { email: accepted.email, role: accepted.role },
        })
      }

      res.json({
        ok: true,
        workspaceId: accepted.workspaceId,
        workspaceName: inv.workspaceName,
      })
    } catch (err) {
      console.error('[invitations] accept failed:', err)
      res.status(500).json({ error: 'Failed to accept invitation' })
    }
  })

  return router
}
