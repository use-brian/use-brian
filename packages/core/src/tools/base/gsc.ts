/**
 * Google Search Console tools — four read-only tools over the properties a
 * workspace's own service account can see.
 *
 * The `api` port is injected by the API layer (`packages/api/src/gsc/client.ts`
 * behind `injectSearchConsoleTools`), so core stays free of network deps and
 * never sees a key. Every tool takes an optional `siteUrl`; resolution is
 * `args.siteUrl ?? await api.defaultSite()` (the property chosen at connect
 * time), and neither → an actionable error naming `searchConsoleListSites`.
 * Property strings pass through verbatim (`sc-domain:example.com` or
 * `https://example.com/`).
 *
 * The dimension / operator / search-type vocabularies below feed BOTH the zod
 * schemas and the tool descriptions, so the model can never be told a value
 * the schema rejects (CLAUDE.md "ship the vocabulary" rule).
 *
 * See docs/architecture/integrations/search-console.md.
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../types.js'
import {
  type Json,
  type ConnectorFailureKind,
  ConnectorApiError,
  asRows,
  bool,
  connectorError,
  num,
  obj,
  str,
} from './_connector-result.js'

const PROVIDER = 'Google Search Console'

export const SEARCH_CONSOLE_DIMENSIONS = ['query', 'page', 'country', 'device', 'date', 'searchAppearance'] as const
export const SEARCH_CONSOLE_SEARCH_TYPES = ['web', 'image', 'video', 'news', 'discover', 'googleNews'] as const
export const SEARCH_CONSOLE_FILTER_OPERATORS = ['equals', 'contains', 'notContains', 'includingRegex', 'excludingRegex'] as const

export const SEARCH_CONSOLE_TOOL_NAMES = [
  'searchConsoleListSites',
  'searchConsoleQuery',
  'searchConsoleInspectUrl',
  'searchConsoleListSitemaps',
] as const

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')

export type SearchConsoleQueryBody = {
  startDate: string
  endDate: string
  dimensions: string[]
  rowLimit: number
  startRow?: number
  type: string
  dimensionFilterGroups?: Array<{ groupType: 'and'; filters: Array<{ dimension: string; operator: string; expression: string }> }>
}

/** The port the API layer fulfils. `defaultSite` is the connect-time property for this instance. */
export type SearchConsoleToolsApi = {
  listSites(): Promise<unknown>
  query(siteUrl: string, body: SearchConsoleQueryBody): Promise<unknown>
  inspectUrl(siteUrl: string, url: string, languageCode?: string): Promise<unknown>
  listSitemaps(siteUrl: string): Promise<unknown>
  defaultSite(): Promise<string | null>
}

// ── Failure copy ─────────────────────────────────────────────
// The api client throws `SearchConsoleConnectorError { code, status?,
// providerMessage? }` whose `message` is OUR sentence. Re-shape it into the
// shared `ConnectorApiError` so `connectorError()` renders what / why / next
// step / verdict by kind, with Google's capped wording as the "said" clause.

const KIND_BY_CODE: Record<string, ConnectorFailureKind> = {
  invalid_key_json: 'auth',
  invalid_credentials: 'auth',
  forbidden: 'forbidden',
  not_found: 'not_found',
  invalid_request: 'validation',
  rate_limited: 'rate_limit',
  upstream_error: 'transient',
  no_properties: 'forbidden',
  unknown_property: 'not_found',
}

function toConnectorApiError(err: unknown): unknown {
  const e = err as { name?: unknown; code?: unknown; status?: unknown; providerMessage?: unknown; message?: unknown } | null
  if (e?.name !== 'SearchConsoleConnectorError' || typeof e.code !== 'string') return err
  const status = typeof e.status === 'number' ? e.status : undefined
  const provider = typeof e.providerMessage === 'string' && e.providerMessage.trim() ? e.providerMessage : undefined
  return new ConnectorApiError({
    provider: PROVIDER,
    status,
    code: e.code,
    message: provider ?? (typeof e.message === 'string' ? e.message : e.code),
    kind: KIND_BY_CODE[e.code],
  })
}

const VOCAB_LINE =
  `Valid dimensions: ${SEARCH_CONSOLE_DIMENSIONS.join(', ')}. ` +
  `Valid searchType values: ${SEARCH_CONSOLE_SEARCH_TYPES.join(', ')}. ` +
  `Valid filter operators: ${SEARCH_CONSOLE_FILTER_OPERATORS.join(', ')}.`

function noSiteError(tool: string): { data: string; isError: true } {
  return {
    data:
      `\`${tool}\` needs a Search Console property and none was given: this connector has no default property, so pass \`siteUrl\`. ` +
      `Call \`searchConsoleListSites\` and use one of its \`siteUrl\` values verbatim (e.g. \`sc-domain:example.com\` or \`https://example.com/\`). ` +
      'Retrying without `siteUrl` will fail the same way.',
    isError: true,
  }
}

// ── Projections ──────────────────────────────────────────────

