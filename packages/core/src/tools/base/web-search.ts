import { z } from 'zod'
import { buildTool } from '../types.js'
import { createSearchStack } from './search-stack.js'
import { braveProvider } from './search-brave.js'
import { serperProvider } from './search-serper.js'
import { tavilyProvider } from './search-tavily.js'
import { duckDuckGoProvider } from './search-ddg.js'
import { encodeExternalCostMeta } from '../../billing/external-cost.js'
import { flatSearchCostUsd } from '../../billing/search-provider-rates.js'

const SEARCH_PROVIDER_NAMES = ['brave', 'serper', 'tavily', 'duckduckgo'] as const
type SearchProviderName = (typeof SEARCH_PROVIDER_NAMES)[number]

const providersByName = {
  brave: braveProvider,
  serper: serperProvider,
  tavily: tavilyProvider,
  duckduckgo: duckDuckGoProvider,
} satisfies Record<SearchProviderName, typeof braveProvider>

const PANEL_CONCURRENCY = 4

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * Web search tool — model-driven search with provider fallback.
 *
 * Provider order: Brave → Serper → Tavily → DuckDuckGo.
 *
 * - Brave is first because it's fast, commerce-aware, and cheap.
 * - Serper (Google SERP) is second because Google indexes commercial sites
 *   better than anything else — the motivating bug was "flight prices" which
 *   Brave/Tavily mis-indexed and Google gets right.
 * - Tavily is third for AI-optimized research queries.
 * - DuckDuckGo is the no-token fallback for local dev without any env set.
 *
 * This is the explicit `webSearch` tool the model calls. It replaces
 * Gemini's passive Google Search grounding (which is now gated off whenever
 * explicit tools are present — see providers/gemini.ts). The model drives
 * the full search → fetch → cite loop: it picks which URLs to read and
 * calls `urlReader` on each before synthesizing a citation-backed answer.
 *
 * See docs/architecture/integrations/search-and-fetch.md.
 */
const searchStack = createSearchStack(SEARCH_PROVIDER_NAMES.map((name) => providersByName[name]))

const webSearchInputSchema = z
  .object({
    query: z.string().min(1).optional().describe('One search query. Use `queries` for an exact-provider panel.'),
    queries: z
      .array(z.string().min(1))
      .min(1)
      .max(25)
      .optional()
      .describe('Ordered panel of up to 25 queries. Requires an exact `provider`.'),
    provider: z
      .enum(SEARCH_PROVIDER_NAMES)
      .optional()
      .describe(
        'Exact provider for repeatable measurement. Omit for normal Brave → Serper → Tavily → DuckDuckGo fallback.',
      ),
    maxResults: z.number().optional().describe('Maximum results per query (default 5, max 10)'),
  })
  .superRefine((input, ctx) => {
    const hasQuery = typeof input.query === 'string'
    const hasQueries = Array.isArray(input.queries)
    if (hasQuery === hasQueries) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Pass exactly one of `query` or `queries`.',
      })
    }
    if (hasQueries && !input.provider) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '`queries` requires an exact `provider` so a panel cannot mix search indexes.',
        path: ['provider'],
      })
    }
  })

