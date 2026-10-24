import { z } from 'zod'
import { buildTool } from '../types.js'
import { createSearchStack } from './search-stack.js'
import { braveProvider, createBraveProvider } from './search-brave.js'
import { createSerperProvider } from './search-serper.js'
import { createSerpApiProvider } from './search-serpapi.js'
import { createTavilyProvider } from './search-tavily.js'
import { createBaiduProvider } from './search-baidu.js'
import { duckDuckGoProvider } from './search-ddg.js'
import { encodeExternalCostMeta } from '../../billing/external-cost.js'
import { flatSearchCostUsd } from '../../billing/search-provider-rates.js'
import { NO_TOOL_TIMEOUT } from '../../engine/tool-executor.js'
import type { ExternalCredentialPool } from '../../providers/credential-pool.js'

import {
  SEARCH_PROVIDER_NAMES, searchFilterShape, refineSearchFilters, pickSearchFilters,
  hasSearchFilters, unsupportedSearchFilters, searchFilterProvenance,
  type SearchProviderName,
} from './search-filters.js'

const PANEL_CONCURRENCY = 4
const SEARCH_REQUEST_TIMEOUT_MS = 15_000
const MAX_SEARCH_ATTEMPTS = 3
const MAX_RETRY_DELAY_MS = 5_000

async function withSearchDeadline<T>(
  parentSignal: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<{ value: T; timedOut: boolean; cancelled: boolean }> {
  const deadline = new AbortController()
  const deadlineReason = new Error(`search timed out after ${SEARCH_REQUEST_TIMEOUT_MS}ms`)
  const timer = setTimeout(() => deadline.abort(deadlineReason), SEARCH_REQUEST_TIMEOUT_MS)
  const signal = AbortSignal.any([parentSignal, deadline.signal])
  try {
    const value = await run(signal)
    return {
      value,
      // AbortSignal.any preserves the first signal's reason. Inspecting only
      // controller state here would mislabel a deadline as caller cancellation
      // if the parent aborts while a provider is still cleaning up.
      timedOut: signal.aborted && signal.reason === deadlineReason,
      cancelled: signal.aborted && signal.reason !== deadlineReason,
    }
  } finally {
    clearTimeout(timer)
  }
}

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

function normalizeDomain(value: string): string | null {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    const hostname = url.hostname.replace(/^www\./, '').replace(/\.$/, '')
    if (!hostname || !hostname.includes('.') || !/^[a-z0-9.-]+$/.test(hostname)) return null
    return hostname
  } catch {
    return null
  }
}

function domainFromUrl(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
  } catch {
    return ''
  }
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, Math.min(Math.max(ms, 0), MAX_RETRY_DELAY_MS))
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Web search tool — model-driven search with provider fallback.
 *
 * Provider order: Brave → Serper → SerpAPI → Tavily → Baidu → DuckDuckGo.
 *
 * - Brave is first because it's fast, commerce-aware, and cheap.
 * - Serper (Google SERP) is second because Google indexes commercial sites
 *   better than anything else — the motivating bug was "flight prices" which
 *   Brave/Tavily mis-indexed and Google gets right.
 * - SerpAPI is a second Google SERP backend for exact-provider measurements
 *   and fallback when Serper rejects a request.
 * - Tavily follows for AI-optimized research queries.
 * - Baidu adds a keyed Chinese-language and mainland-China web index.
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
const webSearchInputSchema = z
  .object({
    ...searchFilterShape,
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
        'Pin a provider; required for query panels and measurements. Omit for Brave → Serper → SerpAPI → Tavily → Baidu → DuckDuckGo fallback among configured providers supporting every requested filter.',
      ),
    maxResults: z.number().optional().describe('Maximum results per query (default 5, max 10)'),
    resultMode: z
      .enum(['full', 'measurement'])
      .optional()
      .describe(
        'Output shape for exact-provider measurements. `measurement` omits snippets and adds normalized domain/rank summaries.',
      ),
    trackDomains: z
      .array(z.string().min(1).max(253))
      .min(1)
      .max(20)
      .optional()
      .describe('Domains to rank in `measurement` mode, for example usebrian.ai or studio.usebrian.ai.'),
  })
  .strict()
  .superRefine((input, ctx) => {
    refineSearchFilters(input, ctx)
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
    if (input.resultMode === 'measurement' && !input.provider) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '`measurement` requires an exact `provider` so provenance cannot change between queries.',
        path: ['provider'],
      })
    }
    if (input.trackDomains && input.resultMode !== 'measurement') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '`trackDomains` is valid only when `resultMode` is `measurement`.',
        path: ['trackDomains'],
      })
    }
    input.trackDomains?.forEach((domain, index) => {
      if (!normalizeDomain(domain)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Pass a valid hostname or http(s) URL.',
          path: ['trackDomains', index],
        })
      }
    })
  })

