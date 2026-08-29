/**
 * HTML → Markdown extraction for file ingest.
 *
 * [COMP:files/html-extract]
 *
 * WHY THIS EXISTS. `parseFileContent` used to route `text/html` through its
 * generic `text/*` branch, which returns `buffer.toString('utf-8')` — the raw
 * markup. Everything downstream then treated stylesheets and script bodies as
 * knowledge: on 2026-08-05 a 4.1 MB HTML report ingested into a workspace brain
 * as 2,000 segments whose first two entries were `<!doctype html><html lang=…>`
 * and a block of CSS custom properties. The segment cap truncated it at 2.95 M
 * of 4.15 M chars, extraction windows repeatedly failed to parse, and the run
 * wrote zero entities, zero memories and zero tasks. The document was
 * unreadable to the model for the same reason it is unreadable to a person:
 * almost none of those bytes were the document.
 *
 * WHY NOT READABILITY. `tools/base/fetch-readability.ts` runs Mozilla
 * Readability over fetched pages, and it is right there — but it is right for a
 * *web page*, where the job is separating an article from navigation, ads and
 * boilerplate. A file a user hands to their brain is a document: an export, a
 * report, a saved dashboard. Readability's whole method is discarding content it
 * scores as peripheral, which on a multi-section report silently drops sections.
 * Ingest wants every word the document actually says, minus the machinery that
 * renders it. So: keep all text, drop only what is unambiguously presentation.
 *
 * Markdown rather than plain text, for the same reason `parseDocxToMarkdown`
 * chose it — headings, lists and tables survive at a fraction of the tokens of
 * raw HTML, and the structure is what makes a long document extractable.
 */

import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

import { stripDataUris } from './data-uri.js'

/**
 * Elements removed outright (tag AND contents). Turndown's default for an
 * element it has no rule for is to emit its *text content* — which is why the
 * incident indexed CSS: `<style>` is an unrecognized element whose text content
 * is a stylesheet. This list is the authoritative filter; the regex pre-pass
 * below is only a size optimization.
 */
const DROPPED_ELEMENTS = [
  // `head` and `title` are dropped as a pair with the lift below: their text is
  // hoisted to the top of the output deliberately, and leaving the elements in
  // place makes Turndown emit the title a second time as a bare line.
  'head',
  'title',
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'embed',
  'map',
  'audio',
  'video',
  'source',
  'track',
  'link',
  'meta',
  'base',
  // Form chrome. A saved dashboard or an exported report carries filter widgets
  // whose labels ("Submit", "All regions") are interface, not document — and a
  // `<button>`'s text is emitted like any other unrecognized element's.
  'form',
  'input',
  'select',
  'textarea',
  'button',
]

/**
 * Above this many characters (after the pre-pass) the DOM path is skipped for a
 * flat tag strip. A DOM is roughly an order of magnitude larger than its source
 * in memory, and the ingest worker shares a 524 MB heap with everything else on
 * `brian-api-workers`. Markdown structure is worth a lot; an OOM is worth less.
 *
 * This bounds MEMORY only. See `MAX_ELEMENT_DEPTH` / `MAX_TAGS` below for the
 * CPU bound, which a character count cannot express.
 */
const DOM_MAX_CHARS = 8_000_000

/**
 * `DOM_MAX_CHARS` is a *heap* guard, and character count is a poor proxy for
 * what Turndown actually costs: it recurses once per element and its running
 * time grows superlinearly with node count, so a document can sit far under
 * that ceiling and still be ruinous. Measured on the reference machine:
 *
 *   50,000 levels of nesting  →    250 KB input, **273 s** then a stack overflow
 *   80,000 flat elements      →    1.4 MB input, 21 s
 *   40,000 flat elements      →    720 KB input, 11 s
 *   20,000 flat elements      →    360 KB input, 2 s
 *   the 4.1 MB reference report →  2,139 tags,  ~110 ms
 *
 * Every one of those passes the 8 MB test. The `try/catch` below does return
 * text in the overflow case, but only after the worker has blocked for minutes
 * — and the flat-element case never throws at all, it is just slow. These two
 * limits are the CPU guard the char ceiling cannot be. The scan that enforces
 * them is a single pass with an early exit: ~15 ms on a 3 MB document, and it
 * bails the moment either limit is breached.
 *
 * Both degrade to `flattenToText`, which keeps every word and drops only
 * structure — the documented rule is that a ceiling may shape what reaches the
 * model, never what reaches storage.
 */
const MAX_ELEMENT_DEPTH = 1_000
const MAX_TAGS = 40_000

/** Elements that never open a nesting level. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/**
 * Estimate whether this document is too deep or too node-dense to hand to
 * Turndown. Deliberately an estimator, not a parser: it reads tag names off the
 * raw string and never builds anything, which is the entire point of running it
 * before the DOM exists.
 */
