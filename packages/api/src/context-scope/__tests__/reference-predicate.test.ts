import { describe, expect, it } from 'vitest'
import {
  clearanceIn, eff, explainRead, read, readable, splitScopeLabels, updatePreservesFloor, write,
  type AccessSnapshot, type Reader, type Row,
} from '../reference-predicate.js'
import { PROJECT_CASES, PROJECT_ROWS, PROJECT_SNAPSHOT, PROJECTS, projectCtx, projectReader } from './fixtures/project-shared-matrix.js'
import { automaticContextAccess } from '../resolve-turn-scope.js'
import {
  ALL_READERS, ALL_ROWS, ASSISTANTS, BEFORE_EXPIRY, CASES_4_1, DEPARTMENTS, LANES, PEOPLE, ROWS, SNAPSHOT,
  WORKSPACE, fixtureCtx, fixtureReader,
} from './fixtures/access-matrix.js'

const ctx = fixtureCtx()
const ranks = { public: 1, internal: 2, confidential: 3 } as const
const r = (c: string | null) => (c ? ranks[c as keyof typeof ranks] : 0)

describe('[COMP:access/reference-predicate] Reference READ / WRITE (permission model v2 §4)', () => {
  describe('§4.1 case table', () => {
    it.each(CASES_4_1.map(c => [c.name, c] as const))('%s', (_name, c) => {
      expect(read(SNAPSHOT, c.reader, c.row, c.ctx)).toBe(c.expected)
    })
  })

  it('I1: no unexpired edge in D means no read of any row listing D, for any role, assistant or credential', () => {
    for (const tier of ['public', 'internal', 'confidential'] as const) {
      const boardRow: Row = { ...ROWS.r6, tier }
      for (const a of [ASSISTANTS.brian, ASSISTANTS.ops]) {
        // Jun is an admin with confidential base; Maya, Priya are members.
        for (const p of [PEOPLE.jun, PEOPLE.maya, PEOPLE.priya]) {
          expect(read(SNAPSHOT, { principal: p, assistant: a }, boardRow, ctx)).toBe(false)
          expect(read(SNAPSHOT, { principal: p, assistant: a, credential: { issuerUserId: p.id, scope: 'read_write' } }, boardRow, ctx)).toBe(false)
        }
      }
    }
    // An expired edge is no edge: Maya's Sales edge after 10-31.
    const salesRow: Row = { ...ROWS.salesPage, id: 'not-granted' }
    expect(read(SNAPSHOT, fixtureReader('maya', 'brian'), salesRow, fixtureCtx(BEFORE_EXPIRY))).toBe(true)
    expect(read(SNAPSHOT, fixtureReader('maya', 'brian'), salesRow, fixtureCtx(new Date('2026-11-02T12:00:00Z')))).toBe(false)
  })

  it('I7: eff(P, A, D) never exceeds either side; the primary assistant\'s auto edge widens nobody', () => {
    for (const reader of ALL_READERS) {
      for (const d of Object.values(DEPARTMENTS)) {
        const e = eff(SNAPSHOT, reader, d, ctx.now)
        expect(r(e)).toBeLessThanOrEqual(r(clearanceIn(SNAPSHOT, reader.principal, d, ctx.now)))
        expect(r(e)).toBeLessThanOrEqual(r(clearanceIn(SNAPSHOT, reader.assistant!, d, ctx.now)))
      }
    }
    // Failing case: Brian is confidential in Board, Jun is not in Board.
    expect(eff(SNAPSHOT, fixtureReader('jun', 'brian'), DEPARTMENTS.board, ctx.now)).toBeNull()
  })

  it('I8: a credential reads at most what its issuer reads; removing the issuer\'s edge removes the key\'s reach', () => {
    for (const issuer of Object.values(PEOPLE)) {
      for (const a of Object.values(ASSISTANTS)) {
        const key: Reader = { principal: PEOPLE.ava, assistant: a, credential: { issuerUserId: issuer.id, scope: 'read' } }
        for (const row of ALL_ROWS) {
          if (read(SNAPSHOT, key, row, ctx)) expect(read(SNAPSHOT, { principal: issuer, assistant: a }, row, ctx)).toBe(true)
        }
      }
    }
    const mayaKey: Reader = { principal: PEOPLE.jun, assistant: ASSISTANTS.brian, credential: { issuerUserId: PEOPLE.maya.id, scope: 'read' } }
    expect(read(SNAPSHOT, mayaKey, ROWS.r1, ctx)).toBe(true)
    const revoked: AccessSnapshot = { ...SNAPSHOT, edges: SNAPSHOT.edges.filter(e => !(e.principal.id === PEOPLE.maya.id && e.departmentId === DEPARTMENTS.platform)) }
    expect(read(revoked, mayaKey, ROWS.r1, ctx)).toBe(false)
    // A cap and a binding only ever narrow.
    expect(read(SNAPSHOT, { ...mayaKey, credential: { ...mayaKey.credential!, cap: 'internal' } }, ROWS.r1, ctx)).toBe(false)
    expect(read(SNAPSHOT, { ...mayaKey, credential: { ...mayaKey.credential!, binding: [DEPARTMENTS.finance] } }, ROWS.r1, ctx)).toBe(false)
  })

  it('I9: a page grant never allows a read P.base would not', () => {
    const after = fixtureCtx(new Date('2026-11-02T12:00:00Z'))
    expect(read(SNAPSHOT, fixtureReader('maya', 'brian'), ROWS.salesPage, after)).toBe(true)
    // Confidential page, Maya's base is internal: the grant cannot raise it.
    expect(explainRead(SNAPSHOT, fixtureReader('maya', 'brian'), ROWS.salesSecretPage, after))
      .toEqual({ allowed: false, denial: 'tier_department' })
    // The grant covers its one row only.
    expect(read(SNAPSHOT, fixtureReader('maya', 'brian'), { ...ROWS.salesPage, id: 'another-sales-page' }, after)).toBe(false)
  })

  it('I11: every lane returns READ over its candidates; counts and provenance see nothing READ refuses', () => {
    for (const reader of ALL_READERS) {
      const expected = ALL_ROWS.filter(row => read(SNAPSHOT, reader, row, ctx)).map(row => row.id)
      for (const lane of LANES) {
        const visible = readable(SNAPSHOT, reader, ALL_ROWS, ctx)
        if (lane === 'count') expect(visible.length).toBe(expected.length)
        else expect(visible.map(row => row.id)).toEqual(expected)
      }
    }
    // Failing case: Jun via Brian sees neither the Board row nor its existence in a count.
    const jun = readable(SNAPSHOT, fixtureReader('jun', 'brian'), ALL_ROWS, ctx)
    expect(jun.some(row => row.departmentIds.includes(DEPARTMENTS.board))).toBe(false)
  })

  it('I12: a derived row carries the union of its sources\' departments and the max of their tiers', () => {
    const maya = fixtureReader('maya', 'brian')
    const derived = write(SNAPSHOT, maya, { requestedTier: 'public', sources: [ROWS.r1, ROWS.r3] }, ctx)
    expect(derived.row).toMatchObject({ tier: 'confidential', departmentIds: [DEPARTMENTS.platform, DEPARTMENTS.finance].sort() })
    expect(derived.allowed).toBe(true)
    // Never General unless every source was General.
    expect(write(SNAPSHOT, maya, { requestedTier: 'public', sources: [ROWS.r5, ROWS.r3] }, ctx).row.departmentIds).toEqual([DEPARTMENTS.finance])
    expect(write(SNAPSHOT, maya, { requestedTier: 'public', sources: [ROWS.r5] }, ctx).row.departmentIds).toEqual([])
    // Failing case: the write ceiling is the assistant's. Ops is internal in
    // Finance, so a confidential derived Finance row is refused through Ops.
    expect(write(SNAPSHOT, fixtureReader('maya', 'ops'), { requestedTier: 'internal', sources: [ROWS.r2] }, ctx))
      .toMatchObject({ allowed: false, denial: 'tier_department' })
    // A read-scoped credential never writes.
    expect(write(SNAPSHOT, { ...maya, credential: { issuerUserId: PEOPLE.maya.id, scope: 'read' } }, { requestedTier: 'public', sources: [] }, ctx))
      .toMatchObject({ allowed: false, denial: 'scope' })
    // Stamped with the context department.
    expect(write(SNAPSHOT, maya, { requestedTier: 'internal', sources: [] }, fixtureCtx(BEFORE_EXPIRY, DEPARTMENTS.platform)).row.departmentIds)
      .toEqual([DEPARTMENTS.platform])
  })

  it('I13: an update cannot remove a department or lower a tier', () => {
    const before = { tier: 'confidential' as const, departmentIds: [DEPARTMENTS.platform, DEPARTMENTS.finance] }
    expect(updatePreservesFloor(before, { tier: 'confidential', departmentIds: [DEPARTMENTS.platform, DEPARTMENTS.finance, DEPARTMENTS.sales] })).toBe(true)
    expect(updatePreservesFloor(before, { tier: 'internal', departmentIds: before.departmentIds })).toBe(false)
    expect(updatePreservesFloor(before, { tier: 'confidential', departmentIds: [DEPARTMENTS.platform] })).toBe(false)
    expect(updatePreservesFloor(before, { tier: 'confidential', departmentIds: [] })).toBe(false)
  })

  it('the workspace wall and the private leg hold for every reader', () => {
    for (const reader of ALL_READERS) {
      expect(explainRead(SNAPSHOT, reader, ROWS.foreign, ctx)).toEqual({ allowed: false, denial: 'workspace' })
      expect(read(SNAPSHOT, reader, ROWS.mayaPrivate, ctx)).toBe(reader.principal.id === PEOPLE.maya.id)
    }
    expect(read(SNAPSHOT, { principal: { kind: 'anonymous', id: 'anonymous' }, assistant: ASSISTANTS.brian },
      { ...ROWS.r5, tier: 'public' }, { workspaceId: WORKSPACE, department: null, now: ctx.now })).toBe(true)
    expect(read(SNAPSHOT, { principal: { kind: 'anonymous', id: 'anonymous' }, assistant: ASSISTANTS.brian },
      ROWS.r3, ctx)).toBe(false)
  })
})

