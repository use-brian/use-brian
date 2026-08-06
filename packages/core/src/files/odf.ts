/**
 * OpenDocument (.odt / .ods / .odp) → Markdown. [COMP:files/odf]
 *
 * The OpenDocument family is the other half of the born-digital structured
 * document space, and it was refused outright at the upload gate — a LibreOffice
 * user, or anyone exporting from Google Docs/Sheets/Slides with the default
 * OpenDocument option, could not put a document into the brain at all.
 *
 * Same construction as `pptx.ts` and for the same reason: an ODF file is a zip
 * whose `content.xml` holds the whole document, so JSZip plus a direct XML walk
 * gets born-digital text deterministically with no model call and no new
 * dependency. (`odf2html`/`officeparser` would each pull a far larger tree for
 * the same result.)
 *
 * One shared body walker serves all three: ODF uses `<text:h>`, `<text:p>`,
 * `<text:list>` and `<table:table>` in every document type — a spreadsheet is
 * tables all the way down, a presentation is tables and paragraphs inside
 * `<draw:page>`. Only the framing differs.
 */
import JSZip from 'jszip'

export type OdfKind = 'text' | 'spreadsheet' | 'presentation'

export type OdfParseResult = {
  /** Markdown. Empty when the document carries no extractable text. */
  text: string
  kind: OdfKind
  /** Sheets for a spreadsheet, slides for a presentation, else 0. */
  sections: number
  /** Total table rows emitted across the document. */
  rows: number
}

/**
 * A run of empty cells/rows that ODF encodes as one repeated element. Writers
 * pad every sheet to the format's column limit, so `table:number-columns-repeated`
 * routinely says 1024 (and rows 1048576). Expanding those literally turns a
 * three-column sheet into a megabyte of pipes, so a repeat is only expanded
 * when the element actually carries content.
 */
const MAX_EMPTY_REPEAT = 1

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&') // must be last
}

