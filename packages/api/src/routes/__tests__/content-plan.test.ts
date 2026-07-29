import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import {
  deriveSlotStatus,
  parseIsoDate,
  parseMonthRange,
  type ContentPlanStore,
  type PlanSlot,
} from '../../db/content-plan-store.js'
import type { ContentPlanningStore } from '../../db/content-planning-store.js'
import { contentPlanRoutes } from '../content-plan.js'
import type { PlanningAccessContext } from '../content-planning.js'

const ACCESS: PlanningAccessContext = {
  userId: 'user-1',
  workspaceId: 'workspace-1',
  role: 'owner',
  canDraft: true,
}

function slot(overrides: Partial<PlanSlot> = {}): PlanSlot {
  return {
    id: 'slot-1',
    assistantId: 'assistant-1',
    platform: 'threads',
    scheduledFor: '2026-08-04',
    title: 'Launch recap',
    brief: 'What shipped and what broke.',
    status: 'planned',
    draftId: null,
    sessionId: null,
    createdBy: 'user-1',
    createdAt: new Date('2026-07-29T01:00:00Z'),
    updatedAt: new Date('2026-07-29T01:00:00Z'),
    ...overrides,
  }
}

function fakeStore(overrides: Partial<ContentPlanStore> = {}): ContentPlanStore {
  return {
    listSlots: vi.fn(async () => [slot()]),
    getSlot: vi.fn(async () => slot()),
    createSlot: vi.fn(async () => slot()),
    updateSlot: vi.fn(async () => slot()),
    deleteSlot: vi.fn(async () => true),
    ensurePlanSession: vi.fn(async () => ({ sessionId: 'session-plan' })),
    getBrief: vi.fn(async () => null),
    upsertBrief: vi.fn(async () => ({
      assistantId: 'assistant-1',
      monthStart: '2026-08-01',
      brief: 'Ship the launch.',
      themes: ['launch'],
      updatedBy: 'user-1',
      updatedAt: new Date('2026-07-29T01:00:00Z'),
    })),
    ...overrides,
  }
}

function fakePlanningStore(
  overrides: Partial<ContentPlanningStore> = {},
): ContentPlanningStore {
  return {
    createSession: vi.fn(async () => ({
      id: 'session-9',
      platform: 'threads' as const,
      title: '[threads] Launch recap',
      startedBy: { id: 'user-1', name: 'Ada' },
      createdAt: new Date('2026-07-29T01:00:00Z'),
      lastActiveAt: new Date('2026-07-29T01:00:00Z'),
      preview: null,
      replyTarget: null,
      draftText: null,
      selectedDraft: null,
      draftCounts: { pending: 0, ready: 0, posted: 0, rejected: 0, deleted: 0 },
      seedKind: 'freeform' as const,
    })),
    listSessions: vi.fn(async () => []),
    sessionExists: vi.fn(async () => true),
    discardSession: vi.fn(async () => true),
    saveDraft: vi.fn(),
    listSessionDrafts: vi.fn(async () => []),
    listPending: vi.fn(async () => []),
    listReady: vi.fn(async () => []),
    approve: vi.fn(async () => true),
    reject: vi.fn(async () => true),
    markPosted: vi.fn(async () => true),
    discardReady: vi.fn(async () => true),
    removeDraft: vi.fn(async () => true),
    ...overrides,
  } as ContentPlanningStore
}

function app(
  store: ContentPlanStore,
  planningStore: ContentPlanningStore = fakePlanningStore(),
  access: PlanningAccessContext = ACCESS,
) {
  const server = express()
  server.use(express.json())
  server.use((req, _res, next) => {
    req.userId = 'user-1'
    next()
  })
  server.use(
    '/api/distribution',
    contentPlanRoutes({
      store,
      planningStore,
      resolveAccess: async () => access,
    }),
  )
  return server
}

