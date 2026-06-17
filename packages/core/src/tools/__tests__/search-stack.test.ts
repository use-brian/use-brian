import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import { createSearchStack, type SearchProvider, type SearchResult } from '../base/search-stack.js'
import { braveProvider } from '../base/search-brave.js'
import { serperProvider } from '../base/search-serper.js'
import { tavilyProvider } from '../base/search-tavily.js'
import { duckDuckGoProvider } from '../base/search-ddg.js'

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
    expect(out).toEqual({ provider: null, results: [] })
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
    expect(out).toEqual({ provider: null, results: [] })
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

  it('tavilyProvider gates on TAVILY_API_KEY', () => {
    withEnv('TAVILY_API_KEY', undefined, () => {
      expect(tavilyProvider.available()).toBe(false)
    })
    withEnv('TAVILY_API_KEY', 'test-token', () => {
      expect(tavilyProvider.available()).toBe(true)
    })
  })

  it('duckDuckGoProvider is always available (no-token fallback)', () => {
    expect(duckDuckGoProvider.available()).toBe(true)
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

  it('braveProvider throws on non-200 so stack falls through', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
    await withEnv('BRAVE_SEARCH_API_KEY', 'test-token', async () => {
      await expect(braveProvider.search('x', 5)).rejects.toThrow(/Brave HTTP 429/)
    })
  })
})
