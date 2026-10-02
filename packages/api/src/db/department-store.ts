/**
 * Department owners and membership edges (permission model v2, Phase 1).
 * Spec: docs/architecture/features/workspace-access.md -> "Department edges (v2)";
 * platform docs/plans/permission-model-v2.md §3-§5, §12.4 item 1.
 *
 * Every mutation is one call into an actor-bound SQL function from migration
 * 648 on the RLS-enforced app connection. The function locks workspace then
 * department, rechecks the actor's ownership inside the transaction, refuses a
 * stale revision and treats a repeat of the current state as success (I17).
 * No live read path consumes these edges until the Phase 2 flag flips.
 */
import type { PoolClient } from 'pg'
import { applyRLSGucs, getAppPool, rollbackAndRelease } from './client.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'

export type DepartmentClearance = 'public' | 'internal' | 'confidential'
export type DepartmentPrincipal = { kind: 'user' | 'assistant'; id: string }
export type DepartmentEdge = {
  departmentId: string
  principal: DepartmentPrincipal
  clearance: DepartmentClearance
  expiresAt: Date | null
  origin: string
}

const ERRORS: Record<string, number> = {
  department_not_found: 404,
  department_owner_required: 403,
  department_break_glass_owner_only: 403,
  department_clearance_above_own: 403,
  department_principal_not_in_workspace: 400,
  department_principal_invalid: 400,
  department_clearance_invalid: 400,
  department_expiry_invalid: 400,
  department_break_glass_reason_required: 400,
  department_revision_stale: 409,
  department_last_owner: 409,
  department_owner_edge_required: 409,
  department_actor_required: 401,
  department_home_not_allowed: 403,
  department_home_requires_edge: 409,
  department_primary_assistant: 409,
  department_access_via_grant: 409,
}

async function asActor<T>(actor: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client, actor)
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    const message = (error as Error).message
    if (message in ERRORS) throw new WorkspaceAccessError(message, ERRORS[message])
    throw error
  } finally {
    await rollbackAndRelease(client)
  }
}

const revisionOf = (rows: { revision: string }[]) => Number(rows[0].revision)