/** Inline text of one ODF element: runs, tabs, `<text:s>` runs, line breaks. */
function inlineText(xml: string): string {
  return decodeEntities(
    xml
      .replace(/<text:line-break\s*\/?>/g, ' ')
      .replace(/<text:tab\s*\/?>/g, ' ')
      .replace(/<text:s\b[^>]*text:c="(\d+)"[^>]*\/?>/g, (_, n: string) =>
        ' '.repeat(Math.min(Number(n), 40)),
      )
      .replace(/<text:s\s*\/?>/g, ' ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, '\\|')
}

/**
 * Remove comments and revision metadata BEFORE the body walk, not during it.
 *
 * An `<office:annotation>` contains its own `<text:p>`, so a non-greedy
 * paragraph match closes on the *comment's* closing tag and the reviewer's
 * words end up spliced into the author's sentence. Deleting these whole
 * elements first is the only ordering that cannot produce that.
 *
 * Footnotes are deliberately kept: unlike a comment, their text is the
 * document's own. They read inline, which loses their marker position but no
 * content.
 */
function stripEditorialChrome(xml: string): string {
  return xml
    .replace(/<office:annotation\b[\s\S]*?<\/office:annotation>/g, '')
    .replace(/<office:annotation-end\b[^>]*\/?>/g, '')
    .replace(/<text:tracked-changes\b[\s\S]*?<\/text:tracked-changes>/g, '')
}

/** `<attr>="N"` as a bounded positive integer, or 1. */
function repeatOf(tag: string, attr: string): number {
  const m = tag.match(new RegExp(`${attr}="(\\d+)"`))
  if (!m) return 1
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : 1
}

// ── Tables ────────────────────────────────────────────────────────

type ParsedTable = { name: string; rows: string[][] }

/**
 * Read one `<table:table>` into a rectangular string grid, honouring the
 * repeat attributes but never expanding a repeat of empty content (see
 * MAX_EMPTY_REPEAT).
 */
function parseTable(tableXml: string): ParsedTable {
  const name = decodeEntities(tableXml.match(/\btable:name="([^"]*)"/)?.[1] ?? '')
  const rows: string[][] = []

  for (const rowMatch of tableXml.matchAll(
    /<table:table-row\b([^>]*)>([\s\S]*?)<\/table:table-row>|<table:table-row\b([^>]*)\/>/g,
  )) {
    const attrs = rowMatch[1] ?? rowMatch[3] ?? ''
    const body = rowMatch[2] ?? ''
    const cells: string[] = []

    for (const cellMatch of body.matchAll(
      /<table:(?:covered-)?table-cell\b([^>]*)>([\s\S]*?)<\/table:(?:covered-)?table-cell>|<table:(?:covered-)?table-cell\b([^>]*)\/>/g,
    )) {
      const cellAttrs = cellMatch[1] ?? cellMatch[3] ?? ''
      const cellBody = cellMatch[2] ?? ''
      // Prefer the displayed text; fall back to the typed value so a date or a
      // number with no rendered <text:p> is not lost.
      const shown = inlineText(cellBody)
      const typed = decodeEntities(cellAttrs.match(/\boffice:(?:date-)?value="([^"]*)"/)?.[1] ?? '')
      const value = shown || typed
      const repeat = repeatOf(cellAttrs, 'table:number-columns-repeated')
      const times = value ? repeat : Math.min(repeat, MAX_EMPTY_REPEAT)
      for (let i = 0; i < times; i++) cells.push(value)
    }

    while (cells.length && cells[cells.length - 1] === '') cells.pop()
    const repeat = repeatOf(attrs, 'table:number-rows-repeated')
    const times = cells.length ? repeat : Math.min(repeat, MAX_EMPTY_REPEAT)
    for (let i = 0; i < times; i++) rows.push([...cells])
  }

  while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop()
  return { name, rows }
}

function renderTable(rows: string[][]): string {
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map((r) => r.length))
  const line = (r: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => escapePipes(r[i] ?? '')).join(' | ')} |`
  const [head, ...body] = rows
  return [line(head), `| ${Array(width).fill('---').join(' | ')} |`, ...body.map(line)].join('\n')
}

// ── Body walk ─────────────────────────────────────────────────────

/**
 * Walk a body fragment in document order, emitting Markdown blocks. Scanning
 * positionally (rather than matching each element type separately) is what
 * keeps a heading with the paragraphs that follow it.
 */
function walkBody(xml: string): { blocks: string[]; rows: number } {
  const blocks: string[] = []
  let rows = 0

  const pattern =
    /<text:h\b([^>]*)>([\s\S]*?)<\/text:h>|<text:p\b[^>]*>([\s\S]*?)<\/text:p>|<text:list\b[^>]*>([\s\S]*?)<\/text:list>|<table:table\b[^>]*>[\s\S]*?<\/table:table>/g

  for (const m of xml.matchAll(pattern)) {
    const whole = m[0]

    if (whole.startsWith('<text:h')) {
      const level = Math.min(Math.max(Number(m[1].match(/text:outline-level="(\d+)"/)?.[1] ?? 1), 1), 6)
      const title = inlineText(m[2])
      if (title) blocks.push(`${'#'.repeat(level)} ${title}`)
      continue
    }

    if (whole.startsWith('<text:p')) {
      const body = inlineText(m[3])
      if (body) blocks.push(body)
      continue
    }

    if (whole.startsWith('<text:list')) {
      const items = [...m[4].matchAll(/<text:list-item\b[^>]*>([\s\S]*?)<\/text:list-item>/g)]
        .map((li) => inlineText(li[1]))
        .filter(Boolean)
        .map((li) => `- ${li}`)
      if (items.length) blocks.push(items.join('\n'))
      continue
    }

    const table = parseTable(whole)
    const rendered = renderTable(table.rows)
    if (rendered) {
      rows += table.rows.length
      blocks.push(table.name ? `**${table.name}**\n\n${rendered}` : rendered)
    }
  }

  return { blocks, rows }
}

// ── Entry point ───────────────────────────────────────────────────

function kindOf(contentXml: string, mimetype: string): OdfKind {
  if (/opendocument\.spreadsheet/.test(mimetype) || /<office:spreadsheet\b/.test(contentXml)) {
    return 'spreadsheet'
  }
  if (/opendocument\.presentation/.test(mimetype) || /<office:presentation\b/.test(contentXml)) {
    return 'presentation'
  }
  return 'text'
}

/**
 * Parse an OpenDocument buffer to Markdown. Throws on a buffer that is not a
 * readable ODF package — the caller decides whether to placeholder, exactly as
 * for `.docx` / `.xlsx` / `.pptx`.
 */
export async function parseOdfToMarkdown(buffer: Buffer): Promise<OdfParseResult> {
  const zip = await JSZip.loadAsync(buffer)
  const raw = await zip.file('content.xml')?.async('string')
  if (!raw) throw new Error('content.xml missing (not an OpenDocument package)')
  const content = stripEditorialChrome(raw)
  const mimetype = (await zip.file('mimetype')?.async('string')) ?? ''
  const kind = kindOf(content, mimetype)

  const body = content.match(/<office:body\b[^>]*>([\s\S]*)<\/office:body>/)?.[1] ?? content

  if (kind === 'spreadsheet') {
    const sheets: string[] = []
    let rows = 0
    for (const m of body.matchAll(/<table:table\b[^>]*>[\s\S]*?<\/table:table>/g)) {
      const table = parseTable(m[0])
      const rendered = renderTable(table.rows)
      if (!rendered) continue
      rows += table.rows.length
      sheets.push(`## ${table.name || `Sheet ${sheets.length + 1}`}\n\n${rendered}`)
    }
    return { text: sheets.join('\n\n').trim(), kind, sections: sheets.length, rows }
  }

  if (kind === 'presentation') {
    const slides: string[] = []
    for (const m of body.matchAll(/<draw:page\b([^>]*)>([\s\S]*?)<\/draw:page>/g)) {
      const name = decodeEntities(m[1].match(/\bdraw:name="([^"]*)"/)?.[1] ?? '')
      const { blocks } = walkBody(m[2])
      const heading = `## Slide ${slides.length + 1}${name ? ` — ${name}` : ''}`
      slides.push(blocks.length ? `${heading}\n\n${blocks.join('\n\n')}` : heading)
    }
    // A deck with pages but no text is still a parse, not a failure — the same
    // text-track-only limit `.pptx` carries.
    return { text: slides.join('\n\n').trim(), kind, sections: slides.length, rows: 0 }
  }

  const { blocks, rows } = walkBody(body)
  return { text: blocks.join('\n\n').trim(), kind, sections: 0, rows }
}
