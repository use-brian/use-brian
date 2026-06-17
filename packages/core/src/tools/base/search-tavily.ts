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
import { clampResultCount } from './search-stack.js'

const TAVILY_ENDPOINT = 'https://api.tavily.com/search'

type TavilyRawResult = {
  title?: string
  url?: string
  content?: string
}

type TavilyResponse = {
  results?: TavilyRawResult[]
}

export const tavilyProvider: SearchProvider = {
  name: 'tavily',

  available: () => Boolean(process.env.TAVILY_API_KEY),

  async search(query, maxResults, signal): Promise<SearchResult[]> {
    const token = process.env.TAVILY_API_KEY
    if (!token) return []

    const res = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: token,
        query,
        max_results: clampResultCount(maxResults),
        search_depth: 'basic',
        // include_raw_content: false — deferred to a webSearchDeep variant
        // if/when the snippet-only loop proves too expensive. See plan.
      }),
      signal,
    })

    if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`)

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
