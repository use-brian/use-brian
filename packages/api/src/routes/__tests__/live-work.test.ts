/**
 * Live roster route — tiering + negative space (§6.2).
 * Component tag: [COMP:api/live-work-roster].
 *
 * `db/client.query` and the membership lookup are module-mocked; the
 * §6-a boundary (non-workspace assistants never appear) is enforced by
 * the sessions query's `assistants.workspace_id = $1` join, asserted
 * here against the captured SQL — an integration replay would be
 * stronger, but the join predicate is the whole mechanism.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../db/client.js', () => ({ query: vi.fn() }))
vi.mock('../../db/workspace-store.js', () => ({
  getWorkspaceMembershipWithClearanceSystem: vi.fn(),
}))

import { query } from '../../db/client.js'
import { getWorkspaceMembershipWithClearanceSystem } from '../../db/workspace-store.js'
import {
  liveWorkRoutes,
  deriveSessionState,
  deriveRunState,
  projectSessionRow,
  projectRunRow,
} from '../live-work.js'

const mockQuery = vi.mocked(query)
const mockMembership = vi.mocked(getWorkspaceMembershipWithClearanceSystem)

const WS = '11111111-1111-1111-1111-111111111111'
const CALLER = '22222222-2222-2222-2222-222222222222'
const TEAMMATE = '33333333-3333-3333-3333-333333333333'
const ASSISTANT = '44444444-4444-4444-4444-444444444444'

// Relative to the real clock: the roster route derives state from `new
// Date()` at request time, so an absolute fixture date silently crosses
// TURN_LEASE_STALE_AFTER_MS once the calendar moves on (working -> stalled
// a day after the fixture was written). The pure derive* tests inject
// `now: NOW` explicitly and are invariant to what NOW actually is.
const NOW = new Date()
const FRESH = new Date(NOW.getTime() - 5_000)

function makeApp() {
  const app = express()
  app.use(
    '/api',
    (req, _res, next) => {
      req.userId = CALLER
      next()
    },
    liveWorkRoutes(),
  )
  return app
}

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '55555555-5555-5555-5555-555555555555',
    assistantId: ASSISTANT,
    assistantName: 'Brian',
    assistantIconSeed: 42,
    assistantWorkspaceId: WS,
    userId: CALLER,
    ownerName: 'Caller',
    channelType: 'web',
    appOrigin: null,
    visibility: 'owner',
    mode: null,
    status: 'running',
    effectiveClearance: null,
    title: 'Quarterly recap',
    createdAt: new Date(NOW.getTime() - 3_600_000),
    lastActiveAt: FRESH,
    turnHeartbeatAt: FRESH,
    waiting: false,
    ...overrides,
  }
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '66666666-6666-6666-6666-666666666666',
    workflowId: '77777777-7777-7777-7777-777777777777',
    workflowName: 'Daily digest',
    triggerKind: 'schedule',
    status: 'running',
    currentStepId: 'summarize',
    startedAt: new Date(NOW.getTime() - 1_800_000),
    lastActiveAt: FRESH,
    ...overrides,
  }
}

/** Wire the two roster queries: first call = sessions, second = runs. */
function primeRoster(sessions: unknown[], runs: unknown[]) {
  mockQuery
    .mockResolvedValueOnce({ rows: sessions } as never)
    .mockResolvedValueOnce({ rows: runs } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockMembership.mockResolvedValue({ role: 'member', clearance: 'internal' })
})

