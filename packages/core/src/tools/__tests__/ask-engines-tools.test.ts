import { describe, it, expect, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
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
        ENGINES_GSC_KEY_JSON: '{"client_email":"a@b.example","private_key":"x"}',
      }).map((t) => t.name)
      expect(names).toEqual(['askPerplexity', 'searchConsoleQuery'])
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

  describe('searchConsoleQuery', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const saJson = JSON.stringify({
      client_email: 'watch@project.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      token_uri: 'https://oauth2.googleapis.com/token',
    })

    it('records a $0 audit row rather than no row at all', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(fakeResponse({ access_token: 'ya29.tok', expires_in: 3600 }))
        .mockResolvedValueOnce(fakeResponse({ rows: [{ keys: ['q'], clicks: 1 }] }))
      const [tool] = createEngineBaseTools(
        { ENGINES_GSC_KEY_JSON: saJson, ENGINES_GSC_SITE: 'sc-domain:example.com' },
        fetchMock as unknown as typeof fetch,
      )
      const result = await tool.execute(
        { startDate: '2026-08-01', endDate: '2026-08-07' },
        ctx,
      )

      expect(result.isError).toBeFalsy()
      expect(decodeExternalCostMeta(result.meta)).toEqual({
        kind: 'flat',
        model: 'engine:gsc',
        flatCostUsd: 0,
      })
    })

    it('surfaces a missing property as a tool error, not a crash', async () => {
      const fetchMock = vi.fn()
      const [tool] = createEngineBaseTools(
        { ENGINES_GSC_KEY_JSON: saJson },
        fetchMock as unknown as typeof fetch,
      )
      const result = await tool.execute(
        { startDate: '2026-08-01', endDate: '2026-08-07' },
        ctx,
      )
      expect(result.isError).toBe(true)
      expect(String(result.data)).toContain('siteUrl')
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
