import { minSensitivity, RANK, type Sensitivity } from './sensitivity.js'

/**
 * A turn's resolved read authority under permission model v2: the per-
 * department `eff(P, A, D)` and `eff_base(P, A)` of the reference predicate
 * (`packages/api/src/context-scope/reference-predicate.ts`), evaluated once at
 * turn start. Present only for a workspace whose v2 read flag is on; the
 * legacy clearance / compartment axes are then neutral and this grant alone
 * decides department and tier.
 * Spec: docs/architecture/context-engine/scoped-context.md -> "Reference predicate (v2)".
 */
export type DepartmentReadGrant = {
  workspaceId: string
  /** The human P (the issuer under a credential); private rows match only P. */
  userId: string
  /** The assistant A whose edges cap P; null when no assistant acts. */
  assistantId: string | null
  /** eff_base(P, A): the ceiling for General rows. */
  base: Sensitivity
  /** eff(P, A, D) per department. A department absent here is `none`. */
  departments: Readonly<Record<string, Sensitivity>>
  /** ctx.department: a bound surface or session narrows reads to it plus General. */
  contextDepartment: string | null
  /** A credential's binding: every row department must be listed. */
  binding: readonly string[] | null
  /** A credential's cap, already folded into `base` and `departments`. */
  cap: Sensitivity | null
  /**
   * Shared Project admission (platform plan project-shared-spaces D16-D27):
   * `member` = the human and the acting assistant each hold an unexpired
   * roster edge; `oversight` = the human is the current workspace owner and
   * the acting assistant holds an edge (read only, never a write). A Project
   * absent here is not admitted, so an older grant without this field reads
   * no Project-labelled row.
   * Spec: docs/architecture/features/project-shared-spaces.md -> "The admission map".
   */
  projects?: Readonly<Record<string, ProjectAdmission>>
}

export type ProjectAdmission = 'member' | 'oversight'

/** A Project survives an intersection only on both sides, at the weaker level. */
export function intersectProjectAdmissions(
  a: Readonly<Record<string, ProjectAdmission>> | undefined,
  b: Readonly<Record<string, ProjectAdmission>> | undefined,
): Record<string, ProjectAdmission> {
  const result: Record<string, ProjectAdmission> = {}
  for (const [id, level] of Object.entries(a ?? {})) {
    const other = b?.[id]
    if (other) result[id] = level === 'member' && other === 'member' ? 'member' : 'oversight'
  }
  return result
}

/** Write authority never includes workspace-owner oversight (D27). */
export function mutationProjectAdmissions(grant: Pick<DepartmentReadGrant, 'projects'>): Record<string, ProjectAdmission> {
  return Object.fromEntries(Object.entries(grant.projects ?? {}).filter(([, level]) => level === 'member'))
}

/** A nested execution may only narrow: per-department min, base min, binding intersect. */
export function intersectDepartmentReadGrants(a: DepartmentReadGrant, b: DepartmentReadGrant): DepartmentReadGrant {
  if (a.workspaceId !== b.workspaceId || a.userId !== b.userId) throw new Error('access_actor_mismatch')
  const departments: Record<string, Sensitivity> = {}
  for (const [d, c] of Object.entries(a.departments)) {
    const other = b.departments[d]
    if (other) departments[d] = minSensitivity(c, other)
  }
  if (a.contextDepartment !== null && b.contextDepartment !== null && a.contextDepartment !== b.contextDepartment) {
    throw new Error('access_context_mismatch')
  }
  const binding = a.binding === null ? b.binding : b.binding === null ? a.binding : a.binding.filter(d => b.binding!.includes(d))
  const caps = [a.cap, b.cap].filter((c): c is Sensitivity => c !== null)
  return {
    workspaceId: a.workspaceId,
    userId: a.userId,
    assistantId: a.assistantId ?? b.assistantId,
    base: minSensitivity(a.base, b.base),
    departments,
    contextDepartment: a.contextDepartment ?? b.contextDepartment,
    binding: binding === null ? null : [...binding].sort(),
    cap: caps.length === 0 ? null : caps.reduce((low, c) => (RANK[c] < RANK[low] ? c : low)),
    ...(a.projects === undefined && b.projects === undefined ? {} : { projects: intersectProjectAdmissions(a.projects, b.projects) }),
  }
}

/**
 * The JSON map the shared SQL row function `department_row_allows` reads, for
 * one workspace: `{ "<workspaceId>": { b, d, c, k, u, p, o } }` with ranks
 * public=1 / internal=2 / confidential=3, `p` the admitted Project ids and `o`
 * the read-only oversight Project ids. RLS builds the same shape in SQL from
 * the edges; the store predicate builds it here from the resolved grant. A
 * mutation drops `o` (D27: oversight is never write authority).
 */
export function departmentReadGrantJson(grant: DepartmentReadGrant, operation: 'read' | 'mutation' = 'read'): string {
  const d: Record<string, number> = {}
  for (const [id, c] of Object.entries(grant.departments)) d[id] = RANK[c]
  const p: string[] = [], o: string[] = []
  for (const [id, level] of Object.entries(grant.projects ?? {})) {
    if (level === 'member') p.push(id)
    else if (operation === 'read') o.push(id)
  }
  return JSON.stringify({ [grant.workspaceId]: {
    b: RANK[grant.base], d, c: grant.contextDepartment, k: grant.binding, u: grant.userId, p: p.sort(), o: o.sort(),
  } })
}
