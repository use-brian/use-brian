/**
 * Append-only audit for canonical scope changes. Domain writers own the row
 * mutation; this store records the before/after boundary in the same service
 * transaction once the writer succeeds.
 *
 * [COMP:brain/context-reclassification]
 */

import { queryWithRLS } from './client.js'

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
  }
}
