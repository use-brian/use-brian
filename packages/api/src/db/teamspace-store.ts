/**
 * Teamspace store (migration 313) — Notion-style page containers.
 *
 * A teamspace is a member-gated container with a sensitivity tier; pages
 * (`saved_views.teamspace_id`) either belong to one or are private to their
 * creator. Reads that back the sidebar run RLS-scoped (the `teamspaces_member`
 * SELECT policy confines rows to the caller's memberships); every write and
 * the roster read go through the owner pool behind route-level clearance
 * gates (the workspace_invitations / memberCountsSystem posture — the two new
 * tables carry SELECT-only policies by design).
 *
 * Management is clearance-gated, not role-gated: any teamspace member whose
 * effective read clearance ≥ the teamspace's sensitivity may manage it. The
 * gates live in `routes/teamspaces.ts`; this store is mechanism only.
 *
 * Spec: docs/architecture/features/teamspaces.md. [COMP:api/teamspace-store]
 */

import type { Sensitivity } from '@sidanclaw/core'
import { getPool, query, queryWithRLS } from './client.js'

export type Teamspace = {
  id: string
  workspaceId: string
  name: string
  icon: string | null
  description: string | null
  sensitivity: Sensitivity
  isDefault: boolean
  position: number
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

export type TeamspaceMember = {
  userId: string
  name: string | null
  email: string | null
  /** The member's workspace role — display-only in the roster. */
  role: 'owner' | 'admin' | 'member' | null
  /** Raw `workspace_members.clearance` (role-stamped, migration 236). */
  clearance: Sensitivity | null
  addedAt: Date
}

export type TeamspaceUpdateFields = {
  name?: string
  /** Pass `null` to clear; omit to leave unchanged. */
  icon?: string | null
  /** Pass `null` to clear; omit to leave unchanged. */
  description?: string | null
  sensitivity?: Sensitivity
}

const TEAMSPACE_SELECT = `
  id,
  workspace_id AS "workspaceId",
  name,
  icon,
  description,
  sensitivity,
  is_default   AS "isDefault",
  position,
  created_by   AS "createdBy",
  created_at   AS "createdAt",
  updated_at   AS "updatedAt"
`

/**
 * Find-or-create the workspace's default (General) teamspace, joining every
 * current workspace member. Normally the default exists (migration 313
 * backfill; workspace creation seeds it), but a workspace minted by a
 * pre-teamspace API instance in the deploy window would lack one — callers
 * heal lazily. Race-safe: the partial unique index makes the second creator
 * lose with 23505, and we re-read the winner. Returns the default's id.
 */
export async function ensureDefaultTeamspaceSystem(workspaceId: string): Promise<string> {
  const existing = await query<{ id: string }>(
    `SELECT id FROM teamspaces WHERE workspace_id = $1 AND is_default = true`,
    [workspaceId],
  )
  if (existing.rows[0]) return existing.rows[0].id
  let id: string
  try {
    const created = await query<{ id: string }>(
      `INSERT INTO teamspaces (workspace_id, name, sensitivity, is_default, created_by)
       SELECT w.id, 'General', 'internal', true, w.owner_user_id FROM workspaces w WHERE w.id = $1
       RETURNING id`,
      [workspaceId],
    )
    if (!created.rows[0]) throw new Error(`workspace ${workspaceId} not found`)
    id = created.rows[0].id
  } catch (err) {
    if ((err as { code?: string }).code !== '23505') throw err
    const winner = await query<{ id: string }>(
      `SELECT id FROM teamspaces WHERE workspace_id = $1 AND is_default = true`,
      [workspaceId],
    )
    if (!winner.rows[0]) throw err
    id = winner.rows[0].id
  }
  await query(
    `INSERT INTO teamspace_members (teamspace_id, user_id)
     SELECT $1, wm.user_id FROM workspace_members wm WHERE wm.workspace_id = $2
     ON CONFLICT DO NOTHING`,
    [id, workspaceId],
  )
  return id
}

/**
 * Auto-join a (new) workspace member to the workspace's default teamspaces.
 * The `addMember` seam — every joiner lands in General so the day-one
 * sidebar is never empty. Heals a missing default first.
 */
export async function joinDefaultTeamspacesSystem(workspaceId: string, userId: string): Promise<void> {
  await ensureDefaultTeamspaceSystem(workspaceId)
  await query(
    `INSERT INTO teamspace_members (teamspace_id, user_id)
     SELECT t.id, $2 FROM teamspaces t WHERE t.workspace_id = $1 AND t.is_default = true
     ON CONFLICT DO NOTHING`,
    [workspaceId, userId],
  )
}

/**
 * Drop every teamspace membership a user holds in a workspace — the
 * `removeMember` cascade (teamspace_members has no workspace-member FK, so
 * the cleanup is explicit).
 */
export async function leaveWorkspaceTeamspacesSystem(workspaceId: string, userId: string): Promise<void> {
  await query(
    `DELETE FROM teamspace_members tm
      USING teamspaces t
      WHERE t.id = tm.teamspace_id AND t.workspace_id = $1 AND tm.user_id = $2`,
    [workspaceId, userId],
  )
}

export type TeamspaceStore = ReturnType<typeof createTeamspaceStore>

export function createTeamspaceStore() {
  return {
    /**
     * The caller's teamspaces in a workspace, RLS-scoped (membership is the
     * visibility boundary — a non-member never learns a teamspace exists).
     * Default (General) first, then sidebar position.
     */
    async listForUser(userId: string, workspaceId: string): Promise<Teamspace[]> {
      const result = await queryWithRLS<Teamspace>(
        userId,
        `SELECT ${TEAMSPACE_SELECT} FROM teamspaces
          WHERE workspace_id = $1
          ORDER BY is_default DESC, position ASC, created_at ASC`,
        [workspaceId],
      )
      return result.rows
    },

    /** Owner-pool fetch for route gates (the caller may not be a member yet). */
    async getSystem(id: string): Promise<Teamspace | null> {
      const result = await query<Teamspace>(
        `SELECT ${TEAMSPACE_SELECT} FROM teamspaces WHERE id = $1`,
        [id],
      )
      return result.rows[0] ?? null
    },

    /** Member counts for a set of teamspaces (owner pool — RLS would see 1). */
    async memberCountsSystem(teamspaceIds: string[]): Promise<Map<string, number>> {
      if (teamspaceIds.length === 0) return new Map()
      const result = await query<{ teamspaceId: string; count: string }>(
        `SELECT teamspace_id AS "teamspaceId", COUNT(*)::text AS count
           FROM teamspace_members
          WHERE teamspace_id = ANY($1)
          GROUP BY teamspace_id`,
        [teamspaceIds],
      )
      return new Map(result.rows.map((r) => [r.teamspaceId, Number(r.count)]))
    },

    /**
     * Create a teamspace and auto-join the creator, in one transaction.
     * Position appends after the workspace's existing sections. The route
     * has already capped `sensitivity` at the creator's clearance.
     */
    async create(params: {
      workspaceId: string
      name: string
      icon?: string | null
      description?: string | null
      sensitivity: Sensitivity
      createdBy: string
    }): Promise<Teamspace> {
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        const result = await client.query<Teamspace>(
          `INSERT INTO teamspaces (workspace_id, name, icon, description, sensitivity, created_by, position)
           VALUES ($1, $2, $3, $4, $5, $6,
             (SELECT COALESCE(MAX(position) + 1, 0) FROM teamspaces WHERE workspace_id = $1))
           RETURNING ${TEAMSPACE_SELECT}`,
          [
            params.workspaceId,
            params.name,
            params.icon ?? null,
            params.description ?? null,
            params.sensitivity,
            params.createdBy,
          ],
        )
        const teamspace = result.rows[0]
        await client.query(
          `INSERT INTO teamspace_members (teamspace_id, user_id) VALUES ($1, $2)`,
          [teamspace.id, params.createdBy],
        )
        await client.query('COMMIT')
        return teamspace
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },

    async update(id: string, fields: TeamspaceUpdateFields): Promise<Teamspace | null> {
      const sets: string[] = []
      const values: unknown[] = []
      let idx = 1
      if (fields.name !== undefined) {
        sets.push(`name = $${idx++}`)
        values.push(fields.name)
      }
      if (fields.icon !== undefined) {
        sets.push(`icon = $${idx++}`)
        values.push(fields.icon)
      }
      if (fields.description !== undefined) {
        sets.push(`description = $${idx++}`)
        values.push(fields.description)
      }
      if (fields.sensitivity !== undefined) {
        sets.push(`sensitivity = $${idx++}`)
        values.push(fields.sensitivity)
      }
      if (sets.length === 0) return this.getSystem(id)
      values.push(id)
      const result = await query<Teamspace>(
        `UPDATE teamspaces SET ${sets.join(', ')} WHERE id = $${idx} RETURNING ${TEAMSPACE_SELECT}`,
        values,
      )
      return result.rows[0] ?? null
    },

    /**
     * Delete a (non-default) teamspace, reassigning every page it contains
     * to the workspace's default (General) teamspace in the same transaction
     * — pages are never destroyed by container deletion, and the FK's
     * `ON DELETE SET NULL` fallback never actually fires on this path.
     * Member rows cascade. Returns false when the row is missing or default.
     */
    async remove(id: string): Promise<boolean> {
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        const found = await client.query<{ workspaceId: string; isDefault: boolean }>(
          `SELECT workspace_id AS "workspaceId", is_default AS "isDefault"
             FROM teamspaces WHERE id = $1 FOR UPDATE`,
          [id],
        )
        const row = found.rows[0]
        if (!row || row.isDefault) {
          await client.query('ROLLBACK')
          return false
        }
        await client.query(
          `UPDATE saved_views
              SET teamspace_id = (SELECT t.id FROM teamspaces t WHERE t.workspace_id = $2 AND t.is_default = true)
            WHERE teamspace_id = $1`,
          [id, row.workspaceId],
        )
        await client.query(`DELETE FROM teamspaces WHERE id = $1`, [id])
        await client.query('COMMIT')
        return true
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },

    // ── Membership ────────────────────────────────────────────────────

    async isMemberSystem(teamspaceId: string, userId: string): Promise<boolean> {
      const result = await query<{ ok: true }>(
        `SELECT true AS ok FROM teamspace_members WHERE teamspace_id = $1 AND user_id = $2`,
        [teamspaceId, userId],
      )
      return result.rows.length > 0
    },

    /**
     * Roster with directory fields (owner pool after the route's membership
     * check — the self-scoped RLS policy can't list teammates by design).
     */
    async listMembersSystem(teamspaceId: string): Promise<TeamspaceMember[]> {
      const result = await query<TeamspaceMember>(
        `SELECT tm.user_id AS "userId",
                u.name,
                u.email,
                wm.role,
                wm.clearance,
                tm.added_at AS "addedAt"
           FROM teamspace_members tm
           JOIN teamspaces t ON t.id = tm.teamspace_id
           LEFT JOIN users u ON u.id = tm.user_id
           LEFT JOIN workspace_members wm
             ON wm.workspace_id = t.workspace_id AND wm.user_id = tm.user_id
          WHERE tm.teamspace_id = $1
          ORDER BY tm.added_at ASC`,
        [teamspaceId],
      )
      return result.rows
    },

    async addMemberSystem(teamspaceId: string, userId: string): Promise<void> {
      await query(
        `INSERT INTO teamspace_members (teamspace_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [teamspaceId, userId],
      )
    },

    async removeMemberSystem(teamspaceId: string, userId: string): Promise<boolean> {
      const result = await query(
        `DELETE FROM teamspace_members WHERE teamspace_id = $1 AND user_id = $2`,
        [teamspaceId, userId],
      )
      return (result.rowCount ?? 0) > 0
    },

    /**
     * True when any current member's effective clearance sits below
     * `sensitivity` — the raise-sensitivity gate (raising is blocked until
     * they're removed; explicit beats silent access loss). Effective =
     * owner/admin bump to confidential, else the stamped column.
     */
    async hasMemberBelowSystem(teamspaceId: string, sensitivity: Sensitivity): Promise<boolean> {
      const result = await query<{ ok: true }>(
        `SELECT true AS ok
           FROM teamspace_members tm
           JOIN teamspaces t ON t.id = tm.teamspace_id
           LEFT JOIN workspace_members wm
             ON wm.workspace_id = t.workspace_id AND wm.user_id = tm.user_id
          WHERE tm.teamspace_id = $1
            AND sensitivity_rank(
                  CASE WHEN wm.role IN ('owner', 'admin') THEN 'confidential'
                       ELSE COALESCE(wm.clearance, 'public') END
                ) < sensitivity_rank($2)
          LIMIT 1`,
        [teamspaceId, sensitivity],
      )
      return result.rows.length > 0
    },
  }
}
