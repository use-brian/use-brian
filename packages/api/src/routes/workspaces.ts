/**
 * Workspace management routes.
 *
 * Mounted at `/api/workspaces` behind requireAuth.
 *
 * [COMP:api/workspaces-route]
 *
 *   POST   /                                              — create workspace (non-personal; gated by plan)
 *   GET    /                                              — list user's workspaces
 *   GET    /:workspaceId                                  — get workspace details + members
 *   PATCH  /:workspaceId                                  — update workspace name
 *   DELETE /:workspaceId                                  — delete workspace (owner only, non-personal)
 *   POST   /:workspaceId/members                          — add member by email
 *   DELETE /:workspaceId/members/:userId                  — remove member
 *   PATCH  /:workspaceId/members/:userId                  — update member role
 *   POST   /:workspaceId/invitations                      — invite member(s) by email
 *   GET    /:workspaceId/invitations                      — list pending invitations
 *   DELETE /:workspaceId/invitations/:invitationId        — revoke a pending invitation
 *   POST   /:workspaceId/assistants                       — create workspace assistant
 *   POST   /:workspaceId/assistants/:assistantId/adopt    — move existing assistant into workspace
 *   POST   /:workspaceId/assistants/:assistantId/remove   — detach assistant from workspace
 */

import { Router } from 'express'
import { z } from 'zod'
import {
  APP_TYPE_IDS,
  defaultClearanceForAppType,
  isAppType,
  type AppType,
} from '@sidanclaw/shared'
import { query, queryWithRLS } from '../db/client.js'
import { findUserById } from '../db/users.js'
import type { WorkspaceStore } from '../db/workspace-store.js'
import {
  getWorkspacePlan,
  getWorkspaceMembershipWithClearanceSystem,
  InvalidRecordingBlueprintError,
} from '../db/workspace-store.js'
import { createConnectionStore } from '../db/connection-store.js'
import type { WorkspaceAuditStore, WorkspaceAuditEventType } from '../db/workspace-audit-store.js'
import type { WorkspaceInvitationStore } from '../db/workspace-invitation-store.js'
import type { SmtpClient } from '../email/smtp-client.js'
import {
  countWorkspaceMemories,
  transferWorkspaceMemories,
  deleteWorkspaceMemories,
  countUnverifiedByWorkspace,
  listUnverifiedByWorkspace,
} from '../db/memories.js'

type WorkspaceRouteOptions = {
  workspaceStore: WorkspaceStore
  /** Optional — when provided, member/settings changes append to the §6 audit feed. */
  auditStore?: WorkspaceAuditStore
  /** Optional — enables the email-invitation routes. Without it, POST
   *  /:workspaceId/invitations returns 501. */
  invitationStore?: WorkspaceInvitationStore
  /** Optional — when present, invitations are emailed; otherwise the accept
   *  link is only returned in the response (copy-link fallback). */
  smtpClient?: SmtpClient
  /** Base URL used to build the accept link (`${appUrl}/invite?token=...`). */
  appUrl?: string
}

