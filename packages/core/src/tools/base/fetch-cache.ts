/**
 * In-memory fetch result cache with 15-minute TTL.
 *
 * Module-level `Map` keyed by normalized URL. Short-circuits the fetch
 * provider stack on hit. Mirrors OpenClaw's `FETCH_CACHE` in
 * openclaw/src/agents/tools/web-fetch.ts:46 — same pattern, same TTL.
 *
 * This is the fast, primary dedup layer. The DB-backed CacheStore
 * (`tool_result_cache` table, 24h TTL) is a write-through layer added
 * by `createFetchStack()` when `cacheStore` + `sessionId` are provided.
 * The DB cache ensures `retrieveCachedResults('urlReader')` works after
 * compaction or process restart.
 *
 * URL normalization strips common tracking parameters so two visits to the
 * same logical page (one with `?utm_source=...`, one without) dedupe into
 * a single entry. Fragment is dropped entirely.
 */

import type { FetchResult } from './fetch-stack.js'

const TTL_MS = 15 * 60 * 1000 // 15 minutes
const MAX_ENTRIES = 256 // LRU soft cap to prevent unbounded growth

type CacheEntry = {
  result: Omit<FetchResult, 'source'>
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

/**
 * Common tracking parameters stripped during cache key normalization.
 * Not exhaustive — covers the 90th percentile and avoids false cache misses
 * on links shared across marketing channels.
 */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'referrer',
])

function normalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    for (const param of Array.from(u.searchParams.keys())) {
      if (TRACKING_PARAMS.has(param.toLowerCase())) {
        u.searchParams.delete(param)
      }
    }
    u.hash = ''
    return u.toString()
  } catch {
    return rawUrl
  }
}

export function readFetchCache(url: string): Omit<FetchResult, 'source'> | null {
  const key = normalizeUrl(url)
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    cache.delete(key)
    return null
  }
  return entry.result
}

export function writeFetchCache(url: string, result: FetchResult): void {
  const key = normalizeUrl(url)
  // Drop the `source` field when caching — a cache hit always sets source='cache'.
  const { source: _source, ...rest } = result
  cache.set(key, { result: rest, expiresAt: Date.now() + TTL_MS })

  // LRU soft cap: when we exceed MAX_ENTRIES, drop the oldest insertion.
  // Map preserves insertion order so the first key is the oldest.
  if (cache.size > MAX_ENTRIES) {
    const firstKey = cache.keys().next().value
    if (firstKey !== undefined) cache.delete(firstKey)
  }
}

/** Test helper — resets the cache between tests. Not exported from public index. */
export function __resetFetchCache(): void {
  cache.clear()
}
