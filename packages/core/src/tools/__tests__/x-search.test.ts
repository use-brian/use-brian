import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { xSearchTool, __resetXSearchCache, _getXSearchCacheSize } from '../base/x-search.js'

const ctx = {
  userId: 'test-user',
  assistantId: 'test-assistant',
  sessionId: 'test-session',
  appId: 'test',
  channelType: 'web',
  channelId: 'test-channel',
  abortSignal: new AbortController().signal,
}

async function withXaiKey<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'stub'
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = prev
  }
}

function mockXaiResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const SAMPLE_RESPONSE = {
  output: [
    {
      type: 'message',
      content: [
        {
          type: 'output_text',
          text: '@xai announced new Grok 4 features.',
          annotations: [
            { type: 'url_citation', url: 'https://x.com/xai/status/123' },
            { type: 'url_citation', url: 'https://x.com/xai/status/123' }, // duplicate
            { type: 'url_citation', url: 'https://x.com/xai/status/456' },
          ],
        },
      ],
    },
  ],
  usage: {
    input_tokens: 523,
    output_tokens: 487,
    input_tokens_cached: 40,
  },
}

describe('[COMP:tools/x-search] xSearch tool', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    __resetXSearchCache()
    fetchSpy = vi.fn(async () => mockXaiResponse(SAMPLE_RESPONSE))
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns error result when XAI_API_KEY is missing', async () => {
    const prev = process.env.XAI_API_KEY
    delete process.env.XAI_API_KEY
    try {
      const result = await xSearchTool.execute({ query: 'anything' }, ctx)
      expect(result.isError).toBe(true)
      expect(String(result.data)).toContain('XAI_API_KEY')
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      if (prev !== undefined) process.env.XAI_API_KEY = prev
    }
  })

  it('posts to xAI /v1/responses with Bearer auth and x_search tool', async () => {
    await withXaiKey(async () => {
      const result = await xSearchTool.execute({ query: 'latest from xai' }, ctx)
      expect(result.isError).toBeFalsy()

      expect(fetchSpy).toHaveBeenCalledOnce()
      const call = fetchSpy.mock.calls[0]
      expect(call[0]).toBe('https://api.x.ai/v1/responses')
      const init = call[1] as RequestInit & { body: string }
      expect(init.method).toBe('POST')
      const headers = init.headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer stub')

      const body = JSON.parse(init.body)
      expect(body.model).toBe('grok-4-1-fast')
      expect(body.input).toEqual([{ role: 'user', content: 'latest from xai' }])
      expect(body.tools).toEqual([{ type: 'x_search' }])

      const data = result.data as { provider: string; content: string; citations: string[] }
      expect(data.provider).toBe('xai')
      expect(data.content).toContain('Grok 4')
      expect(data.citations).toEqual([
        'https://x.com/xai/status/123',
        'https://x.com/xai/status/456',
      ])

      expect(result.meta?.searchProvider).toBe('xai')
      expect(result.meta?.externalCost_kind).toBe('per-token')
      expect(result.meta?.externalCost_model).toBe('grok-4-1-fast')
      expect(result.meta?.externalCost_inputTokens).toBe(523)
      expect(result.meta?.externalCost_outputTokens).toBe(487)
      expect(result.meta?.externalCost_cacheReadTokens).toBe(40)
    })
  })

  it('routes a bare status-URL query through the verbatim-quote path', async () => {
    await withXaiKey(async () => {
      const result = await xSearchTool.execute(
        { query: '  https://x.com/AnatoliKopadze/status/2068328135611822149  ' },
        ctx,
      )
      expect(result.isError).toBeFalsy()

      const init = fetchSpy.mock.calls[0][1] as RequestInit & { body: string }
      const body = JSON.parse(init.body)
      // Verbatim reads use the cheaper non-reasoning quote model, scope to the
      // post's handle, and instruct Grok to quote rather than synthesize.
      expect(body.model).toBe('grok-4-1-fast-non-reasoning')
      expect(body.tools).toEqual([
        { type: 'x_search', allowed_x_handles: ['AnatoliKopadze'] },
      ])
      expect(body.input[0].content).toContain('Quote verbatim')
      expect(body.input[0].content).toContain(
        'https://x.com/AnatoliKopadze/status/2068328135611822149',
      )
      expect(body.input[0].content).not.toContain('  ')

      const data = result.data as { model: string; content: string }
      expect(data.model).toBe('grok-4-1-fast-non-reasoning')
      expect(data.content).toContain('Grok 4')
    })
  })

  it('keeps generic search for natural-language queries that merely contain a URL', async () => {
    await withXaiKey(async () => {
      await xSearchTool.execute(
        { query: 'summarize https://x.com/AnatoliKopadze/status/2068328135611822149' },
        ctx,
      )
      const init = fetchSpy.mock.calls[0][1] as RequestInit & { body: string }
      const body = JSON.parse(init.body)
      // Not a bare permalink → stays on the reasoning search model, no handle scope.
      expect(body.model).toBe('grok-4-1-fast')
      expect(body.tools).toEqual([{ type: 'x_search' }])
      expect(body.input[0].content).toBe(
        'summarize https://x.com/AnatoliKopadze/status/2068328135611822149',
      )
    })
  })

  it('treats an X profile/search URL (no /status/) as a generic query', async () => {
    await withXaiKey(async () => {
      await xSearchTool.execute({ query: 'https://x.com/AnatoliKopadze' }, ctx)
      const init = fetchSpy.mock.calls[0][1] as RequestInit & { body: string }
      const body = JSON.parse(init.body)
      expect(body.model).toBe('grok-4-1-fast')
      expect(body.tools).toEqual([{ type: 'x_search' }])
    })
  })

  it('cache hits do NOT re-emit externalCost meta (no re-billing)', async () => {
    await withXaiKey(async () => {
      const first = await xSearchTool.execute({ query: 'cache-test' }, ctx)
      const second = await xSearchTool.execute({ query: 'cache-test' }, ctx)
      expect(first.meta?.externalCost_kind).toBe('per-token')
      expect(second.meta).toEqual({ searchProvider: 'xai' })
      expect(second.meta?.externalCost_kind).toBeUndefined()
      expect((second.data as { cached?: boolean }).cached).toBe(true)
    })
  })

  it('passes allowedHandles, excludedHandles, and date range through to the payload', async () => {
    await withXaiKey(async () => {
      await xSearchTool.execute(
        {
          query: 'q',
          allowedHandles: ['elonmusk'],
          excludedHandles: ['spam'],
          fromDate: '2026-01-01',
          toDate: '2026-04-22',
        },
        ctx,
      )
      const init = fetchSpy.mock.calls[0][1] as RequestInit & { body: string }
      const body = JSON.parse(init.body)
      expect(body.tools[0]).toEqual({
        type: 'x_search',
        allowed_x_handles: ['elonmusk'],
        excluded_x_handles: ['spam'],
        from_date: '2026-01-01',
        to_date: '2026-04-22',
      })
    })
  })

  it('rejects fromDate after toDate', async () => {
    await withXaiKey(async () => {
      const result = await xSearchTool.execute(
        { query: 'q', fromDate: '2026-05-01', toDate: '2026-04-01' },
        ctx,
      )
      expect(result.isError).toBe(true)
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })

  it('cache hits skip the HTTP call', async () => {
    await withXaiKey(async () => {
      await xSearchTool.execute({ query: 'same' }, ctx)
      const second = await xSearchTool.execute({ query: 'same' }, ctx)
      expect(fetchSpy).toHaveBeenCalledOnce()
      expect((second.data as { cached?: boolean }).cached).toBe(true)
    })
  })

  it('different args miss the cache', async () => {
    await withXaiKey(async () => {
      await xSearchTool.execute({ query: 'a' }, ctx)
      await xSearchTool.execute({ query: 'b' }, ctx)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })
  })

  it('sanitizes zero-width characters out of the response content', async () => {
    fetchSpy.mockImplementationOnce(async () =>
      mockXaiResponse({
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'clean\u200Btext',
                annotations: [],
              },
            ],
          },
        ],
      }),
    )
    await withXaiKey(async () => {
      const result = await xSearchTool.execute({ query: 'unique-zw' }, ctx)
      const data = result.data as { content: string }
      expect(data.content).toBe('cleantext')
    })
  })

  it('surfaces xAI error responses as isError', async () => {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response('{"error": "bad key"}', {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    )
    await withXaiKey(async () => {
      const result = await xSearchTool.execute({ query: 'unique-err' }, ctx)
      expect(result.isError).toBe(true)
      expect(String(result.data)).toContain('401')
    })
  })
})

