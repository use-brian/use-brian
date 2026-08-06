/**
 * File content parsers.
 * Convert various document formats to plain text for the model.
 */
import mammoth from 'mammoth'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import { parseXlsxToMarkdown } from './xlsx.js'
import { parsePptxToMarkdown } from './pptx.js'
import { htmlToMarkdown } from './html.js'
import { parseOdfToMarkdown } from './odf.js'
import { parseEpubToMarkdown } from './epub.js'
import { parseEmlToMarkdown } from './eml.js'
import { estimateStringTokens } from '../compaction/compact.js'

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'

// One reusable HTML → Markdown converter for the .docx path. Markdown is the
// model-facing representation the industry has converged on for structured
// documents — headings, lists, and emphasis survive at a fraction of the
// tokens of raw HTML. GFM adds strikethrough/task-list handling; tables with
// no header row pass through as HTML, which a model reads natively.
const docxToMarkdown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
})
docxToMarkdown.use(gfm)

/**
 * Convert a `.docx` buffer to Markdown: unzip to semantic HTML (mammoth), then
 * HTML → Markdown (turndown + GFM). The deterministic, model-free extraction
 * shared by `parseFileContent` (model context) and `docxToBlocks`
 * (`./docx-convert.ts`, the doc importer). Throws on a corrupt / non-OOXML
 * buffer — callers decide whether to placeholder or surface the error.
 */
export async function parseDocxToMarkdown(buffer: Buffer): Promise<string> {
  const { value: html } = await mammoth.convertToHtml({ buffer })
  return docxToMarkdown.turndown(html).trim()
}

/** Lower-cased final extension including the dot, or `''` when there is none. */
function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) return ''
  return fileName.slice(dot).toLowerCase()
}

const HTML_MIMES = new Set(['text/html', 'application/xhtml+xml', 'application/html'])
const HTML_EXTS = new Set(['.html', '.htm', '.xhtml'])
const RTF_MIMES = new Set(['text/rtf', 'application/rtf'])
const TSV_MIME = 'text/tab-separated-values'

/**
 * OOXML shapes the OTHER parsers read as-is. The allowlist admits the whole
 * `application/vnd.openxmlformats-officedocument` prefix, so these upload
 * successfully and then used to land on the unsupported-type fallback —
 * accepted at the door and refused at the parser. `.ppsx` in particular is an
 * ordinary way to send a deck.
 */
const PPTX_EXTRA_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow', // .ppsx
  'application/vnd.openxmlformats-officedocument.presentationml.template', // .potx
])
const PPTX_EXTS = new Set(['.pptx', '.ppsx', '.potx'])
const XLSX_EXTRA_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template', // .xltx
])
const XLSX_EXTS = new Set(['.xlsx', '.xltx'])
const DOCX_EXTRA_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template', // .dotx
])
const DOCX_EXTS = new Set(['.docx', '.dotx'])

/** OpenDocument: the LibreOffice family, and Google Docs/Sheets/Slides' default export. */
const ODF_MIME_PREFIX = 'application/vnd.oasis.opendocument'
const ODF_EXTS = new Set(['.odt', '.ods', '.odp'])
const EPUB_MIMES = new Set(['application/epub+zip'])
const EML_MIMES = new Set(['message/rfc822', 'application/mbox'])
const EML_EXTS = new Set(['.eml', '.mbox'])

/** Human label for the summary line of each OpenDocument shape. */
const ODF_LABEL = {
  text: 'Document',
  spreadsheet: 'Spreadsheet',
  presentation: 'Presentation',
} as const

/**
 * Match on mime OR extension. A browser reports `text/html` for an `.html`
 * pick, but a file arriving from a channel adapter, an email part, or an OS
 * with no registration can carry `application/octet-stream` while still
 * plainly being a web page.
 */
function isHtml(mimeType: string, ext: string): boolean {
  return HTML_MIMES.has(mimeType.toLowerCase()) || HTML_EXTS.has(ext)
}

