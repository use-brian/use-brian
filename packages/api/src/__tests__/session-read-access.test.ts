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
      ...overrides.session,
    },
    assistantWorkspaceId:
      overrides.assistantWorkspaceId === undefined ? WS : overrides.assistantWorkspaceId,
    membershipClearance:
      overrides.membershipClearance === undefined ? 'internal' : overrides.membershipClearance,
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
})

describe('[COMP:api/live-work-roster] liveSessionTier (§3.3 precedence)', () => {
  it("caller's own session is full, first rule wins", () => {
    expect(liveSessionTier(facts({ session: { userId: CALLER } }))).toBe('full')
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