function exceedsShapeLimits(html: string): boolean {
  let tags = 0
  let depth = 0
  const len = html.length

  for (let i = 0; i < len; i++) {
    if (html.charCodeAt(i) !== 60) continue // '<'
    tags += 1
    if (tags > MAX_TAGS) return true

    const next = html.charCodeAt(i + 1)
    if (next === 33 || next === 63) continue // <!doctype>, <!-- -->, <?…?>

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
        (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 58 || c === 45
      if (!isNameChar) break
      j += 1
    }
    const tagName = html.slice(nameStart, j).toLowerCase()
    if (!tagName) continue

    if (closing) {
      depth = depth > 0 ? depth - 1 : 0
      continue
    }
    if (VOID_ELEMENTS.has(tagName)) continue

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
    if (depth > MAX_ELEMENT_DEPTH) return true
  }

  return false
}

let converter: TurndownService | undefined

function getConverter(): TurndownService {
  if (!converter) {
    converter = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    })
    converter.use(gfm)
    converter.remove(DROPPED_ELEMENTS)
  }
  return converter
}

/**
 * Decode a short HTML fragment to plain text. Runs it back through Turndown so
 * entity handling is the DOM's, not a hand-rolled table — `&mdash;` and friends
 * are otherwise left as literal `&mdash;` in the brain. Always cheap: the
 * inputs here are a title and a meta description, never a document.
 */
function fragmentToText(fragment: string): string {
  try {
    return getConverter().turndown(fragment).replace(/\s+/g, ' ').trim()
  } catch {
    return fragment.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  }
}

/** Contents of the first matching tag, tags stripped. */
function firstTagText(html: string, tag: string): string | null {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(html)
  if (!match?.[1]) return null
  return fragmentToText(match[1]) || null
}

/** `<meta name="description" content="…">`, in either attribute order. */
function metaDescription(html: string): string | null {
  const head = html.slice(0, 200_000)
  const match =
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(head) ??
    /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(head)
  return match?.[1] ? fragmentToText(match[1]) || null : null
}

/**
 * Strip the parts of a document that carry no text a reader would read. Purely
 * a size reduction ahead of the DOM parse — on the incident's 4.1 MB report the
 * inline stylesheet alone was the majority of the file. Correctness does not
 * depend on this pass: `DROPPED_ELEMENTS` runs again inside Turndown.
 */
function stripNonContent(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, '')
  // `head` first — one match usually takes the stylesheet with it. Documents
  // that omit the tag (or never close it) simply fall through to the per-tag
  // passes, and Turndown's own filter is the backstop either way.
  for (const tag of ['head', 'script', 'style', 'noscript', 'template', 'svg', 'canvas']) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi'), '')
  }
  // Inline base64 payloads, keeping the MIME as the surviving `src`. A saved
  // page embeds its screenshots this way, and Turndown faithfully copies the
  // whole payload into `![alt](…)`: on the incident's report, 43 inline JPEGs
  // were 2.82 M of the 2.87 M characters that came out — 98% of the "document"
  // was image bytes. The alt text is the part that carries meaning, and it
  // survives; the bytes are not knowledge and are never worth a segment.
  //
  // Kept here as a size reduction ahead of the DOM parse, not as the guard:
  // the guard is ./data-uri.ts, called from the boundaries every format
  // crosses (see that module for why HTML-only was not enough).
  out = stripDataUris(out)
  return out
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
    const key = name.toLowerCase()
    if (ENTITIES[key] !== undefined) return ENTITIES[key]
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return whole
  })
}

/** Degraded path for documents too large to hand a DOM: flat tag strip. */
function flattenToText(html: string): string {
  return decodeEntities(
    stripNonContent(html)
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
}

function collapseBlankLines(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Convert an HTML document to Markdown for ingest.
 *
 * The `<title>` and `<meta name="description">` are lifted to the top because
 * they are frequently the only place a saved page states what it is (the head
 * itself is dropped), and a leading H1 gives the extraction windows an anchor.
 * Never throws: a document that cannot be converted degrades to flattened text,
 * because the alternative — an empty parse — reads downstream as an empty file.
 */
export function parseHtmlToMarkdown(html: string): string {
  const title = firstTagText(html, 'title')
  const description = metaDescription(html)
  const stripped = stripNonContent(html)

  let body: string
  if (stripped.length > DOM_MAX_CHARS || exceedsShapeLimits(stripped)) {
    body = collapseBlankLines(flattenToText(stripped))
  } else {
    try {
      body = collapseBlankLines(getConverter().turndown(stripped))
    } catch {
      // Malformed markup, or a DOM the converter refused. Text still beats none.
      body = collapseBlankLines(flattenToText(stripped))
    }
  }

  const header: string[] = []
  // Skip the title when the body already opens with it — a well-formed document
  // usually repeats it as its first heading, and a duplicate reads as two.
  if (title && !new RegExp(`^#{1,6}\\s*${escapeRegExp(title)}\\s*$`, 'im').test(body.slice(0, 500))) {
    header.push(`# ${title}`)
  }
  if (description) header.push(description)

  return collapseBlankLines([...header, body].filter(Boolean).join('\n\n'))
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** True for the MIME types / extensions `parseHtmlToMarkdown` should handle. */
export function isHtmlFile(mimeType: string, fileName: string): boolean {
  const mime = mimeType.toLowerCase()
  if (mime.startsWith('text/html') || mime.startsWith('application/xhtml')) return true
  return /\.x?html?$/i.test(fileName)
}