export function createDepartmentStore() {
  return {
    /** Add a principal to a department or change its clearance or expiry. */
    async setEdge(actor: string, departmentId: string, principal: DepartmentPrincipal, clearance: DepartmentClearance,
      expiresAt: Date | null, expectedRevision?: number): Promise<number> {
      return asActor(actor, async (client) => revisionOf((await client.query<{ revision: string }>(
        'SELECT public.department_set_edge($1,$2,$3,$4,$5,$6) AS revision',
        [departmentId, principal.kind, principal.id, clearance, expiresAt, expectedRevision ?? null])).rows))
    },
    async removeEdge(actor: string, departmentId: string, principal: DepartmentPrincipal, expectedRevision?: number): Promise<number> {
      return asActor(actor, async (client) => revisionOf((await client.query<{ revision: string }>(
        'SELECT public.department_remove_edge($1,$2,$3,$4) AS revision',
        [departmentId, principal.kind, principal.id, expectedRevision ?? null])).rows))
    },
    async addOwner(actor: string, departmentId: string, userId: string, expectedRevision?: number): Promise<number> {
      return asActor(actor, async (client) => revisionOf((await client.query<{ revision: string }>(
        'SELECT public.department_add_owner($1,$2,$3) AS revision', [departmentId, userId, expectedRevision ?? null])).rows))
    },
    async removeOwner(actor: string, departmentId: string, userId: string, expectedRevision?: number): Promise<number> {
      return asActor(actor, async (client) => revisionOf((await client.query<{ revision: string }>(
        'SELECT public.department_remove_owner($1,$2,$3) AS revision', [departmentId, userId, expectedRevision ?? null])).rows))
    },
    /** Workspace owner only; audited where the department's members can see it. */
    async breakGlass(actor: string, departmentId: string, reason: string): Promise<number> {
      return asActor(actor, async (client) => revisionOf((await client.query<{ revision: string }>(
        'SELECT public.department_break_glass($1,$2) AS revision', [departmentId, reason])).rows))
    },
    /** The department's roster as its member sees it (empty for a non-member). */
    async listEdges(actor: string, departmentId: string): Promise<DepartmentEdge[]> {
      return asActor(actor, async (client) => (await client.query<{
        departmentId: string; kind: 'user' | 'assistant'; id: string; clearance: DepartmentClearance; expiresAt: Date | null; origin: string
      }>(`SELECT department_id AS "departmentId", principal_kind AS kind, coalesce(user_id, assistant_id) AS id,
                 clearance, expires_at AS "expiresAt", origin
            FROM department_edges
           WHERE department_id = $1 AND (expires_at IS NULL OR expires_at > clock_timestamp())
           ORDER BY principal_kind, coalesce(user_id, assistant_id)`, [departmentId])).rows
        .map(row => ({ departmentId: row.departmentId, principal: { kind: row.kind, id: row.id },
          clearance: row.clearance, expiresAt: row.expiresAt, origin: row.origin })))
    },
    /** Departments the caller may see (D25, P4, I2): their own, plus name and owners of all for the workspace owner. */
    async directory(actor: string, workspaceId: string): Promise<DepartmentDirectoryEntry[]> {
      return asActor(actor, async (client) => (await client.query<{
        departmentId: string; name: string; status: 'active' | 'archived'; revision: string; myClearance: DepartmentClearance | null; isOwner: boolean; ownerIds: string[]
      }>(`SELECT department_id AS "departmentId", name, status, revision::text, my_clearance AS "myClearance",
                 is_owner AS "isOwner", owner_ids AS "ownerIds" FROM public.department_directory($1)`, [workspaceId])).rows
        .map(r => ({ ...r, revision: Number(r.revision) })))
    },
    /** D24: set or clear (null) a person's or assistant's home department. */
    async setHome(actor: string, workspaceId: string, principal: DepartmentPrincipal, departmentId: string | null): Promise<void> {
      await asActor(actor, async (client) => {
        await client.query('SELECT public.department_set_home($1,$2,$3,$4)', [workspaceId, principal.kind, principal.id, departmentId])
      })
    },
    /** The caller's and their workspace assistants' homes (only principals the caller may see). */
    async homes(actor: string, workspaceId: string): Promise<{ principal: DepartmentPrincipal; departmentId: string | null }[]> {
      return asActor(actor, async (client) => {
        const me = (await client.query<{ home: string | null }>(
          'SELECT home_department_id AS home FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, actor])).rows[0]
        const assistants = (await client.query<{ id: string; home: string | null }>(
          'SELECT id, home_department_id AS home FROM assistants WHERE workspace_id=$1 ORDER BY id', [workspaceId])).rows
        return [
          ...(me ? [{ principal: { kind: 'user' as const, id: actor }, departmentId: me.home }] : []),
          ...assistants.map(a => ({ principal: { kind: 'assistant' as const, id: a.id }, departmentId: a.home })),
        ]
      })
    },
    /** True when the department belongs to the workspace (route parameter check; reveals nothing else). */
    async inWorkspace(actor: string, workspaceId: string, departmentId: string): Promise<boolean> {
      return (await this.directory(actor, workspaceId)).some(d => d.departmentId === departmentId)
    },
    /** clearance_in(P, D) of the reference predicate: expired is absent (I6).
     * Read under RLS, so a non-member learns nothing about D (I2). */
    async clearanceIn(actor: string, principal: DepartmentPrincipal, departmentId: string): Promise<DepartmentClearance | null> {
      return asActor(actor, async (client) => (await client.query<{ clearance: DepartmentClearance }>(
        `SELECT clearance FROM department_edges
          WHERE department_id = $1 AND principal_kind = $2 AND coalesce(user_id, assistant_id) = $3
            AND (expires_at IS NULL OR expires_at > clock_timestamp())`,
        [departmentId, principal.kind, principal.id])).rows[0]?.clearance ?? null)
    },
  }
}

export type DepartmentStore = ReturnType<typeof createDepartmentStore>

export type DepartmentDirectoryEntry = {
  departmentId: string
  name: string
  status: 'active' | 'archived'
  revision: number
  /** The caller's own clearance in it; null when only the workspace owner's governance view shows it. */
  myClearance: DepartmentClearance | null
  isOwner: boolean
  ownerIds: string[]
}
