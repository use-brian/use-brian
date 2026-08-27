import { describe, it, expect, vi } from 'vitest'
import { createEngineTools, type EnginesEnv } from '../tools.js'
import { authorizeEnginesRequest, enginesMcpEnabled } from '../server.js'

function fakeResponse(body: unknown, status = 200) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => raw,
    json: async () => JSON.parse(raw) as unknown,
  } as Response
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('')
}

type AskPayload = {
  engine: string
  model: string
  samples: number
  note?: string
  results: Array<{
    question: string
    answers: Array<{
      answer?: string
      error?: string
      citations?: Array<{ url: string; title?: string }>
      matches?: Array<{ term: string; inAnswer: boolean; inCitations: boolean }>
    }>
  }>
}

function perplexityResponse(content: string, urls: string[] = []) {
  return fakeResponse({
    choices: [{ message: { content } }],
    search_results: urls.map((url) => ({ url, title: 't' })),
  })
}

describe('[COMP:api/engines-mcp] AI Engines MCP', () => {
  describe('bearer auth', () => {
    it('accepts the exact secret, rejects everything else uniformly', () => {
      expect(authorizeEnginesRequest('Bearer s3cret', 's3cret')).toBe(true)
      expect(authorizeEnginesRequest('Bearer wrong', 's3cret')).toBe(false)
      expect(authorizeEnginesRequest('Bearer s3cret ', 's3cret')).toBe(false)
      expect(authorizeEnginesRequest(undefined, 's3cret')).toBe(false)
      expect(authorizeEnginesRequest('s3cret', 's3cret')).toBe(false)
      // Fail-closed when the secret is unset — never an open endpoint.
      expect(authorizeEnginesRequest('Bearer ', '')).toBe(false)
    })
  })

  describe('env gating', () => {
    it('route gate needs the secret AND at least one credential', () => {
      expect(enginesMcpEnabled({})).toBe(false)
      expect(enginesMcpEnabled({ ENGINES_MCP_SECRET: 's' })).toBe(false)
      expect(enginesMcpEnabled({ ENGINES_OPENAI_API_KEY: 'k' })).toBe(false)
      expect(enginesMcpEnabled({ ENGINES_MCP_SECRET: 's', ENGINES_OPENAI_API_KEY: 'k' })).toBe(true)
      expect(enginesMcpEnabled({ ENGINES_MCP_SECRET: 's', ENGINES_ANTHROPIC_API_KEY: 'k' })).toBe(true)
      expect(enginesMcpEnabled({ ENGINES_MCP_SECRET: 's', ENGINES_GEMINI_API_KEY: 'k' })).toBe(true)
      expect(enginesMcpEnabled({ ENGINES_MCP_SECRET: 's', ENGINES_PERPLEXITY_API_KEY: 'k' })).toBe(true)
      // The four ask engines are the ONLY gate (Search Console moved to the
      // per-workspace `gsc` connector, docs/architecture/integrations/search-console.md):
      // the secret plus a non-credential engines key does not open the route.
      expect(enginesMcpEnabled({ ENGINES_MCP_SECRET: 's', ENGINES_DAILY_CALL_CAP: '5' })).toBe(false)
    })

    it('registers only the tools whose credential exists', () => {
      expect(createEngineTools({}).map((t) => t.name)).toEqual([])
      const names = createEngineTools({
        ENGINES_PERPLEXITY_API_KEY: 'pplx-k',
        ENGINES_ANTHROPIC_API_KEY: 'ant-k',
      }).map((t) => t.name)
      expect(names).toEqual(['askPerplexity', 'askClaude'])
    })
  })

  describe('ask framework (batch / samples / checkFor / truncation)', () => {
    const env: EnginesEnv = { ENGINES_PERPLEXITY_API_KEY: 'pplx-k' }

    it('a questions panel makes one upstream call per question in one tool call', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(perplexityResponse('answer one', ['https://usebrian.ai/']))
        .mockResolvedValueOnce(perplexityResponse('answer two'))
      const [tool] = createEngineTools(env, fetchMock as unknown as typeof fetch)
      const result = await tool.handler({ questions: ['q1', 'q2'] })

      expect(fetchMock).toHaveBeenCalledTimes(2)
      const payload = JSON.parse(textOf(result)) as AskPayload
      expect(payload.results).toHaveLength(2)
      expect(payload.results.map((r) => r.question)).toEqual(['q1', 'q2'])
      expect(payload.results[0].answers[0].citations).toEqual([
        { url: 'https://usebrian.ai/', title: 't' },
      ])
    })

    it('samples repeats each question and returns every sample', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(perplexityResponse('take 1'))
        .mockResolvedValueOnce(perplexityResponse('take 2'))
      const [tool] = createEngineTools(env, fetchMock as unknown as typeof fetch)
      const payload = JSON.parse(
        textOf(await tool.handler({ question: 'q', samples: 2 })),
      ) as AskPayload
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(payload.results[0].answers).toHaveLength(2)
    })

    it('checkFor detects terms in the FULL answer + citations even under truncation', async () => {
      const longTail = `${'x'.repeat(900)} Use Brian is mentioned way out here.`
      const fetchMock = vi
        .fn()
        .mockResolvedValue(perplexityResponse(longTail, ['https://dust.tt/glean']))
      const [tool] = createEngineTools(env, fetchMock as unknown as typeof fetch)
      const payload = JSON.parse(
        textOf(
          await tool.handler({
            question: 'q',
            checkFor: ['use brian', 'dust.tt', 'glean', 'notion'],
            answerMaxChars: 200,
          }),
        ),
      ) as AskPayload
      const one = payload.results[0].answers[0]
      expect(one.answer!.length).toBeLessThan(220)
      expect(one.answer).toContain('[truncated]')
      expect(one.matches).toEqual([
        { term: 'use brian', inAnswer: true, inCitations: false },
        { term: 'dust.tt', inAnswer: false, inCitations: true },
        { term: 'glean', inAnswer: false, inCitations: true },
        { term: 'notion', inAnswer: false, inCitations: false },
      ])
    })

    it('a mid-batch ceiling hit yields PARTIAL results with an explicit note', async () => {
      const fetchMock = vi.fn().mockResolvedValue(perplexityResponse('a'))
      const [tool] = createEngineTools(
        { ...env, ENGINES_DAILY_CALL_CAP: '2' },
        fetchMock as unknown as typeof fetch,
      )
      const payload = JSON.parse(
        textOf(await tool.handler({ questions: ['q1', 'q2', 'q3', 'q4'] })),
      ) as AskPayload
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(payload.note).toContain('ceiling')
      const errored = payload.results.flatMap((r) => r.answers).filter((a) => a.error)
      expect(errored).toHaveLength(2)
    })

    it('an explicit cap of 0 disables the ceiling (operator opt-out)', async () => {
      const fetchMock = vi.fn().mockResolvedValue(perplexityResponse('a'))
      const [tool] = createEngineTools(
        { ...env, ENGINES_DAILY_CALL_CAP: '0' },
        fetchMock as unknown as typeof fetch,
      )
      const payload = JSON.parse(
        textOf(await tool.handler({ questions: Array.from({ length: 25 }, (_, i) => `q${i}`), samples: 3 })),
      ) as AskPayload
      expect(fetchMock).toHaveBeenCalledTimes(75)
      expect(payload.note).toBeUndefined()
    })

    it('flattens upstream failures to a coded per-answer error, never vendor text', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(fakeResponse('You exceeded your quota, buy credits at ...', 429))
        .mockResolvedValueOnce(fakeResponse('Still rate limited', 429))
        .mockResolvedValueOnce(fakeResponse('Still rate limited', 429))
        .mockResolvedValueOnce(perplexityResponse('fine'))
      const [tool] = createEngineTools(env, fetchMock as unknown as typeof fetch)
      const result = await tool.handler({ questions: ['q1', 'q2'] })
      const payload = JSON.parse(textOf(result)) as AskPayload
      // Partial: one errored, one answered — the call as a whole is NOT an error.
      expect(fetchMock).toHaveBeenCalledTimes(4)
      expect(result.isError).toBeFalsy()
      expect(payload.results[0].answers[0].error).toContain('upstream_error status=429')
      expect(textOf(result)).not.toContain('quota')
      expect(payload.results[1].answers[0].answer).toBe('fine')
    })
  })

  describe('askOpenAI', () => {
    it('uses the Responses API with web_search, country hint, and url_citation parsing', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        fakeResponse({
          output: [
            {
              content: [
                {
                  text: 'Some engines recommend Use Brian.',
                  annotations: [
                    { type: 'url_citation', url: 'https://usebrian.ai/docs', title: 'Docs' },
                    { type: 'other', url: 'https://ignored.example' },
                  ],
                },
              ],
            },
          ],
        }),
      )
      const [tool] = createEngineTools(
        { ENGINES_OPENAI_API_KEY: 'sk-k' },
        fetchMock as unknown as typeof fetch,
      )
      const result = await tool.handler({ question: 'best company brain?', country: 'us' })

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://api.openai.com/v1/responses')
      const body = JSON.parse(String(init.body)) as {
        tools: Array<Record<string, unknown>>
        max_output_tokens: number
      }
      expect(body.tools).toEqual([
        { type: 'web_search', user_location: { type: 'approximate', country: 'US' } },
      ])
      expect(body.max_output_tokens).toBe(2048)

      const payload = JSON.parse(textOf(result)) as AskPayload
      expect(payload.results[0].answers[0].citations).toEqual([
        { url: 'https://usebrian.ai/docs', title: 'Docs' },
      ])
    })
  })

  describe('askGemini', () => {
    it('uses grounded generateContent and parses groundingChunks', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        fakeResponse({
          candidates: [
            {
              content: { parts: [{ text: 'Grounded answer.' }] },
              groundingMetadata: {
                groundingChunks: [{ web: { uri: 'https://usebrian.ai/', title: 'Use Brian' } }],
              },
            },
          ],
        }),
      )
      const [tool] = createEngineTools(
        { ENGINES_GEMINI_API_KEY: 'AIza-k', ENGINES_GEMINI_MODEL: 'gemini-test' },
        fetchMock as unknown as typeof fetch,
      )
      const result = await tool.handler({ question: 'q' })

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toContain('/models/gemini-test:generateContent')
      expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIza-k')
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      expect(body.tools).toEqual([{ google_search: {} }])

      const payload = JSON.parse(textOf(result)) as AskPayload
      expect(payload.results[0].answers[0].answer).toBe('Grounded answer.')
      expect(payload.results[0].answers[0].citations).toEqual([
        { url: 'https://usebrian.ai/', title: 'Use Brian' },
      ])
    })
  })

  describe('askClaude', () => {
    it('uses the Messages API with web_search and parses text-block citations', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        fakeResponse({
          content: [
            { type: 'server_tool_use', name: 'web_search' },
            {
              type: 'text',
              text: 'Use Brian is an AI company brain.',
              citations: [{ url: 'https://usebrian.ai/', title: 'Use Brian' }],
            },
          ],
        }),
      )
      const [tool] = createEngineTools(
        { ENGINES_ANTHROPIC_API_KEY: 'ant-k' },
        fetchMock as unknown as typeof fetch,
      )
      const result = await tool.handler({ question: 'what is use brian?' })

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://api.anthropic.com/v1/messages')
      const headers = init.headers as Record<string, string>
      expect(headers['x-api-key']).toBe('ant-k')
      expect(headers['anthropic-version']).toBe('2023-06-01')
      const body = JSON.parse(String(init.body)) as { tools: Array<Record<string, unknown>> }
      expect(body.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }])

      const payload = JSON.parse(textOf(result)) as AskPayload
      expect(payload.engine).toBe('claude')
      expect(payload.results[0].answers[0].citations).toEqual([
        { url: 'https://usebrian.ai/', title: 'Use Brian' },
      ])
    })
  })
})
