import { describe, it, expect, vi } from 'vitest'
import { createEngineBaseTools } from '../base/ask-engines.js'
import { createBaseTools } from '../base/index.js'
import { decodeExternalCostMeta } from '../../billing/external-cost.js'
import { flatEngineCostUsd } from '../../billing/engine-provider-rates.js'
import type { ToolContext } from '../types.js'

const ctx = {
  userId: 'u',
  assistantId: 'a',
  sessionId: 's',
  appId: 'app',
  channelType: 'web',
  channelId: 'c',
  abortSignal: new AbortController().signal,
} as ToolContext

function fakeResponse(body: unknown, status = 200) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => raw,
    json: async () => JSON.parse(raw) as unknown,
  } as Response
}

const perplexityOk = () =>
  fakeResponse({
    choices: [{ message: { content: 'an answer' } }],
    search_results: [{ url: 'https://example.com/', title: 't' }],
  })

describe('[COMP:tools/ask-engines] in-process engine tools', () => {
  describe('registration is credential-gated', () => {
    it('registers nothing when no ENGINES_* credential is set', () => {
      expect(createEngineBaseTools({})).toEqual([])
    })

    it('registers only the tools whose credential exists', () => {
      const names = createEngineBaseTools({
        ENGINES_PERPLEXITY_API_KEY: 'k',
        ENGINES_ANTHROPIC_API_KEY: 'k',
      }).map((t) => t.name)
      expect(names).toEqual(['askPerplexity', 'askClaude'])
    })

    it('joins the base toolset when the credential is present', () => {
      expect(createBaseTools({}).has('askPerplexity')).toBe(false)
      expect(createBaseTools({ ENGINES_PERPLEXITY_API_KEY: 'k' }).has('askPerplexity')).toBe(true)
    })

    it('is read-only and concurrency-safe, like webSearch', () => {
      const [tool] = createEngineBaseTools({ ENGINES_PERPLEXITY_API_KEY: 'k' })
      expect(tool.isReadOnly).toBe(true)
      expect(tool.isConcurrencySafe).toBe(true)
      expect(tool.requiresConfirmation).toBe(false)
    })
  })

  describe('external-cost meta', () => {
    it('attaches flat rate x successful units for a batch', async () => {
      const fetchMock = vi.fn().mockResolvedValue(perplexityOk())
      const [tool] = createEngineBaseTools(
        { ENGINES_PERPLEXITY_API_KEY: 'k' },
        fetchMock as unknown as typeof fetch,
      )
      const result = await tool.execute({ questions: ['q1', 'q2', 'q3'], samples: 2 }, ctx)

      expect(fetchMock).toHaveBeenCalledTimes(6)
      expect(result.isError).toBeFalsy()
      expect(result.meta?.engineUnits).toBe(6)
      expect(decodeExternalCostMeta(result.meta)).toEqual({
        kind: 'flat',
        model: 'engine:perplexity',
        flatCostUsd: flatEngineCostUsd('perplexity') * 6,
      })
    })

    it('bills only the units that returned an answer', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(fakeResponse('rate limited', 429))
        .mockResolvedValueOnce(perplexityOk())
      const [tool] = createEngineBaseTools(
        { ENGINES_PERPLEXITY_API_KEY: 'k' },
        fetchMock as unknown as typeof fetch,
      )
      const result = await tool.execute({ questions: ['q1', 'q2'] }, ctx)

      expect(result.isError).toBeFalsy()
      expect(result.meta?.engineUnits).toBe(1)
      expect(decodeExternalCostMeta(result.meta)).toMatchObject({
        flatCostUsd: flatEngineCostUsd('perplexity'),
      })
    })

    it('bills nothing and reports an error when every unit failed', async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeResponse('down', 500))
      const [tool] = createEngineBaseTools(
        { ENGINES_PERPLEXITY_API_KEY: 'k' },
        fetchMock as unknown as typeof fetch,
      )
      const result = await tool.execute({ questions: ['q1', 'q2'] }, ctx)

      expect(result.isError).toBe(true)
      expect(decodeExternalCostMeta(result.meta)).toBeUndefined()
    })

    it('an all-failed run reports a reason per question and ONE retry verdict', async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeResponse('down', 500))
      const [tool] = createEngineBaseTools(
        { ENGINES_PERPLEXITY_API_KEY: 'k' },
        fetchMock as unknown as typeof fetch,
      )
      const result = await tool.execute({ questions: ['who sells widgets', 'who sells gadgets'] }, ctx)

      expect(result.isError).toBe(true)
      const data = String(result.data)
      // Not the raw payload: a readable account, message first.
      expect(typeof result.data).toBe('string')
      expect(data).toContain('askPerplexity')
      expect(data).toContain('who sells widgets')
      expect(data).toContain('who sells gadgets')
      expect(data).toContain('upstream_error status=500')
      expect(data).toMatch(/Nothing was billed/i)
      expect(data).toMatch(/transient upstream failures/i)
      expect(data).toMatch(/Retry once/i)
      // The structured payload is still there, after the message.
      expect(data).toContain('"engine":"perplexity"')
    })

    it('a credentials failure is a do-not-retry verdict, not a retry', async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeResponse('bad key', 401))
      const [tool] = createEngineBaseTools(
        { ENGINES_PERPLEXITY_API_KEY: 'k' },
        fetchMock as unknown as typeof fetch,
      )
      const result = await tool.execute({ question: 'who sells widgets' }, ctx)

      expect(result.isError).toBe(true)
      const data = String(result.data)
      expect(data).toMatch(/credentials\/configuration problem/i)
      expect(data).toMatch(/Do NOT retry/)
      expect(data).toMatch(/tell the user/i)
      expect(data).not.toMatch(/Retry once/i)
    })

    it('a quota refusal says retrying now fails the same way', async () => {
      const fetchMock = vi.fn().mockResolvedValue(fakeResponse('slow down', 429))
      const [tool] = createEngineBaseTools(
        { ENGINES_PERPLEXITY_API_KEY: 'k' },
        fetchMock as unknown as typeof fetch,
      )
      const result = await tool.execute({ question: 'who sells widgets' }, ctx)

      expect(result.isError).toBe(true)
      expect(String(result.data)).toMatch(/out of quota or rate-limited/i)
      expect(String(result.data)).toMatch(/fails the same way/i)
    })

    it('a PARTIAL run keeps the structured payload untouched', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(fakeResponse('down', 500))
        .mockResolvedValueOnce(perplexityOk())
      const [tool] = createEngineBaseTools(
        { ENGINES_PERPLEXITY_API_KEY: 'k' },
        fetchMock as unknown as typeof fetch,
      )
      const result = await tool.execute({ questions: ['q1', 'q2'] }, ctx)

      expect(result.isError).toBeFalsy()
      expect(typeof result.data).toBe('object')
      expect(result.data).toMatchObject({ engine: 'perplexity' })
    })

    it('carries no daily ceiling — that guard belongs to the HTTP surface', async () => {
      const fetchMock = vi.fn().mockResolvedValue(perplexityOk())
      const [tool] = createEngineBaseTools(
        // A cap that would stop the MCP surface after 2 calls is inert here.
        { ENGINES_PERPLEXITY_API_KEY: 'k', ENGINES_DAILY_CALL_CAP: '2' },
        fetchMock as unknown as typeof fetch,
      )
      const result = await tool.execute({ questions: ['q1', 'q2', 'q3', 'q4'] }, ctx)

      expect(fetchMock).toHaveBeenCalledTimes(4)
      expect(result.meta?.engineUnits).toBe(4)
      expect(JSON.stringify(result.data)).not.toContain('ceiling')
    })
  })

  describe('caller-input refusal', () => {
    it('returns the refusal as a tool error without spending', async () => {
      const fetchMock = vi.fn()
      const [tool] = createEngineBaseTools(
        { ENGINES_PERPLEXITY_API_KEY: 'k' },
        fetchMock as unknown as typeof fetch,
      )
      const result = await tool.execute({}, ctx)

      expect(result.isError).toBe(true)
      expect(result.data).toContain('question')
      expect(decodeExternalCostMeta(result.meta)).toBeUndefined()
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
