/**
 * [COMP:api/doc-notifications-store] Doc notifications store.
 *
 * Mocks the pg client and verifies recordMentions validates workspace
 * membership + drops self-mentions before a system-side bulk INSERT, and that
 * list/markRead/unreadCount run RLS-scoped to the recipient.
 *
 * [COMP:api/room-mention-store] below covers migration 469's room-mention
 * recorder/retraction: the additional room-clearance gate, the upsert that
 * makes the multi-assistant fan-out idempotent and re-surfaces a read row on
 * re-add (D-H6), and unread-only retraction.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  queryWithRLS: vi.fn(),
  query: vi.fn(),
}))

import { createDbDocNotificationsStore } from '../doc-notifications-store.js'
import { query, queryWithRLS } from '../client.js'

const mockBareQuery = vi.mocked(query)
const mockRlsQuery = vi.mocked(queryWithRLS)

const ACTOR = '00000000-0000-0000-0000-0000000000a1'
const RECIP1 = '00000000-0000-0000-0000-0000000000b1'
const RECIP2 = '00000000-0000-0000-0000-0000000000b2'
const WS = '00000000-0000-0000-0000-0000000000c2'
const PAGE = '00000000-0000-0000-0000-0000000000c3'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:api/doc-notifications-store] createDbDocNotificationsStore', () => {
  it('recordMentions validates membership, drops the self-mention, then bulk-inserts the rest', async () => {
    // Membership check returns only RECIP1 as a workspace member (RECIP2 is
    // not), and the actor is in the list too (a self-mention).
    mockBareQuery
      .mockResolvedValueOnce({ rows: [{ userId: RECIP1 }] } as never) // membership
      .mockResolvedValueOnce({ rows: [{ id: 'n-1' }], rowCount: 1 } as never) // insert

    const store = createDbDocNotificationsStore()
    const created = await store.recordMentions({
      workspaceId: WS,
      pageId: PAGE,
      threadId: 't-1',
      actorUserId: ACTOR,
      recipientUserIds: [RECIP1, RECIP2, ACTOR],
      preview: '  hey  @you  ',
    })

    // Membership query excludes the self-mention up front (only RECIP1/RECIP2).
    const memberArgs = mockBareQuery.mock.calls[0][1] as unknown[]
    expect(memberArgs[0]).toBe(WS)
    expect(memberArgs[1]).toEqual([RECIP1, RECIP2])
    // The INSERT only gets the validated members (RECIP2 dropped → just RECIP1).
    expect(mockBareQuery.mock.calls[1][0]).toContain('INSERT INTO doc_notifications')
    const insertArgs = mockBareQuery.mock.calls[1][1] as unknown[]
    expect(insertArgs).toContain(WS)
    expect(insertArgs).toContain(PAGE)
    expect(insertArgs).toContain(ACTOR)
    expect(insertArgs).toEqual(expect.arrayContaining([[RECIP1]]))
    // Preview is trimmed/clamped.
    expect(insertArgs).toContain('hey @you')
    expect(created).toBe(1)
  })

  it('recordMentions no-ops when the only recipient is the actor (self-mention)', async () => {
    const store = createDbDocNotificationsStore()
    const created = await store.recordMentions({
      workspaceId: WS,
      pageId: PAGE,
      actorUserId: ACTOR,
      recipientUserIds: [ACTOR],
    })
    expect(created).toBe(0)
    expect(mockBareQuery).not.toHaveBeenCalled()
  })

  it('recordMentions no-ops when no candidate is a workspace member', async () => {
    mockBareQuery.mockResolvedValueOnce({ rows: [] } as never) // membership → none
    const store = createDbDocNotificationsStore()
    const created = await store.recordMentions({
      workspaceId: WS,
      pageId: PAGE,
      actorUserId: ACTOR,
      recipientUserIds: [RECIP1],
    })
    expect(created).toBe(0)
    // Membership checked, but no INSERT fired.
    expect(mockBareQuery).toHaveBeenCalledTimes(1)
  })

  it('listForUser reads RLS-scoped, newest-first, joined to page title + actor name', async () => {
    mockRlsQuery.mockResolvedValue({
      rows: [
        {
          id: 'n-1',
          pageId: PAGE,
          threadId: 't-1',
          actorUserId: ACTOR,
          actorName: 'Jane',
          pageTitle: 'Weekly',
          preview: 'see this',
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
          readAt: null,
        },
      ],
    } as never)

    const store = createDbDocNotificationsStore()
    const rows = await store.listForUser(RECIP1, WS)

    expect(mockRlsQuery.mock.calls[0][0]).toBe(RECIP1)
    expect(mockRlsQuery.mock.calls[0][1]).toContain('ORDER BY n.created_at DESC')
    expect(rows[0]).toMatchObject({
      id: 'n-1',
      pageTitle: 'Weekly',
      actorName: 'Jane',
      readAt: null,
    })
  })

  it('listForUser maps a room_mention row to InboxRoomMention, not through the page mapper', async () => {
    mockRlsQuery.mockResolvedValue({
      rows: [
        {
          id: 'n-2',
          kind: 'room_mention',
          pageId: null,
          threadId: null,
          sessionId: 'sess-1',
          sessionMessageId: 'msg-1',
          actorUserId: ACTOR,
          actorName: 'Jane',
          pageTitle: null,
          roomTitle: 'Product Room',
          preview: '@Jane Doe can you look at this',
          createdAt: new Date('2026-01-03T00:00:00.000Z'),
          readAt: null,
        },
      ],
    } as never)

    const store = createDbDocNotificationsStore()
    const rows = await store.listForUser(RECIP1, WS)

    // Both kinds are selected — no `AND n.kind = 'mention'` restriction.
    expect(mockRlsQuery.mock.calls[0][1]).toContain("n.kind IN ('mention', 'room_mention')")
    expect(rows[0]).toEqual({
      kind: 'room_mention',
      id: 'n-2',
      sessionId: 'sess-1',
      sessionMessageId: 'msg-1',
      roomTitle: 'Product Room',
      actorUserId: ACTOR,
      actorName: 'Jane',
      preview: '@Jane Doe can you look at this',
      createdAt: '2026-01-03T00:00:00.000Z',
      readAt: null,
    })
    // Never carries page-mention fields — proof it didn't run through mapMention.
    expect(rows[0]).not.toHaveProperty('pageId')
    expect(rows[0]).not.toHaveProperty('pageTitle')
  })

  it('listForUser falls back to an empty roomTitle for an untitled room', async () => {
    mockRlsQuery.mockResolvedValue({
      rows: [
        {
          id: 'n-3',
          kind: 'room_mention',
          pageId: null,
          threadId: null,
          sessionId: 'sess-1',
          sessionMessageId: 'msg-2',
          actorUserId: ACTOR,
          actorName: null,
          pageTitle: null,
          roomTitle: null,
          preview: null,
          createdAt: new Date('2026-01-03T00:00:00.000Z'),
          readAt: null,
        },
      ],
    } as never)
    const store = createDbDocNotificationsStore()
    const rows = await store.listForUser(RECIP1, WS)
    expect(rows[0]).toMatchObject({ kind: 'room_mention', roomTitle: '' })
  })

  // ── Dismiss on read + retention (migration 426) ──────────────

  it('listForUser returns UNREAD mentions only — reading is what clears a row', async () => {
    mockRlsQuery.mockResolvedValue({ rows: [] } as never)
    const store = createDbDocNotificationsStore()
    await store.listForUser(RECIP1, WS)
    expect(mockRlsQuery.mock.calls[0][1]).toContain('n.read_at IS NULL')
  })

  it('listForUser passes the retention cutoff as a nullable bound', async () => {
    mockRlsQuery.mockResolvedValue({ rows: [] } as never)
    const store = createDbDocNotificationsStore()
    const since = new Date('2026-02-01T00:00:00.000Z')

    await store.listForUser(RECIP1, WS, { since })
    // A NULL-tolerant bound, so "never prune" needs no second query shape.
    expect(mockRlsQuery.mock.calls[0][1]).toContain('$2::timestamptz IS NULL OR')
    expect(mockRlsQuery.mock.calls[0][2]).toEqual([WS, since])

    await store.listForUser(RECIP1, WS)
    expect(mockRlsQuery.mock.calls[1][2]).toEqual([WS, null])
  })

  it('unreadCount applies the same window as listForUser so the badge cannot over-count', async () => {
    mockRlsQuery.mockResolvedValue({ rows: [{ count: 3 }] } as never)
    const store = createDbDocNotificationsStore()
    const since = new Date('2026-02-01T00:00:00.000Z')

    const n = await store.unreadCount(RECIP1, WS, { since })
    expect(n).toBe(3)
    expect(mockRlsQuery.mock.calls[0][1]).toContain('read_at IS NULL')
    expect(mockRlsQuery.mock.calls[0][1]).toContain('$2::timestamptz IS NULL OR')
    expect(mockRlsQuery.mock.calls[0][2]).toEqual([WS, since])
  })

  it('unreadCount counts both kinds (PH2) — a room mention counts toward the badge too', async () => {
    mockRlsQuery.mockResolvedValue({ rows: [{ count: 5 }] } as never)
    const store = createDbDocNotificationsStore()
    const n = await store.unreadCount(RECIP1, WS)
    expect(n).toBe(5)
    expect(mockRlsQuery.mock.calls[0][1]).toContain("kind IN ('mention', 'room_mention')")
  })

  it('markRead marks a subset by id (RLS-scoped) or all when no ids given', async () => {
    mockRlsQuery.mockResolvedValue({ rows: [] } as never)
    const store = createDbDocNotificationsStore()

    await store.markRead(RECIP1, { ids: ['n-1', 'n-2'] })
    expect(mockRlsQuery.mock.calls[0][0]).toBe(RECIP1)
    expect(mockRlsQuery.mock.calls[0][1]).toContain('id = ANY($1::uuid[])')
    expect(mockRlsQuery.mock.calls[0][2]).toEqual([['n-1', 'n-2']])

    await store.markRead(RECIP1)
    expect(mockRlsQuery.mock.calls[1][1]).toContain('WHERE read_at IS NULL')
    expect(mockRlsQuery.mock.calls[1][1]).not.toContain('ANY')
  })

  it('unreadCount counts the recipient unread rows in the workspace', async () => {
    mockRlsQuery.mockResolvedValue({ rows: [{ count: 3 }] } as never)
    const store = createDbDocNotificationsStore()
    const n = await store.unreadCount(RECIP1, WS)
    expect(mockRlsQuery.mock.calls[0][1]).toContain('read_at IS NULL')
    expect(n).toBe(3)
  })
})

// ── Room mentions (migration 469, docs/plans/room-human-mentions.md) ─────

describe('[COMP:api/room-mention-store] createDbDocNotificationsStore — room mentions', () => {
  const SESSION = '00000000-0000-0000-0000-0000000000d1'
  const MESSAGE = '00000000-0000-0000-0000-0000000000d2'

  it('recordRoomMentions drops the self-mention before querying membership', async () => {
    const store = createDbDocNotificationsStore()
    const created = await store.recordRoomMentions({
      workspaceId: WS,
      sessionId: SESSION,
      sessionMessageId: MESSAGE,
      sessionClearance: 'internal',
      actorUserId: ACTOR,
      recipientUserIds: [ACTOR],
    })
    expect(created).toBe(0)
    expect(mockBareQuery).not.toHaveBeenCalled()
  })

  it('recordRoomMentions drops a candidate who is not a workspace member', async () => {
    mockBareQuery.mockResolvedValueOnce({ rows: [] } as never) // membership: no one
    const store = createDbDocNotificationsStore()
    const created = await store.recordRoomMentions({
      workspaceId: WS,
      sessionId: SESSION,
      sessionMessageId: MESSAGE,
      sessionClearance: 'internal',
      actorUserId: ACTOR,
      recipientUserIds: [RECIP1],
    })
    expect(created).toBe(0)
    // Membership checked, but no INSERT fired.
    expect(mockBareQuery).toHaveBeenCalledTimes(1)
  })

  it('recordRoomMentions drops a recipient whose clearance is below the room effective_clearance', async () => {
    mockBareQuery
      .mockResolvedValueOnce({
        rows: [
          { userId: RECIP1, clearance: 'confidential' },
          { userId: RECIP2, clearance: 'internal' },
        ],
      } as never) // membership + clearance, both are members of WS
      .mockResolvedValueOnce({ rows: [{ id: 'n-1' }], rowCount: 1 } as never) // insert

    const store = createDbDocNotificationsStore()
    const created = await store.recordRoomMentions({
      workspaceId: WS,
      sessionId: SESSION,
      sessionMessageId: MESSAGE,
      sessionClearance: 'confidential',
      actorUserId: ACTOR,
      recipientUserIds: [RECIP1, RECIP2],
    })

    // Membership query selects clearance alongside membership.
    expect(mockBareQuery.mock.calls[0][0]).toContain('clearance')
    // RECIP2 (internal) cannot read a confidential room; only RECIP1 survives
    // into the INSERT's recipient array (last positional arg).
    const insertArgs = mockBareQuery.mock.calls[1][1] as unknown[]
    expect(insertArgs[insertArgs.length - 1]).toEqual([RECIP1])
    expect(created).toBe(1)
  })

  it('recordRoomMentions with no sessionClearance gates nobody (mirrors gateSessionRead)', async () => {
    mockBareQuery
      .mockResolvedValueOnce({ rows: [{ userId: RECIP1, clearance: 'public' }] } as never)
      .mockResolvedValueOnce({ rows: [{ id: 'n-1' }], rowCount: 1 } as never)

    const store = createDbDocNotificationsStore()
    const created = await store.recordRoomMentions({
      workspaceId: WS,
      sessionId: SESSION,
      sessionMessageId: MESSAGE,
      sessionClearance: null,
      actorUserId: ACTOR,
      recipientUserIds: [RECIP1],
    })
    expect(created).toBe(1)
    const insertArgs = mockBareQuery.mock.calls[1][1] as unknown[]
    expect(insertArgs[insertArgs.length - 1]).toEqual([RECIP1])
  })

  it('recordRoomMentions upserts on (session_message_id, recipient_user_id) so a re-add re-surfaces an already-read row', async () => {
    mockBareQuery
      .mockResolvedValueOnce({ rows: [{ userId: RECIP1, clearance: 'public' }] } as never)
      .mockResolvedValueOnce({ rows: [{ id: 'n-1' }], rowCount: 1 } as never)

    const store = createDbDocNotificationsStore()
    await store.recordRoomMentions({
      workspaceId: WS,
      sessionId: SESSION,
      sessionMessageId: MESSAGE,
      sessionClearance: 'public',
      actorUserId: ACTOR,
      recipientUserIds: [RECIP1],
      preview: '  hi @Jane  ',
    })

    const insertSql = mockBareQuery.mock.calls[1][0] as string
    // Targets the migration-469 partial unique index; re-adding a name whose
    // row was read clears read_at instead of inserting a duplicate (D-H6).
    expect(insertSql).toContain(
      'ON CONFLICT (session_message_id, recipient_user_id) WHERE session_message_id IS NOT NULL',
    )
    expect(insertSql).toContain('DO UPDATE SET read_at = NULL, preview = EXCLUDED.preview')
    const insertArgs = mockBareQuery.mock.calls[1][1] as unknown[]
    expect(insertArgs).toContain('hi @Jane') // preview clamped, same as recordMentions
  })

  it('retractRoomMentions deletes only unread rows for the given message/recipients', async () => {
    mockBareQuery.mockResolvedValueOnce({ rows: [{ id: 'n-1' }], rowCount: 1 } as never)
    const store = createDbDocNotificationsStore()
    const removed = await store.retractRoomMentions({
      sessionMessageId: MESSAGE,
      recipientUserIds: [RECIP1, RECIP2],
    })
    expect(removed).toBe(1)
    const [sql, args] = mockBareQuery.mock.calls[0]
    expect(sql).toContain('read_at IS NULL')
    expect(args).toEqual([MESSAGE, [RECIP1, RECIP2]])
  })

  it('retractRoomMentions no-ops for an empty recipient list', async () => {
    const store = createDbDocNotificationsStore()
    const removed = await store.retractRoomMentions({
      sessionMessageId: MESSAGE,
      recipientUserIds: [],
    })
    expect(removed).toBe(0)
    expect(mockBareQuery).not.toHaveBeenCalled()
  })
})
