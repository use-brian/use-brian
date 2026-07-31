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
  getUserAssistant: vi.fn(),
  getUserProfilesByIds: vi.fn(async () => new Map()),
  getWorkspacePrimaryAssistant: vi.fn(),
}))

vi.mock('../../db/sessions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/sessions.js')>()
  return {
    ...actual,
    findSessionById: vi.fn(),
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
  }
})

import { sessionRoutes } from '../sessions.js'
import { addSessionMessage, findSessionById } from '../../db/sessions.js'
import type { SessionEvent } from '../../session-event-port.js'

const mockFindSession = vi.mocked(findSessionById)
const mockAddMessage = vi.mocked(addSessionMessage)

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
    }),
  )
  return app
}

beforeEach(() => {
  mockFindSession.mockReset()
  mockAddMessage.mockClear()
})

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
