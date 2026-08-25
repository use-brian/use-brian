/**
 * SerpAPI Google SERP provider.
 *
 * This is distinct from Serper (`search-serper.ts`). Both expose Google
 * organic results, but they use different vendors, credentials, endpoints,
 * and response shapes. Keeping separate provider names lets exact-provider
 * GEO measurements fail closed instead of silently changing search indexes.
 *
 * Docs: https://serpapi.com/search-api
 * Endpoint: GET https://serpapi.com/search.json
 * Query: engine=google, q, num, api_key
 * Response: { organic_results: [{ title, link, snippet }], error? }
 */

import type { SearchProvider, SearchResult } from './search-stack.js'
import { SearchProviderError } from './_fetch-error.js'
import { clampResultCount } from './search-stack.js'

const SERPAPI_ENDPOINT = 'https://serpapi.com/search.json'

type SerpApiOrganicResult = {
  title?: string
  link?: string
  snippet?: string
}

type SerpApiResponse = {
  search_metadata?: {
    status?: string
  }
  organic_results?: SerpApiOrganicResult[]
  error?: string
}

export const serpApiProvider: SearchProvider = {
  name: 'serpapi',

  available: () => Boolean(process.env.SERPAPI_API_KEY),

  async search(query, maxResults, signal): Promise<SearchResult[]> {
    const token = process.env.SERPAPI_API_KEY
    if (!token) return []

    const url = new URL(SERPAPI_ENDPOINT)
    url.searchParams.set('engine', 'google')
    url.searchParams.set('q', query)
    url.searchParams.set('num', String(clampResultCount(maxResults)))
    url.searchParams.set('api_key', token)

    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal,
    })

    if (!res.ok) throw new SearchProviderError({ provider: 'SerpAPI', status: res.status })

    const data = (await res.json()) as SerpApiResponse
    // SerpAPI uses a top-level `error` for both failures and successful empty
    // Google searches. Its status is the authoritative discriminator: a
    // `Success` response with no organic_results is a trustworthy empty.
    if (
      data.search_metadata?.status !== 'Success' &&
      typeof data.error === 'string' &&
      data.error.trim()
    ) {
      throw new SearchProviderError({
        provider: 'SerpAPI',
        kind: 'other',
        detail: data.error.trim().slice(0, 300),
      })
    }

    const raw = data.organic_results ?? []
    return raw
      .map((r) => ({
        title: (r.title ?? '').trim(),
        url: r.link ?? '',
        snippet: (r.snippet ?? '').trim(),
      }))
      .filter((r) => r.url && r.url.startsWith('http'))
      .slice(0, maxResults)
  },
}
