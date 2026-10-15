/**
 * Shared Project fixtures (platform docs/plans/project-shared-spaces-implementation.md
 * §10 foundation rows), layered on the permission model v2 access matrix so
 * Department edges, bases and assistants are the same principals. The
 * reference predicate, RLS and the store predicate run these cases; the
 * expectation is the plan's verdict. Identities are fictional.
 */
import type { AccessSnapshot, Ctx, ProjectEdge, Reader, Row, Tier } from '../../reference-predicate.js'
import { ASSISTANTS, BEFORE_EXPIRY, AFTER_EXPIRY, DEPARTMENTS, PEOPLE, SALES_EXPIRY, SALES_OWNER, SNAPSHOT, WORKSPACE } from './access-matrix.js'

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

export const PROJECTS = {
  atlas: id(0xf01),     // shared, active
  beacon: id(0xf02),    // shared, active
  quarantined: id(0xf03), // shared, quarantined: unavailable to everyone
  legacy: id(0xf04),    // focus-only, no scope
} as const

const edge = (principal: ProjectEdge['principal'], projectId: string, expiresAt: Date | null = null): ProjectEdge =>
  ({ principal, projectId, expiresAt })

/** Atlas: Maya (owner), Priya (until the Sales expiry), the Sales lead, Brian. Beacon: Maya, Brian, Ops. */
export const PROJECT_EDGES: ProjectEdge[] = [
  edge(PEOPLE.maya, PROJECTS.atlas),
  edge(PEOPLE.priya, PROJECTS.atlas, SALES_EXPIRY),
  edge(SALES_OWNER, PROJECTS.atlas),
  edge(ASSISTANTS.brian, PROJECTS.atlas),
  edge(PEOPLE.maya, PROJECTS.beacon),
  edge(ASSISTANTS.brian, PROJECTS.beacon),
  edge(ASSISTANTS.ops, PROJECTS.beacon),
  edge(PEOPLE.maya, PROJECTS.quarantined),
  edge(ASSISTANTS.brian, PROJECTS.quarantined),
]

export const PROJECT_OWNERS = [
  { person: PEOPLE.maya, project: PROJECTS.atlas },
  { person: PEOPLE.maya, project: PROJECTS.beacon },
  { person: PEOPLE.maya, project: PROJECTS.quarantined },
]

/** Ava is the workspace owner (D26/D27 oversight). */
export const PROJECT_SNAPSHOT: AccessSnapshot = {
  ...SNAPSHOT,
  projectEdges: PROJECT_EDGES,
  activeProjects: [PROJECTS.atlas, PROJECTS.beacon],
  workspaceOwners: [PEOPLE.ava.id],
}

const row = (n: number, tier: Tier, departmentIds: string[], projectScopeIds: string[], userId: string | null = null): Row =>
  ({ id: id(0xf10 + n), workspaceId: WORKSPACE, tier, departmentIds, userId, projectScopeIds })

export const PROJECT_ROWS = {
  /** An ordinary internal working note in Atlas. */
  note: row(1, 'internal', [], [PROJECTS.atlas]),
  /** A Confidential General source derived into Atlas: the General base rule survives. */
  confidentialGeneral: row(2, 'confidential', [], [PROJECTS.atlas]),
  /** A Finance summary shared into Atlas: Finance AND Atlas. */
  financeSummary: row(3, 'internal', [DEPARTMENTS.finance], [PROJECTS.atlas]),
  /** A multi-Project derivation. */
  atlasBeacon: row(4, 'internal', [], [PROJECTS.atlas, PROJECTS.beacon]),
  /** A private Project-associated row of Maya's. */
  mayaPrivate: row(5, 'internal', [], [PROJECTS.atlas], PEOPLE.maya.id),
  /** Material of a quarantined scope. */
  quarantinedNote: row(6, 'internal', [], [PROJECTS.quarantined]),
  /** A Beacon note: relevance case (A and B both visible to Maya). */
  beaconNote: row(7, 'internal', [], [PROJECTS.beacon]),
} as const

export const ALL_PROJECT_ROWS: Row[] = Object.values(PROJECT_ROWS)

const via = (person: keyof typeof PEOPLE | 'sales', a: keyof typeof ASSISTANTS | null): Reader =>
  ({ principal: person === 'sales' ? SALES_OWNER : PEOPLE[person], assistant: a ? ASSISTANTS[a] : null })
const ctx = (now = BEFORE_EXPIRY, operation: 'read' | 'mutation' = 'read'): Ctx => ({ workspaceId: WORKSPACE, department: null, now, operation })

export type ProjectCase = { name: string; reader: Reader; row: Row; ctx: Ctx; expected: boolean }

