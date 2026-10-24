import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  compileSearchFilters, matchesSearchDomains, searchFiltersSchema, unsupportedSearchFilters,
  SEARCH_PROVIDER_NAMES, type SearchFilters,
} from '../base/search-filters.js'
import { createSearchStack, type SearchProvider } from '../base/search-stack.js'
import { createWebSearchTool, webSearchTool } from '../base/web-search.js'
import { braveProvider } from '../base/search-brave.js'
import { serperProvider } from '../base/search-serper.js'
import { serpApiProvider } from '../base/search-serpapi.js'
import { tavilyProvider } from '../base/search-tavily.js'
import { baiduProvider } from '../base/search-baidu.js'
import { duckDuckGoProvider } from '../base/search-ddg.js'
import type { ToolContext } from '../types.js'

const range = { from: '2026-10-01', to: '2026-10-24' }
const filters: SearchFilters = { dateRange: range, country: 'HK', language: 'zh-TW' }
const hit = { title: 'Result', url: 'https://news.example.com/article', snippet: 'Text' }
const context = (): ToolContext => ({ assistantId: 'a', userId: 'u', sessionId: 's', appId: 'Use Brian', channelType: 'web', channelId: 'c', abortSignal: new AbortController().signal })
function mockSearchProvider(name: string, search = vi.fn(async () => [hit])): SearchProvider {
  return { name, search, available: () => true }
}
function response(results = [hit]) {
  return new Response(JSON.stringify({
    web: { results: results.map((r) => ({ ...r, description: r.snippet })) },
    organic: results.map((r) => ({ ...r, link: r.url })),
    organic_results: results.map((r) => ({ ...r, link: r.url })),
    results: results.map((r) => ({ ...r, content: r.snippet })),
    references: results,
    search_metadata: { status: 'Success' },
  }), { status: 200 })
}

describe('[COMP:tools/search-filters] Canonical input and capabilities', () => {
  it.each(['2026-02-29', '2024-02-30', '2026-04-31', '0000-01-01', '2026-1-01', '2026-10-01T00:00:00Z'])('rejects invalid date %s', (from) => {
    expect(searchFiltersSchema.safeParse({ dateRange: { from } }).success).toBe(false)
  })
  it('accepts leap days and same-day ranges', () => {
    expect(searchFiltersSchema.parse({ dateRange: { from: '2024-02-29', to: '2024-02-29' } }).dateRange?.from).toBe('2024-02-29')
  })
  it.each([{}, { from: range.to, to: range.from }])('rejects empty or inverted date range %j', (dateRange) => {
    expect(searchFiltersSchema.safeParse({ dateRange }).success).toBe(false)
  })
  it('normalizes countries, tags, Unicode domains, duplicates and trailing dots', () => {
    expect(searchFiltersSchema.parse({ country: ' hk ', language: 'ZH-tw', includeDomains: ['EXAMPLE.COM.', 'example.com', '例子.com'] })).toEqual({
      country: 'HK', language: 'zh-TW', includeDomains: ['example.com', 'xn--fsqu00a.com'],
    })
  })
  it.each(['https://example.com', 'example.com/path', '*.example.com', 'example.com:443', '127.0.0.1', '[::1]', 'com', 'co.uk', 'github.io', '-bad.com', 'a..com', 'example.com OR site:other.com', 'a%2eb.com'])('rejects non-hostname or unsafe domain %s', (domain) => {
    expect(searchFiltersSchema.safeParse({ includeDomains: [domain] }).success).toBe(false)
  })
  it('rejects empty lists, excessive lists, unknown fields and vendor parameter names', () => {
    for (const input of [{ includeDomains: [] }, { excludeDomains: Array(21).fill('example.com') }, { freshness: 'pw' }, { dateRange: { from: range.from, timeZone: 'UTC' } }]) {
      expect(searchFiltersSchema.safeParse(input).success).toBe(false)
    }
    expect(webSearchTool.inputSchema.safeParse({ query: 'q', tbs: 'qdr:w' }).success).toBe(false)
  })
  it('rejects entirely excluded inclusions; permits excluded children of included domains', () => {
    expect(searchFiltersSchema.safeParse({ includeDomains: ['news.example.com'], excludeDomains: ['example.com'] }).success).toBe(false)
    expect(searchFiltersSchema.safeParse({ includeDomains: ['example.com'], excludeDomains: ['ads.example.com'] }).success).toBe(true)
  })
  it.each(['brave', 'serper', 'serpapi', 'baidu'])('%s rejects open ranges without widening', (provider) => {
    expect(unsupportedSearchFilters(provider, { dateRange: { from: range.from } })).toEqual(['dateRange requires both from and to'])
    expect(unsupportedSearchFilters(provider, { dateRange: { to: range.to } })).toEqual(['dateRange requires both from and to'])
  })
  it('keeps unsupported locale variants explicit', () => {
    expect(unsupportedSearchFilters('brave', { language: 'en-US' })).toContain('language en-US is unsupported')
    expect(unsupportedSearchFilters('tavily', { country: 'HK' })).toContain('country HK is unsupported')
    expect(unsupportedSearchFilters('baidu', { country: 'CN' })).toContain('country CN is unsupported')
    expect(unsupportedSearchFilters('serpapi', { country: 'ZZ' })).toContain('country ZZ is unsupported')
  })
  it.each(SEARCH_PROVIDER_NAMES)('%s leaves requests without filters unchanged', (provider) => {
    expect(compileSearchFilters(provider)).toEqual({})
  })
  it('checks domain boundaries, subdomains, exclusions and deceptive hosts', () => {
    const restricted = { includeDomains: ['example.com'], excludeDomains: ['ads.example.com'] }
    for (const url of ['https://example.com/x', 'https://www.example.com/x', 'https://news.example.com./x']) expect(matchesSearchDomains(url, restricted)).toBe(true)
    for (const url of ['https://notexample.com', 'https://example.com.attacker.org', 'https://ads.example.com', 'https://a.ads.example.com', 'https://example.com@attacker.org', 'file://example.com/x', 'bad']) expect(matchesSearchDomains(url, restricted)).toBe(false)
  })
})

