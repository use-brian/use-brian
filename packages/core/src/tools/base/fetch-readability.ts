/**
 * Local Mozilla Readability extraction — primary fetch provider.
 *
 * Fetches the URL directly, parses the HTML with `linkedom` (10x faster and
 * half the memory of jsdom — matches OpenClaw's production choice in
 * openclaw/src/agents/tools/web-fetch-utils.ts), runs @mozilla/readability,
 * and returns the extracted article body + title.
 *
 * Handles ~80% of article/blog sites. No network hop beyond the target URL
 * itself — no privacy leak through a third party.
 *
 * Lazy-loaded deps: both libraries are imported dynamically on first use so
 * the cost is paid only when the tool actually runs. Matches OpenClaw's
 * `loadReadabilityDeps()` pattern.
 *
 * Cheap HTML nesting depth guard catches pathological "<div><div>..." input
 * before handing it to linkedom (which would OOM on attacker-controlled
 * deep nesting). Same heuristic as OpenClaw's
 * `exceedsEstimatedHtmlNestingDepth`.
 */

import type { FetchProvider, FetchResult } from './fetch-stack.js'
import { isXHost } from './fetch-xai.js'

const READABILITY_MAX_HTML_CHARS = 1_000_000
const READABILITY_MAX_NESTING_DEPTH = 3_000
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

// ── Lazy dep loader ───────────────────────────────────────────────

let readabilityDepsPromise:
  | Promise<{
      Readability: typeof import('@mozilla/readability').Readability
      parseHTML: typeof import('linkedom').parseHTML
    }>
  | undefined

async function loadReadabilityDeps() {
  if (!readabilityDepsPromise) {
    readabilityDepsPromise = Promise.all([
      import('@mozilla/readability'),
      import('linkedom'),
    ]).then(([readability, linkedom]) => ({
      Readability: readability.Readability,
      parseHTML: linkedom.parseHTML,
    }))
  }
  try {
    return await readabilityDepsPromise
  } catch (err) {
    readabilityDepsPromise = undefined
    throw err
  }
}

// ── Provider ──────────────────────────────────────────────────────

export const readabilityProvider: FetchProvider = {
  name: 'readability',

  // Always eligible — first in the stack. Readability itself will return
  // null on non-article content (login pages, search results, etc.) and the
  // stack will fall through.
  canHandle: (url) => {
    if (!url.startsWith('http://') && !url.startsWith('https://')) return false
    // x.com / twitter.com return a login wall that Readability would "successfully"
    // extract. Delegate those to fetch-xai.ts. See docs/architecture/integrations/xai.md.
    if (isXHost(url)) return false
    return true
  },

  async fetch(url, signal): Promise<FetchResult | null> {
    const res = await globalThis.fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal,
    })

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      // Non-HTML content — let a later provider handle it (fetch-raw will
      // just return the body for text/*).
      return null
    }

    const html = await res.text()

    if (html.length > READABILITY_MAX_HTML_CHARS) return null
    if (exceedsEstimatedHtmlNestingDepth(html, READABILITY_MAX_NESTING_DEPTH)) return null

    const { Readability, parseHTML } = await loadReadabilityDeps()

    try {
      const { document } = parseHTML(html)
      try {
        ;(document as { baseURI?: string }).baseURI = url
      } catch {
        // Best-effort base URI for relative links.
      }

      const reader = new Readability(document, { charThreshold: 0 })
      const parsed = reader.parse()

      if (!parsed?.textContent || parsed.textContent.trim().length === 0) {
        return null
      }

      const content = normalizeWhitespace(parsed.textContent)
      return {
        url,
        title: parsed.title || undefined,
        content,
        length: content.length,
        source: 'readability',
      }
    } catch {
      return null
    }
  },
}

// ── HTML nesting depth guard ──────────────────────────────────────

/**
 * Cheap heuristic to skip Readability+DOM parsing on pathological HTML
 * (deep nesting causes stack/memory blowups). Not an HTML parser — tuned
 * to catch attacker-controlled "<div><div>..." cases.
 *
 * Ported from openclaw/src/agents/tools/web-fetch-utils.ts.
 */
function exceedsEstimatedHtmlNestingDepth(html: string, maxDepth: number): boolean {
  const voidTags = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
  ])

  let depth = 0
  const len = html.length
  for (let i = 0; i < len; i++) {
    if (html.charCodeAt(i) !== 60) continue // '<'
    const next = html.charCodeAt(i + 1)
    if (next === 33 || next === 63) continue // <! ...> or <? ...>

    let j = i + 1
    let closing = false
    if (html.charCodeAt(j) === 47) {
      closing = true
      j += 1
    }
    while (j < len && html.charCodeAt(j) <= 32) j += 1

    const nameStart = j
    while (j < len) {
      const c = html.charCodeAt(j)
      const isNameChar =
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) ||
        (c >= 48 && c <= 57) ||
        c === 58 ||
        c === 45
      if (!isNameChar) break
      j += 1
    }
    const tagName = html.slice(nameStart, j).toLowerCase()
    if (!tagName) continue

    if (closing) {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (voidTags.has(tagName)) continue

    // Self-closing detection: scan a short window for "/>".
    let selfClosing = false
    for (let k = j; k < len && k < j + 200; k++) {
      const c = html.charCodeAt(k)
      if (c === 62) {
        if (html.charCodeAt(k - 1) === 47) selfClosing = true
        break
      }
    }
    if (selfClosing) continue

    depth += 1
    if (depth > maxDepth) return true
  }
  return false
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}
