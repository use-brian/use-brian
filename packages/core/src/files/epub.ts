/**
 * EPUB (.epub) → Markdown. [COMP:files/epub]
 *
 * An EPUB is a zip of XHTML in spine order, so this is almost entirely
 * plumbing on top of two things that already exist: JSZip (the `.pptx` /
 * OpenDocument reader) and `htmlToMarkdown` (`./html.ts`). Every chapter is a
 * document the HTML converter already knows how to strip and convert, which is
 * why this format costs one small file rather than a parser.
 *
 * Reading order comes from the package document's `<spine>`, never from
 * filename order — an EPUB's parts are routinely `part0034.xhtml` in an order
 * that has nothing to do with the reader's.
 */
import JSZip from 'jszip'
import { htmlToMarkdown } from './html.js'

/** Bound on chapters converted; beyond it the omission is stated, not hidden. */
const MAX_CHAPTERS = 500

export type EpubParseResult = {
  text: string
  title?: string
  /** Chapters actually converted. */
  chapters: number
  /** Spine entries beyond MAX_CHAPTERS that were not converted. */
  omittedChapters: number
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Resolve an OPF-relative href against the package document's own directory. */
function resolveHref(opfPath: string, href: string): string {
  const parts = opfPath.split('/').slice(0, -1)
  for (const seg of decodeURIComponent(href.split('#')[0]).split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

async function read(zip: JSZip, path: string): Promise<string | null> {
  return (await zip.file(path)?.async('string')) ?? null
}

/** `META-INF/container.xml` names the package document; fall back to a scan. */
async function findOpfPath(zip: JSZip): Promise<string | null> {
  const container = await read(zip, 'META-INF/container.xml')
  const declared = container?.match(/<rootfile\b[^>]*\bfull-path="([^"]+)"/)?.[1]
  if (declared && zip.file(declared)) return declared
  return Object.keys(zip.files).find((p) => p.toLowerCase().endsWith('.opf')) ?? null
}

/**
 * Parse an EPUB buffer to Markdown, one `## <chapter>` section per spine item.
 * Throws when the package is unreadable — the caller placeholders, as for the
 * other zip-backed formats.
 */
export async function parseEpubToMarkdown(buffer: Buffer): Promise<EpubParseResult> {
  const zip = await JSZip.loadAsync(buffer)
  const opfPath = await findOpfPath(zip)
  if (!opfPath) throw new Error('no package document (not an EPUB container)')
  const opf = await read(zip, opfPath)
  if (!opf) throw new Error(`package document ${opfPath} unreadable`)

  const title = decodeEntities(opf.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/)?.[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim()

  const manifest = new Map(
    [...opf.matchAll(/<item\b[^>]*>/g)].flatMap((m) => {
      const id = m[0].match(/\bid="([^"]+)"/)?.[1]
      const href = m[0].match(/\bhref="([^"]+)"/)?.[1]
      return id && href ? [[id, href] as const] : []
    }),
  )

  const spine = [...opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/g)]
    .map((m) => manifest.get(m[1]))
    .filter((h): h is string => Boolean(h))
    .map((h) => resolveHref(opfPath, h))

  // No spine (or a malformed one) still yields the book: fall back to every
  // XHTML part in archive order rather than returning nothing.
  const parts = spine.length
    ? spine
    : Object.keys(zip.files).filter((p) => /\.x?html?$/i.test(p)).sort()

  const sections: string[] = []
  for (const path of parts.slice(0, MAX_CHAPTERS)) {
    const html = await read(zip, path)
    if (!html) continue
    const { markdown, title: chapterTitle } = await htmlToMarkdown(html)
    if (!markdown) continue
    const heading = chapterTitle && !markdown.startsWith('#') ? `## ${chapterTitle}\n\n` : ''
    sections.push(`${heading}${markdown}`)
  }

  const omittedChapters = Math.max(0, parts.length - MAX_CHAPTERS)
  const body = sections.join('\n\n---\n\n').trim()
  const note = omittedChapters
    ? `\n\n[Note: ${omittedChapters} further chapter(s) were not converted (limit ${MAX_CHAPTERS}).]`
    : ''

  return {
    text: body ? `${body}${note}` : '',
    title: title || undefined,
    chapters: sections.length,
    omittedChapters,
  }
}