/** Google int64 fields arrive as strings; accept either. */
function numish(o: Json | undefined, key: string): number | undefined {
  const v = o?.[key]
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

function strList(v: unknown, cap?: number): string[] {
  const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  return cap === undefined ? list : list.slice(0, cap)
}

const analyticsRow = (r: Json) => ({
  keys: strList(r.keys),
  clicks: num(r, 'clicks') ?? 0,
  impressions: num(r, 'impressions') ?? 0,
  ctr: num(r, 'ctr') ?? 0,
  position: num(r, 'position') ?? 0,
})

function projectSearchAnalytics(
  raw: unknown,
  ctx: { siteUrl: string; startDate: string; endDate: string; dimensions: string[]; rowLimit: number; startRow: number },
) {
  const rows = asRows((raw as Json | null)?.rows).map(analyticsRow)
  return {
    siteUrl: ctx.siteUrl,
    startDate: ctx.startDate,
    endDate: ctx.endDate,
    dimensions: ctx.dimensions,
    rows,
    rowCount: rows.length,
    nextStartRow: rows.length === ctx.rowLimit ? ctx.startRow + ctx.rowLimit : null,
  }
}

function projectInspection(raw: unknown, url: string) {
  const result = obj(raw as Json, 'inspectionResult') ?? {}
  const index = obj(result, 'indexStatusResult') ?? {}
  return {
    url,
    verdict: str(index, 'verdict'),
    coverageState: str(index, 'coverageState'),
    indexingState: str(index, 'indexingState'),
    robotsTxtState: str(index, 'robotsTxtState'),
    pageFetchState: str(index, 'pageFetchState'),
    lastCrawlTime: str(index, 'lastCrawlTime'),
    crawledAs: str(index, 'crawledAs'),
    googleCanonical: str(index, 'googleCanonical'),
    userCanonical: str(index, 'userCanonical'),
    sitemaps: strList(index.sitemap),
    referringUrls: strList(index.referringUrls, 5),
    mobileUsabilityVerdict: str(obj(result, 'mobileUsabilityResult'), 'verdict'),
    richResultsVerdict: str(obj(result, 'richResultsResult'), 'verdict'),
  }
}

function projectSitemaps(raw: unknown, siteUrl: string) {
  return {
    siteUrl,
    sitemaps: asRows((raw as Json | null)?.sitemap).map((s) => ({
      path: str(s, 'path'),
      type: str(s, 'type'),
      lastSubmitted: str(s, 'lastSubmitted'),
      lastDownloaded: str(s, 'lastDownloaded'),
      isPending: bool(s, 'isPending') ?? false,
      isSitemapsIndex: bool(s, 'isSitemapsIndex') ?? false,
      warnings: numish(s, 'warnings') ?? 0,
      errors: numish(s, 'errors') ?? 0,
    })),
  }
}

function projectSites(raw: unknown) {
  return {
    sites: asRows((raw as Json | null)?.siteEntry).map((s) => ({
      siteUrl: str(s, 'siteUrl'),
      permissionLevel: str(s, 'permissionLevel'),
    })),
  }
}

// ── Tools ────────────────────────────────────────────────────

export function createSearchConsoleTools(api: SearchConsoleToolsApi): Tool[] {
  const siteArg = z.string().min(1).max(500).optional().describe(
    'Search Console property, exactly as `searchConsoleListSites` returns it (`sc-domain:example.com` or `https://example.com/`). ' +
    'Defaults to the property chosen when the connector was set up.',
  )
  const resolveSite = async (given: string | undefined): Promise<string | null> => {
    const site = given?.trim()
    if (site) return site
    return (await api.defaultSite())?.trim() || null
  }

  const listSites = buildTool({
    name: 'searchConsoleListSites',
    description:
      'List the Search Console properties this connector\'s service account can read, with the permission level on each. ' +
      'Call this first when the user has more than one site, or when another searchConsole* tool asks for `siteUrl`.',
    inputSchema: z.object({}),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 20_000,
    async execute() {
      try {
        return { data: projectSites(await api.listSites()) }
      } catch (err) {
        return connectorError({ provider: PROVIDER, tool: 'searchConsoleListSites', err: toConnectorApiError(err) })
      }
    },
  })

  const query = buildTool({
    name: 'searchConsoleQuery',
    description:
      'Query Search Console performance (clicks, impressions, CTR, average position) for a property over a date range, ' +
      'grouped by dimensions. Read-only ground truth for how the site performs in Google Search. ' +
      `${VOCAB_LINE} ` +
      'Data lags ~2 days; `date` rows are per day. Page through large results with `startRow` = the previous `nextStartRow`.',
    inputSchema: z.object({
      startDate: DATE.describe('Inclusive start date, YYYY-MM-DD.'),
      endDate: DATE.describe('Inclusive end date, YYYY-MM-DD.'),
      dimensions: z.array(z.enum(SEARCH_CONSOLE_DIMENSIONS)).max(4).optional()
        .describe(`Group rows by these dimensions. Omit for default ["query"]; pass [] for ungrouped property totals. One of: ${SEARCH_CONSOLE_DIMENSIONS.join(', ')}.`),
      rowLimit: z.number().int().min(1).max(1000).optional().describe('Max rows to return (default 100, max 1000).'),
      startRow: z.number().int().min(0).optional().describe('Zero-based row offset for paging (default 0).'),
      searchType: z.enum(SEARCH_CONSOLE_SEARCH_TYPES).optional()
        .describe(`Search surface (default web). One of: ${SEARCH_CONSOLE_SEARCH_TYPES.join(', ')}.`),
      filters: z.array(z.object({
        dimension: z.enum(SEARCH_CONSOLE_DIMENSIONS).describe('Dimension to filter on.'),
        operator: z.enum(SEARCH_CONSOLE_FILTER_OPERATORS).optional().describe(`Match operator (default equals). One of: ${SEARCH_CONSOLE_FILTER_OPERATORS.join(', ')}.`),
        expression: z.string().min(1).max(2000).describe('Value / regex to match.'),
      })).max(10).optional().describe('Filters combined with AND (one filter group).'),
      siteUrl: siteArg,
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 20_000,
    async execute(input) {
      const siteUrl = await resolveSite(input.siteUrl)
      if (!siteUrl) return noSiteError('searchConsoleQuery')
      const dimensions = input.dimensions === undefined ? ['query'] : [...input.dimensions]
      const rowLimit = input.rowLimit ?? 100
      const startRow = input.startRow ?? 0
      const body: SearchConsoleQueryBody = {
        startDate: input.startDate,
        endDate: input.endDate,
        dimensions,
        rowLimit,
        type: input.searchType ?? 'web',
        ...(startRow > 0 ? { startRow } : {}),
        ...(input.filters?.length
          ? {
              dimensionFilterGroups: [{
                groupType: 'and' as const,
                filters: input.filters.map((f) => ({ dimension: f.dimension, operator: f.operator ?? 'equals', expression: f.expression })),
              }],
            }
          : {}),
      }
      try {
        const raw = await api.query(siteUrl, body)
        return { data: projectSearchAnalytics(raw, { siteUrl, startDate: input.startDate, endDate: input.endDate, dimensions, rowLimit, startRow }) }
      } catch (err) {
        return connectorError({
          provider: PROVIDER,
          tool: 'searchConsoleQuery',
          target: `property \`${siteUrl}\``,
          discoveryTool: 'searchConsoleListSites',
          err: toConnectorApiError(err),
          translate: (e) => e.kind === 'validation' || e.status === 400
            ? `${PROVIDER} rejected the \`searchConsoleQuery\` request for property \`${siteUrl}\` (${e.status ?? 400}${e.code ? `, ${e.code}` : ''}).${e.detail ? ` ${PROVIDER} said: "${e.detail}".` : ''} ${VOCAB_LINE} Dates are YYYY-MM-DD and endDate must not precede startDate. Fix the argument that message names before retrying; the same input will fail the same way.`
            : undefined,
        })
      }
    },
  })

  const inspectUrl = buildTool({
    name: 'searchConsoleInspectUrl',
    description:
      'Inspect one URL\'s Google index status for a property: verdict, coverage state, indexing state, robots.txt state, ' +
      'last crawl, canonical chosen by Google vs the user, referring sitemaps / URLs, and mobile usability / rich results verdicts. ' +
      'The URL must belong to the property.',
    inputSchema: z.object({
      url: z.string().url().max(2000).describe('Fully-qualified URL to inspect (must be inside the property).'),
      languageCode: z.string().max(16).optional().describe('BCP-47 language for the human-readable fields (default en-US).'),
      siteUrl: siteArg,
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 20_000,
    async execute(input) {
      const siteUrl = await resolveSite(input.siteUrl)
      if (!siteUrl) return noSiteError('searchConsoleInspectUrl')
      try {
        return { data: projectInspection(await api.inspectUrl(siteUrl, input.url, input.languageCode), input.url) }
      } catch (err) {
        return connectorError({
          provider: PROVIDER,
          tool: 'searchConsoleInspectUrl',
          target: `URL \`${input.url}\` in property \`${siteUrl}\``,
          discoveryTool: 'searchConsoleListSites',
          err: toConnectorApiError(err),
        })
      }
    },
  })

  const listSitemaps = buildTool({
    name: 'searchConsoleListSitemaps',
    description:
      'List the sitemaps submitted for a property: path, type, last submitted / downloaded, pending state, and warning / error counts.',
    inputSchema: z.object({ siteUrl: siteArg }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 20_000,
    async execute(input) {
      const siteUrl = await resolveSite(input.siteUrl)
      if (!siteUrl) return noSiteError('searchConsoleListSitemaps')
      try {
        return { data: projectSitemaps(await api.listSitemaps(siteUrl), siteUrl) }
      } catch (err) {
        return connectorError({
          provider: PROVIDER,
          tool: 'searchConsoleListSitemaps',
          target: `property \`${siteUrl}\``,
          discoveryTool: 'searchConsoleListSites',
          err: toConnectorApiError(err),
        })
      }
    },
  })

  return [listSites, query, inspectUrl, listSitemaps]
}
