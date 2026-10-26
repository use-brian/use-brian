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
import { compileSearchFilters } from './search-filters.js'
import { retryAfterMs, SearchProviderError } from './_fetch-error.js'
import { clampResultCount } from './search-stack.js'
import type { ExternalCredentialPool } from '../../providers/credential-pool.js'
import { flatSearchCostUsd } from '../../billing/search-provider-rates.js'
import { recordToolSpend, resolveToolCredential } from './provider-credential.js'

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

export function createSerpApiProvider(pool?: ExternalCredentialPool): SearchProvider {
  return {
  name: 'serpapi',

  available: () => Boolean(pool || process.env.SERPAPI_API_KEY),

  async search(query, maxResults, signal, filters): Promise<SearchResult[]> {
    const filterParams = compileSearchFilters('serpapi', filters)
    const lease = await resolveToolCredential(pool, 'serpapi', process.env.SERPAPI_API_KEY)
    if (!lease) throw new SearchProviderError({ provider: 'serpapi', kind: 'bad_key', detail: 'No eligible search credential is configured.' })

    const url = new URL(SERPAPI_ENDPOINT)
    url.searchParams.set('engine', 'google')
    url.searchParams.set('q', query)
    url.searchParams.set('num', String(clampResultCount(maxResults)))
    url.searchParams.set('api_key', lease.secret)
    for (const [key, value] of Object.entries(filterParams)) url.searchParams.set(key, String(value))

    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal,
    })

    if (!res.ok) {
      throw new SearchProviderError({
        provider: 'SerpAPI',
        status: res.status,
        retryAfterMs: retryAfterMs(res.headers.get('retry-after')),
      })
    }
    await recordToolSpend(lease, flatSearchCostUsd('serpapi'))

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
}

export const serpApiProvider: SearchProvider = createSerpApiProvider()
