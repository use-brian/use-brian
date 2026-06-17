/**
 * Fetch provider stack — pluggable URL → readable content extractors.
 *
 * Providers are tried in order; the first provider that returns a non-empty
 * text result wins. Skipped if not available for the given URL (e.g. Jina
 * declines sensitive URLs). On error or empty content, the stack falls
 * through to the next provider.
 *
 * Stack-wide deadline: a single AbortController gates the whole chain so
 * per-provider timeouts don't stack. The caller passes a total budget in
 * the signal.
 *
 * Results pass through `sanitizeDeep` before returning to the model — the
 * same untrusted-external-content trust class as search results and MCP
 * output (see docs/historical/old-security-model.md).
 *
 * Pattern mirrors openclaw/src/agents/tools/web-fetch.ts — their Readability
 * → Firecrawl fallback is our Readability → Jina → raw fallback. Firecrawl
 * is a drop-in add post-MVP (same HTTP-proxy interface as Jina).
 */

import { sanitizeDeep } from '../../security/sanitize.js'
import { readFetchCache, writeFetchCache } from './fetch-cache.js'
import type { CacheStore } from '../../compaction/cache-tool.js'
import type { ExternalCost } from '../../billing/external-cost.js'

// ── Types ─────────────────────────────────────────────────────────

export type FetchResult = {
  url: string
  title?: string
  content: string
  length: number
  source: 'readability' | 'jina' | 'raw' | 'cache' | 'xai'
  /**
   * Present when this fetch incurred an external-API cost that must be
   * billed back to the user (e.g. xAI tokens for an x.com URL read).
   * The urlReader tool propagates this into `ToolResult.meta` so the chat
   * route writes a `usage_tracking` row. Cache hits do NOT set this —
   * the originating fetch paid already.
   */
  externalCost?: ExternalCost
}

export type FetchProvider = {
  /** Human-readable name, used for logging/tests. */
  name: FetchResult['source']
  /** Decide whether this provider can run for the given URL. */
  canHandle: (url: string) => boolean
  /** Fetch + extract. Should throw on unrecoverable error; return null on soft-fail. */
  fetch: (url: string, signal?: AbortSignal) => Promise<FetchResult | null>
}

// ── Stack composer ────────────────────────────────────────────────

export type FetchStackOptions = {
  providers: FetchProvider[]
  maxChars: number
  /** DB-backed cache for cross-restart persistence. Write-through on fetch success. */
  cacheStore?: CacheStore
  /** Session ID for DB cache writes. Required if cacheStore is provided. */
  sessionId?: string
  /** Acting user for the DB cache write — scopes the cached row to its owner
   *  so a shared-session member can't read another member's fetch (audit #7). */
  actorUserId?: string | null
}

/**
 * Create a fetch function that tries providers in order, returning the first
 * successful extraction. Cache-reads at the top, cache-writes on success.
 */
export function createFetchStack(
  options: FetchStackOptions,
): (url: string, signal?: AbortSignal) => Promise<FetchResult> {
  return async (url, signal) => {
    // Cache hit short-circuits the entire provider stack.
    const cached = readFetchCache(url)
    if (cached) {
      return sanitizeDeep(truncate({ ...cached, source: 'cache' }, options.maxChars)) as FetchResult
    }

    let lastError: Error | undefined
    for (const provider of options.providers) {
      if (signal?.aborted) {
        throw new Error('Fetch aborted')
      }
      if (!provider.canHandle(url)) continue

      try {
        const result = await provider.fetch(url, signal)
        if (result && result.content.trim().length > 0) {
          const truncated = truncate(result, options.maxChars)
          // Strip externalCost before caching — a cache hit should not
          // re-bill the user for an API call that already happened.
          const { externalCost: _cost, ...cacheable } = truncated
          writeFetchCache(url, cacheable as FetchResult)

          // DB write-through for post-compaction retrieveCachedResults
          if (options.cacheStore && options.sessionId) {
            options.cacheStore.set(options.sessionId, 'urlReader', { url }, cacheable, 24, options.actorUserId ?? null)
              .catch(() => {}) // fire-and-forget — in-memory cache is the primary
          }

          return sanitizeDeep(truncated) as FetchResult
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        // Fall through to the next provider. Errors are recorded so the
        // caller can surface the last one if the stack is exhausted.
      }
    }

    throw lastError ?? new Error(`No fetch provider could read ${url}`)
  }
}

// ── Truncation ────────────────────────────────────────────────────

function truncate(result: FetchResult, maxChars: number): FetchResult {
  if (result.content.length <= maxChars) return result
  return {
    ...result,
    content: result.content.slice(0, maxChars) + '\n\n[Content truncated]',
    length: maxChars,
  }
}
