/**
 * The turn resolver's permission model v2 path. For a workspace whose
 * `department_read_v2` flag is on, a turn's read authority is computed from
 * department edges and base clearances alone, through the reference
 * predicate's `eff` / `effBase`. Nothing else is an input: no role universe,
 * read bundle, read grant, manager, access mode, classification mode, Team
 * scope mode or readiness constant.
 * Spec: docs/architecture/context-engine/scoped-context.md -> "Reference predicate (v2)".
 */
import {z} from 'zod'
import type { DepartmentReadGrant } from '@use-brian/agent-runtime/security/department-read.js'
import type { Sensitivity } from '@use-brian/agent-runtime/security/sensitivity.js'
import { ANONYMOUS, eff, effBase, projectAdmission, type AccessSnapshot, type Edge, type Principal, type ProjectEdge, type Reader, type Tier } from './reference-predicate.js'

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
const tier = z.enum(['public', 'internal', 'confidential'])
const principalEdge = z.object({ kind: z.enum(['user', 'assistant']), id: z.string().uuid(),
  expiresAt: z.coerce.date().nullable() }).strict()
const departmentSnapshot = z.object({
  member: z.object({ role: z.string(), clearance: tier }).strict().nullable(),
  assistant: z.object({ clearance: tier }).strict().nullable(),
  edges: z.array(principalEdge.extend({ departmentId: z.string().uuid(), clearance: tier })),
  activeProjects: z.array(z.string().uuid()),
  projectEdges: z.array(principalEdge.extend({ projectId: z.string().uuid() })),
}).strict()

/** Shared statement fragment: each consumer still executes a new snapshot. */
export const departmentSnapshotSql = 'SELECT read_session_department_facts($1,$2,$3) AS snapshot'

export async function loadDepartmentSnapshot(query: Query, input: DepartmentReadInput): Promise<{ snapshot: AccessSnapshot; principal: Principal }> {
  const result = await query<{ snapshot: unknown }>(departmentSnapshotSql, [input.workspaceId, input.userId, input.assistantId])
  if (result.rows.length !== 1) throw new Error('authority_unavailable')
  return decodeDepartmentSnapshot(input, result.rows[0].snapshot)
}

/** Applies the same reference-predicate inputs to a freshly acquired fact tuple. */
export function decodeDepartmentSnapshot(input: DepartmentReadInput, raw: unknown): { snapshot: AccessSnapshot; principal: Principal } {
  const loaded = departmentSnapshot.parse(raw)
  const { member, assistant } = loaded
  const principal: Principal = member ? { kind: 'user', id: input.userId } : ANONYMOUS
  const base: Record<string, Tier> = {}
  // §3: owner and admin bases are confidential; everyone else's is set by governance.
  if (member) base[`user:${input.userId}`] = member.role === 'owner' || member.role === 'admin' ? 'confidential' : member.clearance
  if (input.assistantId) {
    // An absent or invisible assistant cannot act as a reader.
    if (!assistant) throw new Error('authority_unavailable')
    base[`assistant:${input.assistantId}`] = assistant.clearance
  }
  const edges: Edge[] = loaded.edges.map(r => ({ principal: { kind: r.kind, id: r.id }, departmentId: r.departmentId,
    clearance: r.clearance, expiresAt: r.expiresAt }))
  const projectEdges: ProjectEdge[] = loaded.projectEdges.map(r => ({ principal: { kind: r.kind, id: r.id }, projectId: r.projectId, expiresAt: r.expiresAt }))
  return { snapshot: { workspaceId: input.workspaceId, edges, base, projectEdges,
    activeProjects: loaded.activeProjects,
    workspaceOwners: member?.role === 'owner' ? [input.userId] : [] }, principal }
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
  const projects: Record<string, 'member' | 'oversight'> = {}
  for (const projectId of snapshot.activeProjects ?? []) {
    const admission = projectAdmission(snapshot, reader, projectId, now)
    if (admission) projects[projectId] = admission
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
    ...(Object.keys(projects).length ? { projects } : {}),
  }
}
