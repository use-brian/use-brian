/**
 * Teamspace routes (migration 313) — Notion-style page containers.
 *
 * Mounted at `/api` under `requireAuth`. Visibility rides the RLS policies
 * (a non-member never sees a teamspace); the sensitivity tier is enforced
 * here, app-side, mirroring the page-clearance posture:
 *
 *  - **create**: any workspace member, `sensitivity ≤` their effective read
 *    clearance; the creator is auto-joined.
 *  - **manage** (rename / icon / description / sensitivity / members /
 *    delete): any TEAMSPACE member whose effective clearance ≥ the
 *    teamspace's sensitivity. No admin floor — the workspace-owned-connector
 *    posture (mcp.md → "Workspace-owned connectors").
 *  - **add member**: the target's clearance must satisfy the teamspace's
 *    sensitivity (you can't file someone into a container they can't read).
 *  - **raise sensitivity**: blocked (`409 member_below_sensitivity`) while
 *    any current member sits below the new tier — remove them first;
 *    explicit beats silent access loss.
 *  - The default (General) teamspace can't be deleted or left, and nobody
 *    can be removed from it.
 *
 * Effective clearance = owner/admin → 'confidential' (role bump), member →
 * the stamped `workspace_members.clearance` column — `effectiveReadClearance`
 * with the assistant leg pinned to 'confidential' (no assistant in the loop).
 *
 * Spec: docs/architecture/features/teamspaces.md. [COMP:api/teamspaces-route]
 */

import { Router } from 'express'
import { z } from 'zod'
import { canRead, type Sensitivity } from '@use-brian/core'
import type { TeamspaceStore, Teamspace } from '../db/teamspace-store.js'
import { ensureDefaultTeamspaceSystem, joinDefaultTeamspacesSystem } from '../db/teamspace-store.js'
import {
  effectiveReadClearance,
  getWorkspaceMembershipWithClearanceSystem,
} from '../db/workspace-store.js'

export type TeamspacesRouteOptions = {
  teamspaceStore: TeamspaceStore
}

const sensitivitySchema = z.enum(['public', 'internal', 'confidential'])

const createBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  icon: z.string().trim().min(1).max(16).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  sensitivity: sensitivitySchema.optional(),
})

const patchBodySchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  icon: z.string().trim().min(1).max(16).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  sensitivity: sensitivitySchema.optional(),
})

const addMemberBodySchema = z.object({
  userId: z.string().uuid(),
})

function unauthorized(res: import('express').Response): void {
  res.status(401).json({ error: 'Unauthorized' })
}

function notMember(res: import('express').Response): void {
  res.status(403).json({ error: 'Not a member of this workspace' })
}

function notFound(res: import('express').Response, what = 'Not found'): void {
  res.status(404).json({ error: what })
}

function badRequest(res: import('express').Response, message: string): void {
  res.status(400).json({ error: message })
}

function zodMessage(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
}

function teamspaceJson(t: Teamspace, extras: { memberCount?: number; canManage?: boolean } = {}) {
  return {
    id: t.id,
    workspaceId: t.workspaceId,
    name: t.name,
    icon: t.icon,
    description: t.description,
    sensitivity: t.sensitivity,
    isDefault: t.isDefault,
    position: t.position,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    ...extras,
  }
}

