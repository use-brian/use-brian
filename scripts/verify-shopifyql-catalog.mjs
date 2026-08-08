#!/usr/bin/env node
/**
 * Verify the ShopifyQL field catalog against a live store.
 *
 * ShopifyQL has no introspection, so `packages/core/src/tools/base/shopify-analytics-catalog.ts`
 * is a hand-carried dictionary — and a hand-carried dictionary silently rots.
 * This script re-submits every name in it to the Admin API and reports any that
 * Shopify no longer accepts. Run it when SHOPIFY_API_VERSION rolls.
 *
 *   SHOPIFY_TEST_SHOP_DOMAIN=<shop>.myshopify.com \
 *   SHOPIFY_TEST_ACCESS_TOKEN=shpat_... \
 *   node scripts/verify-shopifyql-catalog.mjs
 *
 * Needs `read_reports`. Exits non-zero if any catalogued name is rejected.
 * Batches the whole schema into one query and drops whatever Shopify names as
 * invalid, so a clean run costs one request per schema rather than one per field.
 */
import { SHOPIFYQL_CATALOG } from '../packages/core/dist/tools/base/shopify-analytics-catalog.js'

const shop = process.env.SHOPIFY_TEST_SHOP_DOMAIN
const token = process.env.SHOPIFY_TEST_ACCESS_TOKEN
if (!shop || !token) {
  console.error('Set SHOPIFY_TEST_SHOP_DOMAIN and SHOPIFY_TEST_ACCESS_TOKEN (needs read_reports).')
  process.exit(2)
}
const VERSION = process.env.SHOPIFY_API_VERSION ?? '2026-04'

let calls = 0
async function ql(query) {
  calls++
  const r = await fetch(`https://${shop}/admin/api/${VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({
      query: 'query($q:String!){ shopifyqlQuery(query:$q){ parseErrors tableData{columns{name}} } }',
      variables: { q: query },
    }),
  })
  const j = await r.json()
  if (j.errors) return JSON.stringify(j.errors).slice(0, 200)
  return j.data?.shopifyqlQuery?.parseErrors?.[0] ?? null
}

const rejectedName = (e) => (e ?? '').match(/Column '([^']+)' not found/)?.[1]

/** Submit `names` as one query, dropping any Shopify rejects, until it parses. */
async function survivors(build, names) {
  let pool = [...names]
  const rejected = []
  for (let guard = 0; guard <= names.length && pool.length; guard++) {
    const err = await ql(build(pool))
    if (!err) return { rejected }
    const bad = rejectedName(err)
    const idx = bad ? pool.findIndex((n) => n === bad || n.endsWith(bad)) : -1
    if (idx >= 0) { rejected.push(pool[idx]); pool.splice(idx, 1); continue }
    if (pool.length === 1) { rejected.push(pool[0]); return { rejected } }
    const half = Math.ceil(pool.length / 2)
    const a = await survivors(build, pool.slice(0, half))
    const b = await survivors(build, pool.slice(half))
    return { rejected: [...rejected, ...a.rejected, ...b.rejected] }
  }
  return { rejected }
}

const chunk = (a, n) => (a.length <= n ? [a] : [a.slice(0, n), ...chunk(a.slice(n), n)])

let failed = false
for (const [schema, { metrics, dimensions }] of Object.entries(SHOPIFYQL_CATALOG)) {
  const m = await survivors((ns) => `FROM ${schema} SHOW ${ns.join(', ')} SINCE -30d UNTIL today`, metrics)
  const probe = metrics.find((n) => !m.rejected.includes(n))
  const dimRejected = []
  if (probe) {
    for (const part of chunk([...dimensions], 10)) {
      const d = await survivors(
        (ns) => `FROM ${schema} SHOW ${probe} GROUP BY ${ns.join(', ')} SINCE -30d UNTIL today`,
        part,
      )
      dimRejected.push(...d.rejected)
    }
  }
  const bad = [...m.rejected, ...dimRejected]
  if (bad.length) {
    failed = true
    console.error(`✗ ${schema}: Shopify rejected ${bad.length} catalogued name(s): ${bad.join(', ')}`)
  } else {
    console.log(`✓ ${schema}: ${metrics.length} metrics, ${dimensions.length} dimensions`)
  }
}
console.log(`\n${calls} API calls against ${VERSION}.`)
if (failed) {
  console.error('Catalog is stale — remove the rejected names and update the doc.')
  process.exit(1)
}
