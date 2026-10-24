import { describe, expect, it } from 'vitest'
import { compileSearchFilters, matchesSearchDomains, searchFiltersSchema, unsupportedSearchFilters, SEARCH_PROVIDER_NAMES } from '../base/search-filters.js'

const range = { from: '2026-10-01', to: '2026-10-24' }

describe('[COMP:tools/search-filters] Canonical input and capabilities', () => {
  it.each(['2026-02-29', '2024-02-30', '2026-04-31', '0000-01-01', '2026-1-01', '2026-10-01T00:00:00Z'])('rejects invalid date %s', (from) => {
    expect(searchFiltersSchema.safeParse({ dateRange: { from } }).success).toBe(false)
  })
  it('accepts leap days and same-day ranges', () => {
    expect(searchFiltersSchema.parse({ dateRange: { from: '2024-02-29', to: '2024-02-29' } }).dateRange?.from).toBe('2024-02-29')
  })
  it.each([{}, { from: range.to, to: range.from }])('rejects empty or inverted date range %j', (dateRange) => {
    expect(searchFiltersSchema.safeParse({ dateRange }).success).toBe(false)
  })
  it('normalizes countries, tags, Unicode domains, duplicates and trailing dots', () => {
    expect(searchFiltersSchema.parse({ country: ' hk ', language: 'ZH-tw', includeDomains: ['EXAMPLE.COM.', 'example.com', '例子.com'] })).toEqual({
      country: 'HK', language: 'zh-TW', includeDomains: ['example.com', 'xn--fsqu00a.com'],
    })
  })
  it.each(['https://example.com', 'example.com/path', '*.example.com', 'example.com:443', '127.0.0.1', '[::1]', 'com', 'co.uk', 'github.io', '-bad.com', 'a..com', 'example.com OR site:other.com', 'a%2eb.com'])('rejects non-hostname or unsafe domain %s', (domain) => {
    expect(searchFiltersSchema.safeParse({ includeDomains: [domain] }).success).toBe(false)
  })
  it('rejects empty lists, excessive lists, unknown fields and vendor parameter names', () => {
    for (const input of [{ includeDomains: [] }, { excludeDomains: Array(21).fill('example.com') }, { freshness: 'pw' }, { dateRange: { from: range.from, timeZone: 'UTC' } }]) {
      expect(searchFiltersSchema.safeParse(input).success).toBe(false)
    }
  })
  it('rejects entirely excluded inclusions; permits excluded children of included domains', () => {
    expect(searchFiltersSchema.safeParse({ includeDomains: ['news.example.com'], excludeDomains: ['example.com'] }).success).toBe(false)
    expect(searchFiltersSchema.safeParse({ includeDomains: ['example.com'], excludeDomains: ['ads.example.com'] }).success).toBe(true)
  })
  it.each(['brave', 'serper', 'serpapi', 'baidu'])('%s rejects open ranges without widening', (provider) => {
    expect(unsupportedSearchFilters(provider, { dateRange: { from: range.from } })).toEqual(['dateRange requires both from and to'])
    expect(unsupportedSearchFilters(provider, { dateRange: { to: range.to } })).toEqual(['dateRange requires both from and to'])
  })
  it('keeps unsupported locale variants explicit', () => {
    expect(unsupportedSearchFilters('brave', { language: 'en-US' })).toContain('language en-US is unsupported')
    expect(unsupportedSearchFilters('tavily', { country: 'HK' })).toContain('country HK is unsupported')
    expect(unsupportedSearchFilters('baidu', { country: 'CN' })).toContain('country CN is unsupported')
    expect(unsupportedSearchFilters('serpapi', { country: 'ZZ' })).toContain('country ZZ is unsupported')
  })
  it.each(SEARCH_PROVIDER_NAMES)('%s leaves requests without filters unchanged', (provider) => {
    expect(compileSearchFilters(provider)).toEqual({})
  })
  it('checks domain boundaries, subdomains, exclusions and deceptive hosts', () => {
    const restricted = { includeDomains: ['example.com'], excludeDomains: ['ads.example.com'] }
    for (const url of ['https://example.com/x', 'https://www.example.com/x', 'https://news.example.com./x']) expect(matchesSearchDomains(url, restricted)).toBe(true)
    for (const url of ['https://notexample.com', 'https://example.com.attacker.org', 'https://ads.example.com', 'https://a.ads.example.com', 'https://example.com@attacker.org', 'file://example.com/x', 'bad']) expect(matchesSearchDomains(url, restricted)).toBe(false)
  })
})
