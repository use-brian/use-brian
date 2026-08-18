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
        data: 'xSearch cannot run on this deployment: XAI_API_KEY is not configured, so there is no Grok credential to search X with. Nothing about the query is wrong and retrying will not help — answer from webSearch instead (or tell the user X search is not enabled here).',
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
      // The xAI client keeps the response body as `cause`, never in the
      // message (a Grok error page is noise to the model); the message
      // carries the status and its meaning, and the verdict follows it.
      const message = err instanceof Error ? err.message : String(err)
      const status = /HTTP (\d{3})/.exec(message)?.[1]
      const verdict = status === '401' || status === '403'
        ? 'The xAI key was rejected — a deployment configuration problem, not the query; do not retry, answer from webSearch and tell the user X search is unavailable.'
        : status === '429' || (status && status >= '500')
          ? 'This is transient (rate limit / xAI server error): retry once after a short wait; if it persists, answer from webSearch.'
          : status === '400' || status === '422'
            ? 'xAI rejected the request shape — check the filters (handles without @, YYYY-MM-DD dates); the same input will fail the same way.'
            : /abort|timed? ?out/i.test(message)
              ? 'The search timed out; retry once with a narrower query.'
              : 'Retrying the same query is unlikely to help; answer from webSearch or ask the user.'
      return { data: `xSearch could not search X for \`${input.query}\`: ${message}. ${verdict}`, isError: true }
    }
  },
})
