/**
 * Route tests for POST /api/skills/draft (the conversational draft turn) and
 * GET /api/skills/catalog/:slug (the creator's instant template load).
 * Component tag: [COMP:api/skills-route].
 *
 * Unlike skills.test.ts this file does NOT mock @use-brian/core — the route
 * resolves the REAL `skill-builder` builtin (proving the methodology ships)
 * and the draft call runs through the real generator against a mock provider
 * that streams canned JSON.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'
import { loadBuiltinSkills, type LLMProvider, type Message, type StreamChunk } from '@use-brian/core'

import { skillRoutes } from '../skills.js'

const skillStore = {
  listPublished: vi.fn(),
  listStarred: vi.fn(),
  listOwned: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  publish: vi.fn(),
  unpublish: vi.fn(),
  star: vi.fn(),
  unstar: vi.fn(),
  getBySlug: vi.fn(),
}

const workspaceStore = { getRole: vi.fn() }
const getDraftContext = vi.fn()

type Captured = { systemPrompt?: string; model?: string; messages?: Message[] }

function mockProvider(response: string, capture?: Captured): LLMProvider {
  return {
    createSession() {
      return { thoughtSignature: undefined } as never
    },
    async *stream(params: {
      model: string
      systemPrompt: string
      messages: Message[]
    }): AsyncGenerator<StreamChunk> {
      if (capture) {
        capture.systemPrompt = params.systemPrompt
        capture.model = params.model
        capture.messages = params.messages
      }
      yield { type: 'text_delta', text: response } as StreamChunk
      yield {
        type: 'message_end',
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 80 },
      } as StreamChunk
    },
  } as unknown as LLMProvider
}

const VALID_DRAFT =
  '{"action":"draft","name":"Weekly investor update","description":"d","whenToUse":"w","content":"# steps","sensitivity":"internal","message":"Drafted it."}'
const VALID_REPLY = '{"action":"reply","message":"Who is the audience?"}'

function textOf(message: Message | undefined): string {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  return message.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
}

type DraftAppOptions = {
  provider?: LLMProvider
  limiter?: { check: (k: string) => boolean }
  researchLimiter?: { check: (k: string) => boolean }
  plan?: string
  budgetStatus?: 'ok' | 'downgraded' | 'blocked'
  fileStore?: { get: (id: string, ctx?: unknown) => Promise<unknown> }
}

function draftApp(opts: DraftAppOptions = {}) {
  return createTestApp(
    '/api/skills',
    skillRoutes({
      skillStore: skillStore as never,
      workspaceStore: workspaceStore as never,
      draftProvider: opts.provider,
      getDraftContext,
      draftRateLimiter: (opts.limiter ?? { check: () => true }) as never,
      researchRateLimiter: (opts.researchLimiter ?? { check: () => true }) as never,
      getWorkspacePlan: async () => opts.plan ?? 'max_5x',
      checkUsageBudget: async () => ({ status: opts.budgetStatus ?? 'ok' }),
      fileStore: opts.fileStore as never,
    }),
    { userId: 'u-1' },
  )
}

/** A minimal valid one-turn body. */
function turnBody(extra: Record<string, unknown> = {}) {
  return {
    workspaceId: 'w-1',
    messages: [{ role: 'user', content: 'draft our weekly investor update' }],
    ...extra,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  getDraftContext.mockResolvedValue({ memories: [], entities: [], existingSkills: [] })
  workspaceStore.getRole.mockResolvedValue('member')
})

