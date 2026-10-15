/**
 * The reference READ / WRITE of permission model v2 (platform
 * docs/plans/permission-model-v2.md §4). Pure functions over an in-memory
 * snapshot: no database, no clock, no I/O. RLS (migration 649), the store
 * predicate and the turn resolver are tested against this module on the shared
 * fixture set (`__tests__/fixtures/access-matrix.ts`), and
 * `invariants/read-predicate-parity` fails on any divergence (P10, I10).
 *
 * If a caller seems to need its own branch of the rule, this module is
 * incomplete: extend it and the fixture set, never the caller.
 * Spec: docs/architecture/context-engine/scoped-context.md -> "Reference predicate (v2)".
 */

export type Tier = 'public' | 'internal' | 'confidential'
const RANK: Record<Tier, number> = { public: 1, internal: 2, confidential: 3 }
/** `none` of §4: no edge. Below every tier, so no row is readable at it. */
export type Clearance = Tier | null
const rank = (c: Clearance): number => (c ? RANK[c] : 0)
const minClearance = (...values: Clearance[]): Clearance =>
  values.reduce<Clearance>((low, v) => (rank(v) < rank(low) ? v : low), 'confidential')
const maxTier = (values: Tier[]): Tier =>
  values.reduce<Tier>((high, v) => (RANK[v] > RANK[high] ? v : high), 'public')

export type PrincipalKind = 'user' | 'assistant' | 'anonymous'
export type Principal = { kind: PrincipalKind; id: string }
export const ANONYMOUS: Principal = { kind: 'anonymous', id: 'anonymous' }

export type Edge = {
  principal: Principal
  departmentId: string
  clearance: Tier
  /** NULL = never. Expired means absent (I6). */
  expiresAt: Date | null
}

/** A shared Project roster edge (project-shared-spaces.md -> "Roster"). No clearance (D22). */
export type ProjectEdge = {
  principal: Principal
  projectId: string
  /** NULL = never. Expired means absent. */
  expiresAt: Date | null
}

/** Everything §4 reads, captured once at turn start. */
export type AccessSnapshot = {
  workspaceId: string
  edges: readonly Edge[]
  /** Base clearance per principal key (`kind:id`); anonymous is always public. */
  base: Readonly<Record<string, Tier>>
  /** Shared Project roster edges of the loaded principals. */
  projectEdges?: readonly ProjectEdge[]
  /** Active shared scopes, empty while the workspace capability is off. */
  activeProjects?: readonly string[]
  /** Current workspace owners among the loaded humans (D26/D27 oversight). */
  workspaceOwners?: readonly string[]
}

export type Row = {
  id: string
  workspaceId: string
  tier: Tier
  /** Empty = General. All-of semantics: every listed department must admit. */
  departmentIds: readonly string[]
  /** Set = private to that user (D11). */
  userId: string | null
  /** Shared Project requirements (`project:<id>` labels). All-of; membership gates, no tier. */
  projectScopeIds?: readonly string[]
}

/** A key, chat link or other issued credential (§3, D13, K2). */
export type Credential = {
  issuerUserId: string
  cap?: Tier | null
  /** NULL = unrestricted; otherwise every row department must be listed. */
  binding?: readonly string[] | null
  scope: 'read' | 'read_write'
}

/** Per-page exception: the grantee reads that one row at their base clearance (§3). */
export type PageGrant = { rowId: string; principal: Principal }

export type Reader = {
  /** The human (or anonymous visitor). Replaced by the issuer under a credential. */
  principal: Principal
  /** NULL when no assistant acts (a person in the app directly): identity in min(). */
  assistant: Principal | null
  credential?: Credential | null
  pageGrants?: readonly PageGrant[]
}

export type Ctx = {
  workspaceId: string
  /** The department the session or surface is bound to; NULL = none. */
  department: string | null
  now: Date
  /** A mutation never uses workspace-owner oversight (D27). Default read. */
  operation?: 'read' | 'mutation'
}

export type Denial =
  | 'workspace' | 'private' | 'tier_general' | 'tier_department' | 'context' | 'binding' | 'scope' | 'project'

export type ProjectAdmission = 'member' | 'oversight'

const key = (p: Principal) => `${p.kind}:${p.id}`

/** clearance_in(P, D): an unexpired edge's clearance, else none. No role exception. */
export function clearanceIn(snapshot: AccessSnapshot, principal: Principal, departmentId: string, now: Date): Clearance {
  if (principal.kind === 'anonymous') return null
  const edge = snapshot.edges.find(e => e.departmentId === departmentId
    && e.principal.kind === principal.kind && e.principal.id === principal.id
    && (e.expiresAt === null || e.expiresAt.getTime() > now.getTime()))
  return edge ? edge.clearance : null
}

export function baseClearance(snapshot: AccessSnapshot, principal: Principal): Tier {
  if (principal.kind === 'anonymous') return 'public'
  return snapshot.base[key(principal)] ?? 'public'
}

