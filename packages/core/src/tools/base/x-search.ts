import { z } from 'zod'
import { buildTool } from '../types.js'
import { sanitizeDeep } from '../../security/sanitize.js'
import { encodeExternalCostMeta } from '../../billing/external-cost.js'
import {
  extractXaiResponseText,
  extractXaiUsage,
  postXaiResponses,
  XAI_X_SEARCH_MODEL,
  XAI_X_URL_QUOTE_MODEL,
} from '../../providers/xai.js'
import { isXHost, parseStatusUrl } from './fetch-xai.js'

/**
 * Grok-powered X (Twitter) post search.
 *
 * Backed by xAI's server-side `x_search` tool on /v1/responses. Returns
 * Grok's synthesized answer with URL citations back to the source posts.
 *
 * Registered in `createBaseTools()` only when `XAI_API_KEY` is set —
 * fail-closed. See docs/architecture/integrations/xai.md.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const CACHE_TTL_MS = 15 * 60 * 1000
// Entry cap bounding the cache inside one TTL window (payloads are a few KB
// of Grok response each). Insertion-order (Map) eviction — oldest first.
const CACHE_MAX_ENTRIES = 128
const REQUEST_TIMEOUT_MS = 30_000

const inputSchema = z.object({
  query: z.string().min(1).describe('Natural-language query to run against X posts.'),
  allowedHandles: z
    .array(z.string())
    .optional()
    .describe('Restrict the search to these X handles (no @ prefix).'),
  excludedHandles: z
    .array(z.string())
    .optional()
    .describe('Exclude posts from these X handles.'),
  fromDate: z
    .string()
    .regex(ISO_DATE_RE, 'fromDate must be YYYY-MM-DD')
    .optional()
    .describe('Earliest post date (YYYY-MM-DD).'),
  toDate: z
    .string()
    .regex(ISO_DATE_RE, 'toDate must be YYYY-MM-DD')
    .optional()
    .describe('Latest post date (YYYY-MM-DD).'),
})

type XSearchInput = z.infer<typeof inputSchema>

type CacheEntry = {
  expiresAt: number
  payload: Record<string, unknown>
}

const cache = new Map<string, CacheEntry>()

function readCache(key: string): Record<string, unknown> | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (entry.expiresAt < Date.now()) {
    cache.delete(key)
    return undefined
  }
  return entry.payload
}

function writeCache(key: string, payload: Record<string, unknown>): void {
  // Sweep expired entries on every write. readCache only deletes the exact
  // key it re-reads, so one-shot queries (the common case) were never evicted
  // and the map grew for the process lifetime — the same leak shape the fetch
  // cache had before it was bounded. Writes are rare (one per un-cached xAI
  // call), so a full sweep here is cheap.
  const now = Date.now()
  for (const [k, entry] of cache) {
    if (entry.expiresAt < now) cache.delete(k)
  }
  cache.set(key, { expiresAt: now + CACHE_TTL_MS, payload })
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

function cacheKey(model: string, inputText: string, toolOptions: Record<string, unknown>): string {
  // Key on the *effective* request (resolved model + prompt + tool options) so
  // the status-URL verbatim branch and the generic-search branch never collide
  // and never re-bill on a repeat call.
  return JSON.stringify(['x_search', model, inputText, toolOptions])
}

function buildXSearchTool(input: XSearchInput): Record<string, unknown> {
  return {
    type: 'x_search',
    ...(input.allowedHandles?.length ? { allowed_x_handles: input.allowedHandles } : {}),
    ...(input.excludedHandles?.length ? { excluded_x_handles: input.excludedHandles } : {}),
    ...(input.fromDate ? { from_date: input.fromDate } : {}),
    ...(input.toDate ? { to_date: input.toDate } : {}),
  }
}

/** Test-only: reset the in-memory cache between cases. */
export function __resetXSearchCache(): void {
  cache.clear()
}

/** Test-only: observe cache size for the eviction-bound tests. */
export function _getXSearchCacheSize(): number {
  return cache.size
}

export const xSearchTool = buildTool({
  name: 'xSearch',
  description:
    "Read or search X (formerly Twitter) posts via Grok. Use when the user shares an X post link, or asks about tweets, X accounts, or news that broke on X. Pass a single `/status/` permalink as `query` to read that post's text verbatim; pass a natural-language query to search across X. The returned `content` IS the post (or Grok's synthesized answer) the user asked about: present it, and never reply that you are unable to fetch the post when this tool returned content. Optional filters: allowedHandles / excludedHandles (no @ prefix), fromDate / toDate (YYYY-MM-DD). Always cite the returned URLs.",
  inputSchema,
  isConcurrencySafe: true,
  isReadOnly: true,
  timeoutMs: REQUEST_TIMEOUT_MS + 2_000,

  async execute(input, context) {
    const apiKey = process.env.XAI_API_KEY
    if (!apiKey) {
      return {
        data: 'xSearch unavailable: XAI_API_KEY is not configured on this deployment.',
        isError: true,
      }
    }

    if (input.fromDate && input.toDate && input.fromDate > input.toDate) {
      return { data: 'fromDate must be on or before toDate.', isError: true }
    }

    // A query that is itself a bare X status permalink means "read this post",
    // not "search X for it". Generic `x_search` on a URL returns a synthesized
    // answer *about* the post, which the model tends to distrust as "not the
    // live tweet" and disclaim ("unable to fetch the live tweet contents") even
    // though the content is usable. Route it through the same verbatim-quote
    // path `urlReader`'s xaiFetchProvider uses so the returned `content` is the
    // post itself. See docs/architecture/integrations/xai.md → "Status-URL queries".
    const trimmedQuery = input.query.trim()
    const status = isXHost(trimmedQuery) ? parseStatusUrl(trimmedQuery) : undefined

    const model = status ? XAI_X_URL_QUOTE_MODEL : XAI_X_SEARCH_MODEL
    const inputText = status
      ? `Quote verbatim the full text of the X post at https://x.com/${status.handle}/status/${status.postId}. Include any replies in the thread if they are part of the post. Do not summarize — give the raw post text.`
      : input.query
    const toolOptions: Record<string, unknown> = status
      ? { type: 'x_search', allowed_x_handles: [status.handle] }
      : buildXSearchTool(input)

    const key = cacheKey(model, inputText, toolOptions)
    const cached = readCache(key)
    if (cached) {
      // Cache hits don't incur a new API call — emit `searchProvider` for
      // analytics attribution but NO externalCost meta (nothing billable).
      return {
        data: { ...cached, cached: true },
        meta: { searchProvider: 'xai' },
      }
    }

    const startedAt = Date.now()
    try {
      const data = await postXaiResponses({
        apiKey,
        model,
        inputText,
        tools: [toolOptions],
        timeoutMs: REQUEST_TIMEOUT_MS,
        signal: context.abortSignal,
      })
      const { content, citations } = extractXaiResponseText(data)
      const usage = extractXaiUsage(data)
      const payload = sanitizeDeep({
        query: input.query,
        provider: 'xai',
        model,
        tookMs: Date.now() - startedAt,
        content: content || 'No response from Grok.',
        citations,
      }) as Record<string, unknown>
      writeCache(key, payload)
      return {
        data: payload,
        meta: {
          searchProvider: 'xai',
          ...encodeExternalCostMeta({
            kind: 'per-token',
            model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
          }),
        },
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { data: `xSearch failed: ${message}`, isError: true }
    }
  },
})
