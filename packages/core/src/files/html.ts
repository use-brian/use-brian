/**
 * HTML → Markdown extraction for uploaded files.
 *
 * An uploaded `.html` used to fall through `parseFileContent`'s generic
 * `text/*` branch, which returns the bytes verbatim. That put raw markup into
 * the model's context, into `file_segments`, and into Pipeline B's extraction
 * windows: on the reference upload (a 4.1 MB self-contained client report) the
 * "text" the brain indexed was 96% base64 image payload and 12 KB of CSS, the
 * segment cap truncated it mid-document, and extraction produced zero entities
 * and zero memories.
 *
 * Markdown is the right target because it is already the representation the
 * chunker was built for (`chunkFileText`: ATX headings build `headingPath`,
 * fenced blocks are atomic) and the one `.docx`/`.xlsx`/`.pptx` already emit.
 * A converted document therefore arrives with the same affordances as an
 * Office upload rather than as an undifferentiated wall.
 *
 * Three things make this more than "call turndown":
 *
 *  1. **Non-content elements are removed, not flattened.** Turndown keeps the
 *     text of any element it has no rule for, so `<style>`/`<script>` bodies
 *     leak into the output as prose. They are dropped explicitly.
 *  2. **Inline payloads are dropped from URLs.** A self-contained export
 *     inlines its images as `data:` URIs; turndown faithfully preserves them
 *     inside `![](…)`, which is how a 4.1 MB file stays 4.1 MB after
 *     conversion. Alt text is real content and is kept; the payload is not.
 *  3. **Shape guards with an honest fallback.** Turndown is superlinear in
 *     node count and recurses per element: ~40k tags costs ~2s and ~2,000
 *     levels of nesting overflows the stack after minutes of CPU. Both are
 *     reachable from a user upload, so pathological input degrades to a
 *     linear tag-strip (complete text, no structure) instead of pinning a
 *     request. Degrade, never throw: the caller's alternative is a failed
 *     ingest.
 *
 * Deliberately NOT Readability. On the reference report it bought 1% output
 * size and dropped the document's own headline, its date line, and two section
 * headings — its article heuristics prune document chrome that, in a file a
 * user chose to put in the brain, is content. Completeness wins here; the
 * article-extraction path stays where it belongs, on URL fetch
 * (`tools/base/fetch-readability.ts`).
 *
 * Spec: docs/architecture/engine/file-handling.md → "Parser matrix".
 * [COMP:files/html]
 */

import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

/**
 * Elements whose text is presentation or behavior, never reading content.
 * Turndown has no rule for these, and its default is to emit a node's text —
 * so leaving them in means shipping stylesheets and scripts as prose.
 *
 * `title`/`meta`/`link`/`base` are here because turndown parses its input as a
 * body fragment, which leaves head-only elements in the tree. The title is not
 * lost: it is re-attached as an H1 by `htmlToMarkdown`.
 */
const NON_CONTENT_TAGS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'embed',
  'title',
  'meta',
  'link',
  'base',
  'form',
  'input',
  'select',
  'textarea',
  'button',
]

/**
 * A URL longer than this is a payload, not a locator. Real links are far
 * shorter; `data:`/`blob:` are matched by scheme regardless of length.
 */
const MAX_URL_CHARS = 500

/**
 * `<` occurrences above which turndown's cost stops being worth it. Measured:
 * 20k → ~0.5s, 40k → ~2s, 80k → ~11s. The reference 4.1 MB report has 2,139.
 */
const MAX_HTML_TAGS = 40_000

/**
 * Element nesting above which turndown's per-element recursion risks
 * `Maximum call stack size exceeded`. Measured: 1,000 converts in ~60ms,
 * 2,000 overflows. Kept well under the observed cliff.
 */
const MAX_HTML_NESTING_DEPTH = 1_000

/** Elements that never open a nesting level. */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

export type HtmlExtractionMode = 'markdown' | 'stripped'

export type HtmlExtraction = {
  /** The extracted text. Markdown unless a shape guard forced `stripped`. */
  text: string
  /** Which path produced it — surfaced so callers can report degradation. */
  mode: HtmlExtractionMode
  /** Document `<title>`, when the source had one. */
  title?: string
}

/**
 * The only thing the rules below need off a turndown node. Declared
 * structurally because this package compiles without the DOM lib — turndown
 * runs on its own bundled parser here, not on a browser `HTMLElement`.
 */
type AttributedNode = { getAttribute(name: string): string | null }

function isPayloadUrl(url: string): boolean {
  if (!url) return true
  const scheme = url.slice(0, 5).toLowerCase()
  if (scheme === 'data:' || scheme === 'blob:') return true
  return url.length > MAX_URL_CHARS
}