export const webSearchTool = buildTool({
  name: 'webSearch',
  description:
    "Search the web for current information. A single `query` normally uses the provider fallback stack. For a repeatable search-index measurement, set an exact `provider`; for a fixed battery, send `queries` with that provider and receive one ordered status/result row per query. Exact-provider calls never fall through to another index. Results contain ranked title, URL, and snippet fields. The result URL and snippet are themselves usable: when the goal is to FIND or CONFIRM a page (a person's profile, a company site, an official link), the matching result URL IS the answer - report that URL and cite its snippet; you do NOT need to read the page first. Call `urlReader` only when you need content from inside a page body (prices, dates, statistics, article text) - read the 1-3 most relevant URLs ALL IN THE SAME RESPONSE so they execute in parallel (do not wait for one to finish before calling the next). Some pages (social-network profiles like LinkedIn, and other login-gated sites) cannot be read without a signed-in session; for those, give the user the result URL plus its snippet rather than reporting that nothing was found. When the results contain specific numbers (prices, dates, statistics), use the EXACT values from the results - never substitute your own knowledge. Always cite the URLs you used.",
  inputSchema: webSearchInputSchema,
  isConcurrencySafe: true,
  isReadOnly: true,
  timeoutMs: 15_000,

  async execute(input, context) {
    const maxResults = Math.max(1, Math.min(10, input.maxResults ?? 5))
    const exactProvider = input.provider

    if (exactProvider) {
      const selected = providersByName[exactProvider]
      if (!selected.available()) {
        return {
          data:
            `Exact web-search provider ${exactProvider} is not configured. ` +
            'This measurement was not run, and no fallback provider was used.',
          isError: true,
        }
      }

      const queries = input.queries ?? [input.query!]
      const strictStack = createSearchStack([selected])
      const searches = await mapPool(queries, PANEL_CONCURRENCY, async (query) => {
        const outcome = await strictStack(query, maxResults, context.abortSignal)
        if (outcome.results.length > 0) {
          return {
            query,
            status: 'ok' as const,
            provider: exactProvider,
            results: outcome.results,
          }
        }
        if (outcome.trustedEmpty) {
          return {
            query,
            status: 'empty' as const,
            provider: exactProvider,
            results: [],
          }
        }
        const error = outcome.failures.map((failure) => failure.error).join('; ') || 'provider unavailable'
        return {
          query,
          status: 'error' as const,
          provider: exactProvider,
          error,
          results: [],
        }
      })

      const failed = searches.filter((search) => search.status === 'error').length
      const completed = searches.length - failed
      const failureSummary = searches
        .filter((search): search is Extract<(typeof searches)[number], { status: 'error' }> =>
          search.status === 'error',
        )
        .map((search) => `${search.query}: ${search.error}`)
        .join('; ')
      const meta = {
        searchProvider: exactProvider,
        searchProviderUnits: completed,
        ...(completed > 0
          ? encodeExternalCostMeta({
              kind: 'flat',
              model: exactProvider,
              flatCostUsd: flatSearchCostUsd(exactProvider) * completed,
            })
          : {}),
        ...(failureSummary ? { searchProviderErrors: failureSummary.slice(0, 500) } : {}),
      }

      return {
        data: {
          provider: exactProvider,
          expectedQueries: queries.length,
          completed,
          failed,
          searches,
        },
        ...(failed === searches.length ? { isError: true } : {}),
        meta,
      }
    }

    const { provider, results, failures, trustedEmpty } = await searchStack(
      input.query!,
      maxResults,
      context.abortSignal,
    )

    // `meta.searchProvider` carries the winning provider name (brave / serper
    // / tavily / duckduckgo) back to the analytics log site via ToolResult.meta.
    // `externalCost_*` keys carry the per-call USD so the chat route can
    // write a `usage_tracking` row (flat cost, 0 tokens) per billing policy.
    // Both are omitted when no provider served the call.
    const meta =
      provider
        ? {
            searchProvider: provider,
            ...encodeExternalCostMeta({
              kind: 'flat',
              model: provider,
              flatCostUsd: flatSearchCostUsd(provider),
            }),
          }
        : undefined

    if (results.length === 0) {
      // Outage vs no results. When every provider that ran errored and none
      // returned a trustworthy empty, "No results found" would be a lie the
      // model repeats to the user as "X does not exist" / confabulated
      // access limitations (incident 2026-07-13: all three keyed providers
      // quota-exhausted for two days, 100% of webSearch calls affected).
      // Surface the outage as a tool error instead — `isError` flows to the
      // `tool_executed` analytics event as success=false + error_message,
      // and `searchProviderErrors` meta records which providers failed.
      if (failures.length > 0 && !trustedEmpty) {
        const summary = failures.map((f) => `${f.provider}: ${f.error}`).join('; ')
        return {
          data:
            `Web search is temporarily unavailable — every search provider failed (${summary}). ` +
            'This is a system-side outage, NOT evidence that what you searched for does not exist. ' +
            'Do not conclude anything from the empty results; tell the user plainly that web search is currently down.',
          isError: true,
          meta: { searchProviderErrors: summary.slice(0, 500) },
        }
      }
      return { data: 'No results found. Try a different query.', meta }
    }

    return { data: { query: input.query!, results }, meta }
  },
})
