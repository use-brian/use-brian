# Web search filters

`webSearch` remains a directly registered tool. MCP discovery/indexing is outside
this change. Existing single-query, exact-provider panel, measurement and billing
behavior remains compatible for calls without filters.

## Input contract

New optional fields use provider-neutral names:

- `dateRange: { from?: string, to?: string }`: real YYYY-MM-DD dates, at least
  one bound, ordered, inclusive in the provider's documented date convention.
  Brave, Google-backed providers and Baidu require both bounds. Tavily accepts
  open bounds. Never widen a custom range into a relative freshness preset.
- `country`: ISO alpha-2 country code, normalized to uppercase. This localizes
  search, not a strict exclusion of content from other countries.
- `language`: canonical language tag, checked against the selected adapter's
  language mapping. It sets the provider's language preference, not a universal
  guarantee that every result is in that language.
- `location`: a locality string for Google-backed providers or a single city
  name for Baidu standard edition. Brave and Tavily do not support this field.
- `includeDomains` / `excludeDomains`: one to twenty DNS hostnames, normalized
  to lowercase ASCII; a domain includes its subdomains. URLs, IP addresses,
  ports, wildcards and public suffixes are rejected. Exclusions take precedence
  on subdomains, but an inclusion entirely covered by an exclusion is invalid.
  Only Tavily and Baidu currently use verified structured domain filters.
- `safeSearch`: `off`, `moderate`, `strict`. Brave supports all levels;
  SerpAPI, Tavily and Baidu support off/strict. Serper's safe-search mapping and
  filtered DuckDuckGo HTML requests remain unsupported until verified.

`queries` panels apply the same filters to every query. `trackDomains` remains a
ranking measurement input and is independent of domain restrictions. Unknown
filter names are rejected; vendor-specific keys are not part of the public API.

## Mapping and capability contract

`packages/core/src/tools/base/search-filters.ts` owns canonical validation,
provider capabilities, value mappings and filter provenance. Every adapter
validates/compiles options before acquiring credentials or making a request.
Unsupported fields, values and combinations produce an actionable filter error.

| Provider | Date | Country/language | Location | Domains | Safe search |
| --- | --- | --- | --- | --- | --- |
| Brave | `freshness=FROMtoTO` | documented `country` / `search_lang` enums | unsupported | unsupported | off/moderate/strict |
| Serper | Google `tbs` custom range | Google `gl` / `hl` | `location` | unsupported | unsupported |
| SerpAPI | Google `tbs` custom range | Google `gl` / `hl` | `location` | unsupported | off/active |
| Tavily | `start_date` / `end_date` with `filter_by_published_date=true` | country-name bias / language preference | unsupported | native include/exclude | false/true |
| Baidu standard | `search_filter.range.page_time` | unsupported | `range.geo.city` | `match.site` / `block_websites` | false/true |
| DuckDuckGo HTML | unsupported | unsupported | unsupported | unsupported | unsupported |

Country/language tables retain verified provider values rather than silently
falling back to a base language or another country. Google country GB maps to
`uk`. Canonical Chinese tags map to Brave's simplified/traditional language
codes. Unsupported locale variants fail explicitly. Provider docs are linked
from the implementation plan; enum snapshots must be updated with fixtures when
provider support changes.

Dates use each search index's date metadata; they do not independently prove a
page's publication date. Tavily's strict published-date option removes sources
with unknown dates. Other engines may use discovered/updated dates. Country is
localization for Brave/Google and a general-topic ranking bias for Tavily.

Domain results are checked again locally against normalized hostnames to uphold
allow/block restrictions even if a provider returns a violating URL. Fewer
results may remain; do not claim completeness or silently refill with unrestricted
results. Baidu has a shorter query limit; its existing query behavior is unchanged.

## Execution and fallback

Add a fourth, optional filter argument after the existing abort signal in the
provider/stack interfaces so existing callers keep working. Normal search keeps
provider priority among those capable of honoring every requested filter.
Capability exclusions are separate from provider failures and genuine empties.
Exact-provider calls reject incompatible options before network I/O and never
fall back. A credential pool alone is not proof that a provider has credentials;
a missing lease is an explicit provider failure, not a trustworthy empty result.

Filtered successful/empty responses include requested/applied canonical filters,
winning or empty-result provider identity and date/localization semantics.
Errors also retain filter context. Exact-provider panels report common filter
metadata once at the top level, including applied filters only when at least one
query completed successfully or returned a trustworthy empty. Row statuses show
which queries completed; measurement rows stay compact. Unfiltered response
shapes stay unchanged.
Preserve timeout/cancellation, retries, ordered panel results, domain-rank
measurements, sanitization and flat-cost accounting. No compatible provider is
an unsupported-filter error, not an outage or evidence of no matches.

The existing Zod object refinements remain runtime validation. The direct
model-visible schema converter must unwrap top-level effects so the full tool
and nested date range fields remain visible; model-hidden fields stay hidden.
Keep model-visible descriptions concise: field hints own filter formats and
provider capabilities, while the tool description owns execution and citation
guidance. Avoid repeating parameter lists and capability prose on every turn;
the fresh-user prompt-token regression budget remains unchanged.

## Example

```json
{
  "query": "Hong Kong technology news",
  "dateRange": { "from": "2026-10-01", "to": "2026-10-24" },
  "country": "HK",
  "language": "zh-TW",
  "maxResults": 5
}
```

Omitting `provider` preserves normal priority among compatible configured
providers. To use domain restrictions, select Tavily/Baidu or omit the provider;
adding a country that neither supports with those restrictions fails explicitly.

## Verification

Mock provider HTTP requests to verify vendor mappings, absent-filter request
compatibility and no network access for unsupported inputs. Cover invalid/leap
calendar dates, open/inverted ranges, locale mapping, domain/subdomain conflicts,
unsafe hostname syntax, provider eligibility, filtered empty vs outage, missing
pool leases, exact-provider panels, cancellation/retries/accounting and direct
schema visibility. Run focused tests, package typechecks, full `pnpm test` and
`pnpm smoke`. Live authenticated provider enforcement is opt-in and distinct
from these deterministic contract tests.
