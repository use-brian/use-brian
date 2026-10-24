/**
 * Brave Search API provider.
 *
 * Fast, commerce-aware, cheapest keyed option. First in the search stack.
 * Docs: https://api.search.brave.com/app/documentation
 *
 * Endpoint: GET https://api.search.brave.com/res/v1/web/search?q=...&count=...
 * Auth:     X-Subscription-Token header
 * Response: { web: { results: [{ title, url, description, age }] } }
 */

import type { SearchProvider, SearchResult } from './search-stack.js'
import { compileSearchFilters } from './search-filters.js'
import { retryAfterMs, SearchProviderError } from './_fetch-error.js'
import { clampResultCount, stripHtmlTags } from './search-stack.js'
import type { ExternalCredentialPool } from '../../providers/credential-pool.js'
import { flatSearchCostUsd } from '../../billing/search-provider-rates.js'
import { recordToolSpend, resolveToolCredential } from './provider-credential.js'

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

type BraveRawResult = {
  title?: string
  url?: string
  description?: string
}

type BraveResponse = {
  web?: {
    results?: BraveRawResult[]
  }
}

export function createBraveProvider(pool?: ExternalCredentialPool): SearchProvider {
  return {
  name: 'brave',

  available: () => Boolean(pool || process.env.BRAVE_SEARCH_API_KEY),

  async search(query, maxResults, signal, filters): Promise<SearchResult[]> {
    const filterParams = compileSearchFilters('brave', filters)
    const lease = await resolveToolCredential(pool, 'brave', process.env.BRAVE_SEARCH_API_KEY)
    if (!lease) throw new SearchProviderError({ provider: 'brave', kind: 'bad_key', detail: 'No eligible search credential is configured.' })

    const url = new URL(BRAVE_ENDPOINT)
    url.searchParams.set('q', query)
    url.searchParams.set('count', String(clampResultCount(maxResults)))
    for (const [key, value] of Object.entries(filterParams)) url.searchParams.set(key, String(value))

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': lease.secret,
      },
      signal,
    })

    if (!res.ok) {
      throw new SearchProviderError({
        provider: 'Brave',
        status: res.status,
        retryAfterMs: retryAfterMs(res.headers.get('retry-after')),
      })
    }
    await recordToolSpend(lease, flatSearchCostUsd('brave'))

    const data = (await res.json()) as BraveResponse
    const raw = data.web?.results ?? []
    return raw
      .map((r) => ({
        title: stripHtmlTags(r.title ?? '').trim(),
        url: r.url ?? '',
        snippet: stripHtmlTags(r.description ?? '').trim(),
      }))
      .filter((r) => r.url && r.url.startsWith('http'))
      .slice(0, maxResults)
  },
  }
}

export const braveProvider: SearchProvider = createBraveProvider()
