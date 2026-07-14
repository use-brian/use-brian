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
  /**
   * Whether a non-throwing empty result from this provider is a trustworthy
   * "nothing matches" answer. Keyed API providers return a real empty result
   * set; the DDG HTML scraper parses rate-limit/challenge pages as zero
   * results, so its empties prove nothing. Defaults to true.
   */
  trustEmpty?: boolean
  /** Execute the search. Should throw on API error so the stack can fall through. */
  search: (query: string, maxResults: number, signal?: AbortSignal) => Promise<SearchResult[]>
}

// ── Stack composer ────────────────────────────────────────────────

/** Outcome of a stack call — `provider` is the name of the winning provider,
 *  or `null` if every provider was unavailable or returned no results. */
export type SearchStackOutcome = {
  provider: string | null
  results: SearchResult[]
  /**
   * Providers that threw (quota exhausted, invalid key, network), in try
   * order. Lets callers distinguish "every provider errored" (an outage —
   * incident 2026-07-13: Brave/Serper/Tavily all quota-exhausted for two
   * days and every webSearch silently returned "No results found") from
   * "providers ran and genuinely found nothing".
   */
  failures: Array<{ provider: string; error: string }>
  /**
   * True when at least one provider whose empties are trustworthy
   * (`trustEmpty !== false`) returned a real empty result set — the
   * emptiness is a meaningful "no results" answer, not a failure artifact.
   */
  trustedEmpty: boolean
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
    const failures: Array<{ provider: string; error: string }> = []
    let trustedEmpty = false
    for (const provider of providers) {
      if (!provider.available()) continue
      if (signal?.aborted) break
      try {
        const results = await provider.search(query, maxResults, signal)
        if (results.length > 0) {
          return { provider: provider.name, results: sanitizeDeep(results) as SearchResult[], failures, trustedEmpty }
        }
        if (provider.trustEmpty !== false) trustedEmpty = true
      } catch (err) {
        // Fall through to the next provider, but RECORD the failure — a
        // caller that only sees an empty array cannot tell a total provider
        // outage apart from a genuinely empty result set, and must not
        // report the former as "no results".
        failures.push({ provider: provider.name, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { provider: null, results: [], failures, trustedEmpty }
  }
}
