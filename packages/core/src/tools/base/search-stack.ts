/**
 * Search provider stack — pluggable web search backends with fallback.
 *
 * Providers are tried in order; the first available provider that returns a
 * non-empty result set wins. Each provider declares its own `available()`
 * check (typically an env-var presence test) so unset providers are skipped
 * silently. On error or empty result, the stack falls through to the next
 * provider.
 *
 * Results pass through `sanitizeDeep` before returning to the model — search
 * results are untrusted external content and must match the trust class of
 * MCP results (see docs/historical/old-security-model.md).
 *
 * Pattern: one file per provider, a thin composer, no hidden coupling.
 * Adding a new provider is a new file + one entry in the array.
 */

import { sanitizeDeep } from '../../security/sanitize.js'

// ── Shared search utilities ──────────────────────────────────────

/** Clamp a requested result count to the [1, 20] range supported by all providers. */
export function clampResultCount(n: number): number {
  return Math.max(1, Math.min(20, n))
}

/** Strip HTML tags and decode common entities from search result text. */
export function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
}

// ── Types ─────────────────────────────────────────────────────────

export type SearchResult = {
  title: string
  url: string
  snippet: string
}

export type SearchProvider = {
  /** Human-readable name, used for logging/tests. */
  name: string
  /** Returns true when this provider has what it needs to run (e.g. env key set). */
  available: () => boolean
  /** Execute the search. Should throw on API error so the stack can fall through. */
  search: (query: string, maxResults: number, signal?: AbortSignal) => Promise<SearchResult[]>
}

// ── Stack composer ────────────────────────────────────────────────

/** Outcome of a stack call — `provider` is the name of the winning provider,
 *  or `null` if every provider was unavailable or returned no results. */
export type SearchStackOutcome = {
  provider: string | null
  results: SearchResult[]
}

/**
 * Create a search function that tries providers in order.
 * Skips unavailable providers; falls through on errors or empty results.
 * All returned results are sanitized before the caller sees them.
 * Returns the winning provider's name alongside the results so callers
 * can attribute the call for cost/analytics purposes.
 */
export function createSearchStack(
  providers: SearchProvider[],
): (query: string, maxResults: number, signal?: AbortSignal) => Promise<SearchStackOutcome> {
  return async (query, maxResults, signal) => {
    for (const provider of providers) {
      if (!provider.available()) continue
      if (signal?.aborted) return { provider: null, results: [] }
      try {
        const results = await provider.search(query, maxResults, signal)
        if (results.length > 0) {
          return { provider: provider.name, results: sanitizeDeep(results) as SearchResult[] }
        }
      } catch {
        // Fall through to next provider. Errors are intentionally swallowed
        // here because this is a best-effort fallback chain — the caller sees
        // an empty array if every provider fails, and surfaces that as
        // "no results" to the model.
        continue
      }
    }
    return { provider: null, results: [] }
  }
}
