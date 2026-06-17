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
import { clampResultCount } from './search-stack.js'

const SERPER_ENDPOINT = 'https://google.serper.dev/search'

type SerperOrganicResult = {
  title?: string
  link?: string
  snippet?: string
}

type SerperResponse = {
  organic?: SerperOrganicResult[]
}

export const serperProvider: SearchProvider = {
  name: 'serper',

  available: () => Boolean(process.env.SERPER_API_KEY),

  async search(query, maxResults, signal): Promise<SearchResult[]> {
    const token = process.env.SERPER_API_KEY
    if (!token) return []

    const res = await fetch(SERPER_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-API-KEY': token,
      },
      body: JSON.stringify({
        q: query,
        num: clampResultCount(maxResults),
      }),
      signal,
    })

    if (!res.ok) throw new Error(`Serper HTTP ${res.status}`)

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
