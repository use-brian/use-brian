/**
 * Pure session read-access predicate + Live tier assignment.
 * Component tag: [COMP:api/live-work-roster] — the shared predicate is
 * the drift-proofing between `gateSessionRead` and the roster (§3.3).
 */
import { describe, it, expect } from 'vitest'
import { decideSessionRead, liveSessionTier, type SessionReadFacts } from '../session-read-access.js'

const CALLER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const WS = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

function facts(overrides: {
  session?: Partial<SessionReadFacts['session']>
  assistantWorkspaceId?: string | null
  membershipClearance?: SessionReadFacts['membershipClearance']
}): SessionReadFacts {
  return {
    callerUserId: CALLER,
    session: {
      userId: OTHER,
      visibility: 'owner',
      mode: null,
      effectiveClearance: null,
      contextCompartments: [],
      contextProjectId: null,
      ...overrides.session,
    },
    assistantWorkspaceId:
      overrides.assistantWorkspaceId === undefined ? WS : overrides.assistantWorkspaceId,
    membershipClearance:
      overrides.membershipClearance === undefined ? 'internal' : overrides.membershipClearance,
    membershipCompartments: null,
    membershipProjectIds: null,
  }
}

describe('[COMP:api/live-work-roster] decideSessionRead', () => {
  it('owner-only session: readable by its owner', () => {
    const d = decideSessionRead(facts({ session: { userId: CALLER } }))
    expect(d.readable).toBe(true)
  })

  it('owner-only session: forbidden for anyone else', () => {
    const d = decideSessionRead(facts({}))
    expect(d).toEqual({ readable: false, status: 403, error: 'Forbidden' })
  })

  it('workspace session: readable by a member at clearance', () => {
    const d = decideSessionRead(
      facts({ session: { visibility: 'workspace', effectiveClearance: 'internal' } }),
    )
    expect(d.readable).toBe(true)
  })

  it('workspace session: insufficient clearance rejects', () => {
    const d = decideSessionRead(
      facts({
        session: { visibility: 'workspace', effectiveClearance: 'confidential' },
        membershipClearance: 'internal',
      }),
    )
    expect(d).toEqual({ readable: false, status: 403, error: 'Insufficient clearance' })
  })

  it('workspace session: non-member rejects', () => {
    const d = decideSessionRead(
      facts({ session: { visibility: 'workspace' }, membershipClearance: null }),
    )
    expect(d).toEqual({ readable: false, status: 403, error: 'Not a member of this team' })
  })

  it('draft session on a personal assistant rejects (not team-owned)', () => {
    const d = decideSessionRead(
      facts({ session: { mode: 'draft' }, assistantWorkspaceId: null }),
    )
    expect(d).toEqual({ readable: false, status: 403, error: 'Draft session is not team-owned' })
  })

  it('draft session follows the workspace branch (member reads)', () => {
    const d = decideSessionRead(facts({ session: { mode: 'draft' } }))
    expect(d.readable).toBe(true)
  })

  it('null effective_clearance on a workspace session does not gate', () => {
    const d = decideSessionRead(
      facts({ session: { visibility: 'workspace', effectiveClearance: null }, membershipClearance: 'public' }),
    )
    expect(d.readable).toBe(true)
  })

  it.each([
    ['Team', { contextCompartments: ['finance'] }, [], null],
    ['Project', { contextProjectId: 'project-1' }, null, []],
  ])('workspace session: missing %s reach is refused without naming it', (_axis, session, compartments, projectIds) => {
    const d = decideSessionRead({
      ...facts({ session: { visibility: 'workspace', ...session } }),
      membershipCompartments: compartments,
      membershipProjectIds: projectIds,
    })
    expect(d).toEqual({ readable: false, status: 403, error: 'Session context unavailable' })
  })

  it('workspace session: matching Team and Project reach permits the room', () => {
    const d = decideSessionRead({
      ...facts({ session: {
        visibility: 'workspace',
        contextCompartments: ['finance'],
        contextProjectId: 'project-1',
      } }),
      membershipCompartments: ['finance'],
      membershipProjectIds: ['project-1'],
    })
    expect(d.readable).toBe(true)
  })
})