describe('[COMP:tools/search-filters] Vendor request contracts', () => {
  beforeEach(() => {
    for (const key of ['BRAVE_SEARCH_API_KEY', 'SERPER_API_KEY', 'SERPAPI_API_KEY', 'TAVILY_API_KEY', 'BAIDU_SEARCH_API_KEY']) vi.stubEnv(key, 'test-key')
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers() })

  it('sends Brave custom dates and canonical HK/traditional Chinese mappings', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response())
    await braveProvider.search('q', 5, undefined, { ...filters, safeSearch: 'moderate' })
    const url = new URL(String(fetch.mock.calls[0][0]))
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'q', count: '5', country: 'HK', search_lang: 'zh-hant', freshness: '2026-10-01to2026-10-24', safesearch: 'moderate' })
  })
  it('sends Serper Google date/locality parameters with no vendor keys exposed publicly', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response())
    await serperProvider.search('q', 5, undefined, { dateRange: range, country: 'GB', language: 'en', location: 'London, England, United Kingdom' })
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ q: 'q', num: 5, gl: 'uk', hl: 'en', location: 'London, England, United Kingdom', tbs: 'cdr:1,cd_min:10/1/2026,cd_max:10/24/2026' })
  })
  it('sends SerpAPI inclusive custom dates, localization and active safe search', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response())
    await serpApiProvider.search('q', 5, undefined, { ...filters, safeSearch: 'strict', location: 'Hong Kong' })
    const url = new URL(String(fetch.mock.calls[0][0]))
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ engine: 'google', gl: 'hk', hl: 'zh-tw', location: 'Hong Kong', safe: 'active', tbs: 'cdr:1,cd_min:10/1/2026,cd_max:10/24/2026' })
  })
  it('sends Tavily open date bounds, publication filtering and native domain restrictions', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response())
    await tavilyProvider.search('q', 5, undefined, { dateRange: { from: range.from }, country: 'US', language: 'en', includeDomains: ['example.com'], excludeDomains: ['ads.example.com'], safeSearch: 'strict' })
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      api_key: 'test-key', query: 'q', max_results: 5, search_depth: 'basic', start_date: range.from,
      filter_by_published_date: true, country: 'united states', language: 'en', include_domains: ['example.com'],
      exclude_domains: ['ads.example.com'], include_domains_mode: 'restrict', safe_search: true,
    })
    expect(compileSearchFilters('tavily', { dateRange: { to: range.to } })).toEqual({ end_date: range.to, filter_by_published_date: true })
  })
  it('combines Baidu date/city/site filters without overwriting each other', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response())
    await baiduProvider.search('q', 5, undefined, { dateRange: range, location: '北京', includeDomains: ['example.com'], excludeDomains: ['ads.example.com'], safeSearch: 'off' })
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
      edition: 'standard', search_source: 'baidu_search_v2',
      search_filter: { range: { page_time: { gte: range.from, lte: range.to }, geo: { city: ['北京'] } }, match: { site: ['example.com'] } },
      block_websites: ['ads.example.com'], safe_search: false,
    })
  })
  it('rejects unsupported boolean safe-search levels and DuckDuckGo filters before I/O', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(tavilyProvider.search('q', 5, undefined, { safeSearch: 'moderate' })).rejects.toThrow('safeSearch moderate is unsupported')
    await expect(serperProvider.search('q', 5, undefined, { safeSearch: 'off' })).rejects.toThrow('safeSearch off is unsupported')
    await expect(duckDuckGoProvider.search('q', 5, undefined, filters)).rejects.toThrow('cannot honor')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('does not treat an absent pooled credential as an empty search', async () => {
    const resolve = vi.fn(async () => null)
    const fetch = vi.spyOn(globalThis, 'fetch')
    const output = await createWebSearchTool({ resolve }).execute({ query: 'q', provider: 'tavily', includeDomains: ['example.com'] }, context())
    expect(output.isError).toBe(true)
    expect(output.data).toMatchObject({ failed: 1, completed: 0, searches: [{ status: 'error' }] })
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects exact-provider incompatible filters without acquiring credentials', async () => {
    const resolve = vi.fn(async () => null)
    const output = await createWebSearchTool({ resolve }).execute({ query: 'q', provider: 'brave', location: 'London' }, context())
    expect(output.isError).toBe(true)
    expect(output.data).toMatchObject({ error: 'unsupported_filters', provider: 'brave', reasons: ['location is unsupported'] })
    expect(resolve).not.toHaveBeenCalled()
  })
  it('automatically skips incompatible providers and preserves filter provenance', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response())
    const output = await webSearchTool.execute({ query: 'q', includeDomains: ['example.com'] }, context())
    expect(output.isError).not.toBe(true)
    expect(output.data).toMatchObject({ provider: 'tavily', appliedFilters: { includeDomains: ['example.com'] }, results: [hit], excludedProviders: [
      { provider: 'brave' }, { provider: 'serper' }, { provider: 'serpapi' },
    ] })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toBe('https://api.tavily.com/search')
  })
  it('distinguishes all-incompatible filters from outage and genuine filtered empties', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response([]))
    const incompatible = await webSearchTool.execute({ query: 'q', location: 'London', safeSearch: 'moderate' }, context())
    expect(incompatible.isError).toBe(true)
    expect(incompatible.data).toMatchObject({ error: 'unsupported_filters' })
    expect(fetch).not.toHaveBeenCalled()
    const empty = await webSearchTool.execute({ query: 'q', includeDomains: ['example.com'] }, context())
    expect(empty.isError).not.toBe(true)
    expect(empty.data).toMatchObject({ results: [], provider: 'baidu', appliedFilters: { includeDomains: ['example.com'] } })
    fetch.mockImplementation(async () => new Response('Unavailable', { status: 503 }))
    const outage = await webSearchTool.execute({ query: 'q', includeDomains: ['example.com'] }, context())
    expect(outage.isError).toBe(true)
    expect(outage.data).toMatchObject({ error: 'search_unavailable', requestedFilters: { includeDomains: ['example.com'] } })
  })
  it('reports provider request rejection separately from an outage or zero matches', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('Bad request', { status: 400 }))
    const output = await webSearchTool.execute({ query: 'q', includeDomains: ['example.com'] }, context())
    expect(output.isError).toBe(true)
    expect(output.data).toMatchObject({ error: 'provider_rejected_request', requestedFilters: { includeDomains: ['example.com'] } })
  })
  it('does not claim applied filters when an exact-provider request failed', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('Bad request', { status: 400 }))
    const output = await webSearchTool.execute({ query: 'q', provider: 'tavily', includeDomains: ['example.com'] }, context())
    expect(output.isError).toBe(true)
    expect(output.data).toMatchObject({ failed: 1, completed: 0, requestedFilters: { includeDomains: ['example.com'] } })
    expect(output.data).not.toHaveProperty('appliedFilters')
  })
  it('carries filters through cancellation without issuing a request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const controller = new AbortController()
    controller.abort()
    const output = await webSearchTool.execute({ query: 'q', country: 'HK' }, { ...context(), abortSignal: controller.signal })
    expect(output.isError).toBe(true)
    expect(output.data).toMatchObject({ error: 'cancelled', requestedFilters: { country: 'HK' } })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('retries transient exact-provider failures with the same filters', async () => {
    vi.useFakeTimers()
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => new Response('Unavailable', { status: 503 }))
      .mockImplementation(async () => response())
    const pending = webSearchTool.execute({ query: 'q', provider: 'tavily', dateRange: range }, context())
    await vi.runAllTimersAsync()
    const output = await pending
    expect(output.data).toMatchObject({ completed: 1, failed: 0, appliedFilters: { dateRange: range } })
    expect(fetch).toHaveBeenCalledTimes(2)
    for (const call of fetch.mock.calls) expect(JSON.parse(String(call[1]?.body))).toMatchObject({ start_date: range.from, end_date: range.to, filter_by_published_date: true })
    expect(output.meta).toMatchObject({ searchProvider: 'tavily', searchProviderUnits: 1 })
  })
  it('validates direct execute calls before performing a search', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const output = await webSearchTool.execute({ query: 'q', includeDomains: ['example.com'], excludeDomains: ['example.com'] }, context())
    expect(output.isError).toBe(true)
    expect(output.data).toContain('entirely excluded')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('keeps exact-provider panel order, measurement summaries and filters', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const { query } = JSON.parse(String(init?.body))
      await new Promise((resolve) => setTimeout(resolve, query === 'first' ? 10 : 0))
      return response([{ ...hit, title: query }])
    })
    const output = await webSearchTool.execute({ queries: ['first', 'second'], provider: 'tavily', includeDomains: ['example.com'], resultMode: 'measurement', trackDomains: ['news.example.com'] }, context())
    expect(output.data).toMatchObject({ completed: 2, failed: 0, appliedFilters: { includeDomains: ['example.com'] }, searches: [
      { query: 'first', results: [{ title: 'first', rank: 1 }], trackedDomains: [{ bestRank: 1 }] },
      { query: 'second', results: [{ title: 'second', rank: 1 }] },
    ] })
    for (const call of fetch.mock.calls) expect(JSON.parse(String(call[1]?.body)).include_domains).toEqual(['example.com'])
    expect(output.meta).toMatchObject({ searchProvider: 'tavily', searchProviderUnits: 2 })
    for (const row of (output.data as { searches: unknown[] }).searches) expect(row).not.toHaveProperty('appliedFilters')
  })
})

