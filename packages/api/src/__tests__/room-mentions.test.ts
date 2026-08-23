/**
 * [COMP:api/room-mentions] Room human `@mention` resolver + recorder.
 *
 * `resolveRoomMentions` is pure — exercised directly with plain roster
 * objects. `recordRoomMentionsForMessage` / `reconcileRoomMentionsForEdit`
 * are the orchestration half — `../db/client.js` (roster reads + the
 * unchanged-preview UPDATE) and `../db/doc-notifications-store.js` (the
 * actual writer) are mocked so this suite runs with no database.
 *
 * Spec: docs/plans/room-human-mentions.md — T-H1, T-H2, T-H4, T-H5, T-H6, D-H4, D-H6.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockRecordRoomMentions, mockRetractRoomMentions, mockQuery } = vi.hoisted(() => ({
  mockRecordRoomMentions: vi.fn(),
  mockRetractRoomMentions: vi.fn(),
  mockQuery: vi.fn(),
}))

vi.mock('../db/doc-notifications-store.js', () => ({
  createDbDocNotificationsStore: () => ({
    recordMentions: vi.fn(),
    recordRoomMentions: mockRecordRoomMentions,
    retractRoomMentions: mockRetractRoomMentions,
    listForUser: vi.fn(),
    markRead: vi.fn(),
    unreadCount: vi.fn(),
  }),
}))

vi.mock('../db/client.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}))

import {
  resolveRoomMentions,
  recordRoomMentionsForMessage,
  reconcileRoomMentionsForEdit,
  type RoomMentionAssistant,
  type RoomMentionMember,
} from '../room-mentions.js'

const ACTOR = 'user-actor'
const WS = 'ws-1'
const SESSION = 'sess-1'
const MESSAGE = 'msg-1'

/** Queue the two roster queries `fetchRoomMentionRosters` issues, in order. */
function mockRosters(
  assistants: Array<{ id?: string | null; name?: string | null }>,
  members: Array<{ id?: string | null; name?: string | null; clearance?: string | null }>,
) {
  mockQuery
    .mockResolvedValueOnce({ rows: assistants, rowCount: assistants.length })
    .mockResolvedValueOnce({ rows: members, rowCount: members.length })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRecordRoomMentions.mockResolvedValue(1)
  mockRetractRoomMentions.mockResolvedValue(1)
})

// ── Pure resolver (T-H1/T-H5) ───────────────────────────────────

