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

import { extractText, handlePublicHistory } from '../public-turn.js'
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
