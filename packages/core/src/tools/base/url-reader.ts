import { z } from 'zod'
import { buildTool } from '../types.js'
import { createFetchStack } from './fetch-stack.js'
import { readabilityProvider } from './fetch-readability.js'
import { jinaProvider } from './fetch-jina.js'
import { rawFetchProvider } from './fetch-raw.js'
import { xApiFetchProvider } from './fetch-x-api.js'
import { xaiFetchProvider } from './fetch-xai.js'
import { isAuthWalledUrl, authWalledGuidance } from './auth-walled-hosts.js'
import { encodeExternalCostMeta } from '../../billing/external-cost.js'

/**
 * URL reader tool — reads a web page and returns its extracted readable
 * content.
 *
 * Backed by a fetch provider stack:
 *   X API v2 tweet lookup (x.com/twitter.com permalinks, TWITTER_BEARER_TOKEN)
 *     → xAI / Grok x_search (x.com fallback + non-permalink X URLs)
 *     → Readability (local, @mozilla/readability + linkedom)
 *     → Jina Reader (r.jina.ai, privacy-filtered)
 *     → raw fetch (browser-UA + regex HTML-to-text)
 *
 * Cache-reads short-circuit the stack (15-min in-memory TTL). Results are
 * sanitized (NFKC + strip invisible chars) before returning to the model.
 *
 * The stack-wide AbortController is wired to the tool's timeout — there is
 * no per-provider timeout so providers never stack their budgets.
 *
 * See docs/architecture/integrations/search-and-fetch.md for the full design.
 */

const DEFAULT_MAX_CHARS = 5000

const fetchStack = createFetchStack({
  providers: [xApiFetchProvider, xaiFetchProvider, readabilityProvider, jinaProvider, rawFetchProvider],
  maxChars: DEFAULT_MAX_CHARS,
})

export const urlReaderTool = buildTool({
  name: 'urlReader',
  description:
    'Read the main readable content of a web page by URL. Returns the extracted text, page title, and which extractor produced it. Use after `webSearch` to get full content for the URLs the model wants to cite. Login-gated pages (social-network profiles like LinkedIn and similar sites that require a signed-in session) cannot be read this way; for those, surface the `webSearch` result URL and its snippet directly instead of reporting a failure.',
  inputSchema: z.object({
    url: z.string().url().describe('URL to read'),
    maxChars: z.number().optional().describe('Maximum characters to return (default 5000)'),
  }),
  isConcurrencySafe: true,
  isReadOnly: true,
  timeoutMs: 15_000,
  maxResultSizeChars: 10_000,

  async execute(input, context) {
    // Auth-walled short-circuit: pages behind a login wall (LinkedIn member
    // profiles, Instagram, …) can never be read by the HTTP fetch stack — it
    // 403/999s or returns the "sign in" interstitial as if it were content.
    // Return the URL back as an actionable, non-error result so the model
    // surfaces the link it already has instead of dead-ending and punting to
    // the user. Discovery (finding the URL via webSearch) is unaffected.
    // See docs/architecture/integrations/search-and-fetch.md.
    if (isAuthWalledUrl(input.url)) {
      return {
        data: {
          url: input.url,
          readable: false,
          reason: 'login_required',
          note: authWalledGuidance(input.url),
        },
      }
    }

    // Build a one-off fetch stack when maxChars differs or when a DB cache
    // store is available for write-through persistence. Otherwise reuse the
    // module-level stack which is warm on its lazy deps.
    const needsCustomStack = (input.maxChars && input.maxChars !== DEFAULT_MAX_CHARS) || context.cacheStore
    const stack = needsCustomStack
      ? createFetchStack({
          providers: [xApiFetchProvider, xaiFetchProvider, readabilityProvider, jinaProvider, rawFetchProvider],
          maxChars: input.maxChars ?? DEFAULT_MAX_CHARS,
          cacheStore: context.cacheStore,
          sessionId: context.sessionId,
          actorUserId: context.userId,
        })
      : fetchStack

    try {
      const result = await stack(input.url, context.abortSignal)
      return {
        data: {
          url: result.url,
          title: result.title,
          content: result.content,
          length: result.length,
          source: result.source,
        },
        // Propagate external API cost to the chat route so it can write a
        // usage_tracking row. Present when e.g. the x.com fetch provider
        // paid Grok tokens; absent for free providers (readability, raw)
        // and for cache hits.
        meta: result.externalCost
          ? encodeExternalCostMeta(result.externalCost)
          : undefined,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { data: `Failed to read URL: ${message}`, isError: true }
    }
  },
})