describe('[COMP:api/room-mentions] resolveRoomMentions', () => {
  const assistants: RoomMentionAssistant[] = [{ id: 'a-brian', name: 'Brian' }]
  const members: RoomMentionMember[] = [
    { id: 'u-jane', name: 'Jane Doe', clearance: 'internal' },
    { id: 'u-secret', name: 'Sam Confidential', clearance: 'confidential' },
  ]

  it('resolves a human-only mention to memberIds with no assistant span', () => {
    const result = resolveRoomMentions({
      text: 'hey @Jane Doe can you look at this',
      actorUserId: ACTOR,
      assistants,
      members,
      sessionClearance: 'internal',
    })
    expect(result.memberIds).toEqual(['u-jane'])
    expect(result.unreachable).toEqual([])
    expect(result.assistants).toEqual([])
  })

  it('resolves a mixed @Assistant @Member message into both partitions', () => {
    const result = resolveRoomMentions({
      text: '@Brian @Jane Doe what do you both think?',
      actorUserId: ACTOR,
      assistants,
      members,
      sessionClearance: 'internal',
    })
    expect(result.memberIds).toEqual(['u-jane'])
    expect(result.assistants).toEqual([{ id: 'a-brian', name: 'Brian' }])
  })

  it('drops a self-mention from both partitions', () => {
    const result = resolveRoomMentions({
      text: '@Jane Doe you around?',
      actorUserId: 'u-jane',
      assistants,
      members,
      sessionClearance: 'internal',
    })
    expect(result.memberIds).toEqual([])
    expect(result.unreachable).toEqual([])
  })

  it('reports a matched below-clearance member as unreachable, not notified', () => {
    // canRead(memberClearance, roomClearance): the member's OWN clearance
    // must be at least the room's. A 'public'-cleared member cannot read a
    // 'confidential' room, so a mention of them there is unreachable.
    const result = resolveRoomMentions({
      text: '@Sam Confidential take a look',
      actorUserId: ACTOR,
      assistants,
      members: [{ id: 'u-secret', name: 'Sam Confidential', clearance: 'public' }],
      sessionClearance: 'confidential',
    })
    expect(result.memberIds).toEqual([])
    expect(result.unreachable).toEqual([{ id: 'u-secret', name: 'Sam Confidential' }])
  })

  it('a null sessionClearance gates nobody (mirrors gateSessionRead)', () => {
    const result = resolveRoomMentions({
      text: '@Sam Confidential take a look',
      actorUserId: ACTOR,
      assistants,
      members,
      sessionClearance: null,
    })
    expect(result.memberIds).toEqual(['u-secret'])
    expect(result.unreachable).toEqual([])
  })

  it('an exact name tie between an assistant and a member resolves to the assistant (D-H3)', () => {
    const tiedAssistants: RoomMentionAssistant[] = [{ id: 'a-jane', name: 'Jane' }]
    const tiedMembers: RoomMentionMember[] = [{ id: 'u-jane2', name: 'Jane', clearance: 'internal' }]
    const result = resolveRoomMentions({
      text: '@Jane can you check this',
      actorUserId: ACTOR,
      assistants: tiedAssistants,
      members: tiedMembers,
      sessionClearance: 'internal',
    })
    expect(result.assistants).toEqual([{ id: 'a-jane', name: 'Jane' }])
    expect(result.memberIds).toEqual([])
    expect(result.unreachable).toEqual([])
  })

  it('@Jane does not match a member named "Jane Doe" (boundary)', () => {
    const result = resolveRoomMentions({
      text: 'talk to @Janet about this',
      actorUserId: ACTOR,
      assistants: [],
      members: [{ id: 'u-janet-fragment', name: 'Jane', clearance: 'internal' }],
      sessionClearance: 'internal',
    })
    expect(result.memberIds).toEqual([])
  })

  it('@Jane Doe beats a member named "Jane" when both exist (longest match wins)', () => {
    const result = resolveRoomMentions({
      text: '@Jane Doe please review',
      actorUserId: ACTOR,
      assistants: [],
      members: [
        { id: 'u-jane-short', name: 'Jane', clearance: 'internal' },
        { id: 'u-jane-long', name: 'Jane Doe', clearance: 'internal' },
      ],
      sessionClearance: 'internal',
    })
    expect(result.memberIds).toEqual(['u-jane-long'])
  })

  it('dedupes a member mentioned twice into one notification', () => {
    const result = resolveRoomMentions({
      text: '@Jane Doe ping @Jane Doe again',
      actorUserId: ACTOR,
      assistants,
      members,
      sessionClearance: 'internal',
    })
    expect(result.memberIds).toEqual(['u-jane'])
  })

  it('caps memberIds at MAX_ROOM_RESPONDERS (8)', () => {
    const bigRoster: RoomMentionMember[] = Array.from({ length: 10 }, (_, i) => ({
      id: `u-${i}`,
      name: `Member${i}`,
      clearance: 'internal' as const,
    }))
    const text = bigRoster.map((m) => `@${m.name}`).join(' ')
    const result = resolveRoomMentions({
      text,
      actorUserId: ACTOR,
      assistants: [],
      members: bigRoster,
      sessionClearance: 'internal',
    })
    expect(result.memberIds).toHaveLength(8)
  })
})

// ── recordRoomMentionsForMessage (T-H1/T-H2/T-H6) ───────────────

