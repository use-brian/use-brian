/**
 * The shared fixture set of permission model v2 (platform
 * docs/plans/permission-model-v2.md §4.1 and §7): principals × departments ×
 * tiers × lanes. The reference predicate, the SQL policy of migration 649 and
 * the store predicate are all run against these cases; `expected` is §4.1's
 * verdict. Identities are fictional; ids are fixed so a database run can seed
 * the same rows.
 */
import type { AccessSnapshot, Ctx, Edge, Principal, Reader, Row, Tier } from '../../reference-predicate.js'

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

export const WORKSPACE = id(0x100)
export const OTHER_WORKSPACE = id(0x101)

export const DEPARTMENTS = {
  platform: id(0xd01),
  finance: id(0xd02),
  sales: id(0xd03),
  board: id(0xd04), // hidden
} as const

const user = (n: number): Principal => ({ kind: 'user', id: id(n) })
const assistant = (n: number): Principal => ({ kind: 'assistant', id: id(n) })

export const PEOPLE = {
  ava: user(0xa01),   // workspace owner
  jun: user(0xa02),   // admin
  maya: user(0xa03),  // member
  priya: user(0xa04), // member
} as const
/** §4.1 lists no Sales owner; a database needs one (the creator is seeded as
 * owner), so a fictional sales lead who never reads in the matrix owns it. */
export const SALES_OWNER: Principal = user(0xa05)

export const ASSISTANTS = {
  brian: assistant(0xb01), // primary
  ops: assistant(0xb02),   // standard
} as const
export const ROLES: Record<keyof typeof PEOPLE, 'owner' | 'admin' | 'member'> = { ava: 'owner', jun: 'admin', maya: 'member', priya: 'member' }

/** Maya's Sales edge expires here; "on 11-02" in §4.1 is after it. */
export const SALES_EXPIRY = new Date('2026-10-31T00:00:00Z')
export const BEFORE_EXPIRY = new Date('2026-10-15T12:00:00Z')
export const AFTER_EXPIRY = new Date('2026-11-02T12:00:00Z')

const e = (principal: Principal, department: string, clearance: Tier, expiresAt: Date | null = null): Edge =>
  ({ principal, departmentId: department, clearance, expiresAt })

export const EDGES: Edge[] = [
  e(PEOPLE.ava, DEPARTMENTS.board, 'confidential'),
  e(PEOPLE.maya, DEPARTMENTS.platform, 'confidential'),
  e(PEOPLE.maya, DEPARTMENTS.finance, 'internal'),
  e(PEOPLE.maya, DEPARTMENTS.sales, 'internal', SALES_EXPIRY),
  e(PEOPLE.priya, DEPARTMENTS.finance, 'confidential'),
  e(SALES_OWNER, DEPARTMENTS.sales, 'confidential'),
  ...Object.values(DEPARTMENTS).map(d => e(ASSISTANTS.brian, d, 'confidential')),
  e(ASSISTANTS.ops, DEPARTMENTS.platform, 'confidential'),
  e(ASSISTANTS.ops, DEPARTMENTS.finance, 'internal'),
]

/** Department owners: each holds confidential in its department. */
export const OWNERS: { person: Principal; department: string }[] = [
  { person: PEOPLE.ava, department: DEPARTMENTS.board },
  { person: PEOPLE.maya, department: DEPARTMENTS.platform },
  { person: PEOPLE.priya, department: DEPARTMENTS.finance },
  { person: SALES_OWNER, department: DEPARTMENTS.sales },
]

export const BASE: Record<string, Tier> = {
  [`user:${PEOPLE.ava.id}`]: 'confidential',
  [`user:${PEOPLE.jun.id}`]: 'confidential',
  [`user:${PEOPLE.maya.id}`]: 'internal',
  [`user:${PEOPLE.priya.id}`]: 'internal',
  [`user:${SALES_OWNER.id}`]: 'internal',
  [`assistant:${ASSISTANTS.brian.id}`]: 'confidential',
  [`assistant:${ASSISTANTS.ops.id}`]: 'internal',
}

export const SNAPSHOT: AccessSnapshot = { workspaceId: WORKSPACE, edges: EDGES, base: BASE }

const row = (n: number, tier: Tier, departmentIds: string[], userId: string | null = null): Row =>
  ({ id: id(0xe00 + n), workspaceId: WORKSPACE, tier, departmentIds, userId })

