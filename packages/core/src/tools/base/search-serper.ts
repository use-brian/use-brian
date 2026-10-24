/**
 * Serper Google SERP proxy provider.
 *
 * Cheapest keyed provider (~$0.30/1K). Best for commercial/price queries
 * because it returns Google's actual SERP — the motivating bug fix was
 * "flight prices from HK to TPE" which Brave/Tavily mis-indexed and Google
 * gets right. Second in the stack, after Brave.
 * Docs: https://serper.dev/api-key
 *
 * Endpoint: POST https://google.serper.dev/search
 * Auth:     X-API-KEY header
 * Body:     { q: string, num: number }
 * Response: { organic: [{ title, link, snippet }], ... }
 */

import type { SearchProvider, SearchResult } from './search-stack.js'
import { compileSearchFilters } from './search-filters.js'
import { retryAfterMs, SearchProviderError } from './_fetch-error.js'
import { clampResultCount } from './search-stack.js'
import type { ExternalCredentialPool } from '../../providers/credential-pool.js'
import { flatSearchCostUsd } from '../../billing/search-provider-rates.js'
import { recordToolSpend, resolveToolCredential } from './provider-credential.js'

const SERPER_ENDPOINT = 'https://google.serper.dev/search'

type SerperOrganicResult = {
  title?: string
  link?: string
  snippet?: string
}

type SerperResponse = {
  organic?: SerperOrganicResult[]
}

export function createSerperProvider(pool?: ExternalCredentialPool): SearchProvider {
  return {
  name: 'serper',

  available: () => Boolean(pool || process.env.SERPER_API_KEY),

  async search(query, maxResults, signal, filters): Promise<SearchResult[]> {
    const filterParams = compileSearchFilters('serper', filters)
    const lease = await resolveToolCredential(pool, 'serper', process.env.SERPER_API_KEY)
    if (!lease) throw new SearchProviderError({ provider: 'serper', kind: 'bad_key', detail: 'No eligible search credential is configured.' })

    const res = await fetch(SERPER_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-API-KEY': lease.secret,
      },
      body: JSON.stringify({
        q: query,
        num: clampResultCount(maxResults),
        ...filterParams,
      }),
      signal,
    })

    if (!res.ok) {
      throw new SearchProviderError({
        provider: 'Serper',
        status: res.status,
        retryAfterMs: retryAfterMs(res.headers.get('retry-after')),
      })
    }
    await recordToolSpend(lease, flatSearchCostUsd('serper'))

    const data = (await res.json()) as SerperResponse
    const raw = data.organic ?? []
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

export const serperProvider: SearchProvider = createSerperProvider()