describe('[COMP:api/room-mentions] recordRoomMentionsForMessage', () => {
  it('resolves the roster from the DB and records the notifiable member', async () => {
    mockRosters(
      [{ id: 'a-brian', name: 'Brian' }],
      [{ id: 'u-jane', name: 'Jane Doe', clearance: 'internal' }],
    )
    const result = await recordRoomMentionsForMessage({
      workspaceId: WS,
      sessionId: SESSION,
      sessionMessageId: MESSAGE,
      text: '@Jane Doe can you look at this',
      actorUserId: ACTOR,
      sessionClearance: 'internal',
    })
    expect(result.recipientUserIds).toEqual(['u-jane'])
    expect(mockRecordRoomMentions).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        sessionId: SESSION,
        sessionMessageId: MESSAGE,
        sessionClearance: 'internal',
        actorUserId: ACTOR,
        recipientUserIds: ['u-jane'],
        preview: '@Jane Doe can you look at this',
      }),
    )
  })

  it('does not call the store when nothing resolves to a notifiable member', async () => {
    mockRosters([], [{ id: 'u-jane', name: 'Jane Doe', clearance: 'internal' }])
    const result = await recordRoomMentionsForMessage({
      workspaceId: WS,
      sessionId: SESSION,
      sessionMessageId: MESSAGE,
      text: 'no mentions here',
      actorUserId: ACTOR,
      sessionClearance: 'internal',
    })
    expect(result.recipientUserIds).toEqual([])
    expect(mockRecordRoomMentions).not.toHaveBeenCalled()
  })

  it('returns unreachable and records nothing for a below-clearance name, without crashing', async () => {
    mockRosters([], [{ id: 'u-secret', name: 'Sam Confidential', clearance: 'public' }])
    const result = await recordRoomMentionsForMessage({
      workspaceId: WS,
      sessionId: SESSION,
      sessionMessageId: MESSAGE,
      text: '@Sam Confidential take a look',
      actorUserId: ACTOR,
      sessionClearance: 'confidential',
    })
    expect(result.recipientUserIds).toEqual([])
    expect(result.unreachable).toEqual([{ id: 'u-secret', name: 'Sam Confidential' }])
    expect(mockRecordRoomMentions).not.toHaveBeenCalled()
  })

  it('a non-member client hint is irrelevant — only the server-resolved roster matters', async () => {
    // Simulates a caller ignoring a forged `mentionedUserIds` hint: the
    // roster query (the only source of truth here) simply doesn't contain
    // that id, so nothing is ever notified for it. T-H2.
    mockRosters([], [{ id: 'u-real', name: 'Real Member', clearance: 'internal' }])
    const result = await recordRoomMentionsForMessage({
      workspaceId: WS,
      sessionId: SESSION,
      sessionMessageId: MESSAGE,
      text: '@Not A Member at all',
      actorUserId: ACTOR,
      sessionClearance: 'internal',
    })
    expect(result.recipientUserIds).toEqual([])
    expect(mockRecordRoomMentions).not.toHaveBeenCalled()
  })

  it('drops a self-mention and records nothing', async () => {
    mockRosters([], [{ id: ACTOR, name: 'Me Myself', clearance: 'internal' }])
    const result = await recordRoomMentionsForMessage({
      workspaceId: WS,
      sessionId: SESSION,
      sessionMessageId: MESSAGE,
      text: '@Me Myself note to self',
      actorUserId: ACTOR,
      sessionClearance: 'internal',
    })
    expect(result.recipientUserIds).toEqual([])
    expect(mockRecordRoomMentions).not.toHaveBeenCalled()
  })

  it('tolerates a malformed roster row (missing id/name) instead of throwing', async () => {
    // Several route tests stub client.js's query() with one canned row shape
    // for every call — this is what that looks like from room-mentions.ts's
    // side: a row with no usable name must be filtered, not crash the matcher.
    mockRosters([{ workspaceId: 'ws-1' } as never], [{ workspaceId: 'ws-1' } as never])
    await expect(
      recordRoomMentionsForMessage({
        workspaceId: WS,
        sessionId: SESSION,
        sessionMessageId: MESSAGE,
        text: '@anything here',
        actorUserId: ACTOR,
        sessionClearance: 'internal',
      }),
    ).resolves.toEqual({ recipientUserIds: [], unreachable: [] })
    expect(mockRecordRoomMentions).not.toHaveBeenCalled()
  })
})

// ── reconcileRoomMentionsForEdit (D-H6) ──────────────────────────

