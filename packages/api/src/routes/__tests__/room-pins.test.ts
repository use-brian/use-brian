/**
 * [COMP:api/room-pins] — pinned room context (multiplayer chat P1b).
 *
 * Two halves:
 *   - The CRUD routes (T14): pinning is post-gated (`gateSessionRead`, shared
 *     chat sessions only) and attributed (`added_by_user_id`); changes emit
 *     `pins_changed` on the per-session bus.
 *   - Assembly resolution (T15): the pin block is an INDEX — a pinned task
 *     renders as a compact current-state card, a pinned page as title +
 *     id ONLY (never its body), a pin above the session's clearance renders
 *     as "unavailable" (never silently dropped), and the whole block
 *     respects its character budget.
 *
 * Spec: docs/architecture/features/chat-app.md → "Pinned room context".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

// ── Route-half mocks ────────────────────────────────────────────

vi.mock('../../db/client.js', () => ({
  query: vi.fn(async (sql: string) => {
    if (sql.includes('FROM assistants')) {
      return { rows: [{ workspaceId: 'ws-1' }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }),
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
  getUserProfilesByIds: vi.fn(async () => new Map([['u-2', { name: 'Bob', avatarUrl: null }]])),
  getWorkspacePrimaryAssistant: vi.fn(),
}))

vi.mock('../../db/sessions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/sessions.js')>()
  return { ...actual, findSessionById: vi.fn(), addSessionMessage: vi.fn() }
})

vi.mock('../../db/session-pins-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/session-pins-store.js')>()
  return {
    ...actual,
    listSessionPins: vi.fn(async () => []),
    addSessionPin: vi.fn(async (p: { sessionId: string; kind: string; addedByUserId: string }) => ({
      id: 'pin-1',
      sessionId: p.sessionId,
      kind: p.kind,
      refId: null,
      url: null,
      text: null,
      position: 1,
      addedByUserId: p.addedByUserId,
      createdAt: new Date(),
    })),
    removeSessionPin: vi.fn(async () => true),
  }
})

vi.mock('../../resolve-session-pins.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../resolve-session-pins.js')>()
  return {
    ...actual,
    resolveSessionPinLabels: vi.fn(async () => new Map()),
  }
})

import { sessionRoutes } from '../sessions.js'
import { findSessionById } from '../../db/sessions.js'
import { addSessionPin, removeSessionPin } from '../../db/session-pins-store.js'
import type { SessionEvent } from '../../session-event-port.js'

const mockFindSession = vi.mocked(findSessionById)
const mockAddPin = vi.mocked(addSessionPin)
const mockRemovePin = vi.mocked(removeSessionPin)

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

function makeApp(published: SessionEvent[] = []) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as { userId?: string }).userId = 'u-2'
    next()
  })
  app.use('/api/sessions', sessionRoutes({ publishSessionEvent: (e) => published.push(e) }))
  return app
}

beforeEach(() => {
  mockFindSession.mockReset()
  mockAddPin.mockClear()
  mockRemovePin.mockClear()
})

describe('[COMP:api/room-pins] pin CRUD is post-gated and attributed (T14)', () => {
  it('a member pins into a shared chat, attributed, and the bus signals', async () => {
    const published: SessionEvent[] = []
    mockFindSession.mockResolvedValue(roomSession())
    const res = await request(makeApp(published))
      .post('/api/sessions/s-room/pins')
      .send({ kind: 'task', refId: '11111111-2222-3333-4444-555555555555' })
    expect(res.status).toBe(201)
    expect(mockAddPin).toHaveBeenCalledTimes(1)
    expect(mockAddPin.mock.calls[0][0]).toMatchObject({
      sessionId: 's-room',
      kind: 'task',
      refId: '11111111-2222-3333-4444-555555555555',
      addedByUserId: 'u-2',
    })
    expect(published).toEqual([
      { kind: 'pins_changed', sessionId: 's-room', payload: { byUserId: 'u-2' } },
    ])
  })

  it('refuses pinning on a personal session', async () => {
    mockFindSession.mockResolvedValue(roomSession({ visibility: 'owner', effectiveClearance: null }))
    const res = await request(makeApp())
      .post('/api/sessions/s-1/pins')
      .send({ kind: 'instruction', text: 'x' })
    expect(res.status).toBe(403)
    expect(mockAddPin).not.toHaveBeenCalled()
  })

  it('validates payload per kind (bad refId / bad URL rejected)', async () => {
    mockFindSession.mockResolvedValue(roomSession())
    const app = makeApp()
    expect(
      (await request(app).post('/api/sessions/s-room/pins').send({ kind: 'task', refId: 'nope' })).status,
    ).toBe(400)
    expect(
      (await request(app).post('/api/sessions/s-room/pins').send({ kind: 'url', url: 'ftp://x' })).status,
    ).toBe(400)
    expect(
      (await request(app).post('/api/sessions/s-room/pins').send({ kind: 'bogus' })).status,
    ).toBe(400)
  })

  it('unpin emits the same signal and is session-scoped', async () => {
    const published: SessionEvent[] = []
    mockFindSession.mockResolvedValue(roomSession())
    const res = await request(makeApp(published)).delete('/api/sessions/s-room/pins/pin-1')
    expect(res.status).toBe(200)
    expect(mockRemovePin).toHaveBeenCalledWith('s-room', 'pin-1')
    expect(published[0]?.kind).toBe('pins_changed')
  })
})

// ── Assembly-half (T15): buildPinnedContextBlock over a mocked db ──

import { query } from '../../db/client.js'
import { listSessionPins, type SessionPin } from '../../db/session-pins-store.js'
import { buildPinnedContextBlock } from '../../resolve-session-pins.js'

const mockQuery = vi.mocked(query)
const mockListPins = vi.mocked(listSessionPins)

function pin(over: Partial<SessionPin>): SessionPin {
  return {
    id: `pin-${Math.abs(JSON.stringify(over).length)}-${over.kind}-${over.refId ?? ''}`,
    sessionId: 's-room',
    kind: 'task',
    refId: null,
    url: null,
    text: null,
    position: 0,
    addedByUserId: 'u-2',
    createdAt: new Date('2026-07-31T10:00:00Z'),
    ...over,
  } as SessionPin
}

describe('[COMP:api/room-pins] assembly resolution is an index, not stuffing (T15)', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('a pinned task renders a compact current-state card; a pinned page renders title + id ONLY', async () => {
    mockListPins.mockResolvedValue([
      pin({ kind: 'task', refId: 'aaaaaaaa-0000-0000-0000-000000000001' }),
      pin({ kind: 'page', refId: 'bbbbbbbb-0000-0000-0000-000000000002' }),
    ])
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM tasks')) {
        return {
          rows: [{ title: 'Ship the Q3 deck', status: 'in_progress', due: new Date('2026-08-02T00:00:00Z'), sensitivity: 'internal' }],
          rowCount: 1,
        } as never
      }
      if (sql.includes('FROM saved_views')) {
        return {
          rows: [{ name: 'Q3 launch plan', clearance: 'internal' }],
          rowCount: 1,
        } as never
      }
      return { rows: [], rowCount: 0 } as never
    })

    const block = await buildPinnedContextBlock({
      sessionId: 's-room',
      workspaceId: 'ws-1',
      clearance: 'internal',
    })
    expect(block).toContain('# Pinned context')
    // Task: compact inline card with current state.
    expect(block).toContain('Task "Ship the Q3 deck" (in_progress, due 2026-08-02)')
    // Page: title + reference only — NEVER its body.
    expect(block).toContain('Page "Q3 launch plan" [page id: bbbbbbbb-0000-0000-0000-000000000002]')
    expect(block).toContain('not inlined')
    // Tool-awareness rule: no tool names in the block.
    expect(block).not.toMatch(/readPage|searchKnowledge|browseKnowledge|getTask/)
  })

  it('a pin above the session clearance resolves as unavailable, never silently dropped', async () => {
    mockListPins.mockResolvedValue([
      pin({ kind: 'task', refId: 'aaaaaaaa-0000-0000-0000-000000000001' }),
    ])
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM tasks')) {
        return {
          rows: [{ title: 'Board compensation review', status: 'todo', due: null, sensitivity: 'confidential' }],
          rowCount: 1,
        } as never
      }
      return { rows: [], rowCount: 0 } as never
    })
    const block = await buildPinnedContextBlock({
      sessionId: 's-room',
      workspaceId: 'ws-1',
      clearance: 'internal',
    })
    expect(block).toContain('unavailable')
    expect(block).not.toContain('Board compensation review')
  })

  it('respects the block budget — oldest pins degrade / drop behind an omission note', async () => {
    // Ten 2k-char instructions = ~20k chars of payload against a ~12k cap.
    mockListPins.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) =>
        pin({ kind: 'instruction', text: `[i${i}] ${'x'.repeat(1_990)}`, refId: null, id: `pin-${i}` } as Partial<SessionPin>),
      ),
    )
    const block = await buildPinnedContextBlock({
      sessionId: 's-room',
      workspaceId: 'ws-1',
      clearance: 'internal',
    })
    expect(block).not.toBeNull()
    expect(block!.length).toBeLessThanOrEqual(13_000)
    // The newest instruction survives; the oldest is behind the note.
    expect(block).toContain('[i9]')
    expect(block).not.toContain('[i0]')
    expect(block).toContain('omitted')
  })

  it('returns null for a room with no pins', async () => {
    mockListPins.mockResolvedValue([])
    expect(
      await buildPinnedContextBlock({ sessionId: 's-room', workspaceId: 'ws-1', clearance: 'internal' }),
    ).toBeNull()
  })
})