/**
 * One converter per call rather than a module singleton: turndown accumulates
 * per-instance rule state, and this runs on user-supplied input.
 */
function buildConverter(): TurndownService {
  const converter = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  })
  converter.use(gfm)
  converter.remove(NON_CONTENT_TAGS)

  // Keep the alt text (content), drop the src when it is an inline payload.
  converter.addRule('imageWithoutInlinePayload', {
    filter: 'img',
    replacement: (_content, node) => {
      const el = node as unknown as AttributedNode
      const alt = (el.getAttribute('alt') ?? '').trim()
      const src = el.getAttribute('src') ?? ''
      if (isPayloadUrl(src)) return alt ? `![${alt}]` : ''
      return `![${alt}](${src})`
    },
  })

  // Same for links: the anchor text is content, a base64 href is not.
  converter.addRule('linkWithoutInlinePayload', {
    filter: (node) => node.nodeName === 'A' && node.getAttribute('href') !== null,
    replacement: (content, node) => {
      const href = (node as unknown as AttributedNode).getAttribute('href') ?? ''
      if (isPayloadUrl(href)) return content
      return content ? `[${content}](${href})` : ''
    },
  })

  return converter
}

/**
 * Single cheap pass over the source to decide whether turndown is safe to run.
 * Bails at the first breach, so pathological input costs a partial scan rather
 * than a full one. Not an HTML parser — an estimator, deliberately.
 */
function exceedsShapeLimits(html: string): boolean {
  let tags = 0
  let depth = 0
  const len = html.length

  for (let i = 0; i < len; i++) {
    if (html.charCodeAt(i) !== 60) continue // '<'
    tags += 1
    if (tags > MAX_HTML_TAGS) return true

    const next = html.charCodeAt(i + 1)
    if (next === 33 || next === 63) continue // <!-- … --> / <!doctype> / <?…?>

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
      depth = depth > 0 ? depth - 1 : 0
      continue
    }
    if (VOID_TAGS.has(tagName)) continue

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
    if (depth > MAX_HTML_NESTING_DEPTH) return true
  }

  return false
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  eacute: 'é',
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·',
  bull: '•',
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
}

/**
 * Linear tag-strip: the fallback for input turndown cannot afford. Loses
 * structure but keeps every word, which is the property that matters — the
 * alternative on this path is an ingest that fails or one that stores markup.
 * Headings survive as headings so `chunkFileText` still gets breadcrumbs.
 */
function stripHtmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|template|svg|head)[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<h([1-6])[^>]*>/gi, (_m, level: string) => `\n\n${'#'.repeat(Number(level))} `)
      .replace(/<\/h[1-6]\s*>/gi, '\n\n')
      .replace(/<br[^>]*>/gi, '\n')
      .replace(/<\/(p|div|li|tr|blockquote|section|article|td|th)\s*>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!match) return undefined
  return decodeEntities(match[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim() || undefined
}

function normalize(markdown: string): string {
  return markdown
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Convert an HTML document to Markdown for model context and brain indexing.
 *
 * Never throws: every failure path degrades to `mode: 'stripped'`. Returns an
 * empty `text` only when the source genuinely has no reading content — callers
 * decide whether that is a placeholder or a store-only outcome.
 */
export function htmlToMarkdown(html: string): HtmlExtraction {
  const title = extractTitle(html)

  const withTitle = (text: string, mode: HtmlExtractionMode): HtmlExtraction => {
    const body = normalize(text)
    if (!title) return { text: body, mode }
    // Don't restate a heading the document already leads with.
    const leadsWithTitle = body.startsWith(`# ${title}`)
    const text_ = leadsWithTitle || !body ? body || `# ${title}` : `# ${title}\n\n${body}`
    return { text: text_, mode, title }
  }

  if (exceedsShapeLimits(html)) {
    return withTitle(stripHtmlToText(html), 'stripped')
  }

  try {
    return withTitle(buildConverter().turndown(html), 'markdown')
  } catch {
    // Turndown parses and recurses over attacker-shaped input; a throw here is
    // a reason to degrade, never to fail the upload.
    return withTitle(stripHtmlToText(html), 'stripped')
  }
}

/**
 * Does this upload hold HTML? MIME first (what the browser declared), then
 * extension — a `.html` handed over as `text/plain` or `application/xhtml+xml`
 * is still HTML, and getting this wrong reinstates the raw-markup bug.
 */
export function isHtmlFile(mimeType: string, fileName: string): boolean {
  const mime = mimeType.toLowerCase()
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return true
  if (mime === 'text/htm') return true
  const name = fileName.toLowerCase()
  return name.endsWith('.html') || name.endsWith('.htm') || name.endsWith('.xhtml')
}