describe('[COMP:tools/x-search] cache bounds', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    __resetXSearchCache()
    fetchSpy = vi.fn(async () => mockXaiResponse(SAMPLE_RESPONSE))
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('a write sweeps entries whose TTL lapsed — one-shot queries do not pin memory', async () => {
    vi.useFakeTimers()
    await withXaiKey(async () => {
      await xSearchTool.execute({ query: 'one-shot-a' }, ctx)
      await xSearchTool.execute({ query: 'one-shot-b' }, ctx)
      expect(_getXSearchCacheSize()).toBe(2)
      vi.advanceTimersByTime(16 * 60 * 1000) // past the 15-min TTL
      // readCache only deletes the exact key it re-reads; the sweep on this
      // unrelated write is what reclaims the expired one-shot entries.
      await xSearchTool.execute({ query: 'one-shot-c' }, ctx)
      expect(_getXSearchCacheSize()).toBe(1)
    })
  })

  it('caps entries oldest-first so distinct queries cannot grow the map unboundedly', async () => {
    await withXaiKey(async () => {
      for (let i = 0; i < 130; i++) {
        await xSearchTool.execute({ query: `distinct-query-${i}` }, ctx)
      }
      expect(_getXSearchCacheSize()).toBe(128)
      // The first query fell off the cap: repeating it re-fetches (cache miss).
      const callsBefore = fetchSpy.mock.calls.length
      await xSearchTool.execute({ query: 'distinct-query-0' }, ctx)
      expect(fetchSpy.mock.calls.length).toBe(callsBefore + 1)
    })
  })
})
