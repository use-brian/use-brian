/** Provider-neutral filters. Spec: docs/web-search-filters.md. */
import { z } from 'zod'
import { parse as parseDomain } from 'tldts'
import { BRAVE_COUNTRIES, BRAVE_LANGUAGES, GOOGLE_COUNTRIES, GOOGLE_LANGUAGES, TAVILY_COUNTRIES } from './search-filter-locales.js'

export const SEARCH_PROVIDER_NAMES = ['brave', 'serper', 'serpapi', 'tavily', 'baidu', 'duckduckgo'] as const
export type SearchProviderName = (typeof SEARCH_PROVIDER_NAMES)[number]

function canonicalLanguage(value: string): string | undefined {
  try { return Intl.getCanonicalLocales(value)[0] } catch { return undefined }
}
function languageMap(codes: readonly string[]): Readonly<Record<string, string>> {
  const values: Record<string, string> = {}
  for (const code of codes) {
    const canonical = canonicalLanguage(code)
    if (canonical) values[canonical] = code
  }
  return values
}
const braveLanguages = { ...languageMap(BRAVE_LANGUAGES), 'zh-CN': 'zh-hans', 'zh-TW': 'zh-hant' }
const googleLanguages = languageMap(GOOGLE_LANGUAGES)
const googleCountries: Readonly<Record<string, string>> = {
  ...Object.fromEntries(GOOGLE_COUNTRIES.map((code) => [code === 'uk' ? 'GB' : code.toUpperCase(), code])),
  GB: 'uk',
}
const braveCountries: Readonly<Record<string, string>> = Object.fromEntries(BRAVE_COUNTRIES.map((code) => [code, code]))

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}
function normalizeFilterDomain(value: string): string | undefined {
  const trimmed = value.trim().replace(/\.$/, '').toLowerCase()
  // Require hostnames, not URL syntax, credentials, ports, globbing or operators.
  if (!trimmed || /[\s/:@?#*\\%]/.test(trimmed)) return undefined
  try {
    const hostname = new URL(`https://${trimmed}`).hostname
    const parsed = parseDomain(hostname, { allowPrivateDomains: true })
    if (parsed.isIp || !parsed.domain || !parsed.isIcann && !parsed.isPrivate) return undefined
    if (hostname.length > 253 || hostname.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return undefined
    return hostname
  } catch { return undefined }
}
const domain = z.string().max(253).refine((value) => Boolean(normalizeFilterDomain(value)), 'Pass a DNS hostname (not a URL, IP, wildcard or public suffix).')
  .transform((value) => normalizeFilterDomain(value)!)
const domainList = z.array(domain).min(1).max(20).transform((values) => [...new Set(values)])
const date = z.string().refine(isCalendarDate, 'Pass a real calendar date in YYYY-MM-DD format.')
export const searchFilterShape = {
  dateRange: z.object({ from: date.optional(), to: date.optional() }).strict().superRefine((value, ctx) => {
    if (!value.from && !value.to) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide at least one date bound.' })
    if (value.from && value.to && value.from > value.to) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '`from` must be on or before `to`.' })
  }).optional().describe('YYYY-MM-DD bounds {from?, to?}; both required except Tavily. Index dates, not independently verified publication dates.'),
  country: z.string().trim().regex(/^[a-zA-Z]{2}$/, 'Use an ISO alpha-2 country code, e.g. HK or GB.').transform((value) => value.toUpperCase())
    .optional().describe('ISO alpha-2 country preference, e.g. HK. Localizes/ranks results, not a content restriction. No Baidu/DuckDuckGo.'),
  language: z.string().trim().min(2).max(35).refine((value) => Boolean(canonicalLanguage(value)), 'Pass a language tag, e.g. en or zh-TW.')
    .transform((value) => canonicalLanguage(value)!).optional().describe('Language preference, e.g. en or zh-TW; exact provider-supported tags only. No Baidu/DuckDuckGo.'),
  location: z.string().trim().min(1).max(200).optional().describe('Origin locality (Serper/SerpAPI) or one city (Baidu standard); unsupported elsewhere.'),
  includeDomains: domainList.optional().describe('Allow 1-20 DNS hostnames and subdomains (Tavily/Baidu only). Separate from trackDomains.'),
  excludeDomains: domainList.optional().describe('Block 1-20 DNS hostnames and subdomains (Tavily/Baidu only).'),
  safeSearch: z.enum(['off', 'moderate', 'strict']).optional().describe('Adult filtering: Brave all levels; SerpAPI/Tavily/Baidu off/strict; others unsupported.'),
}
export type SearchFilters = z.infer<ReturnType<typeof makeSearchFiltersSchema>>
function isWithinDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}
export function refineSearchFilters(filters: { includeDomains?: string[]; excludeDomains?: string[] }, ctx: z.RefinementCtx): void {
  for (const included of filters.includeDomains ?? []) {
    if (filters.excludeDomains?.some((excluded) => isWithinDomain(included, excluded))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['includeDomains'], message: `Included domain ${included} is entirely excluded.` })
    }
  }
}
function makeSearchFiltersSchema() { return z.object(searchFilterShape).strict().superRefine(refineSearchFilters) }
export const searchFiltersSchema = makeSearchFiltersSchema()
export function pickSearchFilters(input: SearchFilters): SearchFilters {
  return Object.fromEntries(Object.keys(searchFilterShape).filter((key) => input[key as keyof SearchFilters] !== undefined)
    .map((key) => [key, input[key as keyof SearchFilters]])) as SearchFilters
}
export function hasSearchFilters(filters: SearchFilters): boolean { return Object.keys(pickSearchFilters(filters)).length > 0 }

