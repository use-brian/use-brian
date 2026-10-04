/**
 * The turn resolver's permission model v2 path. For a workspace whose
 * `department_read_v2` flag is on, a turn's read authority is computed from
 * department edges and base clearances alone, through the reference
 * predicate's `eff` / `effBase`. Nothing else is an input: no role universe,
 * read bundle, read grant, manager, access mode, classification mode, Team
 * scope mode or readiness constant.
 * Spec: docs/architecture/context-engine/scoped-context.md -> "Reference predicate (v2)".
 */
import type { DepartmentReadGrant, Sensitivity } from '@use-brian/core'
import { ANONYMOUS, eff, effBase, type AccessSnapshot, type Edge, type Principal, type Reader, type Tier } from './reference-predicate.js'

type Query = <R>(sql: string, values: unknown[]) => Promise<{ rows: R[] }>

export type DepartmentReadInput = {
  workspaceId: string
  /** The human P; under a credential, its issuer. */
  userId: string
  /** The acting assistant A, or null when a person reads the app directly. */
  assistantId: string | null
  contextDepartment?: string | null
  credential?: { cap?: Tier | null; binding?: readonly string[] | null } | null
}

/**
 * Loads everything §4 needs for one (P, A) pair: their edges in the workspace
 * and their base clearances. A person who is not a workspace member is the
 * anonymous principal (no edges, base public).
 */
export async function loadDepartmentSnapshot(query: Query, input: DepartmentReadInput): Promise<{ snapshot: AccessSnapshot; principal: Principal }> {
  const member = (await query<{ role: string; clearance: Tier }>(
    'SELECT role, clearance FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [input.workspaceId, input.userId])).rows[0]
  const principal: Principal = member ? { kind: 'user', id: input.userId } : ANONYMOUS
  const base: Record<string, Tier> = {}
  // §3: owner and admin bases are confidential; everyone else's is set by governance.
  if (member) base[`user:${input.userId}`] = member.role === 'owner' || member.role === 'admin' ? 'confidential' : member.clearance
  if (input.assistantId) {
    const assistant = (await query<{ clearance: Tier }>(
      'SELECT clearance FROM assistants WHERE id = $1 AND workspace_id = $2 AND public.assistant_placement_visible($3, id)', [input.assistantId, input.workspaceId, input.userId])).rows[0]
    // An assistant outside the workspace is not a reader of it.
    if (!assistant) throw new Error('authority_unavailable')
    base[`assistant:${input.assistantId}`] = assistant.clearance
  }
  const rows = (await query<{ kind: 'user' | 'assistant'; id: string; departmentId: string; clearance: Tier; expiresAt: Date | null }>(
    `SELECT principal_kind AS kind, coalesce(user_id, assistant_id) AS id, department_id AS "departmentId",
            clearance, expires_at AS "expiresAt"
       FROM department_edges
      WHERE workspace_id = $1 AND ((user_id = $2 AND $4::boolean) OR assistant_id = $3)`,
    [input.workspaceId, input.userId, input.assistantId, member !== undefined])).rows
  const edges: Edge[] = rows.map(r => ({ principal: { kind: r.kind, id: r.id }, departmentId: r.departmentId,
    clearance: r.clearance, expiresAt: r.expiresAt }))
  return { snapshot: { workspaceId: input.workspaceId, edges, base }, principal }
}

/** eff and eff_base for every department P holds an edge in, evaluated at `now`. */
export function resolveDepartmentReadGrant(snapshot: AccessSnapshot, principal: Principal, input: DepartmentReadInput, now: Date): DepartmentReadGrant {
  const assistant: Principal | null = input.assistantId ? { kind: 'assistant', id: input.assistantId } : null
  const cap = input.credential?.cap ?? null
  const reader: Reader = { principal, assistant, credential: null }
  // A credential cap folds into every clearance; the binding stays separate.
  const capped = (c: Sensitivity | null): Sensitivity | null => {
    if (c === null) return null
    if (cap === null) return c
    const order = ['public', 'internal', 'confidential'] as const
    return order[Math.min(order.indexOf(c), order.indexOf(cap))]
  }
  const departments: Record<string, Sensitivity> = {}
  for (const d of new Set(snapshot.edges.filter(e => e.principal.kind === principal.kind && e.principal.id === principal.id).map(e => e.departmentId))) {
    const c = capped(eff(snapshot, reader, d, now))
    if (c) departments[d] = c
  }
  return {
    workspaceId: input.workspaceId,
    userId: input.userId,
    assistantId: input.assistantId,
    base: capped(effBase(snapshot, reader))!,
    departments,
    contextDepartment: input.contextDepartment ?? null,
    binding: input.credential?.binding ? [...input.credential.binding].sort() : null,
    cap,
  }
}
