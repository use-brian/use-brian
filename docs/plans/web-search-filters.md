# Provider-neutral web search filters

Implemented on `feat/web-search-filters`, based on develop commit
`472765ccb84ce36ffb6548fb71386c16590252c0` (2026-10-24).

The behavior specification is [Web search filters](../web-search-filters.md).

## Delivered scope

- Optional provider-neutral `dateRange`, `country`, `language`, `location`,
  `includeDomains`, `excludeDomains`, and `safeSearch` parameters.
- One capability/validation registry, documented locale snapshots and native
  parameter mappings for Brave, Serper, SerpAPI, Tavily and Baidu.
- Compatible-only automatic fallback and preflight errors for incompatible
  exact-provider requests. Unverified DuckDuckGo HTML filters remain unsupported.
- Native domain restrictions plus local hostname checks, including subdomain
  boundaries and conflicting-domain validation.
- Filter provenance, explicit localization/date semantics, errors distinguished
  from genuine empty results, and no false empties for absent pooled credentials.
- Existing exact-provider panels, measurement output, cancellation, retries and
  billing behavior retained; successful filtered empties remain attributable.
- Direct model-visible schema conversion unwraps object refinements without
  removing runtime validation or exposing model-hidden fields.

## Deferred by user request

`webSearch` remains a direct tool and is not added to `mcp_search`. There are no
MCP discovery parameters, hooks, index sources or injection changes in this work.
The capability registry can be reused if provider-aware discovery is requested
later. Unsupported or unverified vendor mappings are explicit capability errors,
not silent approximations.

## Verification

- Focused search/filter/schema suites: 107 passed, including 57 new filter
  contract tests. This includes the final compact panel metadata and provider
  request-rejection behavior.
- `pnpm --filter @use-brian/core build`: passed.
- `pnpm --filter @use-brian/core typecheck`: passed, including script checks.
- `pnpm smoke`: passed (`OK`).
- Full repository test attempts did not pass because of unchanged baseline
  failures: nine desktop signing tests could not find their temporary
  `calls.jsonl` fixture, and the OCR comparison-table test exceeded five seconds.
- The serial full core run had 6,809 passing tests, 20 skipped, and the one OCR
  timeout. That timeout also reproduced in isolation; its test and implementation
  (`providers/wrappers.ts`) are byte-for-byte identical to develop.
- The default-concurrency engineering-capture CLI timeout passed on isolated
  rerun and in the serial repository run (all 26 package tests passed).
- API build passed; 259 API test files passed with no observed failures before
  the remaining broad run was stopped after its known failures. Full API and
  app-web suite completion is not claimed.

Provider tests assert real adapter request shapes using mocked HTTP responses.
They do not claim authenticated live-provider enforcement was verified.

## CI follow-up

The initial PR run passed core tests, build/typecheck and the other API shards,
but API shard 3 failed the fresh-user prompt-token budget: 6,545 estimated tokens
against the existing 6,500 ceiling. Compact shared search guidance and field
hints retain the provider constraints, exact-provider/panel behavior and citation
instructions while removing repetition. The same unchanged nine token-cost
scenarios now pass; the fresh-user estimate is 6,295. These are the existing
benchmark estimates, not measured production tokenizer usage.

## Provider references checked

- Brave: https://api-dashboard.search.brave.com/api-reference/web/search/get
- Serper public demo: https://serper.dev/ (full playground requires sign-in).
- Serper adapter source: https://github.com/langchain-ai/langchain-community/blob/main/libs/community/langchain_community/utilities/google_serper.py
- SerpAPI parameters: https://serpapi.com/search-api
- Google custom dates: https://www.serpapi.com/blog/filtering-google-search-and-google-news-results/
- Country values: https://serpapi.com/google-countries
- Language values: https://serpapi.com/google-languages
- Tavily: https://docs.tavily.com/documentation/api-reference/endpoint/search
- Baidu: https://cloud.baidu.com/doc/qianfan/s/2mh4su4uy
- DuckDuckGo consumer settings (not proof of HTML endpoint support): https://duckduckgo.com/duckduckgo-help-pages/settings/params