describe('[COMP:api/room-mentions] reconcileRoomMentionsForEdit', () => {
  const members: Array<{ id: string; name: string; clearance: string }> = [
    { id: 'u-jane', name: 'Jane Doe', clearance: 'internal' },
    { id: 'u-sam', name: 'Sam Lee', clearance: 'internal' },
  ]

  it('a newly added name is recorded via recordRoomMentions', async () => {
    mockRosters([], members)
    const result = await reconcileRoomMentionsForEdit({
      workspaceId: WS,
      sessionId: SESSION,
      sessionMessageId: MESSAGE,
      oldText: 'just a note',
      newText: 'just a note @Jane Doe',
      actorUserId: ACTOR,
      sessionClearance: 'internal',
    })
    expect(result.added).toEqual(['u-jane'])
    expect(result.removed).toEqual([])
    expect(mockRecordRoomMentions).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserIds: ['u-jane'], preview: 'just a note @Jane Doe' }),
    )
    expect(mockRetractRoomMentions).not.toHaveBeenCalled()
  })

  it('an unchanged name is neither recorded nor retracted — only its preview refreshes', async () => {
    mockRosters([], members)
    const result = await reconcileRoomMentionsForEdit({
      workspaceId: WS,
      sessionId: SESSION,
      sessionMessageId: MESSAGE,
      oldText: '@Jane Doe original text',
      newText: '@Jane Doe edited text',
      actorUserId: ACTOR,
      sessionClearance: 'internal',
    })
    expect(result.added).toEqual([])
    expect(result.removed).toEqual([])
    // Not recordRoomMentions — that would reset read_at on an unchanged,
    // already-read row (D-H6: "does not re-notify").
    expect(mockRecordRoomMentions).not.toHaveBeenCalled()
    expect(mockRetractRoomMentions).not.toHaveBeenCalled()
    // The preview-only UPDATE is the third query() call, after the two
    // roster reads.
    const previewCall = mockQuery.mock.calls[2]
    expect(previewCall[0]).toContain('UPDATE doc_notifications')
    expect(previewCall[0]).not.toContain('read_at')
    expect(previewCall[1]).toEqual(['@Jane Doe edited text', MESSAGE, ['u-jane']])
  })

  it('a removed name is retracted', async () => {
    mockRosters([], members)
    const result = await reconcileRoomMentionsForEdit({
      workspaceId: WS,
      sessionId: SESSION,
      sessionMessageId: MESSAGE,
      oldText: '@Jane Doe please review',
      newText: 'please review', // Jane Doe's tag removed
      actorUserId: ACTOR,
      sessionClearance: 'internal',
    })
    expect(result.added).toEqual([])
    expect(result.removed).toEqual(['u-jane'])
    expect(mockRetractRoomMentions).toHaveBeenCalledWith({
      sessionMessageId: MESSAGE,
      recipientUserIds: ['u-jane'],
    })
    expect(mockRecordRoomMentions).not.toHaveBeenCalled()
  })

  it('one edit can add, keep, and remove different names at once', async () => {
    mockRosters([], members)
    const result = await reconcileRoomMentionsForEdit({
      workspaceId: WS,
      sessionId: SESSION,
      sessionMessageId: MESSAGE,
      oldText: '@Jane Doe and @Sam Lee, take a look',
      newText: '@Jane Doe and someone new, take a look', // Sam removed, Jane kept
      actorUserId: ACTOR,
      sessionClearance: 'internal',
    })
    expect(result.added).toEqual([])
    expect(result.removed).toEqual(['u-sam'])
    expect(mockRetractRoomMentions).toHaveBeenCalledWith({
      sessionMessageId: MESSAGE,
      recipientUserIds: ['u-sam'],
    })
    // Jane Doe is unchanged: preview-only refresh, never recordRoomMentions.
    expect(mockRecordRoomMentions).not.toHaveBeenCalled()
  })

  it('re-adding a previously-removed name calls recordRoomMentions again (re-surfaces a read row)', async () => {
    mockRosters([], members)
    const result = await reconcileRoomMentionsForEdit({
      workspaceId: WS,
      sessionId: SESSION,
      sessionMessageId: MESSAGE,
      oldText: 'no mentions right now',
      newText: '@Jane Doe back on this',
      actorUserId: ACTOR,
      sessionClearance: 'internal',
    })
    expect(result.added).toEqual(['u-jane'])
    // The store's own ON CONFLICT DO UPDATE SET read_at = NULL is what makes
    // this call re-surface an existing read row rather than duplicate it
    // (proven in doc-notifications-store.test.ts); this suite only proves
    // the caller resolves the diff correctly and calls through.
    expect(mockRecordRoomMentions).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserIds: ['u-jane'] }),
    )
  })

  it('surfaces unreachable names from the NEW text for the sender-facing note', async () => {
    mockRosters(
      [],
      [{ id: 'u-secret', name: 'Sam Confidential', clearance: 'public' }],
    )
    const result = await reconcileRoomMentionsForEdit({
      workspaceId: WS,
      sessionId: SESSION,
      sessionMessageId: MESSAGE,
      oldText: 'draft',
      newText: '@Sam Confidential please review',
      actorUserId: ACTOR,
      sessionClearance: 'confidential',
    })
    expect(result.added).toEqual([])
    expect(result.unreachable).toEqual([{ id: 'u-secret', name: 'Sam Confidential' }])
    expect(mockRecordRoomMentions).not.toHaveBeenCalled()
  })
})
