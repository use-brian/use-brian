/**
 * Unit tests for the doc Inbox routes.
 * Component tag: [COMP:api/inbox-routes].
 *
 * Injects fake stores + a fake retention port. Covers the auth gate, the
 * merged payload, that ONE retention cutoff is resolved and handed to both
 * lanes, and the dismiss route.
 *
 * Spec: docs/architecture/features/doc-inbox.md.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

import { inboxRoutes } from '../inbox.js'
import type { CommentThreadStore, DocNotificationsStore } from '@use-brian/core'

const USER = 'u-1'
const WS = 'ws-1'

function pendingRow(over: Record<string, unknown> = {}) {
  return {
    threadId: 't-1',
    pageId: 'p-1',
    pageTitle: 'Weekly',
    quote: null,
    lastActivityAt: '2026-03-01T00:00:00.000Z',
    ...over,
  }
}

function mentionRow(over: Record<string, unknown> = {}) {
  return {
    kind: 'mention',
    id: 'n-1',
    pageId: 'p-1',
    pageTitle: 'Weekly',
    threadId: null,
    actorUserId: 'u-2',
    actorName: 'Ada',
    preview: 'hey @you',
    createdAt: '2026-03-01T00:00:00.000Z',
    readAt: null,
    ...over,
  }
}

// Room mention (migration 469, PH2 of docs/plans/room-human-mentions.md) —
// the route is store-shape-agnostic, so these exercise that a room_mention
// row rides the same merged payload + read path as a page mention.
function roomMentionRow(over: Record<string, unknown> = {}) {
  return {
    kind: 'room_mention',
    id: 'n-2',
    sessionId: 's-1',
    sessionMessageId: 'm-1',
    roomTitle: 'Product Room',
    actorUserId: 'u-2',
    actorName: 'Ada',
    preview: '@Jane Doe can you look at this',
    createdAt: '2026-03-01T00:00:00.000Z',
    readAt: null,
    ...over,
  }
}

function makeApp(opts: {
  pending?: unknown[]
  mentions?: unknown[]
  retentionDays?: number | null
  authed?: boolean
}) {
  const listPendingRepliesForUser = vi.fn().mockResolvedValue(opts.pending ?? [])
  const dismissPendingReply = vi.fn().mockResolvedValue(undefined)
  const listForUser = vi.fn().mockResolvedValue(opts.mentions ?? [])
  const markRead = vi.fn().mockResolvedValue(undefined)
  const getInboxRetentionDays = vi.fn().mockResolvedValue(opts.retentionDays ?? null)

  const app = express()
  app.use(express.json())
  if (opts.authed !== false) {
    app.use((req, _res, next) => {
      ;(req as { userId?: string }).userId = USER
      next()
    })
  }
  app.use(
    '/api',
    inboxRoutes({
      commentThreadStore: {
        listPendingRepliesForUser,
        dismissPendingReply,
      } as unknown as CommentThreadStore,
      docNotificationsStore: {
        listForUser,
        markRead,
      } as unknown as DocNotificationsStore,
      getInboxRetentionDays,
    }),
  )
  return { app, listPendingRepliesForUser, dismissPendingReply, listForUser, markRead, getInboxRetentionDays }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:api/inbox-routes] inboxRoutes', () => {
  it('401s an unauthenticated request', async () => {
    const { app } = makeApp({ authed: false })
    await request(app).get(`/api/workspaces/${WS}/inbox`).expect(401)
  })

  it('merges both lanes and counts them', async () => {
    const { app } = makeApp({
      pending: [pendingRow(), pendingRow({ threadId: 't-2' })],
      mentions: [mentionRow()],
    })
    const res = await request(app).get(`/api/workspaces/${WS}/inbox`).expect(200)
    expect(res.body.pending).toHaveLength(2)
    expect(res.body.mentions).toHaveLength(1)
    expect(res.body.pendingCount).toBe(2)
    expect(res.body.unreadMentionCount).toBe(1)
  })

  it('merges a room mention alongside a page mention in the same lane (PH2)', async () => {
    const { app } = makeApp({
      mentions: [mentionRow(), roomMentionRow()],
    })
    const res = await request(app).get(`/api/workspaces/${WS}/inbox`).expect(200)
    expect(res.body.mentions).toHaveLength(2)
    expect(res.body.unreadMentionCount).toBe(2)
    const kinds = res.body.mentions.map((m: { kind: string }) => m.kind).sort()
    expect(kinds).toEqual(['mention', 'room_mention'])
    const room = res.body.mentions.find((m: { kind: string }) => m.kind === 'room_mention')
    expect(room).toMatchObject({ sessionId: 's-1', sessionMessageId: 'm-1', roomTitle: 'Product Room' })
  })

  it('resolves ONE cutoff and passes the same instant to both lanes', async () => {
    const { app, listPendingRepliesForUser, listForUser, getInboxRetentionDays } = makeApp({
      retentionDays: 30,
    })
    await request(app).get(`/api/workspaces/${WS}/inbox`).expect(200)

    expect(getInboxRetentionDays).toHaveBeenCalledWith(WS)
    const pendingSince = listPendingRepliesForUser.mock.calls[0][2].since as Date
    const mentionSince = listForUser.mock.calls[0][2].since as Date
    expect(pendingSince).toBeInstanceOf(Date)
    // Same instant for both halves — a slow request must not prune them
    // against different clocks.
    expect(mentionSince.getTime()).toBe(pendingSince.getTime())
    // ~30 days back.
    const daysBack = (Date.now() - pendingSince.getTime()) / 86_400_000
    expect(daysBack).toBeGreaterThan(29.9)
    expect(daysBack).toBeLessThan(30.1)
  })

  it('passes a null cutoff to both lanes when the workspace never prunes', async () => {
    const { app, listPendingRepliesForUser, listForUser } = makeApp({ retentionDays: null })
    await request(app).get(`/api/workspaces/${WS}/inbox`).expect(200)
    expect(listPendingRepliesForUser.mock.calls[0][2]).toEqual({ since: null })
    expect(listForUser.mock.calls[0][2]).toEqual({ since: null })
  })

  it('dismiss records the pending reply for the caller and 204s', async () => {
    const { app, dismissPendingReply } = makeApp({})
    await request(app)
      .post(`/api/workspaces/${WS}/inbox/dismiss`)
      .send({ threadId: 't-1' })
      .expect(204)
    expect(dismissPendingReply).toHaveBeenCalledWith(USER, WS, 't-1')
  })

  it('dismiss 400s without a threadId and 401s unauthenticated', async () => {
    const { app, dismissPendingReply } = makeApp({})
    await request(app).post(`/api/workspaces/${WS}/inbox/dismiss`).send({}).expect(400)
    expect(dismissPendingReply).not.toHaveBeenCalled()

    const { app: anon } = makeApp({ authed: false })
    await request(anon)
      .post(`/api/workspaces/${WS}/inbox/dismiss`)
      .send({ threadId: 't-1' })
      .expect(401)
  })

  it('read marks the given mention ids read', async () => {
    const { app, markRead } = makeApp({})
    await request(app)
      .post(`/api/workspaces/${WS}/inbox/read`)
      .send({ ids: ['n-1'] })
      .expect(204)
    expect(markRead).toHaveBeenCalledWith(USER, { ids: ['n-1'] })
  })

  it('read marks a room mention id exactly as it does a page mention (PH2)', async () => {
    const { app, markRead } = makeApp({})
    await request(app)
      .post(`/api/workspaces/${WS}/inbox/read`)
      .send({ ids: ['n-2'] })
      .expect(204)
    expect(markRead).toHaveBeenCalledWith(USER, { ids: ['n-2'] })
  })
})
