/**
 * Append-only audit for canonical scope changes. Domain writers own the row
 * mutation; this store records the before/after boundary in the same service
 * transaction once the writer succeeds.
 *
 * [COMP:brain/context-reclassification]
 */

import { scopeGrantContains, type ScopeGrant } from '@use-brian/core'
import {
  applyRLSGucs,
  getAppPool,
  queryWithRLS,
  rollbackAndRelease,
} from './client.js'

export type ContextRequirements = {
  compartments: string[]
  projectIds: string[]
}

export type ScopeChangeKind = 'widening' | 'narrowing' | 'lateral' | 'unchanged'

function setEquals(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left)
  const b = new Set(right)
  return a.size === b.size && [...a].every((value) => b.has(value))
}

function removedAny(before: readonly string[], after: readonly string[]): boolean {
  const next = new Set(after)
  return before.some((value) => !next.has(value))
}

function addedAny(before: readonly string[], after: readonly string[]): boolean {
  const previous = new Set(before)
  return after.some((value) => !previous.has(value))
}

export function classifyScopeChange(
  previous: ContextRequirements,
  next: ContextRequirements,
): ScopeChangeKind {
  if (
    setEquals(previous.compartments, next.compartments)
    && setEquals(previous.projectIds, next.projectIds)
  ) return 'unchanged'

  const teamWidened = removedAny(previous.compartments, next.compartments)
  const projectWidened = previous.projectIds.length > 0 && (
    next.projectIds.length === 0
    || (
      next.projectIds.every((id) => previous.projectIds.includes(id))
      && removedAny(previous.projectIds, next.projectIds)
    )
  )
  if (teamWidened || projectWidened) return 'widening'

  const teamNarrowed = addedAny(previous.compartments, next.compartments)
  const projectNarrowed = previous.projectIds.length === 0 && next.projectIds.length > 0
    || (
      previous.projectIds.every((id) => next.projectIds.includes(id))
      && addedAny(previous.projectIds, next.projectIds)
    )
  if (teamNarrowed || projectNarrowed) return 'narrowing'
  return 'lateral'
}

export type ContextReclassificationEvent = {
  id: string
  workspaceId: string
  primitive: string
  rowId: string
  previous: ContextRequirements
  next: ContextRequirements
  actorUserId: string
  reason: string
  kind: ScopeChangeKind
  createdAt: string
}

export type ContextReclassificationStore = {
  append(userId: string, input: {
    workspaceId: string
    primitive: string
    rowId: string
    previous: ContextRequirements
    next: ContextRequirements
    reason: string
  }): Promise<ContextReclassificationEvent>
  reclassify(userId: string, input: {
    workspaceId: string
    primitive: ReclassifiablePrimitive
    rowId: string
    teamIds: string[]
    projectIds: string[]
    reason: string
    confirmed: boolean
  }): Promise<ContextReclassificationEvent>
  getRequirements(userId: string, input: {
    workspaceId: string
    primitive: ReclassifiablePrimitive
    rowId: string
  }): Promise<ContextRequirements | null>
}

const RECLASSIFIABLE_ROWS = {
  memory: { table: 'memories', maxProjects: null },
  task: { table: 'tasks', maxProjects: 1 },
  file: { table: 'workspace_files', maxProjects: null },
  entity: { table: 'entities', maxProjects: null },
  knowledge: { table: 'knowledge_entries', maxProjects: null },
  recording: { table: 'recordings', maxProjects: null },
  office: { table: 'office_artifacts', maxProjects: null },
} as const

export type ReclassifiablePrimitive = keyof typeof RECLASSIFIABLE_ROWS

export class ContextReclassificationError extends Error {
  constructor(readonly code:
    | 'not_found'
    | 'not_a_member'
    | 'outside_grant'
    | 'admin_confirmation_required'
    | 'reason_required'
    | 'invalid_scope'
    | 'unchanged') {
    super(code)
    this.name = 'ContextReclassificationError'
  }
}