/** Under a credential, P := its issuer. */
function human(reader: Reader): Principal {
  return reader.credential ? { kind: 'user', id: reader.credential.issuerUserId } : reader.principal
}

/** An unexpired shared Project roster edge for the principal. */
export function projectMember(snapshot: AccessSnapshot, principal: Principal, projectId: string, now: Date): boolean {
  if (principal.kind === 'anonymous') return false
  return (snapshot.projectEdges ?? []).some(e => e.projectId === projectId
    && e.principal.kind === principal.kind && e.principal.id === principal.id
    && (e.expiresAt === null || e.expiresAt.getTime() > now.getTime()))
}

/**
 * Project admission of (P, A) for one shared Project: `member` when both hold
 * an edge, `oversight` when P is the current workspace owner without an edge
 * and A (if acting) holds one, else null. Inactive scopes (capability off,
 * quarantined) admit nobody. A page grant never stands in for it.
 */
export function projectAdmission(snapshot: AccessSnapshot, reader: Reader, projectId: string, now: Date): ProjectAdmission | null {
  if (!(snapshot.activeProjects ?? []).includes(projectId)) return null
  const p = human(reader)
  if (reader.assistant && !projectMember(snapshot, reader.assistant, projectId, now)) return null
  if (projectMember(snapshot, p, projectId, now)) return 'member'
  if (p.kind === 'user' && (snapshot.workspaceOwners ?? []).includes(p.id)) return 'oversight'
  return null
}

/** eff(P, A, D) = min(clearance_in(P, D), clearance_in(A, D) [, cap]). */
export function eff(snapshot: AccessSnapshot, reader: Reader, departmentId: string, now: Date, row?: Row): Clearance {
  const p = human(reader)
  const grantStandsIn = row !== undefined && (reader.pageGrants ?? [])
    .some(g => g.rowId === row.id && g.principal.kind === p.kind && g.principal.id === p.id)
  // page_grant(R, P): for that one row, clearance_in(P, D) := P.base.
  const pIn = grantStandsIn ? baseClearance(snapshot, p) : clearanceIn(snapshot, p, departmentId, now)
  const aIn = reader.assistant ? clearanceIn(snapshot, reader.assistant, departmentId, now) : 'confidential'
  return minClearance(pIn, aIn, reader.credential?.cap ?? 'confidential')
}

/** eff_base(P, A) = min(P.base, A.base [, cap]). */
export function effBase(snapshot: AccessSnapshot, reader: Reader): Tier {
  return minClearance(baseClearance(snapshot, human(reader)), reader.assistant ? baseClearance(snapshot, reader.assistant) : 'confidential',
    reader.credential?.cap ?? 'confidential') as Tier
}

/** READ(P, A, R, ctx) of §4, with the clause that denied it. */
export function explainRead(snapshot: AccessSnapshot, reader: Reader, row: Row, ctx: Ctx): { allowed: true } | { allowed: false; denial: Denial } {
  const p = human(reader)
  if (row.workspaceId !== ctx.workspaceId || snapshot.workspaceId !== ctx.workspaceId) return { allowed: false, denial: 'workspace' }
  if (row.userId !== null && !(p.kind === 'user' && p.id === row.userId)) return { allowed: false, denial: 'private' }
  if (row.departmentIds.length === 0) {
    if (RANK[row.tier] > RANK[effBase(snapshot, reader)]) return { allowed: false, denial: 'tier_general' }
  } else {
    for (const d of row.departmentIds) {
      if (RANK[row.tier] > rank(eff(snapshot, reader, d, ctx.now, row))) return { allowed: false, denial: 'tier_department' }
    }
  }
  for (const projectId of row.projectScopeIds ?? []) {
    const admission = projectAdmission(snapshot, reader, projectId, ctx.now)
    if (admission === null || (admission === 'oversight' && ctx.operation === 'mutation')) return { allowed: false, denial: 'project' }
  }
  if (ctx.department !== null && row.departmentIds.length > 0 && !row.departmentIds.includes(ctx.department)) {
    return { allowed: false, denial: 'context' }
  }
  const binding = reader.credential?.binding
  if (binding && !row.departmentIds.every(d => binding.includes(d))) return { allowed: false, denial: 'binding' }
  if (binding && !(row.projectScopeIds ?? []).every(id => binding.includes(id))) return { allowed: false, denial: 'binding' }
  return { allowed: true }
}

export function read(snapshot: AccessSnapshot, reader: Reader, row: Row, ctx: Ctx): boolean {
  return explainRead(snapshot, reader, row, ctx).allowed
}

/** Every retrieval lane (I11) is READ over its candidate rows; a count or a
 * provenance list never sees a row READ refuses. */