export function workspaceRoutes({
  workspaceStore,
  auditStore,
  invitationStore,
  smtpClient,
  appUrl,
}: WorkspaceRouteOptions): Router {
  const router = Router()
  // Stateless (uses query() under the hood) — used to keep the workspace's
  // primary auto-following its siblings when assistants are created/adopted.
  const connectionStore = createConnectionStore()

  /**
   * Verify the user has the required role on the workspace.
   * Returns the role or sends an error response and returns null.
   */
  async function requireWorkspaceRole(
    req: { userId?: string; params: { workspaceId: string } },
    res: import('express').Response,
    minRole: 'member' | 'admin' | 'owner',
  ): Promise<string | null> {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return null }

    const role = await workspaceStore.getRole(userId, req.params.workspaceId)
    if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return null }

    const ROLE_LEVEL: Record<string, number> = { member: 0, admin: 1, owner: 2 }
    if ((ROLE_LEVEL[role] ?? 0) < (ROLE_LEVEL[minRole] ?? 0)) {
      res.status(403).json({ error: `Requires ${minRole} role` })
      return null
    }
    return role
  }

  // ── POST / — create workspace ────────────────────────────────
  //
  // Every user already has a Personal workspace (auto-created at signup;
  // see findOrCreateUser in db/users.ts). This route creates *additional*
  // workspaces, gated by a free-plan cap: a user may own at most 2
  // free-plan workspaces (Personal counts), so a user with no paid
  // workspace gets Personal + 1 more. Owning any paid workspace lifts the
  // cap to unlimited. Only ownership counts — joined workspaces never do.

  router.post('/', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const { name, purpose } = req.body as { name?: string; purpose?: string }
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'Name is required' })
      return
    }
    if (name.length > 100) {
      res.status(400).json({ error: 'Name must be 100 characters or less' })
      return
    }
    // Purpose grounds the workspace-vs-user routing decision the model
    // makes every time it calls saveMemory on a workspace assistant.
    if (!purpose || typeof purpose !== 'string' || purpose.trim().length < 10) {
      res.status(400).json({ error: 'Purpose is required (min 10 characters). Describe what knowledge this workspace will share — project, infrastructure, decisions, processes.' })
      return
    }
    if (purpose.length > 500) {
      res.status(400).json({ error: 'Purpose must be 500 characters or less' })
      return
    }

    try {
      const user = await findUserById(userId)
      if (!user) { res.status(401).json({ error: 'User not found' }); return }

      // Billing is per-workspace (migration 143). A user who owns no paid
      // workspace is capped at 2 free-plan workspaces (the Personal one
      // counts). Owning any paid workspace lifts the cap.
      const ownsPaid = await query<{ ok: number }>(
        `SELECT 1 AS ok FROM workspaces WHERE owner_user_id = $1 AND plan <> 'free' LIMIT 1`,
        [userId],
      )
      if (ownsPaid.rows.length === 0) {
        const freeOwned = await workspaceStore.countFreeOwned(userId)
        if (freeOwned >= 2) {
          res.status(403).json({
            error: 'plan_required',
            message: 'Free accounts can own up to 2 workspaces. Upgrade a workspace to a paid plan to create more.',
          })
          return
        }
      }

      const workspace = await workspaceStore.create(userId, name.trim(), purpose.trim())
      res.status(201).json(workspace)
    } catch (err) {
      console.error('[workspaces] create failed:', err)
      res.status(500).json({ error: 'Failed to create workspace' })
    }
  })

  // ── GET / — list user's workspaces ───────────────────────────

  router.get('/', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    try {
      const workspaces = await workspaceStore.list(userId)
      // `teams` alias preserved for one release so consumers calling the
      // legacy /api/teams URL still get the field name they expect.
      // Remove after 2026-06-08.
      res.json({ workspaces, teams: workspaces })
    } catch (err) {
      console.error('[workspaces] list failed:', err)
      res.status(500).json({ error: 'Failed to list workspaces' })
    }
  })

  // ── GET /:workspaceId — get workspace details + members ────────────────

  router.get('/:workspaceId', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const role = await requireWorkspaceRole(req as any, res, 'member')
    if (!role) return

    try {
      const team = await workspaceStore.get(userId, req.params.workspaceId)
      if (!team) { res.status(404).json({ error: 'Workspace not found' }); return }

      const members = await workspaceStore.listMembers(userId, req.params.workspaceId)

      // List workspace assistants. `kind` is exposed so the workspace home
      // can locate its `kind='primary'` assistant for the chat composer
      // hero (§2/§3 of company-brain.md) without an extra round-trip.
      const assistants = await queryWithRLS<{
        id: string; name: string; iconSeed: number | null; clearance: string; kind: string; appType: string | null
      }>(
        userId,
        `SELECT id, name, icon_seed AS "iconSeed", clearance, kind, app_type AS "appType"
         FROM assistants
         WHERE workspace_id = $1
         ORDER BY
           CASE kind WHEN 'primary' THEN 0 WHEN 'standard' THEN 1 ELSE 2 END,
           created_at ASC`,
        [req.params.workspaceId],
      )

      const primary = assistants.rows.find((a) => a.kind === 'primary')

      // The requesting member's own clearance — the doc page-header
      // clearance pill uses it to bound the picker (a member can't set a page
      // above their own clearance; the PATCH route enforces the same).
      const membership = await getWorkspaceMembershipWithClearanceSystem(userId, req.params.workspaceId)

      res.json({
        ...team,
        role,
        clearance: membership?.clearance ?? 'internal',
        members,
        assistants: assistants.rows,
        primaryAssistantId: primary?.id ?? null,
        // Echo the requesting user's id so the workspace-context provider can
        // attribute per-message authorship and presence on the frontend
        // (e.g. workspace-shared draft sessions). Source-of-truth is the JWT
        // we already validated for `userId` above.
        me: { id: userId },
      })
    } catch (err) {
      console.error('[workspaces] get failed:', err)
      res.status(500).json({ error: 'Failed to get workspace' })
    }
  })

  // ── GET /:workspaceId/audit — unified audit timeline (§6) ──────────────
  //
  // Returns a single event stream, newest-first, that unions:
  //   1. workspace_audit_log (member/connector/settings/plan changes)
  //   2. distribution_events (feed pipeline — approved/posted/blocked, etc.)
  //   3. memories with category='voice' (voice rule create/update — the spec
  //      explicitly calls these out, and they carry user_id + updated_at
  //      which is all the audit feed needs).
  //
  // Both sources carry an actor and a creation time; the response shape
  // unifies them into `{ source, eventType, actorUserId, actorName, subjectId,
  // details, createdAt }`. The frontend filters by `source` + `eventType`
  // and renders one row per event.
  //
  // Pagination: cursor on `before` (a timestamp). Default limit 50, max 200.
  // Filters: ?type=... (repeatable), ?actor=<userId>.

  router.get('/:workspaceId/audit', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const role = await requireWorkspaceRole(req as any, res, 'member')
    if (!role) return
    if (!auditStore) { res.json({ events: [] }); return }

    const limit = Math.min(parseInt((req.query.limit as string) ?? '50', 10) || 50, 200)
    const beforeRaw = req.query.before as string | undefined
    const before = beforeRaw ? new Date(beforeRaw) : undefined
    const types = (() => {
      const raw = req.query.type
      if (Array.isArray(raw)) return raw.map(String) as WorkspaceAuditEventType[]
      if (typeof raw === 'string' && raw.length > 0) return raw.split(',') as WorkspaceAuditEventType[]
      return undefined
    })()
    const actorUserId = (req.query.actor as string) || undefined

    try {
      const { workspaceId } = req.params

      // Source 1: workspace_audit_log via the store.
      const auditRows = await auditStore.list(userId, workspaceId, {
        limit,
        before,
        eventTypes: types,
        actorUserId,
      })

      // Source 2: distribution_events for assistants in this workspace. Joined
      // through the user's RLS-scoped view of `assistants`.
      // Only include if the caller didn't filter to a specific actor (these
      // events have no actor in the audit-log sense — they're system events).
      const distributionRows = actorUserId
        ? []
        : (await queryWithRLS<{
            id: string
            eventType: string
            assistantId: string
            assistantName: string | null
            createdAt: Date
            metadata: Record<string, unknown> | null
          }>(
            userId,
            `SELECT de.id, de.event_type AS "eventType", de.assistant_id AS "assistantId",
                    a.name AS "assistantName", de.created_at AS "createdAt",
                    de.metadata
             FROM distribution_events de
             JOIN assistants a ON a.id = de.assistant_id
             WHERE a.workspace_id = $1
               ${before ? 'AND de.created_at < $2' : ''}
             ORDER BY de.created_at DESC
             LIMIT ${before ? '$3' : '$2'}`,
            before ? [workspaceId, before, limit] : [workspaceId, limit],
          )).rows

      // Source 3: voice rule edits — workspace-scope memories with
      // category='voice'. The spec explicitly carves these out as the third
      // event class for §6. We surface two synthetic event types based on
      // whether the row is fresh (created_at == updated_at) or has been
      // edited since creation.
      // Honor the actor filter when set; voice memories carry a real user_id.
      const voiceRows = (await queryWithRLS<{
        id: string
        userId: string | null
        summary: string | null
        createdAt: Date
        updatedAt: Date
      }>(
        userId,
        `SELECT id, user_id AS "userId", summary,
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM memories
         WHERE workspace_id = $1
           AND category = 'voice'
           ${before ? `AND updated_at < $2` : ''}
           ${actorUserId ? `AND user_id = $${before ? 3 : 2}` : ''}
         ORDER BY updated_at DESC
         LIMIT $${(before ? 1 : 0) + (actorUserId ? 1 : 0) + 2}`,
        [
          workspaceId,
          ...(before ? [before] : []),
          ...(actorUserId ? [actorUserId] : []),
          limit,
        ],
      )).rows

      // Enrich actor user names in one round-trip — covers both audit-log
      // actors and voice-memory authors (single SELECT IN list).
      const actorIds = Array.from(
        new Set(
          [
            ...auditRows.map((r) => r.actorUserId),
            ...voiceRows.map((r) => r.userId),
          ].filter((id): id is string => !!id),
        ),
      )
      const actorNames = new Map<string, string>()
      if (actorIds.length > 0) {
        const ures = await queryWithRLS<{ id: string; name: string | null; email: string | null }>(
          userId,
          `SELECT id, name, email FROM users WHERE id = ANY($1::uuid[])`,
          [actorIds],
        )
        for (const u of ures.rows) {
          actorNames.set(u.id, u.name ?? u.email ?? 'unknown')
        }
      }

      // Merge + sort. Two sources, both newest-first; do a simple merge-by-time.
      const events = [
        ...auditRows.map((r) => ({
          source: 'workspace' as const,
          id: r.id,
          eventType: r.eventType,
          actorUserId: r.actorUserId,
          actorName: r.actorUserId ? actorNames.get(r.actorUserId) ?? null : null,
          subjectId: r.subjectId,
          details: r.details,
          createdAt: r.createdAt,
        })),
        ...distributionRows.map((r) => ({
          source: 'distribution' as const,
          id: r.id,
          eventType: r.eventType,
          actorUserId: null,
          actorName: r.assistantName,
          subjectId: r.assistantId,
          details: r.metadata ?? {},
          createdAt: r.createdAt,
        })),
        ...voiceRows.map((r) => {
          const isFresh = +new Date(r.updatedAt) - +new Date(r.createdAt) < 1000
          return {
            source: 'voice' as const,
            id: r.id,
            eventType: isFresh ? 'voice.created' : 'voice.updated',
            actorUserId: r.userId,
            actorName: r.userId ? actorNames.get(r.userId) ?? null : null,
            subjectId: r.id,
            details: { summary: r.summary ?? '' },
            createdAt: r.updatedAt,
          }
        }),
      ].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)).slice(0, limit)

      res.json({ events })
    } catch (err) {
      console.error('[workspaces] audit failed:', err)
      res.status(500).json({ error: 'Failed to load audit feed' })
    }
  })

  // ── PATCH /:workspaceId — update workspace name and/or purpose / default blueprint ──

  // The default recording blueprint (migration 291) is a separate write path
  // (it routes to `setDefaultRecordingBlueprint`, which validates the template
  // is a same-workspace blueprint). Validate the field at the boundary with Zod:
  // a string id sets it, `null` clears it (ingest-only). `undefined` (absent)
  // leaves it untouched. See docs/plans/workspace-default-recording-blueprint.md §D4.
  const defaultBlueprintFieldSchema = z.object({
    defaultRecordingBlueprintId: z.string().uuid().nullable().optional(),
  })

  router.patch('/:workspaceId', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const role = await requireWorkspaceRole(req as any, res, 'admin')
    if (!role) return

    const { name, purpose } = req.body as { name?: string; purpose?: string }
    const updates: { name?: string; purpose?: string } = {}

    // Default recording blueprint — validated + routed to its own store setter.
    const blueprintField = defaultBlueprintFieldSchema.safeParse(req.body)
    if (!blueprintField.success) {
      res.status(400).json({ error: 'defaultRecordingBlueprintId must be a UUID or null' })
      return
    }
    const hasBlueprintUpdate = 'defaultRecordingBlueprintId' in (req.body ?? {})

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        res.status(400).json({ error: 'Name must be a non-empty string' })
        return
      }
      if (name.length > 100) {
        res.status(400).json({ error: 'Name must be 100 characters or less' })
        return
      }
      updates.name = name.trim()
    }

    if (purpose !== undefined) {
      if (typeof purpose !== 'string' || purpose.trim().length < 10) {
        res.status(400).json({ error: 'Purpose must be at least 10 characters' })
        return
      }
      if (purpose.length > 500) {
        res.status(400).json({ error: 'Purpose must be 500 characters or less' })
        return
      }
      updates.purpose = purpose.trim()
    }

    if (Object.keys(updates).length === 0 && !hasBlueprintUpdate) {
      res.status(400).json({ error: 'At least one of name, purpose, or defaultRecordingBlueprintId is required' })
      return
    }

    try {
      // Default recording blueprint — separate write path (validates the
      // template is a same-workspace blueprint; throws → 400). Applied first so
      // a bad id 400s without a partial name/purpose write landing.
      if (hasBlueprintUpdate) {
        try {
          const updated = await workspaceStore.setDefaultRecordingBlueprint(
            userId,
            req.params.workspaceId,
            blueprintField.data.defaultRecordingBlueprintId ?? null,
          )
          if (!updated) { res.status(404).json({ error: 'Workspace not found' }); return }
          if (auditStore) {
            void auditStore.append({
              workspaceId: req.params.workspaceId,
              actorUserId: userId,
              eventType: 'workspace.settings_changed',
              details: { defaultRecordingBlueprintId: blueprintField.data.defaultRecordingBlueprintId ?? null },
            })
          }
          // No name/purpose to apply → return the blueprint-updated row.
          if (Object.keys(updates).length === 0) { res.json(updated); return }
        } catch (err) {
          if (err instanceof InvalidRecordingBlueprintError) {
            res.status(400).json({ error: err.message })
            return
          }
          throw err
        }
      }

      const team = await workspaceStore.update(userId, req.params.workspaceId, updates)
      if (!team) { res.status(404).json({ error: 'Workspace not found' }); return }
      // §6 audit: separate event types per field so the timeline can render
      // distinct copy ("Renamed to ..." vs "Updated purpose").
      if (auditStore) {
        if (updates.name !== undefined) {
          void auditStore.append({
            workspaceId: req.params.workspaceId,
            actorUserId: userId,
            eventType: 'workspace.renamed',
            details: { name: updates.name },
          })
        }
        if (updates.purpose !== undefined) {
          void auditStore.append({
            workspaceId: req.params.workspaceId,
            actorUserId: userId,
            eventType: 'workspace.purpose_updated',
            details: { length: updates.purpose.length },
          })
        }
      }
      res.json(team)
    } catch (err) {
      console.error('[workspaces] update failed:', err)
      res.status(500).json({ error: 'Failed to update workspace' })
    }
  })

  // ── DELETE /:workspaceId — delete workspace ────────────────────────────

  router.delete('/:workspaceId', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const role = await requireWorkspaceRole(req as any, res, 'owner')
    if (!role) return

    try {
      const deleted = await workspaceStore.delete(userId, req.params.workspaceId)
      if (!deleted) { res.status(404).json({ error: 'Workspace not found' }); return }
      res.status(204).end()
    } catch (err) {
      console.error('[workspaces] delete failed:', err)
      res.status(500).json({ error: 'Failed to delete workspace' })
    }
  })

  // ── POST /:workspaceId/members — add member by email ─────────────

  router.post('/:workspaceId/members', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const role = await requireWorkspaceRole(req as any, res, 'admin')
    if (!role) return

    const { email, memberRole } = req.body as { email?: string; memberRole?: 'admin' | 'member' }
    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'Email is required' })
      return
    }
    if (memberRole && !['admin', 'member'].includes(memberRole)) {
      res.status(400).json({ error: 'Role must be admin or member' })
      return
    }

    try {
      // Look up user by email
      const userResult = await query<{ id: string }>(
        `SELECT id FROM users WHERE email = $1`,
        [email.trim().toLowerCase()],
      )
      if (userResult.rows.length === 0) {
        res.status(404).json({ error: 'No user found with that email' })
        return
      }

      const memberUserId = userResult.rows[0].id
      const member = await workspaceStore.addMember(userId, req.params.workspaceId, memberUserId, memberRole ?? 'member')
      if (auditStore) {
        void auditStore.append({
          workspaceId: req.params.workspaceId,
          actorUserId: userId,
          eventType: 'member.added',
          subjectId: memberUserId,
          details: { email: email.trim().toLowerCase(), role: memberRole ?? 'member' },
        })
      }
      res.status(201).json(member)
    } catch (err: any) {
      if (err?.code === '23505') { // unique violation
        res.status(409).json({ error: 'User is already a member' })
        return
      }
      console.error('[workspaces] add member failed:', err)
      res.status(500).json({ error: 'Failed to add member' })
    }
  })

  // ── DELETE /:workspaceId/members/:userId — remove member ──────────

  router.delete('/:workspaceId/members/:userId', async (req, res) => {
    const actingUserId = req.userId
    if (!actingUserId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const role = await requireWorkspaceRole(req as any, res, 'admin')
    if (!role) return

    const { workspaceId, userId: memberUserId } = req.params as { workspaceId: string; userId: string }

    try {
      const removed = await workspaceStore.removeMember(actingUserId, workspaceId, memberUserId)
      if (!removed) {
        res.status(400).json({ error: 'Cannot remove this member (they may be the owner)' })
        return
      }
      if (auditStore) {
        void auditStore.append({
          workspaceId,
          actorUserId: actingUserId,
          eventType: 'member.removed',
          subjectId: memberUserId,
        })
      }
      res.status(204).end()
    } catch (err) {
      console.error('[workspaces] remove member failed:', err)
      res.status(500).json({ error: 'Failed to remove member' })
    }
  })

  // ── PATCH /:workspaceId/members/:userId — update member role ──────

  router.patch('/:workspaceId/members/:userId', async (req, res) => {
    const actingUserId = req.userId
    if (!actingUserId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const role = await requireWorkspaceRole(req as any, res, 'owner')
    if (!role) return

    const { workspaceId, userId: memberUserId } = req.params as { workspaceId: string; userId: string }
    const { role: newRole } = req.body as { role?: 'admin' | 'member' }

    if (!newRole || !['admin', 'member'].includes(newRole)) {
      res.status(400).json({ error: 'Role must be admin or member' })
      return
    }

    try {
      const updated = await workspaceStore.updateMemberRole(actingUserId, workspaceId, memberUserId, newRole)
      if (!updated) {
        res.status(400).json({ error: 'Cannot change this member\'s role' })
        return
      }
      if (auditStore) {
        void auditStore.append({
          workspaceId,
          actorUserId: actingUserId,
          eventType: 'member.role_changed',
          subjectId: memberUserId,
          details: { role: newRole },
        })
      }
      res.json({ ok: true })
    } catch (err) {
      console.error('[workspaces] update role failed:', err)
      res.status(500).json({ error: 'Failed to update role' })
    }
  })

  // ── PATCH /:workspaceId/members/:userId/permissions — toggle per-member feature flags ──

  // Admin/owner gated. Today exposes a single flag, `canDraft`, which
  // governs whether a 'member'-role user can use the feed/draft-app
  // surfaces (create/save drafts, approve/reject saved drafts). Owners
  // and admins are always allowed regardless of the flag value, so we
  // refuse to write the column on those rows (matching the store's
  // role <> 'owner' guard) and return 400 for the admin case so the
  // caller doesn't think a no-op succeeded.
  //
  // See docs/architecture/feed/draft-sessions.md → "Authorization".
  router.patch('/:workspaceId/members/:userId/permissions', async (req, res) => {
    const actingUserId = req.userId
    if (!actingUserId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const role = await requireWorkspaceRole(req as any, res, 'admin')
    if (!role) return

    const { workspaceId, userId: memberUserId } = req.params as { workspaceId: string; userId: string }
    const { canDraft } = req.body as { canDraft?: boolean }

    if (typeof canDraft !== 'boolean') {
      res.status(400).json({ error: 'canDraft must be a boolean' })
      return
    }

    try {
      // Refuse admin/owner targets — their effective permission is
      // always true and wouldn't be governed by the column anyway.
      const target = await query<{ role: 'owner' | 'admin' | 'member' }>(
        `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, memberUserId],
      )
      if (target.rows.length === 0) {
        res.status(404).json({ error: 'Member not found' })
        return
      }
      if (target.rows[0].role !== 'member') {
        res.status(400).json({ error: 'Admins and owners always have draft permission. Change the role to member first to govern via this flag.' })
        return
      }

      const ok = await workspaceStore.updateMemberDraftPermission(actingUserId, workspaceId, memberUserId, canDraft)
      if (!ok) {
        res.status(404).json({ error: 'Member not found' })
        return
      }
      res.json({ ok: true, canDraft })
    } catch (err) {
      console.error('[workspaces] update permissions failed:', err)
      res.status(500).json({ error: 'Failed to update permissions' })
    }
  })

  // ── POST /:workspaceId/invitations — invite member(s) by email ──
  //
  // Admin-gated. Accepts a comma/space/newline-separated string or an array
  // of emails, an optional role (member|admin), and an optional personal
  // note. For each email: already-a-member → skipped; otherwise an
  // invitation is upserted, the accept link is built, and (when SMTP is
  // configured) an invitation email is sent fire-and-forget. The link is
  // also returned per-email so the UI can offer a copy-link fallback.
  router.post('/:workspaceId/invitations', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const role = await requireWorkspaceRole(req as any, res, 'admin')
    if (!role) return
    if (!invitationStore) { res.status(501).json({ error: 'Invitations are not configured' }); return }

    const body = req.body as { emails?: string[] | string; role?: 'admin' | 'member'; message?: string }
    const inviteRole: 'admin' | 'member' = body.role === 'admin' ? 'admin' : 'member'
    const message =
      typeof body.message === 'string' && body.message.trim()
        ? body.message.trim().slice(0, 1000)
        : null

    const rawList = Array.isArray(body.emails)
      ? body.emails
      : typeof body.emails === 'string'
        ? body.emails.split(/[\s,;]+/)
        : []
    const emails = Array.from(
      new Set(rawList.map((e) => String(e).trim().toLowerCase()).filter(Boolean)),
    )
    if (emails.length === 0) { res.status(400).json({ error: 'At least one email is required' }); return }
    if (emails.length > 50) { res.status(400).json({ error: 'Too many emails (max 50 per invite)' }); return }

    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    const { workspaceId } = req.params as { workspaceId: string }

    try {
      // Workspace name + inviter name for the email body / preview.
      const wsRow = await query<{ name: string }>(`SELECT name FROM workspaces WHERE id = $1`, [workspaceId])
      const workspaceName = wsRow.rows[0]?.name ?? 'a workspace'
      const inviterRow = await query<{ name: string | null }>(`SELECT name FROM users WHERE id = $1`, [userId])
      const inviterName = inviterRow.rows[0]?.name ?? null

      const results: Array<{ email: string; status: 'invited' | 'already_member' | 'invalid'; link?: string }> = []
      for (const email of emails) {
        if (!EMAIL_RE.test(email)) { results.push({ email, status: 'invalid' }); continue }

        const existing = await query<{ id: string }>(
          `SELECT u.id FROM users u
             JOIN workspace_members wm ON wm.user_id = u.id
            WHERE wm.workspace_id = $1 AND lower(u.email) = $2`,
          [workspaceId, email],
        )
        if (existing.rows.length > 0) { results.push({ email, status: 'already_member' }); continue }

        const { token } = await invitationStore.create({
          workspaceId,
          email,
          role: inviteRole,
          message,
          invitedByUserId: userId,
        })
        const link = `${(appUrl ?? '').replace(/\/$/, '')}/invite?token=${encodeURIComponent(token)}`
        results.push({ email, status: 'invited', link })

        if (smtpClient) {
          smtpClient
            .sendWorkspaceInvitation(email, { link, workspaceName, inviterName, role: inviteRole, message })
            .catch((err) => console.error('[workspaces] invitation email send failed:', err))
        }
        if (auditStore) {
          void auditStore.append({
            workspaceId,
            actorUserId: userId,
            eventType: 'member.invited',
            details: { email, role: inviteRole },
          })
        }
      }
      res.status(201).json({ results })
    } catch (err) {
      console.error('[workspaces] invite failed:', err)
      res.status(500).json({ error: 'Failed to send invitations' })
    }
  })

  // ── GET /:workspaceId/invitations — list pending invitations ──
  router.get('/:workspaceId/invitations', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const role = await requireWorkspaceRole(req as any, res, 'admin')
    if (!role) return
    if (!invitationStore) { res.json({ invitations: [] }); return }

    try {
      const invitations = await invitationStore.listPending(req.params.workspaceId)
      res.json({ invitations })
    } catch (err) {
      console.error('[workspaces] list invitations failed:', err)
      res.status(500).json({ error: 'Failed to list invitations' })
    }
  })

  // ── DELETE /:workspaceId/invitations/:invitationId — revoke ──
  router.delete('/:workspaceId/invitations/:invitationId', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const role = await requireWorkspaceRole(req as any, res, 'admin')
    if (!role) return
    if (!invitationStore) { res.status(404).json({ error: 'invitation_not_found' }); return }

    const { workspaceId, invitationId } = req.params as { workspaceId: string; invitationId: string }
    try {
      const ok = await invitationStore.revoke(workspaceId, invitationId)
      if (!ok) { res.status(404).json({ error: 'invitation_not_found' }); return }
      if (auditStore) {
        void auditStore.append({
          workspaceId,
          actorUserId: userId,
          eventType: 'member.invite_revoked',
          subjectId: invitationId,
        })
      }
      res.status(204).end()
    } catch (err) {
      console.error('[workspaces] revoke invitation failed:', err)
      res.status(500).json({ error: 'Failed to revoke invitation' })
    }
  })

  // ── POST /:workspaceId/assistants — create team assistant ─────────

  router.post('/:workspaceId/assistants', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const role = await requireWorkspaceRole(req as any, res, 'admin')
    if (!role) return

    const { name, kind, appType, clearance } = req.body as {
      name?: string
      kind?: 'standard' | 'app' | 'primary'
      appType?: AppType | null
      clearance?: 'public' | 'internal' | 'confidential'
    }
    const assistantName = (name && typeof name === 'string' && name.trim()) || 'Team Assistant'

    if (kind !== undefined && kind !== 'standard' && kind !== 'app') {
      res.status(400).json({ error: "kind must be 'standard' or 'app'" })
      return
    }
    if (appType !== undefined && appType !== null && !isAppType(appType)) {
      res.status(400).json({
        error: `appType must be one of: ${[...APP_TYPE_IDS].join(', ')}, or null`,
      })
      return
    }
    if (clearance !== undefined && !['public', 'internal', 'confidential'].includes(clearance)) {
      res.status(400).json({ error: "clearance must be public, internal, or confidential" })
      return
    }
    // kind='standard' assistants default to 'internal' clearance (team
    // default — keeps an accidentally `confidential`-tagged connector from
    // leaking to every team assistant).
    // kind='app' assistants pull their default clearance from the app-type
    // registry (distribution=public; future crm=confidential, etc.). The
    // registry decouples clearance from kind so each app type can declare
    // its own trust posture.
    const finalKind = kind ?? 'standard'
    const finalAppType: AppType | null = finalKind === 'app' ? (appType ?? 'distribution') : null
    const finalClearance =
      clearance ?? (finalAppType !== null ? defaultClearanceForAppType(finalAppType) : 'internal')

    try {
      // Check plan limits — gated on the WORKSPACE's plan (billing is
      // per-workspace, migration 143).
      const user = await findUserById(userId)
      if (!user) { res.status(401).json({ error: 'User not found' }); return }

      const { workspaceId } = req.params as { workspaceId: string }
      const workspacePlan = await getWorkspacePlan(workspaceId)

      const countResult = await query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM assistant_members WHERE user_id = $1 AND role = 'owner'`,
        [userId],
      )
      const currentCount = Number(countResult.rows[0].count)

      const maxAssistants = workspacePlan === 'free' ? 1 : 10
      if (currentCount >= maxAssistants) {
        res.status(403).json({
          error: 'assistant_limit',
          plan: workspacePlan,
          limit: maxAssistants,
          message: workspacePlan === 'free'
            ? 'Free plan is limited to 1 assistant. Upgrade to Pro to create more.'
            : `You've reached the ${maxAssistants}-assistant limit. Contact us for higher limits.`,
        })
        return
      }

      // Post-089: team-owned assistants satisfy the ownership XOR by
      // having `owner_user_id IS NULL` and `workspace_id` set. Access flows
      // through `workspace_members` via the refreshed `assistants_own` RLS
      // policy — no `assistant_members` fan-out.
      //
      // Clearance default flows from the app-type registry
      // (`packages/shared/src/app-types.ts`). Standard team assistants
      // default to 'internal'; distribution apps default to 'public' to
      // satisfy the feed eligibility triple (`kind='app'` + `workspace_id` +
      // `clearance='public'`) enforced in `feed-store.ts`. Caller-provided
      // clearance always wins over the default.
      //
      // See docs/architecture/integrations/mcp.md and
      // docs/architecture/feed/assistant-kind-app.md.
      const iconSeed = Math.floor(Math.random() * 1000000)
      const result = await query<{ id: string }>(
        `INSERT INTO assistants (name, owner_user_id, workspace_id, icon_seed, clearance, kind, app_type)
         VALUES ($1, NULL, $2, $3, $4, $5, $6) RETURNING id`,
        [assistantName, workspaceId, iconSeed, finalClearance, finalKind, finalAppType],
      )
      const assistantId = result.rows[0].id

      // §17 — Tasks/CRM primitive grants. kind='standard' inherits primary's
      // default-on policy (most workspace assistants are general-purpose);
      // kind='app' specialists default-off (the distribution app gets its
      // threads tools, not CRM). See docs/plans/company-brain.md §17.
      if (finalKind === 'standard') {
        await query(
          `INSERT INTO assistant_capabilities
             (assistant_id, capability, granted_by_user_id, reason)
           VALUES ($1, 'tasks', $2, '§17 default-on at standard creation'),
                  ($1, 'crm',   $2, '§17 default-on at standard creation'),
                  ($1, 'goals', $2, 'goals default-on at standard creation')`,
          [assistantId, userId],
        )
      }

      // (Doc-app capability auto-grant lives at the `/api/assistants`
      // POST handler in apps/api/src/index.ts, not here. App-kind
      // assistants flow through that endpoint; this workspace route
      // creates standard assistants only.)

      // Intra-workspace auto-follow: keep the workspace primary following its
      // siblings (explicit-trigger-only). Best-effort — idempotent + set-based,
      // so a transient miss self-heals on the next create/adopt. See
      // docs/architecture/channels/inter-assistant.md → "Intra-workspace auto-follow".
      await connectionStore.seedWorkspacePrimaryFollows(workspaceId).catch((err) =>
        console.warn('[workspaces] seedWorkspacePrimaryFollows (create) failed:', err),
      )

      res.status(201).json({
        id: assistantId,
        name: assistantName,
        workspaceId,
        iconSeed,
        kind: finalKind,
        appType: finalAppType,
        clearance: finalClearance,
      })
    } catch (err) {
      console.error('[workspaces] create assistant failed:', err)
      res.status(500).json({ error: 'Failed to create assistant' })
    }
  })

  // ── POST /:workspaceId/assistants/:assistantId/adopt — move existing assistant into team ──

  router.post('/:workspaceId/assistants/:assistantId/adopt', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const role = await requireWorkspaceRole(req as any, res, 'admin')
    if (!role) return

    const { workspaceId, assistantId } = req.params as { workspaceId: string; assistantId: string }

    try {
      const adopted = await workspaceStore.adoptAssistant(userId, workspaceId, assistantId)
      if (!adopted) {
        res.status(400).json({ error: 'Cannot adopt this assistant. You must own it and it must not already belong to a team.' })
        return
      }
      // The adopted assistant now lives in this workspace — fold it into the
      // primary's intra-workspace follow plane (explicit-trigger-only).
      await connectionStore.seedWorkspacePrimaryFollows(workspaceId).catch((err) =>
        console.warn('[workspaces] seedWorkspacePrimaryFollows (adopt) failed:', err),
      )
      res.json({ ok: true })
    } catch (err) {
      console.error('[workspaces] adopt assistant failed:', err)
      res.status(500).json({ error: 'Failed to adopt assistant' })
    }
  })

  // ── POST /:workspaceId/assistants/:assistantId/remove — detach assistant from team ──
  // Guarded: blocks if team memories exist unless force option provided.
  //   force: 'delete' — delete workspace memories, then detach
  //   force: 'keep'   — detach without cleanup (memories stay with team, unlinked)

  router.post('/:workspaceId/assistants/:assistantId/remove', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const role = await requireWorkspaceRole(req as any, res, 'admin')
    if (!role) return

    const { workspaceId, assistantId } = req.params as { workspaceId: string; assistantId: string }
    const { force } = (req.body ?? {}) as { force?: 'delete' | 'keep' }

    try {
      // Guard: check for team memories. This is an admin-gated detach
      // operation — the count is workspace-scoped so we use a system
      // context (no clearance) keyed on the assistant the operator is
      // removing.
      const memoryCount = await countWorkspaceMemories({
        workspaceId,
        userId,
        assistantId,
        // Admin-gated detach operation counts every workspace memory for
        // this assistant; the predicate's assistant_id partition is
        // immaterial because we're counting by-assistant directly.
        assistantKind: 'standard',
      })
      if (memoryCount > 0 && !force) {
        res.status(409).json({
          error: 'team_memories_exist',
          count: memoryCount,
          message: `This assistant has ${memoryCount} team memories. Transfer them to another assistant, delete them, or keep them with the team before detaching.`,
        })
        return
      }

      // Handle force options
      if (force === 'delete' && memoryCount > 0) {
        await deleteWorkspaceMemories(assistantId, workspaceId)
      }
      // force === 'keep' → do nothing, memories stay orphaned

      const removed = await workspaceStore.removeAssistant(userId, workspaceId, assistantId)
      if (!removed) {
        res.status(400).json({ error: 'Assistant not found in this team' })
        return
      }
      res.json({ ok: true })
    } catch (err) {
      console.error('[workspaces] remove assistant failed:', err)
      res.status(500).json({ error: 'Failed to remove assistant' })
    }
  })

  // ── GET /:workspaceId/memories/unverified ──────────────────────
  //
  // Workspace-scoped staged-memory review list. Backs the
  // `/memories/review` page in apps/web. Pagination uses an opaque
  // base64 `(createdAt, id)` cursor — same shape as the per-assistant
  // unverified branch in `memoryRoutes()`. Workspace membership at any
  // role is sufficient; the review surface is for everyone who can see
  // workspace memory anyway.

  router.get('/:workspaceId/memories/unverified', async (req, res) => {
    const role = await requireWorkspaceRole(req as any, res, 'member')
    if (!role) return

    const { workspaceId } = req.params as { workspaceId: string }
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
    let cursor: { createdAt: Date; id: string } | undefined
    const rawCursor = req.query.cursor as string | undefined
    if (rawCursor) {
      try {
        const decoded = JSON.parse(Buffer.from(rawCursor, 'base64').toString('utf8'))
        if (
          decoded &&
          typeof decoded.createdAt === 'string' &&
          typeof decoded.id === 'string'
        ) {
          cursor = { createdAt: new Date(decoded.createdAt), id: decoded.id }
        }
      } catch {
        // Malformed cursor → restart from head (same posture as the
        // per-assistant route).
      }
    }

    try {
      const rows = await listUnverifiedByWorkspace(workspaceId, limit, cursor)
      const nextCursor =
        rows.length === limit
          ? Buffer.from(
              JSON.stringify({
                createdAt: rows[rows.length - 1].createdAt.toISOString(),
                id: rows[rows.length - 1].id,
              }),
            ).toString('base64')
          : null
      res.json({ memories: rows, cursor: nextCursor })
    } catch (err) {
      console.error('[workspaces] unverified list failed:', err)
      res.status(500).json({ error: 'Failed to list unverified memories' })
    }
  })

  // ── GET /:workspaceId/memories/unverified/count ────────────────
  //
  // Lightweight count for the top-bar chrome pill. Same auth + scan as
  // the list endpoint above. Cheap enough to poll on workspace change
  // (sub-millisecond on the partial index).

  router.get('/:workspaceId/memories/unverified/count', async (req, res) => {
    const role = await requireWorkspaceRole(req as any, res, 'member')
    if (!role) return
    const { workspaceId } = req.params as { workspaceId: string }
    try {
      const count = await countUnverifiedByWorkspace(workspaceId)
      res.json({ pending: count })
    } catch (err) {
      console.error('[workspaces] unverified count failed:', err)
      res.status(500).json({ error: 'Failed to count unverified memories' })
    }
  })

  // ── POST /:workspaceId/memories/transfer — transfer team memories between assistants ──

  router.post('/:workspaceId/memories/transfer', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const role = await requireWorkspaceRole(req as any, res, 'admin')
    if (!role) return

    const { workspaceId } = req.params as { workspaceId: string }
    const { fromAssistantId, toAssistantId } = req.body as {
      fromAssistantId?: string
      toAssistantId?: string
    }

    if (!fromAssistantId || !toAssistantId) {
      res.status(400).json({ error: 'fromAssistantId and toAssistantId are required' })
      return
    }
    if (fromAssistantId === toAssistantId) {
      res.status(400).json({ error: 'Cannot transfer to the same assistant' })
      return
    }

    // Verify both assistants belong to this team
    const check = await query<{ id: string }>(
      `SELECT id FROM assistants WHERE id IN ($1, $2) AND workspace_id = $3`,
      [fromAssistantId, toAssistantId, workspaceId],
    )
    if (check.rows.length < 2) {
      res.status(400).json({ error: 'Both assistants must belong to this team' })
      return
    }

    try {
      const transferred = await transferWorkspaceMemories(fromAssistantId, toAssistantId, workspaceId)
      res.json({ transferred })
    } catch (err) {
      console.error('[workspaces] transfer memories failed:', err)
      res.status(500).json({ error: 'Failed to transfer memories' })
    }
  })

  // ── POST /:workspaceId/regenerate-icon — new random pixel shield ──

  router.post('/:workspaceId/regenerate-icon', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const role = await requireWorkspaceRole(req as any, res, 'admin')
    if (!role) return

    try {
      const { workspaceId } = req.params as { workspaceId: string }
      const newSeed = Math.floor(Math.random() * 1000000)
      await query(
        `UPDATE workspaces SET icon_seed = $1 WHERE id = $2`,
        [newSeed, workspaceId],
      )
      if (auditStore) {
        void auditStore.append({
          workspaceId,
          actorUserId: userId,
          eventType: 'workspace.icon_changed',
          details: { iconSeed: newSeed },
        })
      }
      res.json({ iconSeed: newSeed })
    } catch (err) {
      console.error('[workspaces] regenerate-icon failed:', err)
      res.status(500).json({ error: 'Failed to regenerate icon' })
    }
  })

  // /:workspaceId/memory-sharing routes deleted in migration 111. Workspace
  // memory sharing is now expressed via assistant_modes.memory_categories
  // on each assistant's mode bundles. See
  // docs/architecture/integrations/a2a.md.
  router.all('/:workspaceId/memory-sharing', (_req, res) => {
    res.status(410).json({
      error: 'Workspace memory sharing has moved to assistant modes. See /api/assistants/:id/modes.',
    })
  })

  return router
}