describe('[COMP:feed/content-plan-routes] Marketing plan wire contract', () => {
  it('lists a month of slots', async () => {
    const listSlots = vi.fn(async () => [slot()])
    const response = await request(app(fakeStore({ listSlots })))
      .get('/api/distribution/assistant-1/plan-slots?month=2026-08')
      .expect(200)
    expect(listSlots).toHaveBeenCalledWith({
      assistantId: 'assistant-1',
      month: '2026-08',
    })
    expect(response.body.slots).toHaveLength(1)
  })

  it('rejects a month that is not YYYY-MM', async () => {
    await request(app(fakeStore()))
      .get('/api/distribution/assistant-1/plan-slots?month=August')
      .expect(400)
  })

  it('creates a slot with no draft attached', async () => {
    const createSlot = vi.fn(async () => slot())
    await request(app(fakeStore({ createSlot })))
      .post('/api/distribution/assistant-1/plan-slots')
      .send({
        platform: 'threads',
        scheduledFor: '2026-08-04',
        title: '  Launch recap  ',
        brief: 'What shipped.',
      })
      .expect(201)
    expect(createSlot).toHaveBeenCalledWith({
      assistantId: 'assistant-1',
      userId: 'user-1',
      platform: 'threads',
      scheduledFor: '2026-08-04',
      title: 'Launch recap',
      brief: 'What shipped.',
    })
  })

  it('rejects a slot on a day that does not exist', async () => {
    await request(app(fakeStore()))
      .post('/api/distribution/assistant-1/plan-slots')
      .send({ platform: 'threads', scheduledFor: '2026-02-30', title: 'Nope' })
      .expect(400)
  })

  it('reschedules a slot by patching its day', async () => {
    const updateSlot = vi.fn(async () => slot({ scheduledFor: '2026-08-06' }))
    const response = await request(app(fakeStore({ updateSlot })))
      .patch('/api/distribution/assistant-1/plan-slots/slot-1')
      .send({ scheduledFor: '2026-08-06' })
      .expect(200)
    expect(updateSlot).toHaveBeenCalledWith({
      assistantId: 'assistant-1',
      slotId: 'slot-1',
      patch: { scheduledFor: '2026-08-06' },
    })
    expect(response.body.slot.scheduledFor).toBe('2026-08-06')
  })

  // D7: accepting a derived status over the wire is exactly the drift the
  // design forbids, so the route refuses it rather than storing it.
  it('refuses to write a derived status', async () => {
    const updateSlot = vi.fn(async () => slot())
    await request(app(fakeStore({ updateSlot })))
      .patch('/api/distribution/assistant-1/plan-slots/slot-1')
      .send({ status: 'posted' })
      .expect(400)
    expect(updateSlot).not.toHaveBeenCalled()
  })

  it('accepts the operator marks it does own', async () => {
    const updateSlot = vi.fn(async () => slot({ status: 'skipped' }))
    await request(app(fakeStore({ updateSlot })))
      .patch('/api/distribution/assistant-1/plan-slots/slot-1')
      .send({ status: 'skipped' })
      .expect(200)
    expect(updateSlot).toHaveBeenCalledWith({
      assistantId: 'assistant-1',
      slotId: 'slot-1',
      patch: { mark: 'skipped' },
    })
  })

  it('opens a draft session seeded from the slot and binds it', async () => {
    const updateSlot = vi.fn(async () => slot({ sessionId: 'session-9' }))
    const planningStore = fakePlanningStore()
    const response = await request(
      app(fakeStore({ updateSlot }), planningStore),
    )
      .post('/api/distribution/assistant-1/plan-slots/slot-1/draft')
      .expect(201)
    expect(planningStore.createSession).toHaveBeenCalledWith({
      assistantId: 'assistant-1',
      userId: 'user-1',
      platform: 'threads',
      title: 'Launch recap',
    })
    expect(updateSlot).toHaveBeenCalledWith({
      assistantId: 'assistant-1',
      slotId: 'slot-1',
      patch: { sessionId: 'session-9' },
    })
    expect(response.body.sessionId).toBe('session-9')
  })

  it('does not open a second session for a slot already drafting', async () => {
    const planningStore = fakePlanningStore()
    const store = fakeStore({
      getSlot: vi.fn(async () => slot({ sessionId: 'session-5' })),
    })
    const response = await request(app(store, planningStore))
      .post('/api/distribution/assistant-1/plan-slots/slot-1/draft')
      .expect(200)
    expect(planningStore.createSession).not.toHaveBeenCalled()
    expect(response.body.sessionId).toBe('session-5')
  })

  it('returns an empty brief for a month nobody has written yet', async () => {
    const response = await request(app(fakeStore()))
      .get('/api/distribution/assistant-1/plan-brief?month=2026-08')
      .expect(200)
    expect(response.body.brief).toMatchObject({
      monthStart: '2026-08-01',
      brief: '',
      themes: [],
    })
  })

  it('caps and trims themes on upsert', async () => {
    const upsertBrief = vi.fn(async () => ({
      assistantId: 'assistant-1',
      monthStart: '2026-08-01',
      brief: 'Ship the launch.',
      themes: ['launch'],
      updatedBy: 'user-1',
      updatedAt: new Date('2026-07-29T01:00:00Z'),
    }))
    await request(app(fakeStore({ upsertBrief })))
      .put('/api/distribution/assistant-1/plan-brief')
      .send({
        month: '2026-08',
        brief: 'Ship the launch.',
        themes: ['  launch  ', '', 42, 'proof'],
      })
      .expect(200)
    expect(upsertBrief).toHaveBeenCalledWith({
      assistantId: 'assistant-1',
      userId: 'user-1',
      month: '2026-08',
      brief: 'Ship the launch.',
      themes: ['launch', 'proof'],
    })
  })

  it('lets a member without draft permission read but not write', async () => {
    const readOnly: PlanningAccessContext = {
      ...ACCESS,
      role: 'member',
      canDraft: false,
    }
    const store = fakeStore()
    await request(app(store, fakePlanningStore(), readOnly))
      .get('/api/distribution/assistant-1/plan-slots?month=2026-08')
      .expect(200)
    await request(app(store, fakePlanningStore(), readOnly))
      .post('/api/distribution/assistant-1/plan-slots')
      .send({ platform: 'threads', scheduledFor: '2026-08-04', title: 'X' })
      .expect(403)
  })
})

