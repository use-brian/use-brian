import { describe, it, expect, vi } from 'vitest'
import {
  SEARCH_CONSOLE_DIMENSIONS,
  SEARCH_CONSOLE_TOOL_NAMES,
  createSearchConsoleTools,
  type SearchConsoleToolsApi,
} from '../base/gsc.js'
import type { ToolContext } from '../types.js'

const ctx = {
  userId: 'test-user',
  assistantId: 'test-assistant',
  sessionId: 'test-session',
  appId: 'test',
  channelType: 'web' as const,
  channelId: 'test-channel',
  abortSignal: new AbortController().signal,
} as unknown as ToolContext

/** Mirror of the api client's error class shape (no import: core stays free of the api package). */
class FakeGscError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
    public readonly providerMessage?: string,
  ) {
    super(message)
    this.name = 'SearchConsoleConnectorError'
  }
}

function mockApi(overrides?: Partial<SearchConsoleToolsApi>): SearchConsoleToolsApi {
  return {
    listSites: vi.fn().mockResolvedValue({ siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteRestrictedUser' }] }),
    query: vi.fn().mockResolvedValue({ rows: [] }),
    inspectUrl: vi.fn().mockResolvedValue({ inspectionResult: {} }),
    listSitemaps: vi.fn().mockResolvedValue({ sitemap: [] }),
    defaultSite: vi.fn().mockResolvedValue('sc-domain:example.com'),
    ...overrides,
  }
}

function tool(api: SearchConsoleToolsApi, name: string) {
  const t = createSearchConsoleTools(api).find((x) => x.name === name)
  if (!t) throw new Error(`missing tool ${name}`)
  return t
}

describe('[COMP:tools/gsc] Google Search Console tools', () => {
  it('registers exactly the four read-only tools', () => {
    const tools = createSearchConsoleTools(mockApi())
    expect(tools.map((t) => t.name)).toEqual([...SEARCH_CONSOLE_TOOL_NAMES])
    for (const t of tools) {
      expect(t.isReadOnly, t.name).toBe(true)
      expect(t.isConcurrencySafe, t.name).toBe(true)
    }
  })

  it('ships the dimension / operator / searchType vocabulary in the query description', () => {
    const q = tool(mockApi(), 'searchConsoleQuery')
    for (const d of SEARCH_CONSOLE_DIMENSIONS) expect(q.description).toContain(d)
    expect(q.description).toContain('includingRegex')
    expect(q.description).toContain('googleNews')
  })

  it('projects the property list', async () => {
    const result = await tool(mockApi(), 'searchConsoleListSites').execute({}, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.data).toEqual({ sites: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteRestrictedUser' }] })
  })

  it('falls back to the connect-time default property when siteUrl is omitted', async () => {
    const api = mockApi()
    await tool(api, 'searchConsoleListSitemaps').execute({}, ctx)
    expect(api.listSitemaps).toHaveBeenCalledWith('sc-domain:example.com')
    await tool(api, 'searchConsoleListSitemaps').execute({ siteUrl: 'https://example.com/' }, ctx)
    expect(api.listSitemaps).toHaveBeenLastCalledWith('https://example.com/')
  })

  it('with no siteUrl and no default, returns an actionable error naming searchConsoleListSites without calling the api', async () => {
    const api = mockApi({ defaultSite: vi.fn().mockResolvedValue(null) })
    const result = await tool(api, 'searchConsoleQuery').execute({ startDate: '2026-08-01', endDate: '2026-08-07' }, ctx)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('searchConsoleListSites')
    expect(String(result.data)).toContain('siteUrl')
    expect(api.query).not.toHaveBeenCalled()
  })

  it('composes the analytics body (defaults, filters, searchType) and projects rows + nextStartRow', async () => {
    const api = mockApi({
      query: vi.fn().mockResolvedValue({
        rows: [
          { keys: ['ai company brain'], clicks: 3, impressions: 120, ctr: 0.025, position: 8.4 },
          { keys: ['use brian'], clicks: 2, impressions: 40, ctr: 0.05, position: 3.1 },
        ],
        responseAggregationType: 'byProperty',
      }),
    })
    const result = await tool(api, 'searchConsoleQuery').execute({
      startDate: '2026-08-01', endDate: '2026-08-07', rowLimit: 2, startRow: 4,
      filters: [{ dimension: 'country', expression: 'HKG' }, { dimension: 'page', operator: 'contains', expression: '/pricing' }],
      searchType: 'web',
    }, ctx)
    expect(api.query).toHaveBeenCalledWith('sc-domain:example.com', {
      startDate: '2026-08-01',
      endDate: '2026-08-07',
      dimensions: ['query'],
      rowLimit: 2,
      startRow: 4,
      type: 'web',
      dimensionFilterGroups: [{ groupType: 'and', filters: [
        { dimension: 'country', operator: 'equals', expression: 'HKG' },
        { dimension: 'page', operator: 'contains', expression: '/pricing' },
      ] }],
    })
    expect(result.isError).toBeFalsy()
    expect(result.data).toEqual({
      siteUrl: 'sc-domain:example.com',
      startDate: '2026-08-01',
      endDate: '2026-08-07',
      dimensions: ['query'],
      rows: [
        { keys: ['ai company brain'], clicks: 3, impressions: 120, ctr: 0.025, position: 8.4 },
        { keys: ['use brian'], clicks: 2, impressions: 40, ctr: 0.05, position: 3.1 },
      ],
      rowCount: 2,
      nextStartRow: 6,
    })
    // Never raw provider JSON: the aggregation field is dropped.
    expect(JSON.stringify(result.data)).not.toContain('responseAggregationType')
  })

  it('reports nextStartRow null when the page is not full', async () => {
    const api = mockApi({ query: vi.fn().mockResolvedValue({ rows: [{ keys: ['x'], clicks: 1, impressions: 1, ctr: 1, position: 1 }] }) })
    const result = await tool(api, 'searchConsoleQuery').execute({ startDate: '2026-08-01', endDate: '2026-08-07', dimensions: ['page', 'date'] }, ctx)
    expect((result.data as { nextStartRow: unknown }).nextStartRow).toBeNull()
    expect((result.data as { dimensions: string[] }).dimensions).toEqual(['page', 'date'])
    const body = (api.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>
    expect(body.startRow).toBeUndefined()
    expect(body.dimensionFilterGroups).toBeUndefined()
  })

  it('preserves explicit empty dimensions for ungrouped property totals', async () => {
    const api = mockApi({
      query: vi.fn().mockResolvedValue({
        rows: [{ keys: [], clicks: 5, impressions: 100, ctr: 0.05, position: 4.2 }],
      }),
    })
    const result = await tool(api, 'searchConsoleQuery').execute({
      startDate: '2026-08-01',
      endDate: '2026-08-07',
      dimensions: [],
      rowLimit: 1,
    }, ctx)

    expect(api.query).toHaveBeenCalledWith('sc-domain:example.com', {
      startDate: '2026-08-01',
      endDate: '2026-08-07',
      dimensions: [],
      rowLimit: 1,
      type: 'web',
    })
    expect(result.data).toMatchObject({
      dimensions: [],
      rows: [{ keys: [], clicks: 5, impressions: 100, ctr: 0.05, position: 4.2 }],
    })
  })

  it('rejects an unknown dimension at the schema', () => {
    const q = tool(mockApi(), 'searchConsoleQuery')
    const parsed = q.inputSchema.safeParse({ startDate: '2026-08-01', endDate: '2026-08-07', dimensions: ['keyword'] })
    expect(parsed.success).toBe(false)
    expect(q.inputSchema.safeParse({ startDate: '2026-8-1', endDate: '2026-08-07' }).success).toBe(false)
    expect(q.inputSchema.safeParse({ startDate: '2026-08-01', endDate: '2026-08-07', rowLimit: 5000 }).success).toBe(false)
  })

  it('renders a 400 rejection with Google\'s reason plus the valid vocabulary', async () => {
    const api = mockApi({
      query: vi.fn().mockRejectedValue(new FakeGscError('invalid_request', 'Search Console rejected the request', 400, 'Invalid dimension: keyword')),
    })
    const result = await tool(api, 'searchConsoleQuery').execute({ startDate: '2026-08-01', endDate: '2026-08-07' }, ctx)
    expect(result.isError).toBe(true)
    const text = String(result.data)
    expect(text).toContain('Invalid dimension: keyword')
    expect(text).toContain('Valid dimensions: query, page, country, device, date, searchAppearance')
    expect(text).toContain('(400')
  })

  it('renders a dead key as an auth failure the health classifier can flip on', async () => {
    const api = mockApi({
      listSites: vi.fn().mockRejectedValue(new FakeGscError('invalid_credentials', 'Google rejected the service-account key (401)', 401, 'invalid_grant: Invalid JWT Signature.')),
    })
    const result = await tool(api, 'searchConsoleListSites').execute({}, ctx)
    expect(result.isError).toBe(true)
    const text = String(result.data)
    expect(text).toContain('(401)')
    expect(text).toMatch(/invalid or expired/)
    expect(text).toContain('Studio → Connectors')
  })

  it('renders a 403 as a per-property permission, naming the property', async () => {
    const api = mockApi({
      listSitemaps: vi.fn().mockRejectedValue(new FakeGscError('forbidden', 'no access', 403, 'User does not have sufficient permission for site')),
    })
    const result = await tool(api, 'searchConsoleListSitemaps').execute({ siteUrl: 'https://other.example/' }, ctx)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('https://other.example/')
    expect(String(result.data)).toContain('not accessible')
  })

  it('projects a URL inspection down to the documented fields', async () => {
    const api = mockApi({
      inspectUrl: vi.fn().mockResolvedValue({
        inspectionResult: {
          inspectionResultLink: 'https://search.google.com/search-console/inspect?resource_id=x',
          indexStatusResult: {
            verdict: 'PASS',
            coverageState: 'Submitted and indexed',
            robotsTxtState: 'ALLOWED',
            indexingState: 'INDEXING_ALLOWED',
            lastCrawlTime: '2026-08-15T02:11:00Z',
            pageFetchState: 'SUCCESSFUL',
            googleCanonical: 'https://example.com/pricing',
            userCanonical: 'https://example.com/pricing',
            sitemap: ['https://example.com/sitemap.xml'],
            referringUrls: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
            crawledAs: 'MOBILE',
          },
          mobileUsabilityResult: { verdict: 'VERDICT_UNSPECIFIED' },
          richResultsResult: { verdict: 'PASS', detectedItems: [{ richResultType: 'Breadcrumbs' }] },
        },
      }),
    })
    const result = await tool(api, 'searchConsoleInspectUrl').execute({ url: 'https://example.com/pricing' }, ctx)
    expect(api.inspectUrl).toHaveBeenCalledWith('sc-domain:example.com', 'https://example.com/pricing', undefined)
    expect(result.data).toEqual({
      url: 'https://example.com/pricing',
      verdict: 'PASS',
      coverageState: 'Submitted and indexed',
      indexingState: 'INDEXING_ALLOWED',
      robotsTxtState: 'ALLOWED',
      pageFetchState: 'SUCCESSFUL',
      lastCrawlTime: '2026-08-15T02:11:00Z',
      crawledAs: 'MOBILE',
      googleCanonical: 'https://example.com/pricing',
      userCanonical: 'https://example.com/pricing',
      sitemaps: ['https://example.com/sitemap.xml'],
      referringUrls: ['a', 'b', 'c', 'd', 'e'],
      mobileUsabilityVerdict: 'VERDICT_UNSPECIFIED',
      richResultsVerdict: 'PASS',
    })
  })

  it('projects sitemaps, coercing Google\'s int64 strings', async () => {
    const api = mockApi({
      listSitemaps: vi.fn().mockResolvedValue({ sitemap: [{
        path: 'https://example.com/sitemap.xml', type: 'sitemap', lastSubmitted: '2026-08-01T00:00:00Z',
        lastDownloaded: '2026-08-14T00:00:00Z', isPending: false, isSitemapsIndex: false, warnings: '2', errors: '0',
        contents: [{ type: 'web', submitted: '120', indexed: '0' }],
      }] }),
    })
    const result = await tool(api, 'searchConsoleListSitemaps').execute({}, ctx)
    expect(result.data).toEqual({
      siteUrl: 'sc-domain:example.com',
      sitemaps: [{
        path: 'https://example.com/sitemap.xml', type: 'sitemap', lastSubmitted: '2026-08-01T00:00:00Z',
        lastDownloaded: '2026-08-14T00:00:00Z', isPending: false, isSitemapsIndex: false, warnings: 2, errors: 0,
      }],
    })
  })
})