type Capabilities = {
  dateRange: 'closed' | 'open' | false
  countries: Readonly<Record<string, string>>
  languages: Readonly<Record<string, string>> | 'iso639'
  location: boolean
  domains: boolean
  safeSearch: readonly NonNullable<SearchFilters['safeSearch']>[]
  dateSemantics: string
}
const none: Capabilities = { dateRange: false, countries: {}, languages: {}, location: false, domains: false, safeSearch: [], dateSemantics: 'unsupported' }
const google: Capabilities = { ...none, dateRange: 'closed', countries: googleCountries, languages: googleLanguages, location: true, dateSemantics: 'Google index date; not independently verified publication date' }
export const SEARCH_FILTER_CAPABILITIES: Readonly<Record<SearchProviderName, Capabilities>> = {
  brave: { ...none, dateRange: 'closed', countries: braveCountries, languages: braveLanguages, safeSearch: ['off', 'moderate', 'strict'], dateSemantics: 'Brave discovered/updated index date; not independently verified publication date' },
  serper: google,
  serpapi: { ...google, safeSearch: ['off', 'strict'] },
  tavily: { ...none, dateRange: 'open', countries: TAVILY_COUNTRIES, languages: 'iso639', domains: true, safeSearch: ['off', 'strict'], dateSemantics: 'Tavily detected published date; undated results removed' },
  baidu: { ...none, dateRange: 'closed', location: true, domains: true, safeSearch: ['off', 'strict'], dateSemantics: 'Baidu page_time index publication date; not independently verified' },
  duckduckgo: none,
}
export class UnsupportedSearchFiltersError extends Error {
  constructor(readonly provider: string, readonly reasons: string[]) {
    super(`Provider ${provider} cannot honor the requested search filters: ${reasons.join('; ')}. Choose a compatible provider or explicitly revise the filters.`)
    this.name = 'UnsupportedSearchFiltersError'
  }
}
function tavilyLanguage(language: string): string | undefined {
  if (language === 'zh-CN') return 'zh-cn'
  if (!/^[a-z]{2}$/.test(language)) return undefined
  return new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' }).of(language) ? language : undefined
}
export function unsupportedSearchFilters(provider: string, filters: SearchFilters): string[] {
  if (!hasSearchFilters(filters)) return []
  const caps = SEARCH_PROVIDER_NAMES.includes(provider as SearchProviderName) ? SEARCH_FILTER_CAPABILITIES[provider as SearchProviderName] : undefined
  if (!caps) return ['filter capabilities are not declared']
  const reasons: string[] = []
  if (filters.dateRange) {
    if (!caps.dateRange) reasons.push('dateRange is unsupported')
    else if (caps.dateRange === 'closed' && (!filters.dateRange.from || !filters.dateRange.to)) reasons.push('dateRange requires both from and to')
  }
  if (filters.country && !caps.countries[filters.country]) reasons.push(`country ${filters.country} is unsupported`)
  if (filters.language && !(caps.languages === 'iso639' ? tavilyLanguage(filters.language) : caps.languages[filters.language])) reasons.push(`language ${filters.language} is unsupported`)
  if (filters.location && !caps.location) reasons.push('location is unsupported')
  if (filters.includeDomains && !caps.domains) reasons.push('includeDomains is unsupported')
  if (filters.excludeDomains && !caps.domains) reasons.push('excludeDomains is unsupported')
  if (filters.safeSearch && !caps.safeSearch.includes(filters.safeSearch)) reasons.push(`safeSearch ${filters.safeSearch} is unsupported`)
  return reasons
}