describe('[COMP:api/skills-route] POST /draft', () => {
  it('the skill-builder builtin actually ships (D3 methodology source)', () => {
    const builder = loadBuiltinSkills().find((s) => s.id === 'skill-builder')
    expect(builder).toBeDefined()
    expect(builder!.content).toContain('clarify or draft')
  })

  it('503 when no provider is wired; 501 when context deps are missing', async () => {
    const noProvider = await request(draftApp()).post('/api/skills/draft').send(turnBody())
    expect(noProvider.status).toBe(503)

    const noDeps = createTestApp(
      '/api/skills',
      skillRoutes({ skillStore: skillStore as never }),
      { userId: 'u-1' },
    )
    const res = await request(noDeps).post('/api/skills/draft').send(turnBody())
    expect(res.status).toBe(501)
  })

  it('validates the body (400), requires the last turn to be the user, gates on membership (404)', async () => {
    const app = draftApp({ provider: mockProvider(VALID_DRAFT) })

    const noMessages = await request(app).post('/api/skills/draft').send({ workspaceId: 'w-1' })
    expect(noMessages.status).toBe(400)

    const assistantLast = await request(app)
      .post('/api/skills/draft')
      .send({
        workspaceId: 'w-1',
        messages: [
          { role: 'user', content: 'draft it' },
          { role: 'assistant', content: 'done' },
        ],
      })
    expect(assistantLast.status).toBe(400)

    workspaceStore.getRole.mockResolvedValueOnce(null)
    const nonMember = await request(app).post('/api/skills/draft').send(turnBody())
    expect(nonMember.status).toBe(404)
  })

  it('returns a reply turn (questions/advice) without a draft', async () => {
    const res = await request(draftApp({ provider: mockProvider(VALID_REPLY) }))
      .post('/api/skills/draft')
      .send(turnBody({ messages: [{ role: 'user', content: 'make a skill' }] }))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ kind: 'reply', message: 'Who is the audience?' })
  })

  it('returns a revised draft + narration for a conversation, grounded via getDraftContext, with the builder methodology in the system prompt and the live draft in the last message', async () => {
    const capture: Captured = {}
    const res = await request(draftApp({ provider: mockProvider(VALID_DRAFT, capture) }))
      .post('/api/skills/draft')
      .send(
        turnBody({
          messages: [
            { role: 'user', content: 'draft our weekly investor update' },
            { role: 'assistant', content: 'Who is the audience?' },
            { role: 'user', content: 'our angels — tighten step two' },
          ],
          currentDraft: {
            name: 'Weekly investor update',
            description: 'd',
            whenToUse: 'w',
            content: '# steps\n1. gather\n2. draft',
            sensitivity: 'internal',
          },
        }),
      )
    expect(res.status).toBe(200)
    expect(res.body.kind).toBe('draft')
    expect(res.body.draft.name).toBe('Weekly investor update')
    expect(res.body.message).toBe('Drafted it.')
    expect(getDraftContext).toHaveBeenCalledWith('u-1', 'w-1')
    // The REAL skill-builder builtin reached the model.
    expect(capture.systemPrompt).toContain('Skill builder')
    // The live document rode the last user message.
    const last = capture.messages![capture.messages!.length - 1]
    expect(textOf(last)).toContain('## Current draft')
    expect(textOf(last)).toContain('2. draft')
  })

  it('plan-gates the model tier like /api/chat: free plan downgrades a max request, paid plans honour it', async () => {
    const free: Captured = {}
    await request(draftApp({ provider: mockProvider(VALID_DRAFT, free), plan: 'free' }))
      .post('/api/skills/draft')
      .send(turnBody({ model: 'max' }))
    expect(free.model).toBe('gemini-3-flash-standard')

    const paid: Captured = {}
    await request(draftApp({ provider: mockProvider(VALID_DRAFT, paid), plan: 'max_5x' }))
      .post('/api/skills/draft')
      .send(turnBody({ model: 'max' }))
    expect(paid.model).toBe('gemini-3.5-flash')
  })

  it('blocks the turn when the usage budget is exhausted (429)', async () => {
    const res = await request(
      draftApp({ provider: mockProvider(VALID_DRAFT), budgetStatus: 'blocked' }),
    )
      .post('/api/skills/draft')
      .send(turnBody())
    expect(res.status).toBe(429)
  })

  it('maps an unusable model output to 422', async () => {
    const res = await request(draftApp({ provider: mockProvider('not json at all') }))
      .post('/api/skills/draft')
      .send(turnBody())
    expect(res.status).toBe(422)
  })

  it('rate limits per user (429) — and research turns have their own tighter lid', async () => {
    const draftCapped = await request(
      draftApp({ provider: mockProvider(VALID_DRAFT), limiter: { check: () => false } }),
    )
      .post('/api/skills/draft')
      .send(turnBody())
    expect(draftCapped.status).toBe(429)

    // Research limiter only bites research turns.
    const researchApp = draftApp({
      provider: mockProvider(VALID_DRAFT),
      researchLimiter: { check: () => false },
    })
    const plainOk = await request(researchApp).post('/api/skills/draft').send(turnBody())
    expect(plainOk.status).toBe(200)
    const researchCapped = await request(researchApp)
      .post('/api/skills/draft')
      .send(turnBody({ research: true }))
    expect(researchCapped.status).toBe(429)
  })

  it('runs a research turn through the constrained loop (no tool calls ⇒ plain completion)', async () => {
    const res = await request(draftApp({ provider: mockProvider(VALID_DRAFT) }))
      .post('/api/skills/draft')
      .send(turnBody({ research: true }))
    expect(res.status).toBe(200)
    expect(res.body.kind).toBe('draft')
  })

  it('resolves a template by slug (builtin) and 404s an unknown one', async () => {
    const builtinSlug = loadBuiltinSkills()[0]!.id
    const ok = await request(draftApp({ provider: mockProvider(VALID_DRAFT) }))
      .post('/api/skills/draft')
      .send(turnBody({ templateSlug: builtinSlug }))
    expect(ok.status).toBe(200)

    skillStore.getBySlug.mockResolvedValueOnce(null)
    const missing = await request(draftApp({ provider: mockProvider(VALID_DRAFT) }))
      .post('/api/skills/draft')
      .send(turnBody({ templateSlug: 'no-such-skill' }))
    expect(missing.status).toBe(404)
  })

  it('hydrates fileIds into attachment envelopes on the last message (text inline, media as blocks)', async () => {
    const capture: Captured = {}
    const fileStore = {
      get: vi.fn(async (id: string) =>
        id === 'f-text'
          ? {
              id,
              sessionId: 's',
              fileName: 'sop.md',
              mimeType: 'text/markdown',
              content: '# Our SOP\nstep one',
              summary: null,
              sizeBytes: 20,
            }
          : {
              id,
              sessionId: 's',
              fileName: 'shot.png',
              mimeType: 'image/png',
              content: 'data:image/png;base64,aGk=',
              summary: null,
              sizeBytes: 3,
            },
      ),
    }
    const res = await request(
      draftApp({ provider: mockProvider(VALID_DRAFT, capture), fileStore }),
    )
      .post('/api/skills/draft')
      .send(turnBody({ fileIds: ['f-text', 'f-img'] }))
    expect(res.status).toBe(200)
    // Access-gated read: the turn's identity reached the file store.
    expect(fileStore.get).toHaveBeenCalledWith(
      'f-text',
      expect.objectContaining({ workspaceId: 'w-1', userId: 'u-1' }),
    )
    const last = capture.messages![capture.messages!.length - 1]!
    const lastText = textOf(last)
    expect(lastText).toContain('<attached_file id="f-text"')
    expect(lastText).toContain('step one')
    expect(Array.isArray(last.content)).toBe(true)
    const blocks = last.content as Array<{ type: string; mimeType?: string }>
    expect(blocks.some((b) => b.type === 'image' && b.mimeType === 'image/png')).toBe(true)
  })
})

describe('[COMP:api/skills-route] GET /catalog/:slug', () => {
  it('returns the FULL builtin template (including content)', async () => {
    const builtin = loadBuiltinSkills()[0]!
    const res = await request(draftApp()).get(`/api/skills/catalog/${builtin.id}`)
    expect(res.status).toBe(200)
    expect(res.body.skill.id).toBe(builtin.id)
    expect(res.body.skill.name).toBe(builtin.name)
    expect(res.body.skill.content).toBe(builtin.content)
  })

  it('falls back to a user-published skill and 404s an unknown slug', async () => {
    skillStore.getBySlug.mockResolvedValueOnce({
      id: 'row-1',
      name: 'Community skill',
      description: 'd',
      whenToUse: 'w',
      content: '# body',
      category: 'custom',
      requiresConnectors: [],
      source: 'user',
    })
    const published = await request(draftApp()).get('/api/skills/catalog/community-skill')
    expect(published.status).toBe(200)
    expect(published.body.skill.content).toBe('# body')

    skillStore.getBySlug.mockResolvedValueOnce(null)
    const missing = await request(draftApp()).get('/api/skills/catalog/no-such-skill')
    expect(missing.status).toBe(404)
  })
})
