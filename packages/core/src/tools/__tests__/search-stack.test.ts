import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import { createSearchStack, type SearchProvider, type SearchResult } from '../base/search-stack.js'
import { braveProvider } from '../base/search-brave.js'
import { serperProvider } from '../base/search-serper.js'
import { serpApiProvider } from '../base/search-serpapi.js'
import { tavilyProvider } from '../base/search-tavily.js'
import { baiduProvider } from '../base/search-baidu.js'
import { duckDuckGoProvider } from '../base/search-ddg.js'
import { webSearchTool } from '../base/web-search.js'
import type { ToolContext } from '../types.js'
import { createToolExecutor, NO_TOOL_TIMEOUT } from '../../engine/tool-executor.js'
import { createLoopDetector } from '../../engine/loop-detector.js'
import type { ContentBlock } from '../../providers/types.js'

// ── Helpers ─────────────────────────────────────────────────────

function mockProvider(
  name: string,
  opts: { available?: boolean; results?: SearchResult[]; throws?: Error } = {},
): SearchProvider {
  return {
    name,
    available: () => opts.available ?? true,
    search: async () => {
      if (opts.throws) throw opts.throws
      return opts.results ?? []
    },
  }
}

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
}

function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('This operation was aborted'))
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function drainResults(executor: ReturnType<typeof createToolExecutor>): Promise<ContentBlock[]> {
  const all: ContentBlock[] = []
  for await (const batch of executor.getRemainingResults()) all.push(...batch.blocks)
  return all
}

// ── Stack composer tests ────────────────────────────────────────

describe('[COMP:tools/search] Search stack composer', () => {
  it('returns the first provider with results', async () => {
    const stack = createSearchStack([
      mockProvider('a', { results: [] }),
      mockProvider('b', { results: [{ title: 'hit', url: 'https://ok', snippet: 's' }] }),
      mockProvider('c', { results: [{ title: 'never', url: 'https://x', snippet: 'x' }] }),
    ])
    const out = await stack('q', 5)
    expect(out.provider).toBe('b')
    expect(out.results).toEqual([{ title: 'hit', url: 'https://ok', snippet: 's' }])
  })

  it('skips unavailable providers', async () => {
    const stack = createSearchStack([
      mockProvider('a', { available: false, results: [{ title: 'skipped', url: 'x', snippet: 'x' }] }),
      mockProvider('b', { results: [{ title: 'hit', url: 'https://ok', snippet: 's' }] }),
    ])
    const out = await stack('q', 5)
    expect(out.provider).toBe('b')
    expect(out.results[0].title).toBe('hit')
  })

  it('falls through on provider error', async () => {
    const stack = createSearchStack([
      mockProvider('a', { throws: new Error('429 rate limited') }),
      mockProvider('b', { results: [{ title: 'hit', url: 'https://ok', snippet: 's' }] }),
    ])
    const out = await stack('q', 5)
    expect(out.provider).toBe('b')
    expect(out.results[0].title).toBe('hit')
  })

  it('returns provider=null with [] when every provider is empty or unavailable', async () => {
    const stack = createSearchStack([
      mockProvider('a', { available: false }),
      mockProvider('b', { results: [] }),
      mockProvider('c', { throws: new Error('boom') }),
    ])
    const out = await stack('q', 5)
    expect(out).toEqual({
      provider: null,
      results: [],
      failures: [{ provider: 'c', error: 'boom' }],
      trustedEmpty: true,
    })
  })

  it('records every provider failure and trustedEmpty=false when all throw', async () => {
    const stack = createSearchStack([
      mockProvider('a', { throws: new Error('Tavily HTTP 432') }),
      mockProvider('b', { throws: new Error('Brave HTTP 402') }),
    ])
    const out = await stack('q', 5)
    expect(out.provider).toBeNull()
    expect(out.trustedEmpty).toBe(false)
    expect(out.failures).toEqual([
      { provider: 'a', error: 'Tavily HTTP 432' },
      { provider: 'b', error: 'Brave HTTP 402' },
    ])
  })

  it('an empty from a trustEmpty:false provider does not set trustedEmpty', async () => {
    const scraper = mockProvider('ddg-like', { results: [] })
    scraper.trustEmpty = false
    const stack = createSearchStack([mockProvider('a', { throws: new Error('quota') }), scraper])
    const out = await stack('q', 5)
    expect(out.trustedEmpty).toBe(false)
    expect(out.failures).toEqual([{ provider: 'a', error: 'quota' }])
  })

  it('applies sanitizeDeep to returned results (strips zero-width chars)', async () => {
    const dirty = 'Fli\u200Bghts'
    const stack = createSearchStack([
      mockProvider('a', { results: [{ title: dirty, url: 'https://ok', snippet: dirty }] }),
    ])
    const out = await stack('q', 5)
    expect(out.results[0].title).toBe('Flights')
    expect(out.results[0].snippet).toBe('Flights')
  })

  it('aborts early if signal is already aborted between providers', async () => {
    const controller = new AbortController()
    const calls: string[] = []
    const stack = createSearchStack([
      {
        name: 'a',
        available: () => true,
        search: async () => {
          calls.push('a')
          controller.abort()
          return []
        },
      },
      {
        name: 'b',
        available: () => true,
        search: async () => {
          calls.push('b')
          return [{ title: 'should-not-run', url: 'x', snippet: '' }]
        },
      },
    ])
    const out = await stack('q', 5, controller.signal)
    expect(out.provider).toBeNull()
    expect(out.results).toEqual([])
    expect(calls).toEqual(['a'])
  })
})