export function teamspacesRoutes(opts: TeamspacesRouteOptions): Router {
  const router = Router()
  const store = opts.teamspaceStore

  /** The caller's effective read clearance in a workspace, or null = not a member. */
  async function memberClearance(userId: string, workspaceId: string): Promise<Sensitivity | null> {
    const membership = await getWorkspaceMembershipWithClearanceSystem(userId, workspaceId)
    if (!membership) return null
    // No assistant in the loop — pin that leg to the ceiling so the member
    // side alone decides (owner/admin role bump included).
    return effectiveReadClearance(membership.role, membership.clearance, 'confidential')
  }

  /**
   * Resolve a teamspace + gate the caller as a MANAGER: a teamspace member
   * whose effective clearance ≥ the teamspace's sensitivity. Writes the
   * error response and returns null when the gate fails.
   */
  async function requireManage(
    req: import('express').Request,
    res: import('express').Response,
  ): Promise<{ teamspace: Teamspace; clearance: Sensitivity } | null> {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      unauthorized(res)
      return null
    }
    const teamspace = await store.getSystem(String(req.params.id))
    // Non-members get the same 404 as a missing id — membership is the
    // visibility boundary, so we never confirm existence to outsiders.
    if (!teamspace || !(await store.isMemberSystem(teamspace.id, userId))) {
      notFound(res, 'Teamspace not found')
      return null
    }
    const clearance = await memberClearance(userId, teamspace.workspaceId)
    if (!clearance) {
      notMember(res)
      return null
    }
    if (!canRead(clearance, teamspace.sensitivity)) {
      res.status(403).json({ error: 'insufficient_clearance' })
      return null
    }
    return { teamspace, clearance }
  }

  // GET /workspaces/:workspaceId/teamspaces — the caller's sections
  router.get('/workspaces/:workspaceId/teamspaces', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const workspaceId = req.params.workspaceId

    const clearance = await memberClearance(userId, workspaceId)
    if (!clearance) return notMember(res)

    // Heal the General teamspace + the caller's auto-join lazily — covers
    // both a workspace minted and a member added by a pre-teamspace API
    // instance in the deploy window (a cheap SELECT + single-row upsert).
    try {
      await joinDefaultTeamspacesSystem(workspaceId, userId)
    } catch (err) {
      console.error('[teamspaces] default heal failed:', err)
    }

    const teamspaces = await store.listForUser(userId, workspaceId)
    const counts = await store.memberCountsSystem(teamspaces.map((t) => t.id))
    res.json({
      teamspaces: teamspaces.map((t) =>
        teamspaceJson(t, {
          memberCount: counts.get(t.id) ?? 1,
          canManage: canRead(clearance, t.sensitivity),
        }),
      ),
    })
  })

  // POST /workspaces/:workspaceId/teamspaces — create (any member)
  router.post('/workspaces/:workspaceId/teamspaces', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const workspaceId = req.params.workspaceId

    const clearance = await memberClearance(userId, workspaceId)
    if (!clearance) return notMember(res)

    const parsed = createBodySchema.safeParse(req.body ?? {})
    if (!parsed.success) return badRequest(res, zodMessage(parsed.error))

    const sensitivity = parsed.data.sensitivity ?? 'internal'
    // A member can never mint a container above their own ceiling.
    if (!canRead(clearance, sensitivity)) {
      return res.status(403).json({ error: 'sensitivity_exceeds_clearance' })
    }

    const teamspace = await store.create({
      workspaceId,
      name: parsed.data.name,
      icon: parsed.data.icon ?? null,
      description: parsed.data.description ?? null,
      sensitivity,
      createdBy: userId,
    })
    res.status(201).json(teamspaceJson(teamspace, { memberCount: 1, canManage: true }))
  })

  // PATCH /teamspaces/:id — rename / icon / description / sensitivity
  router.patch('/teamspaces/:id', async (req, res) => {
    const gate = await requireManage(req, res)
    if (!gate) return

    const parsed = patchBodySchema.safeParse(req.body ?? {})
    if (!parsed.success) return badRequest(res, zodMessage(parsed.error))

    const next = parsed.data.sensitivity
    if (next !== undefined && next !== gate.teamspace.sensitivity) {
      // Cap at the actor's own clearance…
      if (!canRead(gate.clearance, next)) {
        return res.status(403).json({ error: 'sensitivity_exceeds_clearance' })
      }
      // …and refuse to strand current members below the new tier.
      if (await store.hasMemberBelowSystem(gate.teamspace.id, next)) {
        return res.status(409).json({ error: 'member_below_sensitivity' })
      }
    }

    const updated = await store.update(gate.teamspace.id, {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.icon !== undefined ? { icon: parsed.data.icon } : {}),
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      ...(next !== undefined ? { sensitivity: next } : {}),
    })
    if (!updated) return notFound(res, 'Teamspace not found')
    res.json(teamspaceJson(updated))
  })

  // DELETE /teamspaces/:id — non-default; pages move to General
  router.delete('/teamspaces/:id', async (req, res) => {
    const gate = await requireManage(req, res)
    if (!gate) return
    if (gate.teamspace.isDefault) {
      return badRequest(res, 'The default teamspace cannot be deleted')
    }
    await ensureDefaultTeamspaceSystem(gate.teamspace.workspaceId)
    const removed = await store.remove(gate.teamspace.id)
    if (!removed) return notFound(res, 'Teamspace not found')
    res.json({ ok: true })
  })

  // GET /teamspaces/:id/members — roster (any teamspace member)
  router.get('/teamspaces/:id/members', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const teamspace = await store.getSystem(req.params.id)
    if (!teamspace || !(await store.isMemberSystem(teamspace.id, userId))) {
      return notFound(res, 'Teamspace not found')
    }
    const members = await store.listMembersSystem(teamspace.id)
    res.json({
      members: members.map((m) => ({
        userId: m.userId,
        name: m.name,
        email: m.email,
        role: m.role,
        clearance: m.clearance,
        addedAt: m.addedAt.toISOString(),
      })),
    })
  })

  // POST /teamspaces/:id/members — add a workspace member
  router.post('/teamspaces/:id/members', async (req, res) => {
    const gate = await requireManage(req, res)
    if (!gate) return

    const parsed = addMemberBodySchema.safeParse(req.body ?? {})
    if (!parsed.success) return badRequest(res, zodMessage(parsed.error))

    const target = await memberClearance(parsed.data.userId, gate.teamspace.workspaceId)
    if (!target) return badRequest(res, 'User is not a member of this workspace')
    // Never file someone into a container they can't read.
    if (!canRead(target, gate.teamspace.sensitivity)) {
      return res.status(409).json({ error: 'target_clearance_below_sensitivity' })
    }

    await store.addMemberSystem(gate.teamspace.id, parsed.data.userId)
    res.status(201).json({ ok: true })
  })

  // DELETE /teamspaces/:id/members/:userId — remove / leave
  router.delete('/teamspaces/:id/members/:userId', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const targetUserId = req.params.userId

    const teamspace = await store.getSystem(req.params.id)
    if (!teamspace || !(await store.isMemberSystem(teamspace.id, userId))) {
      return notFound(res, 'Teamspace not found')
    }
    // Everyone belongs to General — no leaving, no removals.
    if (teamspace.isDefault) {
      return badRequest(res, 'Members cannot be removed from the default teamspace')
    }

    if (targetUserId !== userId) {
      // Removing someone else is a management action.
      const gate = await requireManage(req, res)
      if (!gate) return
    }
    // Self-removal (leave) is any member's right on a non-default teamspace.

    const removed = await store.removeMemberSystem(teamspace.id, targetUserId)
    if (!removed) return notFound(res, 'Member not found')
    res.json({ ok: true })
  })

  return router
}