describe('[COMP:api/live-work-roster] roster route', () => {
  it('403 when the caller is not a workspace member', async () => {
    mockMembership.mockResolvedValue(null)
    const res = await request(makeApp()).get(`/api/workspaces/${WS}/live`)
    expect(res.status).toBe(403)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it("caller's own running session is a full row with title", async () => {
    primeRoster([sessionRow()], [])
    const res = await request(makeApp()).get(`/api/workspaces/${WS}/live`)
    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(1)
    const item = res.body.items[0]
    expect(item.tier).toBe('full')
    expect(item.title).toBe('Quarterly recap')
    expect(item.state).toBe('working')
    expect(item.canSteer).toBe(true)
  })

  it("teammate's personal session carries EXACTLY the §6.1 presence allowlist", async () => {
    primeRoster([sessionRow({ userId: TEAMMATE, ownerName: 'Teammate' })], [])
    const res = await request(makeApp()).get(`/api/workspaces/${WS}/live`)
    const item = res.body.items[0]
    expect(item.tier).toBe('presence')
    // Negative space pinned: no title, no visibility, nothing content-derived.
    expect(Object.keys(item).sort()).toEqual([
      'assistantIconSeed',
      'assistantId',
      'assistantName',
      'channelType',
      'id',
      'kind',
      'lastActiveAt',
      'ownerName',
      'ownerUserId',
      'startedAt',
      'state',
      'tier',
    ])
    expect(item).not.toHaveProperty('title')
    expect(item).not.toHaveProperty('visibility')
    expect(item.assistantIconSeed).toBe(42)
  })

  it('above-clearance workspace session id appears in NO tier (D5)', async () => {
    const hidden = sessionRow({
      id: '99999999-9999-9999-9999-999999999999',
      userId: TEAMMATE,
      visibility: 'workspace',
      effectiveClearance: 'confidential',
    })
    primeRoster([hidden], [])
    const res = await request(makeApp()).get(`/api/workspaces/${WS}/live`)
    expect(JSON.stringify(res.body)).not.toContain('99999999-9999-9999-9999-999999999999')
    expect(res.body.items).toHaveLength(0)
  })

  it('workspace-visible session within clearance is full for a non-owner', async () => {
    primeRoster(
      [sessionRow({ userId: TEAMMATE, visibility: 'workspace', effectiveClearance: 'internal' })],
      [],
    )
    const res = await request(makeApp()).get(`/api/workspaces/${WS}/live`)
    expect(res.body.items[0].tier).toBe('full')
  })

  it('offers steering only on active turn-inbox-backed personal chat lanes', () => {
    expect(projectSessionRow(sessionRow(), CALLER, 'internal', NOW)?.canSteer).toBe(true)
    expect(projectSessionRow(sessionRow({ channelType: 'doc_thread' }), CALLER, 'internal', NOW)?.canSteer).toBe(true)
    expect(projectSessionRow(sessionRow({ mode: 'draft' }), CALLER, 'internal', NOW)?.canSteer).toBe(false)
    expect(projectSessionRow(sessionRow({ channelType: 'telegram' }), CALLER, 'internal', NOW)?.canSteer).toBe(false)
    expect(projectSessionRow(sessionRow({
      visibility: 'workspace',
      appOrigin: 'chat',
    }), CALLER, 'internal', NOW)?.canSteer).toBe(false)
    expect(projectSessionRow(sessionRow({ status: 'idle' }), CALLER, 'internal', NOW)?.canSteer).toBe(false)
    expect(projectSessionRow(sessionRow({ turnHeartbeatAt: new Date('2026-01-01T00:00:00.000Z') }), CALLER, 'internal', NOW)?.canSteer).toBe(false)
  })

  it('workflow runs merge in with mapped trigger + state', async () => {
    primeRoster([], [runRow(), runRow({ id: '88888888-8888-8888-8888-888888888888', status: 'awaiting_input', triggerKind: 'manual' })])
    const res = await request(makeApp()).get(`/api/workspaces/${WS}/live`)
    const [a, b] = res.body.items
    expect(a.kind).toBe('workflow_run')
    expect(a.trigger).toBe('scheduled')
    expect(a.state).toBe('working')
    expect(a.stepSummary).toBe('summarize')
    expect(b.trigger).toBe('manual')
    expect(b.state).toBe('waiting')
  })

  it('items sort by lastActiveAt, newest first, across kinds', async () => {
    const older = new Date(NOW.getTime() - 60_000)
    primeRoster(
      [sessionRow({ lastActiveAt: older, turnHeartbeatAt: older })],
      [runRow()],
    )
    const res = await request(makeApp()).get(`/api/workspaces/${WS}/live`)
    expect(res.body.items.map((i: { kind: string }) => i.kind)).toEqual(['workflow_run', 'session'])
  })

  it('sessions query scopes by workspace, excludes callee lanes, and ignores stale-turn approvals', async () => {
    primeRoster([], [])
    await request(makeApp()).get(`/api/workspaces/${WS}/live`)
    const sessionsSql = mockQuery.mock.calls[0][0] as string
    expect(sessionsSql).toContain('JOIN assistants a ON a.id = s.assistant_id')
    expect(sessionsSql).toContain('COALESCE(a.icon_seed, 0)')
    expect(sessionsSql).toContain('s.app_origin')
    expect(sessionsSql).toContain('a.workspace_id = $1')
    expect(sessionsSql).toContain(`NOT IN ('workflow', 'assistant-call')`)
    expect(sessionsSql).toContain(
      `pa.approval_payload->>'turnLeaseToken' = s.turn_lease_token::text`,
    )
  })
})

describe('[COMP:api/live-work-roster] state derivation', () => {
  it('running + fresh heartbeat = working', () => {
    expect(
      deriveSessionState({ status: 'running', waiting: false, turnHeartbeatAt: FRESH, lastActiveAt: FRESH, now: NOW }),
    ).toBe('working')
  })

  it('running + blocking approval = waiting', () => {
    expect(
      deriveSessionState({ status: 'running', waiting: true, turnHeartbeatAt: FRESH, lastActiveAt: FRESH, now: NOW }),
    ).toBe('waiting')
  })

  it('running + stale heartbeat = stalled (the sweeper predicate, read-only)', () => {
    const stale = new Date(NOW.getTime() - 120_000)
    expect(
      deriveSessionState({ status: 'running', waiting: false, turnHeartbeatAt: stale, lastActiveAt: FRESH, now: NOW }),
    ).toBe('stalled')
  })

  it('NULL heartbeat falls back to lastActiveAt (pre-424 rows)', () => {
    expect(
      deriveSessionState({ status: 'running', waiting: false, turnHeartbeatAt: null, lastActiveAt: FRESH, now: NOW }),
    ).toBe('working')
  })

  it('not running = settled', () => {
    expect(
      deriveSessionState({ status: 'idle', waiting: false, turnHeartbeatAt: null, lastActiveAt: FRESH, now: NOW }),
    ).toBe('settled')
  })

  it('run: terminal statuses are settled, stale running is stalled', () => {
    expect(deriveRunState({ status: 'completed', lastActiveAt: FRESH, now: NOW })).toBe('settled')
    expect(deriveRunState({ status: 'failed', lastActiveAt: FRESH, now: NOW })).toBe('settled')
    const stale = new Date(NOW.getTime() - 120_000)
    expect(deriveRunState({ status: 'running', lastActiveAt: stale, now: NOW })).toBe('stalled')
    expect(deriveRunState({ status: 'awaiting_wait', lastActiveAt: FRESH, now: NOW })).toBe('waiting')
  })
})

describe('[COMP:api/live-work-roster] projections', () => {
  it('projectSessionRow returns null for omitted rows', () => {
    expect(
      projectSessionRow(
        sessionRow({ userId: TEAMMATE, visibility: 'workspace', effectiveClearance: 'confidential' }) as never,
        CALLER,
        'internal',
        NOW,
      ),
    ).toBeNull()
  })

  it('projectRunRow leaves assistant fields null (no run-level binding)', () => {
    const item = projectRunRow(runRow() as never, NOW)
    expect(item.assistantId).toBeNull()
    expect(item.assistantName).toBeNull()
  })
})