// ── Provider availability tests (env-driven) ────────────────────

describe('[COMP:tools/search] Provider availability gates', () => {
  it('braveProvider is unavailable without BRAVE_SEARCH_API_KEY', () => {
    withEnv('BRAVE_SEARCH_API_KEY', undefined, () => {
      expect(braveProvider.available()).toBe(false)
    })
  })

  it('braveProvider is available with BRAVE_SEARCH_API_KEY', () => {
    withEnv('BRAVE_SEARCH_API_KEY', 'test-token', () => {
      expect(braveProvider.available()).toBe(true)
    })
  })

  it('serperProvider gates on SERPER_API_KEY', () => {
    withEnv('SERPER_API_KEY', undefined, () => {
      expect(serperProvider.available()).toBe(false)
    })
    withEnv('SERPER_API_KEY', 'test-token', () => {
      expect(serperProvider.available()).toBe(true)
    })
  })

  it('serpApiProvider gates on SERPAPI_API_KEY', () => {
    withEnv('SERPAPI_API_KEY', undefined, () => {
      expect(serpApiProvider.available()).toBe(false)
    })
    withEnv('SERPAPI_API_KEY', 'test-token', () => {
      expect(serpApiProvider.available()).toBe(true)
    })
  })

  it('tavilyProvider gates on TAVILY_API_KEY', () => {
    withEnv('TAVILY_API_KEY', undefined, () => {
      expect(tavilyProvider.available()).toBe(false)
    })
    withEnv('TAVILY_API_KEY', 'test-token', () => {
      expect(tavilyProvider.available()).toBe(true)
    })
  })

  it('baiduProvider gates on BAIDU_SEARCH_API_KEY and serializes exact panels', () => {
    withEnv('BAIDU_SEARCH_API_KEY', undefined, () => {
      expect(baiduProvider.available()).toBe(false)
    })
    withEnv('BAIDU_SEARCH_API_KEY', 'test-token', () => {
      expect(baiduProvider.available()).toBe(true)
    })
    expect(baiduProvider.panelConcurrency).toBe(1)
  })

  it('duckDuckGoProvider is always available (no-token fallback)', () => {
    expect(duckDuckGoProvider.available()).toBe(true)
  })

  it('duckDuckGoProvider empties are untrusted (challenge pages parse as zero results)', () => {
    expect(duckDuckGoProvider.trustEmpty).toBe(false)
  })
})

// ── webSearch tool: outage vs genuine no-results ─────────────────