describe('[COMP:tools/search-filters] Stack invariants', () => {
  it('never calls an incompatible fallback after a compatible provider fails', async () => {
    const brave = mockSearchProvider('brave')
    const tavily = mockSearchProvider('tavily', vi.fn(async () => { throw new Error('quota exhausted') }))
    const duck = mockSearchProvider('duckduckgo')
    const result = await createSearchStack([brave, tavily, duck])('q', 5, undefined, { includeDomains: ['example.com'] })
    expect(result.trustedEmpty).toBe(false)
    expect(result.failures).toEqual([{ provider: 'tavily', error: 'quota exhausted' }])
    expect(brave.search).not.toHaveBeenCalled()
    expect(duck.search).not.toHaveBeenCalled()
  })
  it('removes provider domain violations and never accepts deceptive suffix matches', async () => {
    const search = vi.fn(async () => [hit, { ...hit, url: 'https://example.com.attacker.org/' }, { ...hit, url: 'https://ads.example.com/' }])
    const result = await createSearchStack([mockSearchProvider('tavily', search)])('q', 5, undefined, { includeDomains: ['example.com'], excludeDomains: ['ads.example.com'] })
    expect(result.results).toEqual([hit])
  })
  it('passes canonical filters and the original signal, and respects pre-cancellation', async () => {
    const provider = mockSearchProvider('brave')
    const controller = new AbortController()
    await createSearchStack([provider])('q', 5, controller.signal, filters)
    expect(provider.search).toHaveBeenCalledWith('q', 5, controller.signal, filters)
    vi.mocked(provider.search).mockClear()
    controller.abort()
    await createSearchStack([provider])('q', 5, controller.signal, filters)
    expect(provider.search).not.toHaveBeenCalled()
  })

})
