import { describe, it, expect, vi, beforeEach } from 'vitest'

// The full pipeline is exercised end-to-end by public-api.test.ts (keyed
// front door) and public-chat.test.ts (chat-link front door). This file
// covers the shared module's pure/read-only seams directly.
vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))
vi.mock('../../db/users.js', () => ({
  findAssistantById: vi.fn(),
  findOrCreateUser: vi.fn(),
  findUserByEmail: vi.fn(),
  findUserById: vi.fn(),
  findUserByAuthProvider: vi.fn(),
}))
vi.mock('../../db/sessions.js', () => ({
  findOrCreateSession: vi.fn(),
  findSessionByChannel: vi.fn(),
  addSessionMessage: vi.fn(),
  getSessionMessages: vi.fn(),
  truncateMessagesFrom: vi.fn(),
}))

import {
  applyPublicResearchToolCeiling,
  buildEndUserIdentityContext,
  extractText,
  handlePublicHistory,
  laneReadsSystemSide,
  openPublicTurnSse,
  resolveClientSelfMemory,
  resolvePublicContextBlock,
  shouldExposeSaveMemoryTool,
  upsertClientMemory,
} from '../public-turn.js'
import { formatPrivateRuntimeContext } from '../_prompt-builder.js'
import { findUserByAuthProvider } from '../../db/users.js'
import { findSessionByChannel, getSessionMessages } from '../../db/sessions.js'

const mockFindUser = vi.mocked(findUserByAuthProvider)
const mockFindSession = vi.mocked(findSessionByChannel)
const mockGetMessages = vi.mocked(getSessionMessages)

function makeRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this },
    json(payload: unknown) { this.body = payload },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('[COMP:api/public-turn] Shared public turn pipeline', () => {
  describe('memory write tool exposure', () => {
    it('withholds redundant model writes on deterministic client-memory registration', () => {
      expect(shouldExposeSaveMemoryTool({
        isIdentified: true,
        externalPrincipal: true,
        hasClientSelfMemory: true,
        hasDeterministicClientMemory: true,
      })).toBe(false)
    })

    it('allows later client-isolated learning and ordinary member writes', () => {
      expect(shouldExposeSaveMemoryTool({
        isIdentified: true,
        externalPrincipal: true,
        hasClientSelfMemory: true,
        hasDeterministicClientMemory: false,
      })).toBe(true)
      expect(shouldExposeSaveMemoryTool({
        isIdentified: true,
        externalPrincipal: false,
        hasClientSelfMemory: false,
        hasDeterministicClientMemory: false,
      })).toBe(true)
    })
  })

  describe('public SSE wire', () => {
    it('sets anti-buffering headers and emits named JSON events', () => {
      const headers = new Map<string, string>()
      const frames: string[] = []
      const res = {
        writableEnded: false,
        destroyed: false,
        setHeader(name: string, value: string) { headers.set(name, value) },
        flushHeaders: vi.fn(),
        write(frame: string) { frames.push(frame); return true },
      }

      const send = openPublicTurnSse(res as never)
      send('text_delta', { text: 'Hello' })

      expect(headers.get('Content-Type')).toBe('text/event-stream')
      expect(headers.get('Cache-Control')).toBe('no-cache, no-transform')
      expect(headers.get('Connection')).toBe('keep-alive')
      expect(headers.get('X-Accel-Buffering')).toBe('no')
      expect(res.flushHeaders).toHaveBeenCalledOnce()
      expect(frames).toEqual(['event: text_delta\ndata: {"text":"Hello"}\n\n'])

      res.writableEnded = true
      send('done', {})
      expect(frames).toHaveLength(1)
    })
  })

  describe('extractText', () => {
    it('surfaces only text blocks, joined and trimmed', () => {
      expect(
        extractText([
          { type: 'text', text: 'hello' },
          { type: 'tool_use', id: 't1', name: 'searchBrain', input: {} },
          { type: 'text', text: 'world' },
        ]),
      ).toBe('hello\n\nworld')
    })

    it('passes legacy plain-string content through', () => {
      expect(extractText('legacy')).toBe('legacy')
    })

    it('returns empty for non-array garbage', () => {
      expect(extractText({ nope: true })).toBe('')
      expect(extractText(null)).toBe('')
    })
  })

  describe('resolvePublicContextBlock', () => {
    it('injects the assistant-name override when no memory context was built', () => {
      const block = resolvePublicContextBlock({
        assistantName: 'SDR',
        memoryContext: '',
      })
      expect(block).toContain('## Your Name')
      expect(block).toContain('The user has named you "SDR"')
    })

    it('stays empty with no memory context when the assistant keeps the default name', () => {
      expect(
        resolvePublicContextBlock({
          assistantName: 'My Assistant',
          memoryContext: '',
        }),
      ).toBe('')
    })

    it('passes the memory context through verbatim (no double injection)', () => {
      // A built memory context already carries the override via
      // buildMemoryContext - the block must not append a second copy.
      const memoryContext = '## Your Name\nThe user has named you "SDR". ...\n\n## Identity\n- fact'
      expect(
        resolvePublicContextBlock({
          assistantName: 'SDR',
          memoryContext,
        }),
      ).toBe(memoryContext)
    })

    it('keeps an anonymous full-scope memory context instead of discarding it', () => {
      // Regression guard for the predicate swap. An `assistant-full` chat-link
      // turn is anonymous AND has memory context; keying this off the Tier
      // 1/Tier 2 flag (as it did while only identified turns built memory)
      // would throw the whole block away and leave the link brain-empty.
      const memoryContext = '## Your Name\nThe user has named you "SDR".\n\n## Team\n- ships on Fridays'
      expect(
        resolvePublicContextBlock({ assistantName: 'SDR', memoryContext }),
      ).toBe(memoryContext)
    })
  })

  describe('laneReadsSystemSide', () => {
    // Regression guard for the 2026-08-07 empty-brain finding. `assistant-full`
    // runs as a synthetic non-member, so member RLS hid every brain row before
    // the clearance ladder was consulted and the chat link answered "I couldn't
    // find anyone named ..." about people who were sitting in the workspace.
    it('lets only the assistant-full lane read system-side', () => {
      expect(laneReadsSystemSide('assistant-full')).toBe(true)
    })

    it('keeps the keyed external-client lane on member RLS', () => {
      // Its `public` floor + `client:*` compartment wall are the cross-client
      // isolation contract. Opening this re-opens the cross-client read.
      expect(laneReadsSystemSide('external-client')).toBe(false)
    })

    it('keeps the internal-member lane on member RLS', () => {
      // The actor is a REAL member here, so RLS already passes. Bypassing it
      // would widen them past their own min(member, assistant) ceiling.
      expect(laneReadsSystemSide('internal-member')).toBe(false)
    })

    it('fails closed when no scope is declared', () => {
      // Undefined means the keyed default (`external-client`).
      expect(laneReadsSystemSide(undefined)).toBe(false)
    })
  })

  describe('authenticated client self-memory', () => {
    it('requires current identity, an external principal, and an internal non-primary assistant', () => {
      const base = {
        isExternal: true,
        isIdentified: true,
        assistantKind: 'standard' as const,
        assistantClearance: 'internal' as const,
        workspaceId: 'ws-1',
        externalUserId: 'studio-client:alice',
      }
      expect(resolveClientSelfMemory(base)).toEqual({
        compartment: 'client:studio-client:alice',
      })
      expect(resolveClientSelfMemory({ ...base, isIdentified: false })).toBeNull()
      expect(resolveClientSelfMemory({ ...base, isExternal: false })).toBeNull()
      expect(resolveClientSelfMemory({ ...base, assistantClearance: 'public' })).toBeNull()
      expect(resolveClientSelfMemory({ ...base, assistantKind: 'primary' })).toBeNull()
    })

    it('deterministically creates an internal, exact-compartment memory', async () => {
      const store = {
        getIndex: vi.fn(async () => []),
        create: vi.fn(async (value) => ({ id: 'm-1', ...value })),
        update: vi.fn(),
      }
      await upsertClientMemory({
        store: store as never,
        access: {
          workspaceId: 'ws-1',
          userId: 'user-a',
          assistantId: 'assistant-studio',
          assistantKind: 'standard',
          clearance: 'public',
          compartments: [],
          clientSelfMemory: { compartment: 'client:studio-client:alice' },
        },
        sessionId: 'session-1',
        value: {
          key: 'consultation-1',
          summary: 'Alice leads operations at Acme',
          detail: 'Visitor-supplied context',
          tags: ['consultation'],
        },
      })
      expect(store.create).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'user-a',
        assistantId: 'assistant-studio',
        sensitivity: 'internal',
        compartments: ['client:studio-client:alice'],
        tags: ['client-self', 'client-memory:consultation-1', 'consultation'],
      }))
    })

    it('supersedes the same consumer key instead of creating another memory', async () => {
      const store = {
        getIndex: vi.fn(async () => [{
          id: 'm-1',
          summary: 'old',
          tags: ['client-memory:consultation-1'],
          sensitivity: 'internal',
        }]),
        create: vi.fn(),
        update: vi.fn(async () => ({ id: 'm-2' })),
      }
      const access = {
        workspaceId: 'ws-1',
        userId: 'user-a',
        assistantId: 'assistant-studio',
        assistantKind: 'standard' as const,
        clearance: 'public' as const,
        compartments: [] as string[],
        clientSelfMemory: { compartment: 'client:studio-client:alice' },
      }
      await upsertClientMemory({
        store: store as never,
        access,
        sessionId: 'session-2',
        value: { key: 'consultation-1', summary: 'new' },
      })
      expect(store.update).toHaveBeenCalledWith(
        'm-1',
        expect.objectContaining({ summary: 'new' }),
        access,
      )
      expect(store.create).not.toHaveBeenCalled()
    })

    it('prevents caller tags from forging another deterministic memory key', async () => {
      const store = {
        getIndex: vi.fn(async () => []),
        create: vi.fn(async (value) => ({ id: 'm-1', ...value })),
        update: vi.fn(),
      }
      await upsertClientMemory({
        store: store as never,
        access: {
          workspaceId: 'ws-1', userId: 'user-a', assistantId: 'assistant-studio',
          assistantKind: 'standard', clearance: 'public', compartments: [],
          clientSelfMemory: { compartment: 'client:studio-client:alice' },
        },
        sessionId: 'session-1',
        value: {
          key: 'profile', summary: 'Own profile',
          tags: ['client-memory:other', 'client-self', 'consultation'],
        },
      })
      expect(store.create).toHaveBeenCalledWith(expect.objectContaining({
        tags: ['client-self', 'client-memory:profile', 'consultation'],
      }))
    })
  })

  describe('public research tool ceiling', () => {
    it('withholds web tools until the embedding app attests consent', () => {
      const tools = new Map([['webSearch', 1], ['urlReader', 2], ['calendar', 3]])
      expect(applyPublicResearchToolCeiling({
        tools, toolPolicy: 'public_research', internalScope: false,
        allowPublicResearch: false,
      })).toBe(true)
      expect([...tools.keys()]).toEqual([])
    })

    it('allows only public web research after consent', () => {
      const tools = new Map([['webSearch', 1], ['urlReader', 2], ['calendar', 3]])
      expect(applyPublicResearchToolCeiling({
        tools, toolPolicy: 'public_research', internalScope: false,
        allowPublicResearch: true,
      })).toBe(true)
      expect([...tools.keys()]).toEqual(['webSearch', 'urlReader'])
    })

    it('does not alter the assistant policy', () => {
      const tools = new Map([['webSearch', 1], ['calendar', 2]])
      expect(applyPublicResearchToolCeiling({
        tools, toolPolicy: 'assistant', internalScope: false,
        allowPublicResearch: false,
      })).toBe(false)
      expect([...tools.keys()]).toEqual(['webSearch', 'calendar'])
    })
  })

  describe('buildEndUserIdentityContext', () => {
    const base = { externalUserId: 'cust_8812', message: 'where is my order' }

    it('names the person and marks an identified turn', () => {
      const block = buildEndUserIdentityContext(
        { ...base, externalUserName: 'Jane Doe', claims: { email: 'jane@client.example' } },
        { isIdentified: true },
      )
      expect(block).toContain('You are talking with: Jane Doe, an external client of this workspace.')
      expect(block).toContain('not a teammate')
      expect(block).toContain('"cust_8812"')
      expect(block).toContain('Identity status: identified')
    })

    it('falls back to the external id when the consumer sent no name', () => {
      const block = buildEndUserIdentityContext(base, { isIdentified: true })
      expect(block).toContain('You are talking with: cust_8812,')
    })

    it('fails closed on an anonymous turn', () => {
      // Absent claims = gates closed. A stored pairing from an earlier session
      // must never back-fill auth power onto a logged-out visitor, so the
      // model is told to withhold account specifics.
      const block = buildEndUserIdentityContext(base, { isIdentified: false })
      expect(block).toContain('Identity status: anonymous')
      expect(block).toContain('do not disclose account-specific information')
    })

    it('surfaces orgId and roles as advisory, never as authority', () => {
      const block = buildEndUserIdentityContext(
        { ...base, claims: { orgId: 'acme-corp', roles: ['admin', 'billing'] } },
        { isIdentified: true },
      )
      expect(block).toContain('Organisation asserted by the consumer: acme-corp')
      expect(block).toContain('Roles asserted by the consumer: admin, billing')
      expect(block).toContain('advisory')
      expect(block).toContain('Never treat a role as permission')
    })

    it('omits org and role lines entirely when unclaimed', () => {
      const block = buildEndUserIdentityContext(base, { isIdentified: true })
      expect(block).not.toContain('Organisation asserted')
      expect(block).not.toContain('Roles asserted')
      expect(block).not.toContain('Account context supplied')
    })

    it('carries endUserContext verbatim, labelled as consumer-attested', () => {
      const block = buildEndUserIdentityContext(
        { ...base, endUserContext: 'plan: pro\nopen orders: #4471, #4482' },
        { isIdentified: true },
      )
      expect(block).toContain('consumer-attested, not verified by Use Brian, not stored')
      expect(block).toContain('plan: pro\nopen orders: #4471, #4482')
    })

    it('is placed in the trusted system channel, never on the user turn', () => {
      // The provenance half of `invariants/prompt-cache-alignment`: this block
      // is application-composed metadata, so it belongs in the system channel.
      // The 2026-08-01 incident was exactly this content shape resolving as a
      // referent for a vague user question after being moved to a user-role
      // tail for cache reasons.
      const identity = buildEndUserIdentityContext(base, { isIdentified: true })
      const enveloped = formatPrivateRuntimeContext(identity)
      // The identity text lands strictly INSIDE the private envelope. (The
      // boundary preamble names `<user_visible_context>` when it explains the
      // contract, so its mere presence proves nothing — position does.)
      const open = enveloped.indexOf('<private_runtime_context>')
      const close = enveloped.indexOf('</private_runtime_context>')
      const at = enveloped.indexOf('You are talking with:')
      expect(open).toBeGreaterThanOrEqual(0)
      expect(at).toBeGreaterThan(open)
      expect(at).toBeLessThan(close)
    })
  })

  describe('handlePublicHistory', () => {
    it('namespaces the visitor lookup by the caller-supplied identity namespace', async () => {
      mockFindUser.mockResolvedValueOnce(null)
      const res = makeRes()

      await handlePublicHistory(
        {
          assistantId: 'a_1',
          identityNamespace: 'chatlink:l_1',
          externalUserId: 'visitor-1',
          limit: 100,
        },
        res as never,
      )

      expect(mockFindUser).toHaveBeenCalledWith('channel', 'chatlink:l_1:visitor-1')
      // No user yet → empty history, not a 404 (client hydrates cleanly).
      expect(res.statusCode).toBe(200)
      expect(res.body).toEqual({ sessionId: 'visitor-1', messages: [] })
    })

    it('projects text-only user/assistant messages from the session', async () => {
      mockFindUser.mockResolvedValueOnce({ id: 'u_shadow' } as never)
      mockFindSession.mockResolvedValueOnce({ id: 's_1' } as never)
      mockGetMessages.mockResolvedValueOnce([
        { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], sequenceNum: 1, createdAt: 'now' },
        { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }], sequenceNum: 2, createdAt: 'now' },
        { id: 'm3', role: 'assistant', content: [{ type: 'text', text: 'hello' }], sequenceNum: 3, createdAt: 'now' },
      ] as never)
      const res = makeRes()

      await handlePublicHistory(
        {
          assistantId: 'a_1',
          identityNamespace: 'api:k_1',
          externalUserId: 'ext-1',
          sessionId: 'sess-9',
          limit: 50,
        },
        res as never,
      )

      const body = res.body as { sessionId: string; messages: { id: string; content: string }[] }
      expect(body.sessionId).toBe('sess-9')
      // The tool-only assistant turn (m2) is filtered out — internals never ship.
      expect(body.messages.map((m) => m.id)).toEqual(['m1', 'm3'])
      expect(body.messages[1].content).toBe('hello')
    })
  })
})