describe('[COMP:api/live-work-roster] liveSessionTier (§3.3 precedence)', () => {
  it("caller's own session is full, first rule wins", () => {
    expect(liveSessionTier(facts({ session: { userId: CALLER } }))).toBe('full')
  })

  it("caller's own shared room is omitted after its Team reach is revoked", () => {
    expect(liveSessionTier({
      ...facts({ session: {
        userId: CALLER,
        visibility: 'workspace',
        contextCompartments: ['finance'],
      } }),
      membershipCompartments: [],
      membershipProjectIds: null,
    })).toBe('omitted')
  })

  it('workspace-visible within clearance is full', () => {
    expect(
      liveSessionTier(facts({ session: { visibility: 'workspace', effectiveClearance: 'internal' } })),
    ).toBe('full')
  })

  it('workspace-visible above clearance is OMITTED, never presence (D5)', () => {
    expect(
      liveSessionTier(
        facts({
          session: { visibility: 'workspace', effectiveClearance: 'confidential' },
          membershipClearance: 'internal',
        }),
      ),
    ).toBe('omitted')
  })

  it("teammate's personal session on a workspace assistant is presence (D4)", () => {
    expect(liveSessionTier(facts({}))).toBe('presence')
  })

  it('draft sessions follow the workspace branch, not presence', () => {
    expect(liveSessionTier(facts({ session: { mode: 'draft' } }))).toBe('full')
  })
})


describe('[COMP:api/live-work-roster] department READ parity', () => {
  function departmentFacts(base: 'internal' | 'confidential', edge: 'internal' | 'confidential' | null): SessionReadFacts {
    return {
      ...facts({ membershipClearance: base, session: {
        visibility: 'workspace', effectiveClearance: 'confidential',
        contextCompartments: ['team:department-a'], contextProjectId: 'unjoined-project',
      } }),
      membershipCompartments: null, membershipProjectIds: [],
      departmentAccess: {
        principal: { kind: 'user', id: CALLER },
        snapshot: { workspaceId: WS, base: { [`user:${CALLER}`]: base },
          edges: edge ? [{ principal: { kind: 'user', id: CALLER }, departmentId: 'department-a',
            clearance: edge, expiresAt: null }] : [] },
      },
    }
  }
  it('department clearance admits above base, regardless of project membership', () => {
    expect(decideSessionRead(departmentFacts('internal', 'confidential')).readable).toBe(true)
  })
  it('a high base cannot override a lower department edge', () => {
    expect(decideSessionRead(departmentFacts('confidential', 'internal')).readable).toBe(false)
  })
  it('no department edge omits even a confidential-base viewer from Live', () => {
    expect(liveSessionTier(departmentFacts('confidential', null))).toBe('omitted')
  })
  it('an expired department edge denies the same session', () => {
    const input = departmentFacts('confidential', 'confidential')
    input.departmentAccess!.snapshot.edges[0].expiresAt = new Date(0)
    expect(decideSessionRead(input).readable).toBe(false)
  })
  it('ownership of a private workspace session cannot bypass a removed department edge', () => {
    const input = departmentFacts('confidential', null)
    input.session = { ...input.session, userId: CALLER, visibility: 'owner' }
    expect(decideSessionRead(input).readable).toBe(false)
    expect(liveSessionTier(input)).toBe('omitted')
  })
  it('private presence requires department access without granting another owner content', () => {
    const input = departmentFacts('internal', 'confidential')
    input.session = { ...input.session, userId: OTHER, visibility: 'owner' }
    expect(liveSessionTier(input)).toBe('presence')
    expect(decideSessionRead(input).readable).toBe(false)
    input.departmentAccess!.snapshot.edges = []
    expect(liveSessionTier(input)).toBe('omitted')
  })
  it('private workspace reads require both ownership and the department clearance', () => {
    const input = departmentFacts('internal', 'confidential')
    input.session = { ...input.session, userId: CALLER, visibility: 'owner' }
    expect(decideSessionRead(input).readable).toBe(true)
    input.session.userId = OTHER
    expect(decideSessionRead(input).readable).toBe(false)
  })

})
