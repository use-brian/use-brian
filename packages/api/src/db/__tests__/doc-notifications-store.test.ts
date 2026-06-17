/**
 * [COMP:api/doc-notifications-store] Doc notifications store.
 *
 * Mocks the pg client and verifies recordMentions validates workspace
 * membership + drops self-mentions before a system-side bulk INSERT, and that
 * list/markRead/unreadCount run RLS-scoped to the recipient.
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