/** Compile validated canonical fields to vendor request fields, before credentials/I/O. */
export function compileSearchFilters(provider: SearchProviderName, input: SearchFilters = {}): Record<string, unknown> {
  const filters = searchFiltersSchema.parse(input)
  const reasons = unsupportedSearchFilters(provider, filters)
  if (reasons.length) throw new UnsupportedSearchFiltersError(provider, reasons)
  const params: Record<string, unknown> = {}
  const caps = SEARCH_FILTER_CAPABILITIES[provider]
  if (filters.country) params[provider === 'brave' || provider === 'tavily' ? 'country' : 'gl'] = caps.countries[filters.country]
  if (filters.language) params[provider === 'brave' ? 'search_lang' : provider === 'tavily' ? 'language' : 'hl'] = caps.languages === 'iso639' ? tavilyLanguage(filters.language) : caps.languages[filters.language]
  if (filters.location && provider !== 'baidu') params.location = filters.location
  if (filters.dateRange) {
    const { from, to } = filters.dateRange
    if (provider === 'brave') params.freshness = `${from}to${to}`
    else if (provider === 'serper' || provider === 'serpapi') {
      const googleDate = (value: string) => { const [year, month, day] = value.split('-'); return `${Number(month)}/${Number(day)}/${year}` }
      params.tbs = `cdr:1,cd_min:${googleDate(from!)},cd_max:${googleDate(to!)}`
    } else if (provider === 'tavily') {
      if (from) params.start_date = from
      if (to) params.end_date = to
      params.filter_by_published_date = true
    }
  }
  if (filters.safeSearch) {
    if (provider === 'brave') params.safesearch = filters.safeSearch
    else if (provider === 'serpapi') params.safe = filters.safeSearch === 'off' ? 'off' : 'active'
    else params.safe_search = filters.safeSearch === 'strict'
  }
  if (provider === 'tavily') {
    if (filters.includeDomains) { params.include_domains = filters.includeDomains; params.include_domains_mode = 'restrict' }
    if (filters.excludeDomains) params.exclude_domains = filters.excludeDomains
  }
  if (provider === 'baidu') {
    const range: Record<string, unknown> = {}
    if (filters.dateRange) range.page_time = { gte: filters.dateRange.from, lte: filters.dateRange.to }
    if (filters.location) range.geo = { city: [filters.location] }
    const filter: Record<string, unknown> = {}
    if (Object.keys(range).length) filter.range = range
    if (filters.includeDomains) filter.match = { site: filters.includeDomains }
    if (Object.keys(filter).length) params.search_filter = filter
    if (filters.excludeDomains) params.block_websites = filters.excludeDomains
  }
  return params
}
export function matchesSearchDomains(url: string, filters: SearchFilters): boolean {
  if (!filters.includeDomains && !filters.excludeDomains) return true
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '')
    return (!filters.includeDomains || filters.includeDomains.some((domain) => isWithinDomain(hostname, domain)))
      && !filters.excludeDomains?.some((domain) => isWithinDomain(hostname, domain))
  } catch { return false }
}
export function searchFilterProvenance(provider: SearchProviderName, filters: SearchFilters) {
  return {
    appliedFilters: filters,
    ...(filters.dateRange ? { dateSemantics: SEARCH_FILTER_CAPABILITIES[provider].dateSemantics } : {}),
    ...(filters.country || filters.location || filters.language ? { localizationSemantics: provider === 'tavily' ? 'Country/language ranking preference, not a geographic/content restriction.' : 'Provider search origin/language setting, not a geographic/content restriction.' } : {}),
  }
}