describe('[COMP:tools/search] webSearch outage surfacing', () => {
  const ENV_KEYS = ['BRAVE_SEARCH_API_KEY', 'SERPER_API_KEY', 'SERPAPI_API_KEY', 'TAVILY_API_KEY', 'BAIDU_SEARCH_API_KEY'] as const
  let savedEnv: Record<string, string | undefined>
  let fetchSpy: MockInstance<typeof fetch>

  const ctx = { abortSignal: new AbortController().signal } as ToolContext

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    delete process.env.BRAVE_SEARCH_API_KEY
    delete process.env.SERPER_API_KEY
    delete process.env.SERPAPI_API_KEY
    delete process.env.BAIDU_SEARCH_API_KEY
    process.env.TAVILY_API_KEY = 'test-token'
    fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as MockInstance<typeof fetch>
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
    fetchSpy.mockRestore()
  })

  it('returns an isError result when every provider fails (quota outage, not "no results")', async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('tavily')) return new Response('plan limit', { status: 432 })
      return new Response('blocked', { status: 403 }) // DDG
    })

    const out = await webSearchTool.execute({ query: 'David Yeung Green Monday LinkedIn' }, ctx)
    expect(out.isError).toBe(true)
    expect(String(out.data)).toMatch(/temporarily unavailable/)
    expect(String(out.data)).not.toMatch(/No results found/)
    expect(out.meta?.searchProviderErrors).toContain('tavily: Tavily HTTP 432')
    expect(out.meta?.searchProviderErrors).toContain('duckduckgo: DuckDuckGo HTTP 403')
  })

  it('still reports "No results found" when a keyed provider returns a real empty set', async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('tavily')) return new Response(JSON.stringify({ results: [] }), { status: 200 })
      return new Response('blocked', { status: 403 }) // DDG
    })

    const out = await webSearchTool.execute({ query: 'xzqv-no-such-thing' }, ctx)
    expect(out.isError).toBeUndefined()
    expect(out.data).toBe('No results found. Try a different query.')
  })
})

