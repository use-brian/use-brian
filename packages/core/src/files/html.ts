/**
 * HTML → Markdown for uploaded documents. [COMP:files/html]
 *
 * An `.html` upload used to fall into `parseFileContent`'s generic `text/`
 * branch and reach storage as **raw markup** — doctype, `<head>`, the whole
 * stylesheet — which is what then got chunked into `file_segments` and fed to
 * extraction. On a real 4.1 MB self-contained report that meant segment 0 was
 * `<!doctype html>…<style>` and segment 1 was pure CSS.
 *
 * The converter is deliberately **whole-body**, not Readability. Readability
 * (used by the *fetch* path in `tools/base/fetch-readability.ts`) throws away
 * whatever it scores as boilerplate, which is right for a page pulled off the
 * open web and wrong for a file a user chose to upload: dropping 60% of a
 * document as "chrome" is exactly the silent content loss the file-handling
 * spec forbids. Here the only things removed are elements that carry no
 * document content at all (script, style, and friends). Presentation is
 * discarded; prose, headings, lists, and tables are not.
 *
 * Zero new dependencies: `linkedom` and `turndown` are already direct
 * dependencies of this package (the fetch path and the `.docx` path
 * respectively).
 */

import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

/**
 * Elements that never carry document content. Stripped from the DOM before
 * conversion AND registered with turndown, so the raw-HTML fallback (which
 * skips the DOM entirely) is covered by the same list.
 */
const NON_CONTENT_TAGS = [
  'script',
  'style',
  'noscript',
  'template',
  'link',
  'meta',
  'base',
  'iframe',
  'object',
  'embed',
  'canvas',
  'svg',
  'head',
] as const

/**
 * Above this nesting depth `linkedom` (and turndown's own DOM) risk a
 * stack/memory blowup on adversarial input, so conversion degrades to a regex
 * tag-strip with a stated note instead. Shared with the fetch path.
 */
const HTML_MAX_NESTING_DEPTH = 3_000

export type HtmlToMarkdownResult = {
  markdown: string
  /** `<title>` when the document has a non-empty one. */
  title?: string
  /**
   * `dom` — parsed and converted normally.
   * `raw` — DOM parse failed; turndown ran on the markup directly.
   * `stripped` — markup was pathological; tags were removed textually.
   */
  mode: 'dom' | 'raw' | 'stripped'
}

// ── Lazy dep loader ───────────────────────────────────────────────
// linkedom is only needed when an HTML document actually arrives; every other
// parser branch pays nothing for it.

let parseHTMLPromise: Promise<typeof import('linkedom').parseHTML> | undefined

async function loadParseHTML() {
  if (!parseHTMLPromise) {
    parseHTMLPromise = import('linkedom').then((m) => m.parseHTML)
  }
  try {
    return await parseHTMLPromise
  } catch (err) {
    parseHTMLPromise = undefined
    throw err
  }
}

// ── Turndown ──────────────────────────────────────────────────────

function createConverter(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  })
  td.use(gfm)
  td.remove([...NON_CONTENT_TAGS])

  // An image's `src` is worthless to the brain and can be catastrophic: a
  // self-contained report inlines its charts as `data:image/png;base64,…`,
  // and turndown's default rule would copy every one of those megabytes into
  // the Markdown — reintroducing the exact bloat this converter exists to
  // remove. Keep the alt text (it describes the figure) and keep an ordinary
  // URL (it is provenance); drop data URIs.
  td.addRule('imageWithoutDataUri', {
    filter: 'img',
    replacement: (_content, node) => {
      const el = node as unknown as { getAttribute(name: string): string | null }
      const alt = (el.getAttribute('alt') ?? '').trim()
      const src = (el.getAttribute('src') ?? '').trim()
      if (!alt && !src) return ''
      if (!src || src.startsWith('data:')) return alt ? `![${alt}]` : ''
      return `![${alt}](${src})`
    },
  })

  // Same reasoning for anchors: a `data:` href is payload, not a link.
  td.addRule('anchorWithoutDataUri', {
    filter: (node) =>
      node.nodeName === 'A' &&
      (node.getAttribute('href') ?? '').trim().startsWith('data:'),
    replacement: (content) => content,
  })

  return td
}