export const ROWS = {
  r1: row(1, 'confidential', [DEPARTMENTS.platform]),
  r2: row(2, 'confidential', [DEPARTMENTS.finance]),
  r3: row(3, 'internal', [DEPARTMENTS.finance]),
  r4: row(4, 'internal', [DEPARTMENTS.platform, DEPARTMENTS.finance]),
  r5: row(5, 'confidential', []),
  r6: row(6, 'internal', [DEPARTMENTS.board]),
  /** A Sales page, granted to Maya by page grant. */
  salesPage: row(7, 'internal', [DEPARTMENTS.sales]),
  /** A confidential Sales page also granted to Maya (I9: base caps the grant). */
  salesSecretPage: row(8, 'confidential', [DEPARTMENTS.sales]),
  /** Private to Maya, General internal. */
  mayaPrivate: row(9, 'internal', [], PEOPLE.maya.id),
  /** Another workspace's row (workspace wall). */
  foreign: { id: id(0xe0a), workspaceId: OTHER_WORKSPACE, tier: 'public', departmentIds: [], userId: null } as Row,
} as const

export const PAGE_GRANTS = [
  { rowId: ROWS.salesPage.id, principal: PEOPLE.maya },
  { rowId: ROWS.salesSecretPage.id, principal: PEOPLE.maya },
]

const via = (person: keyof typeof PEOPLE, a: keyof typeof ASSISTANTS): Reader =>
  ({ principal: PEOPLE[person], assistant: ASSISTANTS[a], pageGrants: PAGE_GRANTS })
const ctx = (now = BEFORE_EXPIRY, department: string | null = null): Ctx => ({ workspaceId: WORKSPACE, department, now })

export type MatrixCase = { name: string; reader: Reader; row: Row; ctx: Ctx; expected: boolean }

/** Every row of the §4.1 case table, one fixture each. */
export const CASES_4_1: MatrixCase[] = [
  { name: 'R1 Maya via Brian: read', reader: via('maya', 'brian'), row: ROWS.r1, ctx: ctx(), expected: true },
  { name: 'R1 Jun via Brian: admin role grants no edge', reader: via('jun', 'brian'), row: ROWS.r1, ctx: ctx(), expected: false },
  { name: 'R2 Maya via Ops: min(internal, internal) < confidential', reader: via('maya', 'ops'), row: ROWS.r2, ctx: ctx(), expected: false },
  { name: 'R2 Priya via Ops: the assistant caps the owner', reader: via('priya', 'ops'), row: ROWS.r2, ctx: ctx(), expected: false },
  { name: 'R3 Maya via Ops: read', reader: via('maya', 'ops'), row: ROWS.r3, ctx: ctx(), expected: true },
  { name: 'R4 Maya via Brian: internal <= both cells', reader: via('maya', 'brian'), row: ROWS.r4, ctx: ctx(), expected: true },
  { name: 'R5 Maya via Brian: eff_base = min(internal, confidential)', reader: via('maya', 'brian'), row: ROWS.r5, ctx: ctx(), expected: false },
  { name: 'R5 Jun via Brian: General is where base applies', reader: via('jun', 'brian'), row: ROWS.r5, ctx: ctx(), expected: true },
  { name: 'R6 Ava via Brian: read', reader: via('ava', 'brian'), row: ROWS.r6, ctx: ctx(), expected: true },
  { name: 'R6 Ava via Ops: Ops has no Board edge', reader: via('ava', 'ops'), row: ROWS.r6, ctx: ctx(), expected: false },
  ...(['jun', 'maya', 'priya'] as const).flatMap(p => (['brian', 'ops'] as const).map(a => ({
    name: `R6 ${p} via ${a}: Board is hidden from non-members`, reader: via(p, a), row: ROWS.r6, ctx: ctx(), expected: false }))),
  { name: 'R6 a key Jun issued acting as Brian: credentials read with the issuer\'s edges',
    reader: { principal: PEOPLE.ava, assistant: ASSISTANTS.brian, credential: { issuerUserId: PEOPLE.jun.id, scope: 'read' } },
    row: ROWS.r6, ctx: ctx(), expected: false },
  { name: 'R3 with ctx.department = Sales, Maya: Finance not in ctx', reader: via('maya', 'brian'), row: ROWS.r3,
    ctx: ctx(BEFORE_EXPIRY, DEPARTMENTS.sales), expected: false },
  { name: 'a Sales page granted to Maya on 11-02, via Brian: grant stands in at base internal', reader: via('maya', 'brian'),
    row: ROWS.salesPage, ctx: ctx(AFTER_EXPIRY), expected: true },
  { name: 'same page via Ops: Ops has no Sales edge', reader: via('maya', 'ops'), row: ROWS.salesPage, ctx: ctx(AFTER_EXPIRY), expected: false },
]

/** I11: every lane that returns rows. Each is READ over its candidates. */
export const LANES = ['list', 'by-id', 'fts', 'vector', 'graph', 'file', 'page', 'count', 'provenance'] as const

export const ALL_READERS: Reader[] = (Object.keys(PEOPLE) as (keyof typeof PEOPLE)[])
  .flatMap(p => (Object.keys(ASSISTANTS) as (keyof typeof ASSISTANTS)[]).map(a => via(p, a)))

export const ALL_ROWS: Row[] = Object.values(ROWS)
export { ctx as fixtureCtx, via as fixtureReader }
