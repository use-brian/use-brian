import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import {
  deriveIdeaStatus,
  type ContentIdea,
  type ContentIdeasStore,
} from '../../db/content-ideas-store.js'
import type { ContentPlanStore, PlanSlot } from '../../db/content-plan-store.js'
import type {
  ContentDraftSessionSummary,
  ContentPlanningStore,
} from '../../db/content-planning-store.js'
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

function draftSession(
  overrides: Partial<ContentDraftSessionSummary> = {},
): ContentDraftSessionSummary {
  return {
    id: 'session-1',
    platform: 'threads',
    title: 'Our onboarding horror story as a thread',
    startedBy: { id: 'user-1', name: null },
    createdAt: new Date('2026-08-01T01:00:00Z'),
    lastActiveAt: new Date('2026-08-01T01:00:00Z'),
    preview: null,
    replyTarget: null,
    draftText: null,
    selectedDraft: null,
    draftCounts: { pending: 0, ready: 0, posted: 0, rejected: 0 },
    seedKind: 'freeform',
    ...overrides,
  } as ContentDraftSessionSummary
}

function fakePlanningStore(
  overrides: Partial<ContentPlanningStore> = {},
): ContentPlanningStore {
  return {
    createSession: vi.fn(async (params: { platform: string; title?: string }) =>
      draftSession({
        platform: params.platform as ContentDraftSessionSummary['platform'],
      }),
    ),
    listSessions: vi.fn(async () => []),
    ...overrides,
  } as unknown as ContentPlanningStore
}

function app(
  store: ContentIdeasStore,
  planStore: ContentPlanStore = fakePlanStore(),
  access: PlanningAccessContext = ACCESS,
  planningStore: ContentPlanningStore = fakePlanningStore(),
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
      planningStore,
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

describe('[COMP:feed/content-ideas-routes] Draft directly from an idea (P7)', () => {
  it('creates a draft session seeded from the jot and binds session_id', async () => {
    const theIdea = idea({
      text: 'Launch teaser\nWhy the beta list matters',
      note: 'mention the waitlist',
      platformHint: 'threads',
    })
    const updateIdea = vi.fn(async () =>
      idea({ ...theIdea, sessionId: 'session-1', status: 'promoted' }),
    )
    const createSession = vi.fn(async () => draftSession())
    const response = await request(
      app(
        fakeStore({ getIdea: vi.fn(async () => theIdea), updateIdea }),
        fakePlanStore(),
        ACCESS,
        fakePlanningStore({ createSession }),
      ),
    )
      .post('/api/distribution/assistant-1/ideas/idea-1/draft')
      .send({ platform: 'twitter' })
      .expect(201)
    // The idea's own hint outranks the caller's default platform.
    expect(createSession).toHaveBeenCalledWith({
      assistantId: 'assistant-1',
      userId: 'user-1',
      platform: 'threads',
      title: 'Launch teaser',
      seed: {
        kind: 'freeform',
        brief: 'Launch teaser\nWhy the beta list matters\n\nmention the waitlist',
      },
    })
    expect(updateIdea).toHaveBeenCalledWith({
      assistantId: 'assistant-1',
      ideaId: 'idea-1',
      patch: { sessionId: 'session-1' },
    })
    expect(response.body.sessionId).toBe('session-1')
    expect(response.body.platform).toBe('threads')
  })

  it('falls back to the caller default platform, and refuses with neither', async () => {
    const createSession = vi.fn(async () => draftSession({ platform: 'twitter' }))
    await request(
      app(
        fakeStore({ getIdea: vi.fn(async () => idea({ platformHint: null })) }),
        fakePlanStore(),
        ACCESS,
        fakePlanningStore({ createSession }),
      ),
    )
      .post('/api/distribution/assistant-1/ideas/idea-1/draft')
      .send({ platform: 'twitter' })
      .expect(201)
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'twitter' }),
    )

    await request(
      app(fakeStore({ getIdea: vi.fn(async () => idea({ platformHint: null })) })),
    )
      .post('/api/distribution/assistant-1/ideas/idea-1/draft')
      .send({})
      .expect(400)
  })

  it('refuses a discarded idea', async () => {
    const createSession = vi.fn(async () => draftSession())
    await request(
      app(
        fakeStore({
          getIdea: vi.fn(async () =>
            idea({ discardedAt: new Date('2026-08-02T00:00:00Z') }),
          ),
        }),
        fakePlanStore(),
        ACCESS,
        fakePlanningStore({ createSession }),
      ),
    )
      .post('/api/distribution/assistant-1/ideas/idea-1/draft')
      .send({ platform: 'threads' })
      .expect(409)
    expect(createSession).not.toHaveBeenCalled()
  })

  it('is idempotent: an already-promoted idea returns its existing session', async () => {
    const createSession = vi.fn(async () => draftSession())
    const response = await request(
      app(
        fakeStore({
          getIdea: vi.fn(async () =>
            idea({ sessionId: 'session-9', status: 'promoted' }),
          ),
        }),
        fakePlanStore(),
        ACCESS,
        fakePlanningStore({
          createSession,
          listSessions: vi.fn(async () => [
            draftSession({ id: 'session-9', platform: 'xhs' }),
          ]),
        }),
      ),
    )
      .post('/api/distribution/assistant-1/ideas/idea-1/draft')
      .send({ platform: 'threads' })
      .expect(200)
    expect(createSession).not.toHaveBeenCalled()
    expect(response.body.sessionId).toBe('session-9')
    expect(response.body.platform).toBe('xhs')
  })

  it('requires draft permission like every other mutation', async () => {
    const readOnly: PlanningAccessContext = {
      userId: 'user-1',
      workspaceId: 'workspace-1',
      role: 'member',
      canDraft: false,
    }
    await request(app(fakeStore(), fakePlanStore(), readOnly))
      .post('/api/distribution/assistant-1/ideas/idea-1/draft')
      .send({ platform: 'threads' })
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