let converter: TurndownService | undefined

function getConverter(): TurndownService {
  if (!converter) converter = createConverter()
  return converter
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Convert an HTML document to Markdown. Never throws: every failure mode
 * degrades to a coarser conversion and reports which one it used via `mode`.
 */
export async function htmlToMarkdown(html: string): Promise<HtmlToMarkdownResult> {
  if (exceedsEstimatedHtmlNestingDepth(html, HTML_MAX_NESTING_DEPTH)) {
    return { markdown: stripTagsTextually(html), mode: 'stripped' }
  }

  let title: string | undefined
  let bodyHtml: string | undefined

  try {
    const parseHTML = await loadParseHTML()
    const { document } = parseHTML(ensureDocumentShape(html))

    const rawTitle = document.querySelector('title')?.textContent ?? ''
    title = normalizeWhitespace(rawTitle) || undefined

    for (const tag of NON_CONTENT_TAGS) {
      const matches = Array.from(document.querySelectorAll(tag)) as { remove(): void }[]
      for (const el of matches) el.remove()
    }

    const body = document.body?.innerHTML ?? ''
    // `documentElement` is the safety net for markup that lands content
    // outside <body> despite the wrapper above.
    bodyHtml = body || document.documentElement?.innerHTML || undefined
  } catch {
    // Fall through to the raw conversion below.
  }

  if (bodyHtml !== undefined) {
    try {
      return { markdown: tidy(getConverter().turndown(bodyHtml)), title, mode: 'dom' }
    } catch {
      // Fall through.
    }
  }

  try {
    return { markdown: tidy(getConverter().turndown(html)), title, mode: 'raw' }
  } catch {
    return { markdown: stripTagsTextually(html), title, mode: 'stripped' }
  }
}

// ── Guards and helpers ────────────────────────────────────────────

/**
 * `linkedom` is a literal parser, not an HTML5 tree builder: it does not infer
 * the `<html>`/`<body>` a browser would. Handed a fragment it produces an
 * *empty* `document.body` with the content stranded beside it — which reads
 * downstream as "this file had no text". Uploads are full of fragments (an
 * email part, an exported snippet, a saved partial), so the shape is
 * normalised before parsing rather than discovered after.
 */
function ensureDocumentShape(html: string): string {
  if (/<html[\s>]/i.test(html)) return html
  if (/<body[\s>]/i.test(html)) return `<html>${html}</html>`
  return `<html><body>${html}</body></html>`
}

/**
 * Cheap heuristic to skip DOM parsing on pathological HTML (deep nesting
 * causes stack/memory blowups). Not an HTML parser — tuned to catch
 * attacker-controlled "<div><div>..." cases.
 */
export function exceedsEstimatedHtmlNestingDepth(html: string, maxDepth: number): boolean {
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

/**
 * Last-resort conversion for markup no DOM should be handed. Removes the
 * non-content elements *with their contents* first — otherwise a stylesheet
 * survives as text, which is the original bug in a different costume.
 */
function stripTagsTextually(html: string): string {
  let out = html
  for (const tag of NON_CONTENT_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi'), ' ')
    out = out.replace(new RegExp(`<${tag}\\b[^>]*/?>`, 'gi'), ' ')
  }
  out = out.replace(/<!--[\s\S]*?-->/g, ' ')
  // Block-level tags become newlines so paragraphs do not run together.
  out = out.replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)\s*>/gi, '\n')
  out = out.replace(/<br\b[^>]*\/?>/gi, '\n')
  out = out.replace(/<[^>]+>/g, ' ')
  return tidy(decodeBasicEntities(out))
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function tidy(markdown: string): string {
  return markdown
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