export type ParsedFileContent = {
  text: string
  summary: string
  /**
   * True when `text` is the parser's OWN note about why extraction did not
   * happen ("the legacy .xls format is not supported…"), not document content.
   *
   * The chat path wants that note inline — the model reads it and tells the
   * user to re-save the file. The ingest path must not: chunking it writes our
   * error string into `file_segments` as if it were knowledge, and decomposing
   * it spends a Pipeline B model call to summarise a sentence we wrote
   * ourselves. Callers that persist decide; the parser only reports.
   */
  placeholder?: true
}

/** A parse outcome that is a stated reason, not content. */
function placeholder(text: string, summary: string): ParsedFileContent {
  return { text, summary, placeholder: true }
}

/**
 * Parse file content to text based on MIME type.
 * Returns { text, summary } where summary is a short description for inline use.
 */
export async function parseFileContent(
  buffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<ParsedFileContent> {
  const ext = extensionOf(fileName)

  // HTML is checked BEFORE the generic `text/` branch, which would otherwise
  // swallow `text/html` and hand raw markup — doctype, `<head>`, the entire
  // stylesheet — to chunking and extraction. See html.ts for why the whole
  // body is converted rather than Readability-extracted.
  if (isHtml(mimeType, ext)) {
    const html = buffer.toString('utf-8')
    const { markdown, title, mode } = await htmlToMarkdown(html)
    if (!markdown) {
      return placeholder(
        `[Web page: ${fileName}. No extractable text (the document may be script-rendered or image-only).]`,
        `Web page: ${fileName}`,
      )
    }
    const heading = title && !markdown.startsWith('#') ? `# ${title}\n\n` : ''
    const note =
      mode === 'stripped'
        ? `\n\n[Note: ${fileName} could not be parsed as a document tree, so its markup was removed textually. Structure (headings, lists, tables) is not preserved.]`
        : ''
    const text = `${heading}${markdown}${note}`
    return { text, summary: `Web page: ${fileName} (${text.length} chars of Markdown)` }
  }

  // RTF arrives as `text/rtf`, so the generic `text/` branch used to accept it
  // and hand the brain a document that is mostly control words
  // (`{\rtf1\ansi\deff0{\fonttbl…`) — the same failure as raw HTML, in another
  // costume. A faithful RTF reader is a real parser, not a regex, so this
  // follows the legacy-binary precedent: state the limit and name the fix.
  if (RTF_MIMES.has(mimeType.toLowerCase()) || ext === '.rtf') {
    return placeholder(
      `[Document: ${fileName}. The .rtf format is not supported; re-save as .docx or PDF to extract its text.]`,
      `Document: ${fileName}`,
    )
  }

  // Checked before the `text/` branch too: a `.csv` almost always arrives as
  // `text/csv`, which that branch matches first — so the row-count summary
  // this branch exists to produce was unreachable for the common case.
  //
  // `.tsv` rides the same branch because `tabular-profile.ts` already counts
  // `text/tab-separated-values` and `.tsv` as tabular, so the downstream
  // profile lane was expecting a label the parser never assigned.
  if (ext === '.csv' || ext === '.tsv' || mimeType === 'text/csv' || mimeType === TSV_MIME) {
    const text = buffer.toString('utf-8')
    const label = ext === '.tsv' || mimeType === TSV_MIME ? 'TSV' : 'CSV'
    return { text, summary: `${label}: ${fileName} (${text.split('\n').length} rows)` }
  }

  if (mimeType.startsWith('text/') || mimeType === 'application/json') {
    const text = buffer.toString('utf-8')
    return {
      text,
      summary: `${fileName} (${text.length} chars)`,
    }
  }

  if (mimeType === 'application/pdf') {
    // PDFs ride the same `inlineData` path as images — Gemini reads them
    // natively via multimodal input (tables, scans, layout preserved).
    // Caller wraps the base64 into a `data:application/pdf;base64,<...>` URL
    // for file_cache storage and emits an `image` ContentBlock at turn time.
    return {
      text: buffer.toString('base64'),
      summary: `PDF: ${fileName} (${Math.round(buffer.length / 1024)} KB)`,
    }
  }

  if (mimeType.startsWith('image/')) {
    // Images are stored as base64 and passed to the model as inline_data
    // content blocks. Gemini reads them natively via multimodal input.
    return {
      text: buffer.toString('base64'),
      summary: `Image: ${fileName}`,
    }
  }

  if (mimeType.startsWith('audio/')) {
    // Audio is stored as base64 so `chat.ts` can decode and run the
    // voice-transcription preflight just-in-time. The parsed "text" is
    // empty — the transcript is produced per-turn by `transcribeFirstAudio`
    // and prepended with `[voice] `. See docs/architecture/media/transcription.md.
    return {
      text: '',
      summary: `Voice note: ${fileName}`,
    }
  }

  if (mimeType === XLSX_MIME || XLSX_EXTRA_MIMES.has(mimeType) || XLSX_EXTS.has(ext)) {
    // Each worksheet → a Markdown table (computed values, not formulas).
    try {
      const { text, sheets, totalRows } = await parseXlsxToMarkdown(buffer)
      if (!text) {
        return placeholder(
          `[Spreadsheet: ${fileName}. No extractable cells (the workbook may be empty).]`,
          `Spreadsheet: ${fileName}`,
        )
      }
      // The row count is load-bearing, not decoration: it is how a reader (and
      // the model) can tell a complete parse from a short one. See issue #273.
      const sheetPart =
        sheets.length > 1 ? `, ${sheets.length} sheets (${sheets.map((s) => `${s.name}: ${s.rows}`).join(', ')})` : ''
      return {
        text,
        summary: `Spreadsheet: ${fileName} (${totalRows} rows${sheetPart}, ${text.length} chars)`,
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error'
      return placeholder(
        `[Spreadsheet: ${fileName}. Could not parse as .xlsx (${reason}).]`,
        `Spreadsheet: ${fileName}`,
      )
    }
  }

  // OpenDocument — the LibreOffice family and Google Workspace's default
  // export. Same deterministic zip+XML extraction as the OOXML branches above;
  // one walker covers all three shapes (see odf.ts).
  if (mimeType.startsWith(ODF_MIME_PREFIX) || ODF_EXTS.has(ext)) {
    try {
      const { text, kind, sections, rows } = await parseOdfToMarkdown(buffer)
      const label = ODF_LABEL[kind]
      if (!text) {
        return placeholder(
          `[${label}: ${fileName}. No extractable text (the file may be empty or image-only).]`,
          `${label}: ${fileName}`,
        )
      }
      const detail =
        kind === 'spreadsheet'
          ? `${rows} rows, ${sections} sheets`
          : kind === 'presentation'
            ? `${sections} slides`
            : `${text.length} chars`
      return { text, summary: `${label}: ${fileName} (${detail})` }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error'
      return placeholder(
        `[Document: ${fileName}. Could not parse as OpenDocument (${reason}).]`,
        `Document: ${fileName}`,
      )
    }
  }

  // EPUB is a zip of XHTML in spine order, so each chapter rides the same
  // whole-body converter an uploaded .html file does.
  if (EPUB_MIMES.has(mimeType) || ext === '.epub') {
    try {
      const { text, title, chapters } = await parseEpubToMarkdown(buffer)
      if (!text) {
        return placeholder(
          `[Book: ${fileName}. No extractable text (the EPUB may be image-only or DRM-protected).]`,
          `Book: ${fileName}`,
        )
      }
      const heading = title && !text.startsWith('#') ? `# ${title}\n\n` : ''
      const full = `${heading}${text}`
      return { text: full, summary: `Book: ${fileName} (${chapters} chapters, ${full.length} chars)` }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error'
      return placeholder(
        `[Book: ${fileName}. Could not parse as EPUB (${reason}).]`,
        `Book: ${fileName}`,
      )
    }
  }

  // A saved email. The envelope becomes a header block and the body rides the
  // plain part, or the HTML alternative through the same converter.
  if (EML_MIMES.has(mimeType) || EML_EXTS.has(ext)) {
    try {
      const { text, subject, attachments } = await parseEmlToMarkdown(buffer)
      if (!text) {
        return placeholder(
          `[Email: ${fileName}. No extractable body (the message may carry attachments only).]`,
          `Email: ${fileName}`,
        )
      }
      const attachPart = attachments.length ? `, ${attachments.length} attachments` : ''
      return {
        text,
        summary: `Email: ${subject || fileName} (${text.length} chars${attachPart})`,
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error'
      return placeholder(
        `[Email: ${fileName}. Could not parse as an email message (${reason}).]`,
        `Email: ${fileName}`,
      )
    }
  }

  if (mimeType === 'application/vnd.ms-excel' || ext === '.xls') {
    // Legacy binary .xls (BIFF) — ExcelJS reads only the XML .xlsx format.
    return placeholder(
      `[Spreadsheet: ${fileName}. The legacy .xls format is not supported; re-save as .xlsx to extract its cells.]`,
      `Spreadsheet: ${fileName}`,
    )
  }

  if (mimeType === PPTX_MIME || PPTX_EXTRA_MIMES.has(mimeType) || PPTX_EXTS.has(ext)) {
    // Slide text + speaker notes → Markdown (the deterministic text track;
    // a deck's visuals are not captured — see pptx.ts).
    try {
      const text = await parsePptxToMarkdown(buffer)
      if (!text) {
        return placeholder(
          `[Presentation: ${fileName}. No extractable text (the slides may be image-only).]`,
          `Presentation: ${fileName}`,
        )
      }
      return { text, summary: `Presentation: ${fileName} (${text.length} chars)` }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error'
      return placeholder(
        `[Presentation: ${fileName}. Could not parse as .pptx (${reason}).]`,
        `Presentation: ${fileName}`,
      )
    }
  }

  if (mimeType === 'application/vnd.ms-powerpoint' || ext === '.ppt') {
    // Legacy binary .ppt predates Office Open XML and is not parsed here.
    return placeholder(
      `[Presentation: ${fileName}. The legacy .ppt format is not supported; re-save as .pptx to extract its text.]`,
      `Presentation: ${fileName}`,
    )
  }

  if (mimeType === DOCX_MIME || DOCX_EXTRA_MIMES.has(mimeType) || DOCX_EXTS.has(ext)) {
    // Modern Word (.docx) is Office Open XML — a zip of structured XML.
    // Born-digital text is extracted deterministically here (no model call):
    // unzip to semantic HTML (mammoth), then convert that to Markdown
    // (turndown). PDFs/scans/images take the native multimodal path instead;
    // see the parser matrix in docs/architecture/engine/file-handling.md.
    try {
      const text = await parseDocxToMarkdown(buffer)
      if (!text) {
        return placeholder(
          `[Document: ${fileName}. No extractable text (the file may be empty or image-only).]`,
          `Document: ${fileName}`,
        )
      }
      return { text, summary: `Document: ${fileName} (${text.length} chars)` }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error'
      return placeholder(
        `[Document: ${fileName}. Could not parse as .docx (${reason}).]`,
        `Document: ${fileName}`,
      )
    }
  }

  if (mimeType === 'application/msword' || ext === '.doc') {
    // Legacy binary .doc predates Office Open XML; mammoth cannot read it.
    // Honest, actionable placeholder beats a silent failure.
    return placeholder(
      `[Document: ${fileName}. The legacy .doc format is not supported; re-save as .docx to extract its text.]`,
      `Document: ${fileName}`,
    )
  }

  return placeholder(
    `[File: ${fileName}, type: ${mimeType}. Content type not supported for text extraction.]`,
    `File: ${fileName} (${mimeType})`,
  )
}

/**
 * Determine if content should be inlined (small) or cached (large).
 *
 * The gate is CJK-aware: it estimates the token cost of the text via
 * `estimateStringTokens` (≈1 token per CJK codepoint, ~4 chars/token
 * otherwise) rather than a flat `length * 4` byte heuristic. A 6,000-char
 * CJK document is ~6,000 tokens and must NOT inline, even though its char
 * count sits under the old 20K-char line; the estimator catches that.
 */
const INLINE_TOKEN_THRESHOLD = 5000 // ~20K chars of Latin text

export function shouldInline(text: string): boolean {
  return estimateStringTokens(text) <= INLINE_TOKEN_THRESHOLD
}
