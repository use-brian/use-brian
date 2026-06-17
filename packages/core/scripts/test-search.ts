/**
 * Quick manual test for the search→fetch pipeline.
 * Run: pnpm --filter @sidanclaw/core tsx scripts/test-search.ts
 */

import 'dotenv/config'
import { createSearchStack } from '../src/tools/base/search-stack.js'
import { braveProvider } from '../src/tools/base/search-brave.js'
import { serperProvider } from '../src/tools/base/search-serper.js'
import { tavilyProvider } from '../src/tools/base/search-tavily.js'
import { duckDuckGoProvider } from '../src/tools/base/search-ddg.js'
import { createFetchStack } from '../src/tools/base/fetch-stack.js'
import { readabilityProvider } from '../src/tools/base/fetch-readability.js'
import { jinaProvider } from '../src/tools/base/fetch-jina.js'
import { rawFetchProvider } from '../src/tools/base/fetch-raw.js'

const query = process.argv[2] || 'flight ticket Hong Kong to Taiwan April 2026'

// ── Show which providers are configured ──────────────────────────
console.log('=== Provider availability ===')
console.log(`  Brave:  ${braveProvider.available() ? '✓' : '✗'}`)
console.log(`  Serper: ${serperProvider.available() ? '✓' : '✗'}`)
console.log(`  Tavily: ${tavilyProvider.available() ? '✓' : '✗'}`)
console.log(`  DDG:    ${duckDuckGoProvider.available() ? '✓' : '✗'}`)
console.log(`  Jina:   ${process.env.JINA_API_KEY ? '✓ (keyed)' : '✓ (free tier)'}`)
console.log()

// ── Search ───────────────────────────────────────────────────────
const searchStack = createSearchStack([
  braveProvider, serperProvider, tavilyProvider, duckDuckGoProvider,
])

console.log(`=== Searching: "${query}" ===`)
const start = Date.now()
const { provider, results } = await searchStack(query, 5)
console.log(`  ${results.length} results in ${Date.now() - start}ms (provider: ${provider ?? 'none'})\n`)

for (const r of results) {
  console.log(`  ${r.title}`)
  console.log(`  ${r.url}`)
  console.log(`  ${r.snippet.slice(0, 120)}...`)
  console.log()
}

if (results.length === 0) {
  console.log('  No results — check your API keys.')
  process.exit(1)
}

// ── Fetch the top result ─────────────────────────────────────────
const fetchStack = createFetchStack({
  providers: [readabilityProvider, jinaProvider, rawFetchProvider],
  maxChars: 2000,
})

const topUrl = results[0].url
console.log(`=== Fetching: ${topUrl} ===`)
const fetchStart = Date.now()
try {
  const page = await fetchStack(topUrl)
  console.log(`  source: ${page.source}`)
  console.log(`  title:  ${page.title ?? '(none)'}`)
  console.log(`  length: ${page.length} chars in ${Date.now() - fetchStart}ms`)
  console.log()
  console.log(`  --- content preview (first 500 chars) ---`)
  console.log(page.content.slice(0, 500))
  console.log(`  ---`)
} catch (err) {
  console.log(`  Fetch failed: ${err instanceof Error ? err.message : err}`)
}