describe('[COMP:access/reference-predicate] Shared Project leg (project-shared-spaces.md)', () => {
  it.each(PROJECT_CASES.map(c => [c.name, c] as const))('%s', (_name, c) => {
    expect(read(PROJECT_SNAPSHOT, c.reader, c.row, c.ctx)).toBe(c.expected)
  })

  it('a page grant never stands in for Project membership', () => {
    const reader = { principal: PEOPLE.jun, assistant: ASSISTANTS.brian, pageGrants: [{ rowId: PROJECT_ROWS.note.id, principal: PEOPLE.jun }] }
    expect(explainRead(PROJECT_SNAPSHOT, reader, PROJECT_ROWS.note, projectCtx())).toEqual({ allowed: false, denial: 'project' })
  })

  it('a disabled capability (no active scopes) admits nobody, never General', () => {
    const disabled = { ...PROJECT_SNAPSHOT, activeProjects: [] }
    for (const reader of [projectReader('maya', 'brian'), projectReader('ava', null)]) {
      expect(read(disabled, reader, PROJECT_ROWS.note, projectCtx())).toBe(false)
    }
  })

  it('WRITE to a Project destination needs member writers; oversight and absent assistants are refused', () => {
    const input = { requestedTier: 'internal' as const, sources: [], destinationProject: PROJECTS.atlas, homeDepartment: DEPARTMENTS.platform }
    const ok = write(PROJECT_SNAPSHOT, projectReader('maya', 'brian'), input, projectCtx())
    // An explicit Project destination is a choice: the home Department does not apply.
    expect(ok).toEqual({ allowed: true, row: { workspaceId: WORKSPACE, tier: 'internal', departmentIds: [], userId: null, projectScopeIds: [PROJECTS.atlas] } })
    expect(write(PROJECT_SNAPSHOT, projectReader('ava', null), input, projectCtx())).toMatchObject({ allowed: false, denial: 'project' })
    expect(write(PROJECT_SNAPSHOT, projectReader('maya', 'ops'), input, projectCtx())).toMatchObject({ allowed: false, denial: 'project' })
    expect(write(PROJECT_SNAPSHOT, projectReader('jun', 'brian'), input, projectCtx())).toMatchObject({ allowed: false, denial: 'project' })
  })

  it('a derived write keeps every source Department, tier and Project (I12), so the audience cannot launder it', () => {
    const derived = write(PROJECT_SNAPSHOT, projectReader('maya', 'brian'), {
      requestedTier: 'public', sources: [PROJECT_ROWS.financeSummary, PROJECT_ROWS.beaconNote], destinationProject: PROJECTS.atlas,
    }, projectCtx())
    expect(derived).toMatchObject({ allowed: true, row: { departmentIds: [DEPARTMENTS.finance], tier: 'internal',
      projectScopeIds: [PROJECTS.atlas, PROJECTS.beacon].sort() } })
    if (!derived.allowed) return
    const stored = { ...derived.row, id: 'derived' }
    // A participant without Finance, or without Beacon, still cannot read it.
    expect(read(PROJECT_SNAPSHOT, projectReader('sales', 'brian'), stored, projectCtx())).toBe(false)
    expect(read(PROJECT_SNAPSHOT, projectReader('priya', 'brian'), stored, projectCtx())).toBe(false)
    expect(read(PROJECT_SNAPSHOT, projectReader('maya', 'brian'), stored, projectCtx())).toBe(true)
  })

  it('an update may add a Project requirement but never drop one (I13)', () => {
    expect(updatePreservesFloor({ tier: 'internal', departmentIds: [], projectScopeIds: [PROJECTS.atlas] },
      { tier: 'internal', departmentIds: [], projectScopeIds: [] })).toBe(false)
    expect(updatePreservesFloor({ tier: 'internal', departmentIds: [], projectScopeIds: [] },
      { tier: 'internal', departmentIds: [], projectScopeIds: [PROJECTS.atlas] })).toBe(true)
  })

  it('labels split into Department and Project requirements; an unknown label is refused', () => {
    expect(splitScopeLabels([`team:${DEPARTMENTS.finance}`, `project:${PROJECTS.atlas}`]))
      .toEqual({ departmentIds: [DEPARTMENTS.finance], projectScopeIds: [PROJECTS.atlas] })
    expect(splitScopeLabels(['client:acme'])).toBeNull()
  })
})

describe('[COMP:access/reference-predicate] Automatic-context relevance (D18)', () => {
  it('keeps only the bound shared Project and never adds one', () => {
    const access = { workspaceId: WORKSPACE, userId: PEOPLE.maya.id, departmentRead: { workspaceId: WORKSPACE, userId: PEOPLE.maya.id, assistantId: null,
      base: 'internal' as const, departments: {}, contextDepartment: null, binding: null, cap: null,
      projects: { [PROJECTS.atlas]: 'member' as const, [PROJECTS.beacon]: 'member' as const } } }
    expect(automaticContextAccess(access, PROJECTS.atlas).departmentRead?.projects).toEqual({ [PROJECTS.atlas]: 'member' })
    expect(automaticContextAccess(access, null).departmentRead?.projects).toBeUndefined()
    expect(automaticContextAccess(access, 'not-admitted').departmentRead?.projects).toBeUndefined()
    expect(automaticContextAccess({ workspaceId: WORKSPACE, userId: PEOPLE.maya.id }, PROJECTS.atlas)).toEqual({ workspaceId: WORKSPACE, userId: PEOPLE.maya.id })
  })
})