export const PROJECT_CASES: ProjectCase[] = [
  { name: 'participant reads an ordinary shared note', reader: via('maya', 'brian'), row: PROJECT_ROWS.note, ctx: ctx(), expected: true },
  { name: 'participant edits an ordinary shared note', reader: via('maya', 'brian'), row: PROJECT_ROWS.note, ctx: ctx(BEFORE_EXPIRY, 'mutation'), expected: true },
  { name: 'nonparticipant workspace admin cannot read', reader: via('jun', 'brian'), row: PROJECT_ROWS.note, ctx: ctx(), expected: false },
  { name: 'nonparticipant workspace admin directly, no assistant', reader: via('jun', null), row: PROJECT_ROWS.note, ctx: ctx(), expected: false },
  { name: 'workspace owner reads without joining (D27)', reader: via('ava', null), row: PROJECT_ROWS.note, ctx: ctx(), expected: true },
  { name: 'workspace owner through an admitted assistant reads', reader: via('ava', 'brian'), row: PROJECT_ROWS.note, ctx: ctx(), expected: true },
  { name: 'workspace owner oversight never edits', reader: via('ava', null), row: PROJECT_ROWS.note, ctx: ctx(BEFORE_EXPIRY, 'mutation'), expected: false },
  { name: 'workspace owner through an assistant absent from the roster', reader: via('ava', 'ops'), row: PROJECT_ROWS.note, ctx: ctx(), expected: false },
  { name: 'participant through an assistant absent from the roster', reader: via('maya', 'ops'), row: PROJECT_ROWS.note, ctx: ctx(), expected: false },
  { name: 'membership expired mid-way', reader: via('priya', 'brian'), row: PROJECT_ROWS.note, ctx: ctx(AFTER_EXPIRY), expected: false },
  { name: 'membership before expiry', reader: via('priya', 'brian'), row: PROJECT_ROWS.note, ctx: ctx(), expected: true },
  { name: 'Confidential General source: internal-base participant refused', reader: via('maya', 'brian'), row: PROJECT_ROWS.confidentialGeneral, ctx: ctx(), expected: false },
  { name: 'Confidential General source: confidential-base owner reads', reader: via('ava', 'brian'), row: PROJECT_ROWS.confidentialGeneral, ctx: ctx(), expected: true },
  { name: 'participant lacking the linked Finance requirement', reader: via('sales', 'brian'), row: PROJECT_ROWS.financeSummary, ctx: ctx(), expected: false },
  { name: 'participant holding Finance reads the summary', reader: via('maya', 'brian'), row: PROJECT_ROWS.financeSummary, ctx: ctx(), expected: true },
  { name: 'nonparticipant cannot read the Finance summary in the Project', reader: via('jun', 'brian'), row: PROJECT_ROWS.financeSummary, ctx: ctx(), expected: false },
  { name: 'multi-Project derivation needs every Project', reader: via('priya', 'brian'), row: PROJECT_ROWS.atlasBeacon, ctx: ctx(), expected: false },
  { name: 'multi-Project derivation, member of both', reader: via('maya', 'brian'), row: PROJECT_ROWS.atlasBeacon, ctx: ctx(), expected: true },
  { name: 'private Project-associated row stays private to a participant', reader: via('priya', 'brian'), row: PROJECT_ROWS.mayaPrivate, ctx: ctx(), expected: false },
  { name: 'private Project-associated row stays private to oversight', reader: via('ava', null), row: PROJECT_ROWS.mayaPrivate, ctx: ctx(), expected: false },
  { name: 'private Project-associated row readable by its owner', reader: via('maya', 'brian'), row: PROJECT_ROWS.mayaPrivate, ctx: ctx(), expected: true },
  { name: 'quarantined scope admits nobody', reader: via('maya', 'brian'), row: PROJECT_ROWS.quarantinedNote, ctx: ctx(), expected: false },
  { name: 'admitted to A and B: B stays visible', reader: via('maya', 'brian'), row: PROJECT_ROWS.beaconNote, ctx: ctx(), expected: true },
  { name: 'a credential bound to Finance cannot read Project material', reader: { principal: PEOPLE.maya, assistant: ASSISTANTS.brian,
    credential: { issuerUserId: PEOPLE.maya.id, scope: 'read', binding: [DEPARTMENTS.finance] } }, row: PROJECT_ROWS.note, ctx: ctx(), expected: false },
  { name: 'a credential bound to Atlas reads Atlas material', reader: { principal: PEOPLE.maya, assistant: ASSISTANTS.brian,
    credential: { issuerUserId: PEOPLE.maya.id, scope: 'read', binding: [PROJECTS.atlas] } }, row: PROJECT_ROWS.note, ctx: ctx(), expected: true },
  { name: 'a capped credential keeps the General tier rule', reader: { principal: PEOPLE.ava, assistant: ASSISTANTS.brian,
    credential: { issuerUserId: PEOPLE.ava.id, scope: 'read', cap: 'internal' } }, row: PROJECT_ROWS.confidentialGeneral, ctx: ctx(), expected: false },
]

/** Readers for list/count lanes across the matrix. */
export const PROJECT_READERS: Reader[] = [
  via('ava', null), via('ava', 'brian'), via('jun', null), via('jun', 'brian'), via('maya', 'brian'), via('maya', 'ops'),
  via('priya', 'brian'), via('sales', 'brian'),
]

export { ctx as projectCtx, via as projectReader }
