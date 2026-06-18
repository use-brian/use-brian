import { z } from 'zod'
import { buildTool } from '../types.js'
import { sanitizeDeep } from '../../security/sanitize.js'
import { encodeExternalCostMeta } from '../../billing/external-cost.js'
import {
  extractXaiResponseText,
  extractXaiUsage,
  postXaiResponses,
  XAI_X_SEARCH_MODEL,
} from '../../providers/xai.js'

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
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, payload })
}

function cacheKey(model: string, input: XSearchInput): string {
  return JSON.stringify([
    'x_search',
    model,
    input.query,
    input.allowedHandles ?? null,
    input.excludedHandles ?? null,
    input.fromDate ?? null,
    input.toDate ?? null,
  ])
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

export const xSearchTool = buildTool({
  name: 'xSearch',
  description:
    "Search posts on X (formerly Twitter) via Grok. Use when the user asks about tweets, X accounts, or news that broke on X. Returns Grok's synthesized answer with URL citations back to source posts. Optional filters: allowedHandles / excludedHandles (no @ prefix), fromDate / toDate (YYYY-MM-DD). Always cite the returned URLs.",
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

    const model = XAI_X_SEARCH_MODEL
    const key = cacheKey(model, input)
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
        inputText: input.query,
        tools: [buildXSearchTool(input)],
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