describe('[COMP:tools/search] webSearch exact-provider panels', () => {
  const ENV_KEYS = ['BRAVE_SEARCH_API_KEY', 'SERPER_API_KEY', 'SERPAPI_API_KEY', 'TAVILY_API_KEY', 'BAIDU_SEARCH_API_KEY'] as const
  let savedEnv: Record<string, string | undefined>
  let fetchSpy: MockInstance<typeof fetch>

  const ctx = { abortSignal: new AbortController().signal } as ToolContext

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
    process.env.BRAVE_SEARCH_API_KEY = 'brave-token'
    process.env.SERPER_API_KEY = 'serper-token'
    process.env.SERPAPI_API_KEY = 'serpapi-token'
    process.env.TAVILY_API_KEY = 'tavily-token'
    process.env.BAIDU_SEARCH_API_KEY = 'baidu-token'
    fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as MockInstance<typeof fetch>
  })

  afterEach(() => {
    vi.useRealTimers()
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    fetchSpy.mockRestore()
  })

  it('requires exactly one query shape and an exact provider for panels', () => {
    expect(webSearchTool.inputSchema.safeParse({}).success).toBe(false)
    expect(webSearchTool.inputSchema.safeParse({ query: 'one', queries: ['two'], provider: 'serper' }).success)
      .toBe(false)
    expect(webSearchTool.inputSchema.safeParse({ queries: ['one'] }).success).toBe(false)
    expect(webSearchTool.inputSchema.safeParse({ queries: ['one'], provider: 'serper' }).success).toBe(true)
    expect(webSearchTool.inputSchema.safeParse({ queries: ['one'], provider: 'serpapi' }).success).toBe(true)
    expect(webSearchTool.inputSchema.safeParse({ queries: ['one'], provider: 'baidu' }).success).toBe(true)
    expect(webSearchTool.inputSchema.safeParse({ query: 'one', resultMode: 'measurement' }).success).toBe(false)
    expect(webSearchTool.inputSchema.safeParse({ query: 'one', trackDomains: ['example.com'] }).success).toBe(false)
    expect(webSearchTool.inputSchema.safeParse({
      query: 'one',
      provider: 'serpapi',
      resultMode: 'measurement',
      trackDomains: ['not a domain'],
    }).success).toBe(false)
  })

  it('uses only the selected provider and makes its provenance model-visible', async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input)
      expect(url).toContain('google.serper.dev')
      return new Response(
        JSON.stringify({ organic: [{ title: 'Use Brian', link: 'https://usebrian.ai/', snippet: 'Company brain' }] }),
        { status: 200 },
      )
    })

    const out = await webSearchTool.execute(
      { query: 'AI company brain', provider: 'serper', maxResults: 10 },
      ctx,
    )

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(out.isError).toBeUndefined()
    expect(out.data).toMatchObject({
      provider: 'serper',
      expectedQueries: 1,
      completed: 1,
      failed: 0,
      searches: [{ query: 'AI company brain', status: 'ok', provider: 'serper' }],
    })
    expect(out.meta).toMatchObject({
      searchProvider: 'serper',
      searchProviderUnits: 1,
      externalCost_model: 'serper',
      externalCost_flatCostUsd: 0.001,
    })
  })

  it('preserves input order and partial errors while charging only served units', async () => {
    fetchSpy.mockImplementation(async (_input, init) => {
      const query = String(JSON.parse(String(init?.body)).q)
      if (query === 'q2') return new Response('rate limited', { status: 429 })
      return new Response(
        JSON.stringify({ organic: [{ title: query, link: `https://${query}.example`, snippet: `${query} result` }] }),
        { status: 200 },
      )
    })

    const out = await webSearchTool.execute(
      { queries: ['q1', 'q2', 'q3'], provider: 'serper', maxResults: 10 },
      ctx,
    )
    const data = out.data as {
      completed: number
      failed: number
      searches: Array<{ query: string; status: string; error?: string }>
    }

    expect(out.isError).toBeUndefined()
    expect(data.completed).toBe(2)
    expect(data.failed).toBe(1)
    expect(data.searches.map((search) => [search.query, search.status])).toEqual([
      ['q1', 'ok'],
      ['q2', 'error'],
      ['q3', 'ok'],
    ])
    expect(data.searches[1].error).toMatch(/Serper HTTP 429/)
    expect(out.meta).toMatchObject({
      searchProvider: 'serper',
      searchProviderUnits: 2,
      externalCost_flatCostUsd: 0.002,
    })
  })

  it('runs an exact SerpAPI panel without falling through and records its units', async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = new URL(String(input))
      expect(url.origin + url.pathname).toBe('https://serpapi.com/search.json')
      expect(url.searchParams.get('engine')).toBe('google')
      expect(url.searchParams.get('api_key')).toBe('serpapi-token')
      const query = url.searchParams.get('q') ?? ''
      return new Response(JSON.stringify({
        organic_results: [{ title: query, link: 'https://usebrian.ai/', snippet: 'Company brain' }],
      }), { status: 200 })
    })

    const out = await webSearchTool.execute(
      { queries: ['q1', 'q2'], provider: 'serpapi', maxResults: 10 },
      ctx,
    )

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(out.isError).toBeUndefined()
    expect(out.data).toMatchObject({
      provider: 'serpapi',
      expectedQueries: 2,
      completed: 2,
      failed: 0,
      searches: [
        { query: 'q1', status: 'ok', provider: 'serpapi' },
        { query: 'q2', status: 'ok', provider: 'serpapi' },
      ],
    })
    expect(out.meta).toMatchObject({
      searchProvider: 'serpapi',
      searchProviderUnits: 2,
      externalCost_model: 'serpapi',
      externalCost_flatCostUsd: 0.05,
    })
  })

  it('runs exact Baidu panels serially and records the standard-search cost', async () => {
    let active = 0
    let maxActive = 0
    fetchSpy.mockImplementation(async (input, init) => {
      expect(String(input)).toBe('https://qianfan.baidubce.com/v2/ai_search/web_search')
      active += 1
      maxActive = Math.max(maxActive, active)
      await Promise.resolve()
      const query = JSON.parse(String(init?.body)).messages[0].content as string
      active -= 1
      return new Response(JSON.stringify({
        references: [{ type: 'web', title: query, url: `https://${query}.example`, snippet: `${query} result` }],
      }), { status: 200 })
    })

    const out = await webSearchTool.execute(
      { queries: ['q1', 'q2'], provider: 'baidu', maxResults: 10 },
      ctx,
    )

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(maxActive).toBe(1)
    expect(out.data).toMatchObject({
      provider: 'baidu',
      completed: 2,
      failed: 0,
      searches: [
        { query: 'q1', status: 'ok', provider: 'baidu' },
        { query: 'q2', status: 'ok', provider: 'baidu' },
      ],
    })
    expect(out.meta).toMatchObject({
      searchProvider: 'baidu',
      searchProviderUnits: 2,
      externalCost_model: 'baidu',
      externalCost_flatCostUsd: 0.01008,
    })
  })

  it('[COMP:tools/search-measurement] returns 29 ordered compact rows across the locked two-batch shape', async () => {
    const queries = Array.from({ length: 29 }, (_, index) => `query-${index + 1}`)
    fetchSpy.mockImplementation(async (input) => {
      const query = new URL(String(input)).searchParams.get('q') ?? ''
      return new Response(JSON.stringify({
        organic_results: [
          {
            title: `${query} primary`,
            link: `https://www.UseBrian.ai/${query}`,
            snippet: 'large snippet that must not enter measurement output',
          },
          {
            title: `${query} competitor`,
            link: `https://competitor.example/${query}`,
            snippet: 'another omitted snippet',
          },
          {
            title: `${query} studio`,
            link: `https://studio.usebrian.ai/${query}`,
            snippet: 'also omitted',
          },
        ],
      }), { status: 200 })
    })

    const parts = await Promise.all([
      webSearchTool.execute({
        queries: queries.slice(0, 25),
        provider: 'serpapi',
        maxResults: 10,
        resultMode: 'measurement',
        trackDomains: ['https://WWW.usebrian.ai/about', 'studio.usebrian.ai.'],
      }, ctx),
      webSearchTool.execute({
        queries: queries.slice(25),
        provider: 'serpapi',
        maxResults: 10,
        resultMode: 'measurement',
        trackDomains: ['usebrian.ai', 'studio.usebrian.ai'],
      }, ctx),
    ])
    const rows = parts.flatMap((part) => (part.data as {
      searches: Array<{
        query: string
        results: Array<{ rank: number; title: string; url: string; domain: string; snippet?: string }>
        trackedDomains: Array<{ domain: string; bestRank: number | null; matchingUrls: string[] }>
      }>
    }).searches)

    expect(fetchSpy).toHaveBeenCalledTimes(29)
    expect(rows.map((row) => row.query)).toEqual(queries)
    expect(rows).toHaveLength(29)
    expect(rows[0].results).toEqual([
      { rank: 1, title: 'query-1 primary', url: 'https://www.UseBrian.ai/query-1', domain: 'usebrian.ai' },
      { rank: 2, title: 'query-1 competitor', url: 'https://competitor.example/query-1', domain: 'competitor.example' },
      { rank: 3, title: 'query-1 studio', url: 'https://studio.usebrian.ai/query-1', domain: 'studio.usebrian.ai' },
    ])
    expect(rows[0].results.every((result) => !('snippet' in result))).toBe(true)
    expect(rows[0].trackedDomains).toEqual([
      { domain: 'usebrian.ai', bestRank: 1, matchingUrls: ['https://www.UseBrian.ai/query-1'] },
      { domain: 'studio.usebrian.ai', bestRank: 3, matchingUrls: ['https://studio.usebrian.ai/query-1'] },
    ])
    expect(parts[0].data).toMatchObject({
      resultMode: 'measurement',
      topDomains: [
        { domain: 'usebrian.ai', appearances: 25, bestRank: 1 },
        { domain: 'competitor.example', appearances: 25, bestRank: 2 },
        { domain: 'studio.usebrian.ai', appearances: 25, bestRank: 3 },
      ],
    })
  })

  it('[COMP:tools/search-measurement] honors Retry-After and meters one successful unit after a 429', async () => {
    vi.useFakeTimers()
    fetchSpy
      .mockResolvedValueOnce(new Response('limited', { status: 429, headers: { 'Retry-After': '1' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        organic_results: [{ title: 'served', link: 'https://usebrian.ai/', snippet: 'omitted' }],
      }), { status: 200 }))

    const resultPromise = webSearchTool.execute({
      query: 'q',
      provider: 'serpapi',
      resultMode: 'measurement',
      trackDomains: ['usebrian.ai'],
    }, ctx)
    await vi.advanceTimersByTimeAsync(999)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    const out = await resultPromise

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(out.isError).toBeUndefined()
    expect(out.meta).toMatchObject({ searchProviderUnits: 1, externalCost_flatCostUsd: 0.025 })
    expect(out.data).toMatchObject({ completed: 1, failed: 0 })
  })

  it('[COMP:tools/search-measurement] exhausts transient retries as one attributable partial row', async () => {
    fetchSpy.mockResolvedValue(new Response('down', { status: 503 }))
    const out = await webSearchTool.execute({
      queries: ['good', 'bad'],
      provider: 'serpapi',
      resultMode: 'measurement',
      trackDomains: ['usebrian.ai'],
    }, ctx)
    const data = out.data as {
      completed: number
      failed: number
      searches: Array<{ query: string; status: string; error?: string }>
    }

    expect(fetchSpy).toHaveBeenCalledTimes(6)
    expect(out.isError).toBe(true)
    expect(data).toMatchObject({ completed: 0, failed: 2 })
    expect(data.searches.map((row) => row.query)).toEqual(['good', 'bad'])
    expect(data.searches.every((row) => row.error?.includes('SerpAPI HTTP 503'))).toBe(true)
    expect(out.meta).toMatchObject({ searchProviderUnits: 0 })
    expect(out.meta).not.toHaveProperty('externalCost_flatCostUsd')
  })

  it('lets a 25-query multi-wave panel exceed 15 seconds without aborting queued work', async () => {
    vi.useFakeTimers()
    const queries = Array.from({ length: 25 }, (_, index) => `q${index + 1}`)
    let active = 0
    let maxActive = 0
    fetchSpy.mockImplementation(async (input, init) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      try {
        await waitWithAbort(10_000, init?.signal ?? undefined)
        const query = new URL(String(input)).searchParams.get('q') ?? ''
        return new Response(JSON.stringify({
          organic_results: [{ title: query, link: `https://${query}.example`, snippet: `${query} result` }],
        }), { status: 200 })
      } finally {
        active -= 1
      }
    })

    expect(webSearchTool.timeoutMs).toBe(NO_TOOL_TIMEOUT)
    const executor = createToolExecutor({
      tools: new Map([['webSearch', webSearchTool]]),
      context: ctx,
      loopDetector: createLoopDetector(),
    })
    executor.addTool('panel', 'webSearch', { queries, provider: 'serpapi', maxResults: 10 })
    const resultPromise = drainResults(executor)
    await vi.runAllTimersAsync()
    const results = await resultPromise

    expect(fetchSpy).toHaveBeenCalledTimes(25)
    expect(maxActive).toBe(4)
    expect(results).toHaveLength(1)
    const block = results[0] as Extract<ContentBlock, { type: 'tool_result' }>
    const data = JSON.parse(String(block.content)) as {
      completed: number
      failed: number
      searches: Array<{ query: string; status: string }>
    }
    expect(block.isError).toBeUndefined()
    expect(data.completed).toBe(25)
    expect(data.failed).toBe(0)
    expect(data.searches.map((search) => search.query)).toEqual(queries)
  })

  it('bounds timeout retries without blocking later queued queries', async () => {
    vi.useFakeTimers()
    fetchSpy.mockImplementation(async (input, init) => {
      const query = new URL(String(input)).searchParams.get('q') ?? ''
      await waitWithAbort(query === 'q1' ? 30_000 : 1_000, init?.signal ?? undefined)
      return new Response(JSON.stringify({
        organic_results: [{ title: query, link: `https://${query}.example`, snippet: `${query} result` }],
      }), { status: 200 })
    })

    const resultPromise = webSearchTool.execute(
      { queries: ['q1', 'q2', 'q3', 'q4', 'q5'], provider: 'serpapi', maxResults: 10 },
      ctx,
    )
    await vi.runAllTimersAsync()
    const out = await resultPromise
    const data = out.data as {
      completed: number
      failed: number
      searches: Array<{ query: string; status: string; error?: string }>
    }

    // q1 gets the initial attempt plus two bounded retries; q2-q5 succeed once.
    expect(fetchSpy).toHaveBeenCalledTimes(7)
    expect(data.completed).toBe(4)
    expect(data.failed).toBe(1)
    expect(data.searches.map((search) => [search.query, search.status])).toEqual([
      ['q1', 'error'],
      ['q2', 'ok'],
      ['q3', 'ok'],
      ['q4', 'ok'],
      ['q5', 'ok'],
    ])
    expect(data.searches[0].error).toBe('search timed out after 15000ms')
    expect(out.meta).toMatchObject({
      searchProvider: 'serpapi',
      searchProviderUnits: 4,
      externalCost_flatCostUsd: 0.1,
    })
    expect(out.meta?.searchProviderErrors).toContain('q1: search timed out after 15000ms')
  })

  it('labels parent-aborted active and queued rows as cancelled, never provider unavailable', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const callerCtx = { abortSignal: controller.signal } as ToolContext
    fetchSpy.mockImplementation(async (input, init) => {
      const query = new URL(String(input)).searchParams.get('q') ?? ''
      await waitWithAbort(30_000, init?.signal ?? undefined)
      return new Response(JSON.stringify({
        organic_results: [{ title: query, link: `https://${query}.example`, snippet: `${query} result` }],
      }), { status: 200 })
    })

    const resultPromise = webSearchTool.execute(
      { queries: ['q1', 'q2', 'q3', 'q4', 'q5'], provider: 'serpapi', maxResults: 10 },
      callerCtx,
    )
    await vi.advanceTimersByTimeAsync(1_000)
    controller.abort()
    await vi.runAllTimersAsync()
    const out = await resultPromise
    const data = out.data as {
      searches: Array<{ query: string; status: string; error?: string }>
    }

    expect(fetchSpy).toHaveBeenCalledTimes(4)
    expect(data.searches).toHaveLength(5)
    expect(data.searches.every((search) => search.status === 'error')).toBe(true)
    expect(data.searches.every((search) => search.error === 'search cancelled by caller')).toBe(true)
    expect(JSON.stringify(data)).not.toContain('provider unavailable')
  })

  it('preserves a deadline as the first abort cause if the parent aborts during cleanup', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const callerCtx = { abortSignal: controller.signal } as ToolContext
    fetchSpy.mockImplementation(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        setTimeout(() => reject(new Error('provider cleanup finished')), 2_000)
      }, { once: true })
    }))

    const resultPromise = webSearchTool.execute(
      { query: 'q1', provider: 'serpapi', maxResults: 10 },
      callerCtx,
    )
    setTimeout(() => controller.abort(), 16_000)
    await vi.runAllTimersAsync()
    const out = await resultPromise
    const data = out.data as {
      searches: Array<{ query: string; status: string; error?: string }>
    }

    expect(data.searches[0]).toMatchObject({
      query: 'q1',
      status: 'error',
      error: 'search timed out after 15000ms',
    })
  })

  it('fails closed without a configured exact provider and makes no request', async () => {
    delete process.env.SERPER_API_KEY
    const out = await webSearchTool.execute({ query: 'q', provider: 'serper' }, ctx)
    expect(out.isError).toBe(true)
    expect(String(out.data)).toContain('not configured')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('marks an all-error panel as a tool error without recording served cost', async () => {
    fetchSpy.mockResolvedValue(new Response('rate limited', { status: 429 }))
    const out = await webSearchTool.execute({ queries: ['q1', 'q2'], provider: 'serper' }, ctx)
    expect(out.isError).toBe(true)
    expect(out.meta).toMatchObject({ searchProvider: 'serper', searchProviderUnits: 0 })
    expect(out.meta).not.toHaveProperty('externalCost_flatCostUsd')
  })
})

