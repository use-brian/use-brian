import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import {
  deriveIdeaStatus,
  type ContentIdea,
  type ContentIdeasStore,
} from '../../db/content-ideas-store.js'
import type { ContentPlanStore, PlanSlot } from '../../db/content-plan-store.js'
import { contentIdeasRoutes } from '../content-ideas.js'
import type { PlanningAccessContext } from '../content-planning.js'

const ACCESS: PlanningAccessContext = {
  userId: 'user-1',
  workspaceId: 'workspace-1',
  role: 'owner',
  canDraft: true,
}

function idea(overrides: Partial<ContentIdea> = {}): ContentIdea {
  return {
    id: 'idea-1',
    assistantId: 'assistant-1',
    text: 'Our onboarding horror story as a thread',
    note: null,
    platformHint: null,
    source: 'manual',
    status: 'open',
    slotId: null,
    sessionId: null,
    discardedAt: null,
    createdBy: 'user-1',
    createdAt: new Date('2026-07-31T01:00:00Z'),
    updatedAt: new Date('2026-07-31T01:00:00Z'),
    ...overrides,
  }
}

function fakeStore(
  overrides: Partial<ContentIdeasStore> = {},
): ContentIdeasStore {
  return {
    listIdeas: vi.fn(async () => [idea()]),
    getIdea: vi.fn(async () => idea()),
    createIdea: vi.fn(async () => idea()),
    updateIdea: vi.fn(async () => idea()),
    deleteIdea: vi.fn(async () => true),
    ...overrides,
  }
}

function slot(overrides: Partial<PlanSlot> = {}): PlanSlot {
  return {
    id: 'slot-1',
    assistantId: 'assistant-1',
    platform: 'threads',
    scheduledFor: '2026-08-04',
    scheduledMinute: null,
    title: 'Launch recap',
    brief: null,
    media: [],
    status: 'planned',
    draftId: null,
    sessionId: null,
    createdBy: 'user-1',
    createdAt: new Date('2026-07-31T01:00:00Z'),
    updatedAt: new Date('2026-07-31T01:00:00Z'),
    ...overrides,
  }
}

function fakePlanStore(
  overrides: Partial<ContentPlanStore> = {},
): ContentPlanStore {
  return {
    listSlots: vi.fn(async () => []),
    getSlot: vi.fn(async () => slot()),
    createSlot: vi.fn(async () => slot()),
    updateSlot: vi.fn(async () => slot()),
    deleteSlot: vi.fn(async () => true),
    ensurePlanSession: vi.fn(async () => ({ sessionId: 'session-plan' })),
    getBrief: vi.fn(async () => null),
    upsertBrief: vi.fn(async () => {
      throw new Error('unused')
    }),
    ...overrides,
  }
}

function app(
  store: ContentIdeasStore,
  planStore: ContentPlanStore = fakePlanStore(),
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
    contentIdeasRoutes({
      store,
      planStore,
      resolveAccess: async () => access,
    }),
  )
  return server
}

