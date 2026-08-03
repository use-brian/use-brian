import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import type {
  ContentPlanningStore,
  SavedContentDraft,
} from '../../db/content-planning-store.js'
import {
  contentPlanningRoutes,
  parseContentDraftBody,
  parseContentDraftSeed,
} from '../content-planning.js'

const ACCESS = {
  userId: 'user-1',
  workspaceId: 'workspace-1',
  role: 'owner' as const,
  canDraft: true,
}

function draft(overrides: Partial<SavedContentDraft> = {}): SavedContentDraft {
  return {
    id: 'draft-1',
    assistantId: 'assistant-1',
    sessionId: 'session-1',
    platform: 'instagram',
    draftText: 'A launch caption.',
    finalText: null,
    imageBrief: 'Product close-up in soft daylight.',
    topicTag: null,
    postFormat: 'post',
    formatData: {},
    replyExternalId: null,
    replyAuthor: null,
    replyText: null,
    replyPermalink: null,
    status: 'pending',
    createdBy: 'user-1',
    resolvedBy: null,
    createdAt: new Date('2026-07-27T01:00:00Z'),
    resolvedAt: null,
    postedPermalink: null,
    ...overrides,
  }
}

function fakeStore(overrides: Partial<ContentPlanningStore> = {}): ContentPlanningStore {
  return {
    createSession: vi.fn(),
    listSessions: vi.fn(async () => []),
    sessionExists: vi.fn(async () => true),
    discardSession: vi.fn(async () => true),
    saveDraft: vi.fn(async () => draft()),
    listSessionDrafts: vi.fn(async () => []),
    listPending: vi.fn(async () => []),
    listReady: vi.fn(async () => []),
    approve: vi.fn(async () => true),
    reject: vi.fn(async () => true),
    markPosted: vi.fn(async () => true),
    discardReady: vi.fn(async () => true),
    removeDraft: vi.fn(async () => true),
    ...overrides,
  }
}

function app(store: ContentPlanningStore) {
  const server = express()
  server.use(express.json())
  server.use((req, _res, next) => {
    req.userId = 'user-1'
    next()
  })
  server.use('/api/distribution', contentPlanningRoutes({
    store,
    resolveAccess: async () => ACCESS,
    resolveWorkspaceAccess: async () => true,
  }))
  return server
}

describe('[COMP:feed/content-planning-routes] OSS planning wire contract', () => {
  it('reports zero connected profiles without disabling planning', async () => {
    const response = await request(app(fakeStore()))
      .get('/api/distribution/team/workspace-1/profiles')
      .expect(200)
    expect(response.body).toEqual({ profiles: [] })
  })

  it('approves a pending draft into the manual ready queue', async () => {
    const approve = vi.fn(async () => true)
    const store = fakeStore({ approve })
    const response = await request(app(store))
      .post('/api/distribution/assistant-1/approvals/draft-1/approve')
      .send({ text: 'Edited caption.' })
      .expect(200)
    expect(response.body).toEqual({ ok: true, status: 'ready' })
    expect(approve).toHaveBeenCalledWith({
      assistantId: 'assistant-1',
      draftId: 'draft-1',
      userId: 'user-1',
      finalText: 'Edited caption.',
    })
  })

  it('returns ready rows in the existing app-web shape', async () => {
    const store = fakeStore({
      listReady: vi.fn(async () => [
        draft({
          status: 'ready',
          finalText: 'Ready caption.',
          resolvedBy: 'user-1',
          resolvedAt: new Date('2026-07-27T02:00:00Z'),
        }),
      ]),
    })
    const response = await request(app(store))
      .get('/api/distribution/assistant-1/ready-posts')
      .expect(200)
    expect(response.body.ready[0]).toMatchObject({
      id: 'draft-1',
      platform: 'instagram',
      metadata: {
        finalText: 'Ready caption.',
        imageBrief: 'Product close-up in soft daylight.',
        approvedBy: 'user-1',
        sessionId: 'session-1',
      },
    })
  })

  it('scopes discard to both the assistant and session', async () => {
    const discardSession = vi.fn(async () => true)
    const response = await request(app(fakeStore({ discardSession })))
      .delete('/api/distribution/assistant-1/draft-sessions/session-1')
      .expect(200)
    expect(response.body).toEqual({ ok: true })
    expect(discardSession).toHaveBeenCalledWith({
      assistantId: 'assistant-1',
      sessionId: 'session-1',
      userId: 'user-1',
      allowAnyone: true,
    })
  })

  it('does not publish typing presence for a foreign session id', async () => {
    const response = await request(app(fakeStore({
      sessionExists: vi.fn(async () => false),
    })))
      .post('/api/distribution/assistant-1/draft-sessions/foreign/typing')
      .send({ isTyping: true })
      .expect(404)
    expect(response.body).toEqual({ error: 'Draft session not found' })
  })
})

describe('[COMP:feed/content-planning-routes] planning input parsing', () => {
  it('accepts an unconnected-platform source-link seed', () => {
    expect(parseContentDraftSeed(
      { kind: 'freeform', link: 'https://example.com/launch' },
      'xhs',
    )).toEqual({
      kind: 'freeform',
      link: 'https://example.com/launch',
    })
  })

  it('keeps reply context for manual planning', () => {
    expect(parseContentDraftBody({
      text: 'A thoughtful reply.',
      platform: 'twitter',
      reply: {
        externalId: '123',
        authorHandle: 'alice',
        permalink: 'https://x.com/alice/status/123',
      },
    })).toEqual({
      text: 'A thoughtful reply.',
      platform: 'twitter',
      postFormat: 'post',
      reply: {
        externalId: '123',
        authorHandle: 'alice',
        permalink: 'https://x.com/alice/status/123',
      },
    })
  })

  it('accepts a private brief and platform-shaped format', () => {
    expect(parseContentDraftSeed(
      { kind: 'freeform', format: 'thread', brief: 'Explain the launch.' },
      'twitter',
    )).toEqual({
      kind: 'freeform',
      format: 'thread',
      brief: 'Explain the launch.',
    })
    expect(parseContentDraftSeed(
      { kind: 'freeform', format: 'article' },
      'twitter',
    )).toBe('invalid')
  })

  it('accepts long X threads and applies X weighted limits per segment', () => {
    const segment = `${'a'.repeat(250)} https://example.com/an-extremely-long-path`
    expect(parseContentDraftBody({
      text: Array.from({ length: 20 }, () => segment).join('\n\n'),
      platform: 'twitter',
      postFormat: 'thread',
      threadSegments: Array.from({ length: 20 }, () => segment),
    })).not.toBe('invalid')

    expect(parseContentDraftBody({
      text: '中文'.repeat(71),
      platform: 'twitter',
      postFormat: 'thread',
      threadSegments: ['中文'.repeat(71), 'A valid second post.'],
    })).toBe('invalid')
  })

  it('rejects non-http links and missing draft text', () => {
    expect(parseContentDraftSeed(
      { kind: 'freeform', link: 'javascript:alert(1)' },
      'threads',
    )).toBe('invalid')
    expect(parseContentDraftBody({ platform: 'threads' })).toBe('invalid')
  })
})
