/**
 * [COMP:api/sessions-workspace-list] — workspace-shared chat access rules.
 *
 * The Chat app's Workspace view relaxes several owner-only rules, and each
 * relaxation is a place a bug becomes a privacy incident rather than a broken
 * button. This suite pins the four the plan calls out (chat-app.md →
 * "Workspace view", chat-miniapp-home-config.md T5-T7):
 *
 *   1. a cross-user read/post against an OWNER session is still refused;
 *   2. a member is authorized against a WORKSPACE session they did not start;
 *   3. a member below the session's clearance is refused (and, in the list
 *      query, never sees the row at all);
 *   4. the shared-session predicate is narrower than `visibility`, so doc
 *      comment threads do NOT inherit the relaxed delete / busy rules.
 *
 * Mocks the db client + the membership lookup so the predicate is exercised
 * without a database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const assistantWorkspace: { workspaceId: string | null } = { workspaceId: 'ws-1' }

vi.mock('../../db/client.js', () => ({
  query: vi.fn(async () => ({
    rows: [{ workspaceId: assistantWorkspace.workspaceId }],
    rowCount: 1,
  })),
  queryGated: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  queryWithRLS: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  getAppPool: vi.fn(() => {
    throw new Error('app pool unused in this suite')
  }),
  rollbackAndRelease: vi.fn(),
}))

let membership: { clearance: 'public' | 'internal' | 'confidential' } | null = {
  clearance: 'confidential',
}

vi.mock('../../db/workspace-store.js', () => ({
  getWorkspaceMembershipWithClearanceSystem: vi.fn(async () => membership),
  getWorkspaceRoleSystem: vi.fn(async () => 'member'),
}))

import { gateSessionRead } from '../sessions.js'
import { isSharedChatSession, isMultiParticipantSession } from '../../db/sessions.js'

const STARTER = 'user-starter'
const TEAMMATE = 'user-teammate'

function session(overrides: Record<string, unknown> = {}) {
  return {
    userId: STARTER,
    assistantId: 'a-1',
    visibility: 'workspace',
    mode: null,
    channelType: 'web',
    appOrigin: 'chat',
    effectiveClearance: 'internal',
    ...overrides,
  }
}

describe('[COMP:api/sessions-workspace-list] workspace-shared chat access', () => {
  beforeEach(() => {
    membership = { clearance: 'confidential' }
    assistantWorkspace.workspaceId = 'ws-1'
  })

  it('refuses a cross-user read of an OWNER session (the personal default)', async () => {
    const denied = await gateSessionRead(
      TEAMMATE,
      session({ visibility: 'owner', effectiveClearance: null }),
    )
    expect(denied).toEqual({ status: 403, error: 'Forbidden' })
  })

  it('still lets the starter read their own owner session', async () => {
    const denied = await gateSessionRead(
      STARTER,
      session({ visibility: 'owner', effectiveClearance: null }),
    )
    expect(denied).toBeNull()
  })

  it('authorizes a member against a WORKSPACE session they did not start', async () => {
    const denied = await gateSessionRead(TEAMMATE, session())
    expect(denied).toBeNull()
  })

  it('refuses a non-member of the owning workspace', async () => {
    membership = null
    const denied = await gateSessionRead(TEAMMATE, session())
    expect(denied).toEqual({ status: 403, error: 'Not a member of this team' })
  })

  it('refuses a member below the session clearance', async () => {
    membership = { clearance: 'public' }
    const denied = await gateSessionRead(
      TEAMMATE,
      session({ effectiveClearance: 'confidential' }),
    )
    expect(denied).toEqual({ status: 403, error: 'Insufficient clearance' })
  })

  it('admits a member exactly at the session clearance', async () => {
    membership = { clearance: 'internal' }
    const denied = await gateSessionRead(
      TEAMMATE,
      session({ effectiveClearance: 'internal' }),
    )
    expect(denied).toBeNull()
  })

  it('refuses when the assistant is not workspace-owned', async () => {
    assistantWorkspace.workspaceId = null
    const denied = await gateSessionRead(TEAMMATE, session())
    expect(denied).toEqual({ status: 403, error: 'Draft session is not team-owned' })
  })
})

describe('[COMP:api/sessions-workspace-list] shared-chat predicate scope', () => {
  it('matches only a workspace-visible web chat session', () => {
    expect(isSharedChatSession(session())).toBe(true)
    expect(isSharedChatSession(session({ visibility: 'owner' }))).toBe(false)
    expect(isSharedChatSession(session({ appOrigin: 'doc' }))).toBe(false)
    expect(isSharedChatSession(session({ channelType: 'doc_thread' }))).toBe(false)
  })

  it('does NOT sweep in doc comment threads or feed drafts', () => {
    // Both are workspace-visible, and both have lifecycle rules the shared-chat
    // relaxations must not touch — deleting a doc thread cascades to
    // `comment_threads` and every comment on it.
    const docThread = session({ channelType: 'doc_thread', appOrigin: 'doc' })
    const feedDraft = session({ mode: 'draft', appOrigin: null })
    expect(isSharedChatSession(docThread)).toBe(false)
    expect(isSharedChatSession(feedDraft)).toBe(false)
    // They ARE multi-participant, so speaker labels still apply to them.
    expect(isMultiParticipantSession(docThread)).toBe(true)
    expect(isMultiParticipantSession(feedDraft)).toBe(true)
  })

  it('leaves a personal chat single-participant (no speaker labels)', () => {
    const personal = session({ visibility: 'owner', effectiveClearance: null })
    expect(isMultiParticipantSession(personal)).toBe(false)
  })
})

describe('[COMP:api/sessions-workspace-list] turn serialization is internal for rooms', () => {
  const idle = { status: 'idle', visibility: 'workspace', channelType: 'web', appOrigin: 'chat', mode: null }
  const running = { ...idle, status: 'running' }

  it('lets a turn through when nothing is in flight', async () => {
    const { sharedTurnRejection } = await import('../chat.js')
    expect(sharedTurnRejection(idle)).toBeNull()
  })

  it('no longer rejects a concurrent send in a room — D2: `shared_session_busy` left the human path', async () => {
    // Multiplayer chat (docs/plans/multiplayer-chat.md): a plain post during
    // a live turn is accepted (the post path is never gated), and an
    // ADDRESSED send queues exactly one follow-up turn (roomTurnAdmission,
    // [COMP:api/room-mechanics]). Serialization moved inside the route.
    const { sharedTurnRejection } = await import('../chat.js')
    expect(sharedTurnRejection(running)).toBeNull()
  })

  it('keeps the draft session busy code (drafts still take one turn at a time)', async () => {
    const { sharedTurnRejection } = await import('../chat.js')
    expect(
      sharedTurnRejection({ ...running, mode: 'draft', appOrigin: null })?.code,
    ).toBe('draft_session_busy')
  })

  it('never busy-blocks a personal chat or a doc comment thread', async () => {
    const { sharedTurnRejection } = await import('../chat.js')
    // A personal session is single-author — a second turn is the same person.
    expect(sharedTurnRejection({ ...running, visibility: 'owner' })).toBeNull()
    // A doc thread is workspace-VISIBLE but single-author; blocking it would
    // stop someone replying in their own thread.
    expect(
      sharedTurnRejection({ ...running, channelType: 'doc_thread', appOrigin: 'doc' }),
    ).toBeNull()
  })
})