describe('[COMP:feed/content-ideas-routes] Idea backlog wire contract', () => {
  it('lists the backlog, optionally filtered on the derived status', async () => {
    const listIdeas = vi.fn(async () => [idea()])
    const response = await request(app(fakeStore({ listIdeas })))
      .get('/api/distribution/assistant-1/ideas?status=open')
      .expect(200)
    expect(listIdeas).toHaveBeenCalledWith({
      assistantId: 'assistant-1',
      status: 'open',
    })
    expect(response.body.ideas).toHaveLength(1)
  })

  it('rejects an unknown status filter', async () => {
    await request(app(fakeStore()))
      .get('/api/distribution/assistant-1/ideas?status=parked')
      .expect(400)
  })

  it('captures a jot with nothing but its text', async () => {
    const createIdea = vi.fn(async () => idea())
    await request(app(fakeStore({ createIdea })))
      .post('/api/distribution/assistant-1/ideas')
      .send({ text: '  Our onboarding horror story as a thread  ' })
      .expect(201)
    expect(createIdea).toHaveBeenCalledWith({
      assistantId: 'assistant-1',
      userId: 'user-1',
      text: 'Our onboarding horror story as a thread',
      note: undefined,
    })
  })

  it('rejects an empty jot', async () => {
    await request(app(fakeStore()))
      .post('/api/distribution/assistant-1/ideas')
      .send({ text: '   ' })
      .expect(400)
  })

  it('rejects a platform hint outside the platform registry', async () => {
    await request(app(fakeStore()))
      .post('/api/distribution/assistant-1/ideas')
      .send({ text: 'A reel', platformHint: 'myspace' })
      .expect(400)
  })

  // The plan-slot D7 rule, one level up: status is derived from the links
  // and `discarded_at`, so accepting one over the wire is exactly the drift
  // the design forbids.
  it('refuses to write the derived status', async () => {
    const updateIdea = vi.fn(async () => idea())
    await request(app(fakeStore({ updateIdea })))
      .patch('/api/distribution/assistant-1/ideas/idea-1')
      .send({ status: 'promoted' })
      .expect(400)
    expect(updateIdea).not.toHaveBeenCalled()
  })

  it('discards and restores through the discarded flag', async () => {
    const updateIdea = vi.fn(async () =>
      idea({ status: 'discarded', discardedAt: new Date() }),
    )
    await request(app(fakeStore({ updateIdea })))
      .patch('/api/distribution/assistant-1/ideas/idea-1')
      .send({ discarded: true })
      .expect(200)
    expect(updateIdea).toHaveBeenCalledWith({
      assistantId: 'assistant-1',
      ideaId: 'idea-1',
      patch: { discarded: true },
    })
  })

  it('binds the slot an idea became after checking it belongs to the assistant', async () => {
    const updateIdea = vi.fn(async () =>
      idea({ status: 'promoted', slotId: 'slot-1' }),
    )
    const planStore = fakePlanStore()
    await request(app(fakeStore({ updateIdea }), planStore))
      .patch('/api/distribution/assistant-1/ideas/idea-1')
      .send({ slotId: 'slot-1' })
      .expect(200)
    expect(planStore.getSlot).toHaveBeenCalledWith('assistant-1', 'slot-1')
    expect(updateIdea).toHaveBeenCalledWith({
      assistantId: 'assistant-1',
      ideaId: 'idea-1',
      patch: { slotId: 'slot-1' },
    })
  })

  it("refuses to bind another assistant's slot", async () => {
    const updateIdea = vi.fn(async () => idea())
    const planStore = fakePlanStore({ getSlot: vi.fn(async () => null) })
    await request(app(fakeStore({ updateIdea }), planStore))
      .patch('/api/distribution/assistant-1/ideas/idea-1')
      .send({ slotId: 'slot-elsewhere' })
      .expect(404)
    expect(updateIdea).not.toHaveBeenCalled()
  })

  it('deletes an idea outright', async () => {
    const deleteIdea = vi.fn(async () => true)
    await request(app(fakeStore({ deleteIdea })))
      .delete('/api/distribution/assistant-1/ideas/idea-1')
      .expect(204)
    expect(deleteIdea).toHaveBeenCalledWith('assistant-1', 'idea-1')
  })

  it('lets a member without draft permission read but not write', async () => {
    const readOnly: PlanningAccessContext = {
      ...ACCESS,
      role: 'member',
      canDraft: false,
    }
    const store = fakeStore()
    await request(app(store, fakePlanStore(), readOnly))
      .get('/api/distribution/assistant-1/ideas')
      .expect(200)
    await request(app(store, fakePlanStore(), readOnly))
      .post('/api/distribution/assistant-1/ideas')
      .send({ text: 'X' })
      .expect(403)
  })
})

describe('[COMP:feed/content-ideas-store] Idea status derivation', () => {
  it('is open with no links and no discard', () => {
    expect(
      deriveIdeaStatus({ hasSlot: false, hasSession: false, discarded: false }),
    ).toBe('open')
  })

  it('is promoted the moment either link is set', () => {
    expect(
      deriveIdeaStatus({ hasSlot: true, hasSession: false, discarded: false }),
    ).toBe('promoted')
    expect(
      deriveIdeaStatus({ hasSlot: false, hasSession: true, discarded: false }),
    ).toBe('promoted')
  })

  it('is discarded only when nothing is bound', () => {
    expect(
      deriveIdeaStatus({ hasSlot: false, hasSession: false, discarded: true }),
    ).toBe('discarded')
    // A binding outranks a stale discard: promoting is what happened to it.
    expect(
      deriveIdeaStatus({ hasSlot: true, hasSession: false, discarded: true }),
    ).toBe('promoted')
  })
})