export function createWebSearchTool(pool?: ExternalCredentialPool) {
  const providersByName = {
    brave: createBraveProvider(pool),
    serper: createSerperProvider(pool),
    serpapi: createSerpApiProvider(pool),
    tavily: createTavilyProvider(pool),
    baidu: createBaiduProvider(pool),
    duckduckgo: duckDuckGoProvider,
  } satisfies Record<SearchProviderName, typeof braveProvider>
  const searchStack = createSearchStack(SEARCH_PROVIDER_NAMES.map((name) => providersByName[name]))

  return buildTool({
  name: 'webSearch',
  description:
    "Search the web for current information. Filters use provider-neutral fields; fallback uses only compatible providers. Pin `provider` for exact-index results; exact-provider calls never fall back. Use `queries` for an ordered panel (up to 25) with that provider. `resultMode: measurement` omits snippets and adds rank/domain rows plus optional `trackDomains` summaries. Transient timeouts, 429s and 5xx errors get at most three attempts. Results contain ranked titles, URLs and snippets. To FIND or CONFIRM a page (profile, company site, official link), report the matching URL and cite its snippet; no page read is needed. Use `urlReader` for page-body details (prices, dates, statistics, article text): request the 1-3 most relevant URLs together so reads run in parallel. For login-gated pages such as LinkedIn, use the result URL and snippet when reading is unavailable. Quote exact numbers from results, never substitute prior knowledge. Always cite the URLs used.",
  inputSchema: webSearchInputSchema,
  isConcurrencySafe: true,
  isReadOnly: true,
  // Exact-provider panels can require seven bounded-concurrency waves. Each
  // provider request gets its own deadline below so one slow request cannot
  // abort queued work that has not started yet.
  timeoutMs: NO_TOOL_TIMEOUT,

  async execute(input, context) {
    // Also validate direct/internal execute callers, not only tool-executor calls.
    const parsed = webSearchInputSchema.safeParse(input)
    if (!parsed.success) return { data: `Invalid web search input: ${parsed.error.message}`, isError: true }
    input = parsed.data
    const filters = pickSearchFilters(input)
    const filtered = hasSearchFilters(filters)
    const filterData = (provider: SearchProviderName) => filtered ? searchFilterProvenance(provider, filters) : {}
    const maxResults = Math.max(1, Math.min(10, input.maxResults ?? 5))
    const exactProvider = input.provider

    if (exactProvider) {
      const selected = providersByName[exactProvider]
      const unsupported = unsupportedSearchFilters(exactProvider, filters)
      if (unsupported.length) return {
        data: { error: 'unsupported_filters', provider: exactProvider, requestedFilters: filters, reasons: unsupported,
          message: 'Choose a compatible provider or explicitly revise the filters. No search ran and no fallback was used.' },
        isError: true,
      }
      if (!selected.available()) {
        return {
          data: filtered
            ? { error: 'provider_unavailable', requestedFilters: filters, provider: exactProvider,
                message: 'The selected provider is not configured. No search ran and no fallback was used.' }
            : `Exact web-search provider ${exactProvider} is not configured. ` +
              'This measurement was not run, and no fallback provider was used.',
          isError: true,
        }
      }

      const queries = input.queries ?? [input.query!]
      const measurement = input.resultMode === 'measurement'
      const trackedDomains = [...new Set((input.trackDomains ?? []).map(normalizeDomain).filter((domain): domain is string => Boolean(domain)))]
      const strictStack = createSearchStack([selected])
      const searches = await mapPool(queries, selected.panelConcurrency ?? PANEL_CONCURRENCY, async (query) => {
        let final: {
          value: Awaited<ReturnType<typeof strictStack>>
          timedOut: boolean
          cancelled: boolean
        } | undefined
        for (let attempt = 0; ; attempt++) {
          final = await withSearchDeadline(
            context.abortSignal,
            (signal) => strictStack(query, maxResults, signal, filters),
          )
          const failure = final.value.failures.at(-1)
          const retryable =
            final.timedOut ||
            failure?.kind === 'rate_limit' ||
            failure?.kind === 'server' ||
            failure?.status === 408 ||
            (failure?.status !== undefined && failure.status >= 500)
          if (
            final.cancelled ||
            context.abortSignal.aborted ||
            final.value.results.length > 0 ||
            final.value.trustedEmpty ||
            !retryable ||
            attempt + 1 >= MAX_SEARCH_ATTEMPTS
          ) break
          const fallbackMs = 250 * 2 ** attempt
          if (!await waitForRetry(failure?.retryAfterMs ?? fallbackMs, context.abortSignal)) {
            final = { ...final, timedOut: false, cancelled: true }
            break
          }
        }
        const { value: outcome, timedOut, cancelled } = final!
        if (outcome.results.length > 0) {
          if (measurement) {
            const results = outcome.results.map((result, index) => ({
              rank: index + 1,
              title: result.title,
              url: result.url,
              domain: domainFromUrl(result.url),
            }))
            return {
              query,
              status: 'ok' as const,
              provider: exactProvider,
              results,
              trackedDomains: trackedDomains.map((domain) => {
                const matches = results.filter((result) => result.domain === domain)
                return {
                  domain,
                  bestRank: matches[0]?.rank ?? null,
                  matchingUrls: matches.map((result) => result.url),
                }
              }),
            }
          }
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
            ...(measurement
              ? {
                  trackedDomains: trackedDomains.map((domain) => ({
                    domain,
                    bestRank: null,
                    matchingUrls: [],
                  })),
                }
              : {}),
          }
        }
        const error = cancelled
          ? 'search cancelled by caller'
          : timedOut
            ? `search timed out after ${SEARCH_REQUEST_TIMEOUT_MS}ms`
            : outcome.failures.map((failure) => failure.error).join('; ') || 'provider unavailable'
        return {
          query,
          status: 'error' as const,
          provider: exactProvider,
          error,
          results: [],
          ...(measurement
            ? {
                trackedDomains: trackedDomains.map((domain) => ({
                  domain,
                  bestRank: null,
                  matchingUrls: [],
                })),
              }
            : {}),
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

      const topDomains = measurement
        ? (() => {
            const domains = new Map<string, { appearances: number; bestRank: number }>()
            for (const search of searches) {
              for (const result of search.results) {
                if (!('domain' in result) || !result.domain) continue
                const current = domains.get(result.domain)
                domains.set(result.domain, {
                  appearances: (current?.appearances ?? 0) + 1,
                  bestRank: Math.min(current?.bestRank ?? Number.POSITIVE_INFINITY, result.rank),
                })
              }
            }
            return [...domains.entries()]
              .map(([domain, metrics]) => ({ domain, ...metrics }))
              .sort((a, b) => b.appearances - a.appearances || a.bestRank - b.bestRank || a.domain.localeCompare(b.domain))
          })()
        : undefined

      return {
        data: {
          provider: exactProvider,
          ...(filtered ? { requestedFilters: filters, ...(completed > 0 ? filterData(exactProvider) : {}) } : {}),
          ...(measurement ? { resultMode: 'measurement' as const } : {}),
          expectedQueries: queries.length,
          completed,
          failed,
          searches,
          ...(topDomains ? { topDomains } : {}),
        },
        ...(failed === searches.length ? { isError: true } : {}),
        meta,
      }
    }

    const {
      value: { provider, results, failures, trustedEmpty, excludedProviders, emptyProvider },
      timedOut,
      cancelled,
    } = await withSearchDeadline(
      context.abortSignal,
      (signal) => searchStack(input.query!, maxResults, signal, filters),
    )

    // `meta.searchProvider` carries the winning provider name (brave / serper /
    // serpapi / tavily / baidu / duckduckgo) back to analytics via ToolResult.meta.
    // `externalCost_*` keys carry the per-call USD so the chat route can
    // write a `usage_tracking` row (flat cost, 0 tokens) per billing policy.
    // Both are omitted when no provider served the call.
    const billedProvider = provider ?? (filtered ? emptyProvider : undefined)
    const meta =
      billedProvider
        ? {
            searchProvider: billedProvider,
            ...encodeExternalCostMeta({
              kind: 'flat',
              model: billedProvider,
              flatCostUsd: flatSearchCostUsd(billedProvider),
            }),
          }
        : undefined

    if (results.length === 0) {
      if (!cancelled && !timedOut && filtered && !trustedEmpty && failures.length === 0) return {
        data: { error: 'unsupported_filters', requestedFilters: filters, excludedProviders,
          message: 'No configured provider can honor all requested filters. Choose a compatible provider/configuration or explicitly revise the filters. No conclusion can be drawn from the empty result.' },
        isError: true,
      }
      if (cancelled || timedOut) {
        const reason = cancelled
          ? 'Web search was cancelled by the caller.'
          : `Web search timed out after ${SEARCH_REQUEST_TIMEOUT_MS}ms.`
        return {
          data: filtered
            ? { error: cancelled ? 'cancelled' : 'timeout', requestedFilters: filters, message: `${reason} No conclusion can be drawn from the empty result.` }
            : `${reason} No conclusion can be drawn from the empty result.`,
          isError: true,
          meta: { searchProviderErrors: reason },
        }
      }
      // Outage vs no results. When every provider that ran errored and none
      // returned a trustworthy empty, "No results found" would be a lie the
      // model repeats to the user as "X does not exist" / confabulated
      // access limitations (incident 2026-07-13: all three keyed providers
      // quota-exhausted for two days, 100% of webSearch calls affected).
      // Surface the outage as a tool error instead — `isError` flows to the
      // `tool_executed` analytics event as success=false + error_message,
      // and `searchProviderErrors` meta records which providers failed.
      if (filtered && !trustedEmpty && failures.some((failure) => failure.status === 400 || failure.status === 422)) return {
        data: { error: 'provider_rejected_request', requestedFilters: filters, failures, excludedProviders,
          message: 'A search provider rejected the filtered request. Check its filter support, credentials and quota before retrying; this is not evidence of zero matches.' },
        isError: true,
      }
      if (failures.length > 0 && !trustedEmpty) {
        const summary = failures.map((f) => `${f.provider}: ${f.error}`).join('; ')
        return {
          data: filtered
            ? { error: 'search_unavailable', requestedFilters: filters, failures, excludedProviders,
                message: `Web search is temporarily unavailable — every compatible search provider failed (${summary}). No conclusion can be drawn from the empty results.` }
            : `Web search is temporarily unavailable — every search provider failed (${summary}). ` +
              'This is a system-side outage, NOT evidence that what you searched for does not exist. ' +
              'Do not conclude anything from the empty results; tell the user plainly that web search is currently down.',
          isError: true,
          meta: { searchProviderErrors: summary.slice(0, 500) },
        }
      }
      if (filtered) return { data: { query: input.query!, results: [], provider: emptyProvider,
        ...(emptyProvider ? filterData(emptyProvider as SearchProviderName) : {}), excludedProviders,
        message: 'No results found matching these filters. Try a different query.' }, meta }
      return { data: 'No results found. Try a different query.', meta }
    }

    return { data: { query: input.query!, results,
      ...(filtered && provider ? { provider, ...filterData(provider as SearchProviderName), excludedProviders } : {}),
    }, meta }
  },
  })
}

export const webSearchTool = createWebSearchTool()