describe('[COMP:feed/content-plan-store] Plan slot derivation', () => {
  it('maps every draft status onto a slot status', () => {
    const base = { mark: 'planned' as const, hasSession: true }
    expect(deriveSlotStatus({ ...base, draftStatus: 'pending' })).toBe('drafting')
    expect(deriveSlotStatus({ ...base, draftStatus: 'ready' })).toBe('ready')
    expect(deriveSlotStatus({ ...base, draftStatus: 'posted' })).toBe('posted')
    // A rejected draft leaves the day still needing content.
    expect(deriveSlotStatus({ ...base, draftStatus: 'rejected' })).toBe('planned')
  })

  it('treats a bound session with no saved draft as drafting', () => {
    expect(
      deriveSlotStatus({ mark: 'planned', draftStatus: null, hasSession: true }),
    ).toBe('drafting')
  })

  it('falls back to the operator mark when nothing is bound', () => {
    expect(
      deriveSlotStatus({ mark: 'planned', draftStatus: null, hasSession: false }),
    ).toBe('planned')
    expect(
      deriveSlotStatus({ mark: 'skipped', draftStatus: null, hasSession: false }),
    ).toBe('skipped')
  })

  // A skipped slot the operator later drafted is drafting, not skipped: what
  // it is bound to always outranks the mark.
  it('lets a binding outrank a stale skip mark', () => {
    expect(
      deriveSlotStatus({ mark: 'skipped', draftStatus: 'ready', hasSession: true }),
    ).toBe('ready')
  })

  it('parses month ranges and rejects impossible months', () => {
    expect(parseMonthRange('2026-08')).toEqual({
      start: '2026-08-01',
      end: '2026-09-01',
    })
    // December rolls the year, not the month index.
    expect(parseMonthRange('2026-12')).toEqual({
      start: '2026-12-01',
      end: '2027-01-01',
    })
    expect(parseMonthRange('2026-13')).toBeNull()
    expect(parseMonthRange('2026-00')).toBeNull()
    expect(parseMonthRange('August')).toBeNull()
  })

  it('parses calendar days and rejects days that do not exist', () => {
    expect(parseIsoDate('2026-08-04')).toBe('2026-08-04')
    expect(parseIsoDate('2028-02-29')).toBe('2028-02-29')
    expect(parseIsoDate('2026-02-30')).toBeNull()
    expect(parseIsoDate('2026-8-4')).toBeNull()
    expect(parseIsoDate(20260804)).toBeNull()
  })
})