export function readable<R extends Row>(snapshot: AccessSnapshot, reader: Reader, rows: readonly R[], ctx: Ctx): R[] {
  return rows.filter(row => read(snapshot, reader, row, ctx))
}

export type WriteResult =
  | { allowed: true; row: Omit<Row, 'id'> }
  | { allowed: false; denial: Denial; row: Omit<Row, 'id'> }

/**
 * WRITE(P, A, R_new, ctx) of §4. The new row is stamped with ctx.department
 * and the union of every source actually read this turn (I12); when that is
 * empty, with the writer's home department (D24) unless a person explicitly
 * chose General, at the max of the requested tier and every source tier, and
 * must be readable by the assistant's clearances alone (the write ceiling).
 */
export function write(snapshot: AccessSnapshot, reader: Reader, input: {
  requestedTier: Tier
  /** Every row actually read this turn that the new row derives from. */
  sources: readonly Row[]
  userId?: string | null
  /** The writer's home department (D24): where a write naming no department lands. */
  homeDepartment?: string | null
  /** A person explicitly chose General: the home does not apply. */
  explicitGeneral?: boolean
  /** A chosen shared Project destination: an explicit choice, so the home does not apply either. */
  destinationProject?: string | null
}, ctx: Ctx): WriteResult {
  const departments = new Set<string>(ctx.department ? [ctx.department] : [])
  for (const s of input.sources) for (const d of s.departmentIds) departments.add(d)
  const projects = new Set<string>(input.destinationProject ? [input.destinationProject] : [])
  for (const s of input.sources) for (const id of s.projectScopeIds ?? []) projects.add(id)
  if (departments.size === 0 && projects.size === 0 && input.homeDepartment && !input.explicitGeneral) departments.add(input.homeDepartment)
  const row: Omit<Row, 'id'> = {
    workspaceId: ctx.workspaceId,
    tier: maxTier([input.requestedTier, ...input.sources.map(s => s.tier)]),
    departmentIds: [...departments].sort(),
    userId: input.userId ?? null,
    ...(projects.size ? { projectScopeIds: [...projects].sort() } : {}),
  }
  const credential = reader.credential ?? null
  if (credential && credential.scope !== 'read_write') return { allowed: false, denial: 'scope', row }
  // READ(P, A, R_new, ctx) evaluated with A's clearances only: the write
  // ceiling is the assistant's, still lowered by a credential cap and bound.
  // With no assistant acting, the person is the writer and their own ceiling.
  const writer = reader.assistant ?? human(reader)
  const cap = credential?.cap ?? 'confidential'
  if (row.workspaceId !== snapshot.workspaceId) return { allowed: false, denial: 'workspace', row }
  if (row.departmentIds.length === 0) {
    if (RANK[row.tier] > rank(minClearance(baseClearance(snapshot, writer), cap))) return { allowed: false, denial: 'tier_general', row }
  } else {
    for (const d of row.departmentIds) {
      if (RANK[row.tier] > rank(minClearance(clearanceIn(snapshot, writer, d, ctx.now), cap))) {
        return { allowed: false, denial: 'tier_department', row }
      }
    }
  }
  if (credential?.binding && !row.departmentIds.every(d => credential.binding!.includes(d))) return { allowed: false, denial: 'binding', row }
  // A shared Project write needs membership of the writer and of the person
  // (oversight never writes, D27); a bound credential must name the Project.
  for (const projectId of row.projectScopeIds ?? []) {
    if (!(snapshot.activeProjects ?? []).includes(projectId)
      || !projectMember(snapshot, writer, projectId, ctx.now)
      || !projectMember(snapshot, human(reader), projectId, ctx.now)) return { allowed: false, denial: 'project', row }
    if (credential?.binding && !credential.binding.includes(projectId)) return { allowed: false, denial: 'binding', row }
  }
  return { allowed: true, row }
}

/**
 * An update, successor or dedup may add departments and raise the tier, never
 * remove a department or lower the tier (I13).
 */
export function updatePreservesFloor(before: Pick<Row, 'tier' | 'departmentIds' | 'projectScopeIds'>, after: Pick<Row, 'tier' | 'departmentIds' | 'projectScopeIds'>): boolean {
  return RANK[after.tier] >= RANK[before.tier] && before.departmentIds.every(d => after.departmentIds.includes(d))
    && (before.projectScopeIds ?? []).every(id => (after.projectScopeIds ?? []).includes(id))
}

/** Split a requirement array into Department and shared Project ids; null on any other label. */
export function splitScopeLabels(labels: readonly string[]): { departmentIds: string[]; projectScopeIds: string[] } | null {
  const departmentIds: string[] = [], projectScopeIds: string[] = []
  for (const label of labels) {
    if (label.startsWith('team:')) departmentIds.push(label.slice(5))
    else if (label.startsWith('project:')) projectScopeIds.push(label.slice(8))
    else return null
  }
  return { departmentIds, projectScopeIds }
}