// ── Provider response parsing (mocked fetch) ────────────────────

describe('[COMP:tools/search] Provider response parsers', () => {
  let fetchSpy: MockInstance<typeof fetch>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as MockInstance<typeof fetch>
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('braveProvider parses web.results and filters non-http URLs', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          web: {
            results: [
              { title: 'Cathay Pacific', url: 'https://www.cathaypacific.com', description: 'Flights from HKG' },
              { title: 'skip me', url: 'ftp://nope', description: 'bad protocol' },
              { title: '<strong>STARLUX</strong>', url: 'https://www.starlux-airlines.com', description: '<b>Premium</b>' },
            ],
          },
        }),
        { status: 200 },
      ),
    )

    await withEnv('BRAVE_SEARCH_API_KEY', 'test-token', async () => {
      const results = await braveProvider.search('flights HKG', 5)
      expect(results).toHaveLength(2)
      expect(results[0]).toEqual({
        title: 'Cathay Pacific',
        url: 'https://www.cathaypacific.com',
        snippet: 'Flights from HKG',
      })
      // Brave wraps query terms in <strong>; parser should strip them.
      expect(results[1].title).toBe('STARLUX')
      expect(results[1].snippet).toBe('Premium')
    })
  })

  it('serperProvider parses organic[] and normalizes link→url', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          organic: [
            { title: 'KAYAK', link: 'https://www.kayak.com', snippet: '$87 cheap flights' },
          ],
        }),
        { status: 200 },
      ),
    )
    await withEnv('SERPER_API_KEY', 'test-token', async () => {
      const results = await serperProvider.search('flights', 5)
      expect(results).toEqual([{ title: 'KAYAK', url: 'https://www.kayak.com', snippet: '$87 cheap flights' }])
    })
  })

  it('serpApiProvider parses organic_results[] and normalizes link→url', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          organic_results: [
            { title: 'Use Brian', link: 'https://usebrian.ai/', snippet: 'AI company brain' },
          ],
        }),
        { status: 200 },
      ),
    )
    await withEnv('SERPAPI_API_KEY', 'test-token', async () => {
      const results = await serpApiProvider.search('company brain', 5)
      expect(results).toEqual([{ title: 'Use Brian', url: 'https://usebrian.ai/', snippet: 'AI company brain' }])
    })
  })

  it('serpApiProvider treats a structured provider error as a failure, not an empty result', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Your account has run out of searches.' }), { status: 200 }),
    )
    await withEnv('SERPAPI_API_KEY', 'test-token', async () => {
      await expect(serpApiProvider.search('company brain', 5)).rejects.toThrow(/run out of searches/)
    })
  })

  it('serpApiProvider treats a successful empty Google search as a trusted empty result', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          search_metadata: { status: 'Success' },
          search_information: { organic_results_state: 'Fully empty' },
          error: "Google hasn't returned any results for this query.",
        }),
        { status: 200 },
      ),
    )
    await withEnv('SERPAPI_API_KEY', 'test-token', async () => {
      await expect(serpApiProvider.search('no matching documents', 5)).resolves.toEqual([])
    })
  })

  it('tavilyProvider maps content→snippet', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [
            { title: 'Google Flights', url: 'https://www.google.com/travel/flights', content: 'Find cheap flights' },
          ],
        }),
        { status: 200 },
      ),
    )
    await withEnv('TAVILY_API_KEY', 'test-token', async () => {
      const results = await tavilyProvider.search('flights', 5)
      expect(results[0].snippet).toBe('Find cheap flights')
    })
  })

  it('baiduProvider posts a standard web-only request and maps references', async () => {
    fetchSpy.mockImplementationOnce(async (input, init) => {
      expect(String(input)).toBe('https://qianfan.baidubce.com/v2/ai_search/web_search')
      expect(init?.method).toBe('POST')
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      })
      expect(JSON.parse(String(init?.body))).toEqual({
        messages: [{ role: 'user', content: '百度千帆' }],
        edition: 'standard',
        search_source: 'baidu_search_v2',
        resource_type_filter: [{ type: 'web', top_k: 5 }],
      })
      return new Response(JSON.stringify({
        references: [
          {
            type: 'web',
            title: '<b>百度千帆</b>',
            url: 'https://cloud.baidu.com/product-s/qianfan_home',
            content: '百度智能云<b>千帆平台</b>',
          },
          { type: 'image', title: 'skip non-web', url: 'https://example.com/image' },
          { type: 'web', title: 'skip non-http', url: 'ftp://example.com/result' },
        ],
      }), { status: 200 })
    })

    await withEnv('BAIDU_SEARCH_API_KEY', 'test-token', async () => {
      const results = await baiduProvider.search('百度千帆', 5)
      expect(results).toEqual([{
        title: '百度千帆',
        url: 'https://cloud.baidu.com/product-s/qianfan_home',
        snippet: '百度智能云千帆平台',
      }])
    })
  })

  it('baiduProvider treats a structured API error as a failure, not an empty result', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      code: 216003,
      message: 'Authentication error',
    }), { status: 200 }))

    await withEnv('BAIDU_SEARCH_API_KEY', 'test-token', async () => {
      await expect(baiduProvider.search('company brain', 5)).rejects.toThrow(/Baidu: 216003: Authentication error/)
    })
  })

  it('braveProvider throws on non-200 so stack falls through', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
    await withEnv('BRAVE_SEARCH_API_KEY', 'test-token', async () => {
      await expect(braveProvider.search('x', 5)).rejects.toThrow(/Brave HTTP 429/)
    })
  })
})
