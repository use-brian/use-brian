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
import { clampResultCount, stripHtmlTags } from './search-stack.js'

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

export const braveProvider: SearchProvider = {
  name: 'brave',

  available: () => Boolean(process.env.BRAVE_SEARCH_API_KEY),

  async search(query, maxResults, signal): Promise<SearchResult[]> {
    const token = process.env.BRAVE_SEARCH_API_KEY
    if (!token) return []

    const url = new URL(BRAVE_ENDPOINT)
    url.searchParams.set('q', query)
    url.searchParams.set('count', String(clampResultCount(maxResults)))

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': token,
      },
      signal,
    })

    if (!res.ok) throw new Error(`Brave HTTP ${res.status}`)

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
