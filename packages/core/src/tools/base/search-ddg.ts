/**
 * DuckDuckGo HTML scraper — no-token fallback.
 *
 * Last resort in the search stack. DDG rate-limits aggressively and changes
 * its HTML markup without notice, so this is fragile. Use only when no keyed
 * provider is configured. For production, set BRAVE_SEARCH_API_KEY (or any
 * other keyed provider) so this never runs.
 *
 * Originally lived in search-providers.ts alongside the stack composer;
 * extracted into its own file so every provider follows the same pattern
 * (one file per backend, composable from the stack).
 */

import type { SearchProvider, SearchResult } from './search-stack.js'
import { stripHtmlTags } from './search-stack.js'

const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/'

export const duckDuckGoProvider: SearchProvider = {
  name: 'duckduckgo',

  // Always "available" — no env check, but the stack will fall through
  // on error or empty results (DDG rate-limiting frequently produces both).
  available: () => true,

  // A DDG rate-limit/challenge page is HTTP 200 with no result blocks, which
  // parses as an empty array — so an empty result here is NOT evidence that
  // the query has no matches. See SearchProvider.trustEmpty.
  trustEmpty: false,

  async search(query, maxResults, signal): Promise<SearchResult[]> {
    const url = `${DDG_ENDPOINT}?q=${encodeURIComponent(query)}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; use-brian/1.0)' },
      signal,
    })

    if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`)

    const html = await res.text()
    return parseDuckDuckGoResults(html, maxResults)
  },
}

// ── HTML parser ───────────────────────────────────────────────────

function parseDuckDuckGoResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []
  const resultBlocks = html.split('class="result__body"')

  for (let i = 1; i < resultBlocks.length && results.length < maxResults; i++) {
    const block = resultBlocks[i]

    // Skip ads
    if (block.includes('badge--ad')) continue

    const linkMatch = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/)
    if (!linkMatch) continue

    let url = linkMatch[1]
    const title = stripHtmlTags(linkMatch[2]).trim()

    // DDG wraps URLs in a redirect — extract the actual URL
    const uddgMatch = url.match(/uddg=([^&]+)/)
    if (uddgMatch) {
      url = decodeURIComponent(uddgMatch[1])
    }

    // Skip ad trackers
    if (url.includes('duckduckgo.com/y.js') || url.includes('ad_domain')) continue
    if (url.startsWith('//')) url = 'https:' + url

    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\//)
    const snippet = snippetMatch ? stripHtmlTags(snippetMatch[1]).trim() : ''

    if (title && url && url.startsWith('http')) {
      results.push({ title, url, snippet })
    }
  }

  return results
}

