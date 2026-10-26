/**
 * Tavily Search API provider.
 *
 * AI-optimized search purpose-built for LLM agents. Third in the stack —
 * best for research queries where snippet quality matters more than
 * commercial freshness. Free tier is 1000 req/month.
 * Docs: https://docs.tavily.com
 *
 * Endpoint: POST https://api.tavily.com/search
 * Auth:     api_key field in body
 * Body:     { api_key, query, max_results, search_depth: "basic" }
 * Response: { results: [{ title, url, content, score }], ... }
 */

import type { SearchProvider, SearchResult } from './search-stack.js'
import { compileSearchFilters } from './search-filters.js'
import { retryAfterMs, SearchProviderError } from './_fetch-error.js'
import { clampResultCount } from './search-stack.js'
import type { ExternalCredentialPool } from '../../providers/credential-pool.js'
import { flatSearchCostUsd } from '../../billing/search-provider-rates.js'
import { recordToolSpend, resolveToolCredential } from './provider-credential.js'

const TAVILY_ENDPOINT = 'https://api.tavily.com/search'

type TavilyRawResult = {
  title?: string
  url?: string
  content?: string
}

type TavilyResponse = {
  results?: TavilyRawResult[]
}

export function createTavilyProvider(pool?: ExternalCredentialPool): SearchProvider {
  return {
  name: 'tavily',

  available: () => Boolean(pool || process.env.TAVILY_API_KEY),

  async search(query, maxResults, signal, filters): Promise<SearchResult[]> {
    const filterParams = compileSearchFilters('tavily', filters)
    const lease = await resolveToolCredential(pool, 'tavily', process.env.TAVILY_API_KEY)
    if (!lease) throw new SearchProviderError({ provider: 'tavily', kind: 'bad_key', detail: 'No eligible search credential is configured.' })

    const res = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: lease.secret,
        query,
        max_results: clampResultCount(maxResults),
        search_depth: 'basic',
        ...filterParams,
        // include_raw_content: false — deferred to a webSearchDeep variant
        // if/when the snippet-only loop proves too expensive. See plan.
      }),
      signal,
    })

    if (!res.ok) {
      throw new SearchProviderError({
        provider: 'Tavily',
        status: res.status,
        retryAfterMs: retryAfterMs(res.headers.get('retry-after')),
      })
    }
    await recordToolSpend(lease, flatSearchCostUsd('tavily'))

    const data = (await res.json()) as TavilyResponse
    const raw = data.results ?? []
    return raw
      .map((r) => ({
        title: (r.title ?? '').trim(),
        url: r.url ?? '',
        snippet: (r.content ?? '').trim(),
      }))
      .filter((r) => r.url && r.url.startsWith('http'))
      .slice(0, maxResults)
  },
  }
}

export const tavilyProvider: SearchProvider = createTavilyProvider()
