/**
 * [COMP:api/room-mechanics] — the room POST path + follow-mode stream.
 *
 * Route-level tests (supertest + mocked stores) for the two HTTP halves of
 * the room primitive (docs/plans/multiplayer-chat.md T2/T13):
 *
 *   - `POST /api/sessions/:id/messages` persists one attributed user row,
 *     emits `user_message_saved` on the per-session bus, runs NO turn, and is
 *     NEVER busy-gated — a post during a live turn (status='running') is
 *     accepted, which is the D2 "no `shared_session_busy` on the human path"
 *     contract.
 *   - `GET /api/sessions/:id/stream` in FOLLOW mode relays the live turn's
 *     activity mirror (tool steps, reasoning snapshots) to a SECOND
 *     subscriber during a shared-session turn, plus teammate posts, and does
 *     not close while the room idles.
 *
 * Spec: docs/architecture/features/chat-app.md → "The room model".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { AddressInfo } from 'node:net'
import http from 'node:http'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(async () => ({ rows: [{ workspaceId: 'ws-1' }], rowCount: 1 })),
}))

vi.mock('../../db/workspace-store.js', () => ({
  getWorkspaceMembershipWithClearanceSystem: vi.fn(async () => ({ clearance: 'confidential' })),
  getWorkspaceRoleSystem: vi.fn(async () => 'member'),
}))

vi.mock('../route-helpers.js', () => ({
  resolveUser: vi.fn(async () => ({ id: 'u-2', name: 'Bob' })),
}))

vi.mock('../../db/users.js', () => ({
  findOrCreateUser: vi.fn(),
  getDefaultAssistant: vi.fn(),
  getUserAssistant: vi.fn(async (_userId: string, assistantId: string) =>
    assistantId === 'a-sales'
      ? { id: 'a-sales', workspaceId: 'ws-1', name: 'Sales' }
      : assistantId === 'a-foreign'
        ? { id: 'a-foreign', workspaceId: 'ws-OTHER', name: 'Elsewhere' }
        : null,
  ),
  getUserProfilesByIds: vi.fn(async () => new Map()),
  getWorkspacePrimaryAssistant: vi.fn(async () => ({ id: 'a-primary', workspaceId: 'ws-1', name: 'Gm' })),
}))

vi.mock('../../db/sessions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/sessions.js')>()
  return {
    ...actual,
    findSessionById: vi.fn(),
    createWorkspaceChatSession: vi.fn(async (params: { assistantId: string; starterUserId: string; workspaceId: string; effectiveClearance: string | null }) => ({
      id: 's-new',
      assistantId: params.assistantId,
      userId: params.starterUserId,
      channelType: 'web',
      channelId: 'chan-new',
      appId: 'Use Brian',
      appOrigin: 'chat',
      status: 'idle',
      compactSummary: null,
      compactionCount: 0,
      compactBoundarySequence: null,
      title: null,
      downgradeNoticeSent: false,
      downgradeNoticePinMessageId: null,
      mode: null,
      visibility: 'workspace',
      effectiveClearance: params.effectiveClearance,
      createdAt: new Date(),
      lastActiveAt: new Date(),
    })),
    addSessionMessage: vi.fn(async (params: { sessionId: string; role: string; content: unknown; senderUserId?: string | null }) => ({
      id: 'msg-1',
      sessionId: params.sessionId,
      role: params.role,
      content: params.content,
      sequenceNum: 7,
      createdAt: new Date('2026-07-31T10:00:00Z'),
      replyToText: null,
      topicLabel: null,
      topicConfidence: null,
      channelMessageId: null,
      senderUserId: params.senderUserId ?? null,
      attachments: [],
    })),
    getSessionMessageById: vi.fn(),
    updateSessionMessageText: vi.fn(async (params: { messageId: string; sessionId: string; text: string }) => ({
      id: params.messageId,
      sessionId: params.sessionId,
      role: 'user',
      content: [{ type: 'text', text: params.text }],
      sequenceNum: 7,
      createdAt: new Date('2026-07-31T10:00:00Z'),
      replyToText: null,
      topicLabel: null,
      topicConfidence: null,
      channelMessageId: null,
      senderUserId: 'u-2',
      senderAssistantId: null,
      attachments: [],
    })),
  }
})

import { sessionRoutes } from '../sessions.js'
import {
  addSessionMessage,
  createWorkspaceChatSession,
  findSessionById,
  getSessionMessageById,
  updateSessionMessageText,
} from '../../db/sessions.js'
import type { SessionEvent } from '../../session-event-port.js'

const mockFindSession = vi.mocked(findSessionById)
const mockAddMessage = vi.mocked(addSessionMessage)
const mockGetMessage = vi.mocked(getSessionMessageById)
const mockUpdateMessage = vi.mocked(updateSessionMessageText)

function roomSession(over: Record<string, unknown> = {}) {
  return {
    id: 's-room',
    assistantId: 'a-1',
    userId: 'u-starter',
    channelType: 'web',
    channelId: 'chan-1',
    appId: 'Use Brian',
    appOrigin: 'chat',
    status: 'idle',
    compactSummary: null,
    compactionCount: 0,
    compactBoundarySequence: null,
    title: 'General',
    downgradeNoticeSent: false,
    downgradeNoticePinMessageId: null,
    mode: null,
    visibility: 'workspace',
    effectiveClearance: 'internal',
    createdAt: new Date(),
    lastActiveAt: new Date(),
    ...over,
  } as Awaited<ReturnType<typeof findSessionById>>
}

function makeApp(opts?: {
  published?: SessionEvent[]
  subscribers?: Array<(e: SessionEvent) => void>
  typing?: Array<{ sessionId: string; userId: string; isTyping: boolean }>
}) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as { userId?: string }).userId = 'u-2'
    next()
  })
  app.use(
    '/api/sessions',
    sessionRoutes({
      publishSessionEvent: (e) => opts?.published?.push(e),
      subscribeSessionEvents: ({ cb }) => {
        opts?.subscribers?.push(cb)
        return () => {
          const i = opts?.subscribers?.indexOf(cb) ?? -1
          if (i >= 0) opts?.subscribers?.splice(i, 1)
        }
      },
      setSessionTyping: (p) => opts?.typing?.push(p),
    }),
  )
  return app
}

beforeEach(() => {
  mockFindSession.mockReset()
  mockAddMessage.mockClear()
  mockGetMessage.mockReset()
  mockUpdateMessage.mockClear()
})

function storedPost(over: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    sessionId: 's-room',
    role: 'user',
    content: [{ type: 'text', text: 'reconcile the orders' }],
    sequenceNum: 7,
    createdAt: new Date('2026-07-31T10:00:00Z'),
    replyToText: null,
    topicLabel: null,
    topicConfidence: null,
    channelMessageId: null,
    senderUserId: 'u-2',
    senderAssistantId: null,
    attachments: [],
    ...over,
  } as Awaited<ReturnType<typeof getSessionMessageById>>
}

describe('[COMP:api/room-mechanics] POST /api/sessions/:id/messages (T2)', () => {
  it('persists one attributed user row, emits on the bus, and runs no turn', async () => {
    const published: SessionEvent[] = []
    mockFindSession.mockResolvedValue(roomSession())
    const res = await request(makeApp({ published }))
      .post('/api/sessions/s-room/messages')
      .send({ message: 'shipping friday then?' })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ id: 'msg-1', sequenceNum: 7 })

    // One row, role user, attributed to the poster — never the starter.
    expect(mockAddMessage).toHaveBeenCalledTimes(1)
    expect(mockAddMessage.mock.calls[0][0]).toMatchObject({
      sessionId: 's-room',
      role: 'user',
      senderUserId: 'u-2',
      content: [{ type: 'text', text: 'shipping friday then?' }],
    })

    // Live fan-in signal for every open viewer.
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      kind: 'user_message_saved',
      sessionId: 's-room',
      payload: { id: 'msg-1', senderUserId: 'u-2' },
    })
  })

  it('is accepted while a turn is LIVE — never `shared_session_busy` (D2)', async () => {
    mockFindSession.mockResolvedValue(roomSession({ status: 'running' }))
    const res = await request(makeApp({ published: [] }))
      .post('/api/sessions/s-room/messages')
      .send({ message: 'posting mid-turn' })
    expect(res.status).toBe(201)
    expect(mockAddMessage).toHaveBeenCalledTimes(1)
  })

  it('refuses a personal session (posting is a room primitive)', async () => {
    mockFindSession.mockResolvedValue(roomSession({ visibility: 'owner', effectiveClearance: null }))
    const res = await request(makeApp())
      .post('/api/sessions/s-1/messages')
      .send({ message: 'hi' })
    expect(res.status).toBe(403)
    expect(mockAddMessage).not.toHaveBeenCalled()
  })

  it('refuses a workspace-visible NON-chat session (doc threads keep their lifecycle)', async () => {
    mockFindSession.mockResolvedValue(
      roomSession({ channelType: 'doc_thread', appOrigin: 'doc' }),
    )
    const res = await request(makeApp())
      .post('/api/sessions/s-1/messages')
      .send({ message: 'hi' })
    expect(res.status).toBe(403)
  })

  it('rejects an empty post', async () => {
    mockFindSession.mockResolvedValue(roomSession())
    const res = await request(makeApp())
      .post('/api/sessions/s-room/messages')
      .send({ message: '   ' })
    expect(res.status).toBe(400)
    expect(mockAddMessage).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/room-mechanics] PATCH /api/sessions/:id/messages/:messageId', () => {
  it('rewrites the row in place, keeps its identity, and fans the edit out', async () => {
    const published: SessionEvent[] = []
    mockFindSession.mockResolvedValue(roomSession())
    mockGetMessage.mockResolvedValue(storedPost())

    const res = await request(makeApp({ published }))
      .patch('/api/sessions/s-room/messages/msg-1')
      .send({ message: '@Blendit reconcile the orders' })

    expect(res.status).toBe(200)
    expect(mockUpdateMessage).toHaveBeenCalledWith({
      messageId: 'msg-1',
      sessionId: 's-room',
      text: '@Blendit reconcile the orders',
    })
    // No second row: an in-place edit must never read as a repost.
    expect(mockAddMessage).not.toHaveBeenCalled()
    expect(res.body).toMatchObject({ id: 'msg-1', sequenceNum: 7 })
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      kind: 'user_message_saved',
      sessionId: 's-room',
      payload: {
        id: 'msg-1',
        content: [{ type: 'text', text: '@Blendit reconcile the orders' }],
      },
    })
  })

  it("refuses a teammate's message — read access is not write access", async () => {
    mockFindSession.mockResolvedValue(roomSession())
    mockGetMessage.mockResolvedValue(storedPost({ senderUserId: 'u-someone-else' }))

    const res = await request(makeApp())
      .patch('/api/sessions/s-room/messages/msg-1')
      .send({ message: 'putting words in their mouth' })

    expect(res.status).toBe(403)
    expect(mockUpdateMessage).not.toHaveBeenCalled()
  })

  it('refuses an assistant row', async () => {
    mockFindSession.mockResolvedValue(roomSession())
    mockGetMessage.mockResolvedValue(
      storedPost({ role: 'assistant', senderUserId: null }),
    )

    const res = await request(makeApp())
      .patch('/api/sessions/s-room/messages/msg-1')
      .send({ message: 'rewriting the answer' })

    expect(res.status).toBe(403)
    expect(mockUpdateMessage).not.toHaveBeenCalled()
  })

  it('refuses a message whose content is not plain text', async () => {
    mockFindSession.mockResolvedValue(roomSession())
    mockGetMessage.mockResolvedValue(
      storedPost({
        content: [
          { type: 'image', source: { type: 'base64', data: 'x' } },
          { type: 'text', text: 'see attached' },
        ],
      }),
    )

    const res = await request(makeApp())
      .patch('/api/sessions/s-room/messages/msg-1')
      .send({ message: 'see attached (fixed)' })

    // A text-block rewrite would silently drop the image.
    expect(res.status).toBe(409)
    expect(mockUpdateMessage).not.toHaveBeenCalled()
  })

  it('refuses a message from another session', async () => {
    mockFindSession.mockResolvedValue(roomSession())
    mockGetMessage.mockResolvedValue(storedPost({ sessionId: 's-other-room' }))

    const res = await request(makeApp())
      .patch('/api/sessions/s-room/messages/msg-1')
      .send({ message: 'cross-room edit' })

    expect(res.status).toBe(404)
    expect(mockUpdateMessage).not.toHaveBeenCalled()
  })

  it('refuses a personal session (editing is a room primitive)', async () => {
    mockFindSession.mockResolvedValue(
      roomSession({ visibility: 'owner', effectiveClearance: null }),
    )
    const res = await request(makeApp())
      .patch('/api/sessions/s-1/messages/msg-1')
      .send({ message: 'hi' })
    expect(res.status).toBe(403)
    expect(mockUpdateMessage).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/room-mechanics] POST /api/sessions/:id/typing — the room typing beacon', () => {
  it('updates the presence entry through the injected bus setter', async () => {
    const typing: Array<{ sessionId: string; userId: string; isTyping: boolean }> = []
    mockFindSession.mockResolvedValue(roomSession())
    const res = await request(makeApp({ typing }))
      .post('/api/sessions/s-room/typing')
      .send({ isTyping: true })
    expect(res.status).toBe(204)
    expect(typing).toEqual([{ sessionId: 's-room', userId: 'u-2', isTyping: true }])
  })

  it('coerces a non-boolean body to false (the off-beacon default)', async () => {
    const typing: Array<{ sessionId: string; userId: string; isTyping: boolean }> = []
    mockFindSession.mockResolvedValue(roomSession())
    const res = await request(makeApp({ typing }))
      .post('/api/sessions/s-room/typing')
      .send({ isTyping: 'yes' })
    expect(res.status).toBe(204)
    expect(typing[0]?.isTyping).toBe(false)
  })

  it('refuses a personal session (typing is a room primitive)', async () => {
    const typing: Array<{ sessionId: string; userId: string; isTyping: boolean }> = []
    mockFindSession.mockResolvedValue(roomSession({ visibility: 'owner', effectiveClearance: null }))
    const res = await request(makeApp({ typing }))
      .post('/api/sessions/s-1/typing')
      .send({ isTyping: true })
    expect(res.status).toBe(403)
    expect(typing).toHaveLength(0)
  })
})

describe('[COMP:api/room-mechanics] GET /api/sessions/:id/stream — follow mode (T13)', () => {
  it('relays the live turn activity mirror + teammate posts to a second subscriber, and stays open while idle', async () => {
    const subscribers: Array<(e: SessionEvent) => void> = []
    // The room is MID-TURN (a teammate's turn is streaming over their own
    // POST); this GET is the second subscriber — the viewer.
    mockFindSession.mockResolvedValue(roomSession({ status: 'running' }))
    const app = makeApp({ subscribers })
    const server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port

    try {
      const done = new Promise<string>((resolve, reject) => {
        const req = http.get(
          `http://127.0.0.1:${port}/api/sessions/s-room/stream`,
          (res) => {
            expect(res.statusCode).toBe(200)
            let data = ''
            res.on('data', (chunk: Buffer) => {
              data += chunk.toString()
              // Once every expected frame arrived, hang up client-side —
              // follow mode never sends `done` on idle.
              if (
                data.includes('turn_completed') &&
                data.includes('event: activity') &&
                data.includes('event: snapshot') &&
                data.includes('event: user_message_saved')
              ) {
                req.destroy()
                resolve(data)
              }
            })
            res.on('error', () => resolve(data))
          },
        )
        req.on('error', () => {
          /* destroyed by us */
        })
        setTimeout(() => reject(new Error('timed out waiting for SSE frames')), 5000)
      })

      // Wait for the route's subscription, then replay the turn the sender
      // is driving over their own POST: a tool step, the throttled
      // text+reasoning snapshot, a teammate's post, and the turn end.
      await vi.waitFor(() => {
        expect(subscribers.length).toBeGreaterThan(0)
      })
      const feed = (e: SessionEvent) => subscribers.forEach((cb) => cb(e))
      feed({
        kind: 'turn_activity',
        sessionId: 's-room',
        payload: { event: 'tool_start', id: 't1', name: 'searchKnowledge', senderUserId: 'u-1' },
      })
      feed({
        kind: 'turn_stream',
        sessionId: 's-room',
        payload: { text: 'Working on it', activity: null, reasoning: 'considering the ask', senderUserId: 'u-1' },
      })
      feed({
        kind: 'user_message_saved',
        sessionId: 's-room',
        payload: { id: 'msg-9', sequenceNum: 9, senderUserId: 'u-3', content: [{ type: 'text', text: 'also check the deck' }] },
      })
      feed({
        kind: 'turn_completed',
        sessionId: 's-room',
        payload: { senderUserId: 'u-1' },
      })

      const received = await done

      expect(received).toContain('event: status')
      // The turn's tool step, as the sender's own feed would render it.
      expect(received).toContain('event: activity')
      expect(received).toContain('"event":"tool_start"')
      expect(received).toContain('"name":"searchKnowledge"')
      // The throttled text + reasoning snapshot.
      expect(received).toContain('event: snapshot')
      expect(received).toContain('"reasoning":"considering the ask"')
      // A teammate's post fans in on the same stream.
      expect(received).toContain('event: user_message_saved')
      // Turn end is an event, not a close.
      expect(received).toContain('event: turn_completed')
      expect(received).not.toContain('event: done')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('sends an initial presence frame and relays presence transitions (typing indicators)', async () => {
    const subscribers: Array<(e: SessionEvent) => void> = []
    mockFindSession.mockResolvedValue(roomSession())
    const app = makeApp({ subscribers })
    const server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const done = new Promise<string>((resolve, reject) => {
        const req = http.get(
          `http://127.0.0.1:${port}/api/sessions/s-room/stream`,
          (res) => {
            let data = ''
            res.on('data', (chunk: Buffer) => {
              data += chunk.toString()
              if (data.includes('"isTyping":true')) {
                req.destroy()
                resolve(data)
              }
            })
          },
        )
        setTimeout(() => reject(new Error('no presence frames')), 5000)
      })
      await vi.waitFor(() => {
        expect(subscribers.length).toBeGreaterThan(0)
      })
      subscribers.forEach((cb) =>
        cb({
          kind: 'presence',
          sessionId: 's-room',
          payload: {
            viewers: [
              { userId: 'u-3', name: 'Cara', isTyping: true, lastSeen: '2026-08-06T10:00:00.000Z' },
            ],
          },
        }),
      )
      const received = await done
      // The hello frame: who was already present before the first transition.
      expect(received).toContain('event: presence')
      expect(received).toContain('"viewers":[]')
      // The relayed transition carries the typist's name for the indicator.
      expect(received).toContain('"name":"Cara"')
      expect(received).toContain('"isTyping":true')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('feeds events into the registered subscriber (wiring sanity)', async () => {
    // Companion to the end-to-end read above: the fake bus delivers to every
    // registered subscriber, so once the route subscribes, feed the wire.
    const subscribers: Array<(e: SessionEvent) => void> = []
    mockFindSession.mockResolvedValue(roomSession({ status: 'running' }))
    const app = makeApp({ subscribers })
    const server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const done = new Promise<string>((resolve, reject) => {
        const req = http.get(
          `http://127.0.0.1:${port}/api/sessions/s-room/stream`,
          (res) => {
            let data = ''
            res.on('data', (chunk: Buffer) => {
              data += chunk.toString()
              if (data.includes('tool_result')) {
                req.destroy()
                resolve(data)
              }
            })
          },
        )
        setTimeout(() => reject(new Error('no frames')), 5000)
      })
      // Wait for the subscription to register, then emit one event.
      await vi.waitFor(() => {
        expect(subscribers.length).toBeGreaterThan(0)
      })
      subscribers.forEach((cb) =>
        cb({
          kind: 'turn_activity',
          sessionId: 's-room',
          payload: { event: 'tool_result', id: 't1', name: 'searchKnowledge', isError: false, senderUserId: 'u-1' },
        }),
      )
      const received = await done
      expect(received).toContain('"event":"tool_result"')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('[COMP:api/room-mechanics] POST /api/sessions/workspace — assistant binding at creation', () => {
  const mockCreate = vi.mocked(createWorkspaceChatSession)

  beforeEach(() => {
    mockCreate.mockClear()
  })

  it('binds the room to an explicitly picked workspace assistant', async () => {
    const res = await request(makeApp())
      .post('/api/sessions/workspace')
      .send({ workspaceId: 'ws-1', assistantId: 'a-sales' })
    expect(res.status).toBe(201)
    expect(res.body.assistantId).toBe('a-sales')
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ assistantId: 'a-sales', workspaceId: 'ws-1' })
  })

  it('defaults to the workspace primary when no assistant is picked', async () => {
    const res = await request(makeApp())
      .post('/api/sessions/workspace')
      .send({ workspaceId: 'ws-1' })
    expect(res.status).toBe(201)
    expect(res.body.assistantId).toBe('a-primary')
  })

  it("refuses another workspace's assistant (a stale client id must not cross-bind)", async () => {
    const res = await request(makeApp())
      .post('/api/sessions/workspace')
      .send({ workspaceId: 'ws-1', assistantId: 'a-foreign' })
    expect(res.status).toBe(403)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('refuses an assistant the caller has no access to', async () => {
    const res = await request(makeApp())
      .post('/api/sessions/workspace')
      .send({ workspaceId: 'ws-1', assistantId: 'a-unknown' })
    expect(res.status).toBe(403)
    expect(mockCreate).not.toHaveBeenCalled()
  })
})