export function createDbContextReclassificationStore(): ContextReclassificationStore {
  return {
    async append(userId, input) {
      const kind = classifyScopeChange(input.previous, input.next)
      if (kind === 'unchanged') throw new Error('context_scope_unchanged')
      if (input.reason.trim().length === 0) throw new Error('context_scope_reason_required')
      const result = await queryWithRLS<{
        id: string
        workspaceId: string
        primitive: string
        rowId: string
        previousCompartments: string[]
        nextCompartments: string[]
        previousProjectIds: string[]
        nextProjectIds: string[]
        actorUserId: string
        reason: string
        createdAt: Date
      }>(
        userId,
        `INSERT INTO context_scope_reclassification_events
           (workspace_id, primitive, row_id,
            previous_compartments, next_compartments,
            previous_project_ids, next_project_ids,
            actor_user_id, reason, widening)
         VALUES ($1, $2, $3, $4::text[], $5::text[], $6::uuid[], $7::uuid[],
                 $8, $9, $10)
         RETURNING id, workspace_id AS "workspaceId", primitive,
                   row_id AS "rowId",
                   previous_compartments AS "previousCompartments",
                   next_compartments AS "nextCompartments",
                   previous_project_ids AS "previousProjectIds",
                   next_project_ids AS "nextProjectIds",
                   actor_user_id AS "actorUserId", reason,
                   created_at AS "createdAt"`,
        [
          input.workspaceId,
          input.primitive,
          input.rowId,
          input.previous.compartments,
          input.next.compartments,
          input.previous.projectIds,
          input.next.projectIds,
          userId,
          input.reason.trim(),
          kind === 'widening',
        ],
      )
      const row = result.rows[0]
      return {
        id: row.id,
        workspaceId: row.workspaceId,
        primitive: row.primitive,
        rowId: row.rowId,
        previous: {
          compartments: row.previousCompartments,
          projectIds: row.previousProjectIds,
        },
        next: {
          compartments: row.nextCompartments,
          projectIds: row.nextProjectIds,
        },
        actorUserId: row.actorUserId,
        reason: row.reason,
        kind,
        createdAt: row.createdAt.toISOString(),
      }
    },

    async reclassify(userId, input) {
      if (input.reason.trim().length === 0) {
        throw new ContextReclassificationError('reason_required')
      }
      const shape = RECLASSIFIABLE_ROWS[input.primitive]
      if (shape.maxProjects !== null && input.projectIds.length > shape.maxProjects) {
        throw new ContextReclassificationError('invalid_scope')
      }

      const client = await getAppPool().connect()
      try {
        await client.query('BEGIN')
        await applyRLSGucs(client, userId)
        const membership = await client.query<{
          role: 'owner' | 'admin' | 'member'
          grant: ScopeGrant
          clearance: 'public' | 'internal' | 'confidential'
        }>(
          `SELECT role,
                  effective_member_team_compartments(user_id, workspace_id) AS grant,
                  CASE WHEN role IN ('owner', 'admin') THEN 'confidential' ELSE clearance END AS clearance
             FROM workspace_members
            WHERE workspace_id = $1 AND user_id = $2`,
          [input.workspaceId, userId],
        )
        const principal = membership.rows[0]
        if (!principal) throw new ContextReclassificationError('not_a_member')

        const teams = await client.query<{ compartmentKey: string }>(
          `SELECT compartment_key AS "compartmentKey"
             FROM workspace_groups
            WHERE workspace_id = $1
              AND id = ANY($2::uuid[])
              AND kind = 'team'
              AND status = 'active'`,
          [input.workspaceId, [...new Set(input.teamIds)]],
        )
        if (teams.rows.length !== new Set(input.teamIds).size) {
          throw new ContextReclassificationError('invalid_scope')
        }
        const compartments = teams.rows.map((team) => team.compartmentKey).sort()
        if (!scopeGrantContains(principal.grant, compartments)) {
          throw new ContextReclassificationError('outside_grant')
        }

        const projects = await client.query<{ id: string }>(
          `SELECT id FROM workspace_projects
            WHERE workspace_id = $1
              AND id = ANY($2::uuid[])
              AND status = 'active'`,
          [input.workspaceId, [...new Set(input.projectIds)]],
        )
        if (projects.rows.length !== new Set(input.projectIds).size) {
          throw new ContextReclassificationError('invalid_scope')
        }
        const projectIds = projects.rows.map((project) => project.id).sort()

        const current = await client.query<{
          compartments: string[]
          projectIds: string[]
        }>(
          `SELECT compartments, project_ids AS "projectIds"
             FROM ${shape.table}
            WHERE id::text = $1 AND workspace_id = $2
              AND sensitivity_rank(sensitivity) <= sensitivity_rank($3)
              AND ($4::text[] IS NULL OR compartments <@ $4::text[])
            FOR UPDATE`,
          [input.rowId, input.workspaceId, principal.clearance, principal.grant],
        )
        const row = current.rows[0]
        if (!row) throw new ContextReclassificationError('not_found')
        const previous = {
          compartments: row.compartments ?? [],
          projectIds: row.projectIds ?? [],
        }
        const teamKeys = await client.query<{ key: string }>(
          `SELECT compartment_key AS key
             FROM workspace_groups
            WHERE workspace_id = $1 AND kind = 'team'`,
          [input.workspaceId],
        )
        const knownTeamKeys = new Set(teamKeys.rows.map((team) => team.key))
        const preservedRaw = previous.compartments.filter((key) => !knownTeamKeys.has(key))
        const next = {
          compartments: [...new Set([...preservedRaw, ...compartments])].sort(),
          projectIds,
        }
        const kind = classifyScopeChange(previous, next)
        if (kind === 'unchanged') throw new ContextReclassificationError('unchanged')
        if (
          kind === 'widening'
          && (
            (principal.role !== 'owner' && principal.role !== 'admin')
            || !input.confirmed
          )
        ) {
          throw new ContextReclassificationError('admin_confirmation_required')
        }

        await client.query(
          `UPDATE ${shape.table}
              SET compartments = $1::text[], project_ids = $2::uuid[]
            WHERE id::text = $3 AND workspace_id = $4`,
          [next.compartments, projectIds, input.rowId, input.workspaceId],
        )
        const audit = await client.query<{
          id: string
          createdAt: Date
        }>(
          `INSERT INTO context_scope_reclassification_events
             (workspace_id, primitive, row_id,
              previous_compartments, next_compartments,
              previous_project_ids, next_project_ids,
              actor_user_id, reason, widening)
           VALUES ($1, $2, $3, $4::text[], $5::text[], $6::uuid[], $7::uuid[],
                   $8, $9, $10)
           RETURNING id, created_at AS "createdAt"`,
          [
            input.workspaceId,
            input.primitive,
            input.rowId,
            previous.compartments,
            next.compartments,
            previous.projectIds,
            next.projectIds,
            userId,
            input.reason.trim(),
            kind === 'widening',
          ],
        )
        await client.query('COMMIT')
        return {
          id: audit.rows[0].id,
          workspaceId: input.workspaceId,
          primitive: input.primitive,
          rowId: input.rowId,
          previous,
          next,
          actorUserId: userId,
          reason: input.reason.trim(),
          kind,
          createdAt: audit.rows[0].createdAt.toISOString(),
        }
      } finally {
        await rollbackAndRelease(client)
      }
    },

    async getRequirements(userId, input) {
      const shape = RECLASSIFIABLE_ROWS[input.primitive]
      const result = await queryWithRLS<ContextRequirements>(
        userId,
        `SELECT r.compartments, r.project_ids AS "projectIds"
           FROM ${shape.table} r
           JOIN workspace_members wm
             ON wm.workspace_id = r.workspace_id AND wm.user_id = $2
          WHERE r.id::text = $1 AND r.workspace_id = $3
            AND sensitivity_rank(r.sensitivity) <= sensitivity_rank(
              CASE WHEN wm.role IN ('owner', 'admin') THEN 'confidential' ELSE wm.clearance END
            )
            AND (
              effective_member_team_compartments(wm.user_id, wm.workspace_id) IS NULL
              OR r.compartments <@ effective_member_team_compartments(wm.user_id, wm.workspace_id)
            )`,
        [input.rowId, userId, input.workspaceId],
      )
      return result.rows[0] ?? null
    },
  }
}
