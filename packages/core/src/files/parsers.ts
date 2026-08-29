/**
 * File content parsers.
 * Convert supported documents to model-facing Markdown or native media data.
 */
import { estimateStringTokens } from '../compaction/compact.js'
import {
  detectDocumentFormat,
  documentFamily,
  documentFormatFromMetadata,
  fileExtension,
  type DocumentFormat,
} from './document-formats.js'
import { stripDataUris } from './data-uri.js'
import { isHtmlFile, parseHtmlToMarkdown } from './html.js'
import { OfficeArchiveLimitError } from './office-archive-safety.js'
import { parsePptxToMarkdown } from './pptx.js'
import { parseXlsxToMarkdown } from './xlsx.js'
import type { Format as AnyDocFormat } from '@firecrawl/anydoc'

const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'

type ParsedFileContent = {
  text: string
  summary: string
  mediaMimeType?: string
  detectedFormat?: DocumentFormat
}

async function parseWithAnyDoc(buffer: Buffer, format: DocumentFormat): Promise<string> {
  const { toMarkdownBytes } = await import('@firecrawl/anydoc')
  return (await toMarkdownBytes(buffer, format as AnyDocFormat)).trim()
}

/**
 * Deterministic, model-free `.docx` extraction shared by model context and the
 * workspace-doc importer. Throws on corrupt input so callers can choose their
 * own user-facing failure behavior.
 */
export async function parseDocxToMarkdown(buffer: Buffer): Promise<string> {
  try {
    return await parseWithAnyDoc(buffer, 'docx')
  } catch (cause) {
    throw new Error('Could not parse this Word document.', { cause })
  }
}

function labelFor(format: DocumentFormat): 'Document' | 'Presentation' | 'Spreadsheet' {
  const family = documentFamily(format)
  if (family === 'presentation') return 'Presentation'
  if (family === 'spreadsheet') return 'Spreadsheet'
  return 'Document'
}

function emptyDocument(format: DocumentFormat, fileName: string): ParsedFileContent {
  const label = labelFor(format)
  const qualifier = label === 'Spreadsheet' ? 'cells' : 'text'
  return {
    text: `[${label}: ${fileName}. No extractable ${qualifier} (the file may be empty or image-only).]`,
    summary: `${label}: ${fileName}`,
    detectedFormat: format,
  }
}

function failedDocument(
  format: DocumentFormat,
  fileName: string,
  error: unknown,
): ParsedFileContent {
  const label = labelFor(format)
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  let detail = 'this document'
  if (error instanceof OfficeArchiveLimitError || /resource|limit|too (?:large|many)/.test(message)) {
    detail = 'safely because it exceeded document resource limits'
  } else if (/encrypt|password/.test(message)) {
    detail = 'because it is encrypted or password-protected'
  }
  return {
    // Never relay native/vendor error strings to a user. The cause remains
    // useful to the caller while this delivery boundary stays Brian-owned.
    text: `[${label}: ${fileName}. Could not parse ${detail}.]`,
    summary: `${label}: ${fileName}`,
    detectedFormat: format,
  }
}

async function parseStructuredDocument(
  buffer: Buffer,
  format: DocumentFormat,
  fileName: string,
): Promise<ParsedFileContent> {
  try {
    const text = await parseWithAnyDoc(buffer, format)
    if (!text) return emptyDocument(format, fileName)
    const label = labelFor(format)
    return { text, summary: `${label}: ${fileName} (${text.length} chars)`, detectedFormat: format }
  } catch (error) {
    return failedDocument(format, fileName, error)
  }
}

function looksLikeZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b
}

/** Count CSV records without treating a newline inside a quoted cell as a row. */
function countCsvRows(text: string): number {
  if (!text) return 0

  let rows = 1
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        i++
      } else {
        quoted = !quoted
      }
      continue
    }
    if (quoted) continue
    if (char === '\n') {
      rows++
    } else if (char === '\r') {
      rows++
      if (text[i + 1] === '\n') i++
    }
  }

  // A conventional terminal record separator does not introduce an empty row.
  if (text.endsWith('\n') || text.endsWith('\r')) rows--
  return rows
}

function useBrianXlsxLane(
  format: DocumentFormat,
  buffer: Buffer,
  fileName: string,
): boolean {
  if (format !== 'xlsx') return false
  const extension = fileExtension(fileName)
  if (extension === 'xlsx') return true
  if (extension && ['xls', 'xlsm', 'xlsb'].includes(extension)) return false
  return looksLikeZip(buffer)
}

async function parseModernXlsx(buffer: Buffer, fileName: string): Promise<ParsedFileContent> {
  try {
    const { text, sheets, totalRows } = await parseXlsxToMarkdown(buffer)
    if (!text) return emptyDocument('xlsx', fileName)
    // The exact row count is load-bearing: it proves the complete workbook was
    // retained before downstream context selection and tabular profiling.
    const sheetPart =
      sheets.length > 1
        ? `, ${sheets.length} sheets (${sheets.map((sheet) => `${sheet.name}: ${sheet.rows}`).join(', ')})`
        : ''
    return {
      text,
      summary: `Spreadsheet: ${fileName} (${totalRows} rows${sheetPart}, ${text.length} chars)`,
      detectedFormat: 'xlsx',
    }
  } catch (error) {
    return failedDocument('xlsx', fileName, error)
  }
}

function useBrianPptxLane(
  format: DocumentFormat,
  buffer: Buffer,
  mimeType: string,
  fileName: string,
): boolean {
  if (format !== 'pptx') return false
  const extension = fileExtension(fileName)
  if (extension === 'pptx') return true
  if (extension && ['pptm', 'ppsx', 'ppsm'].includes(extension)) return false
  return mimeType.split(';', 1)[0]!.trim().toLowerCase() === PPTX_MIME || looksLikeZip(buffer)
}

async function parseModernPptx(buffer: Buffer, fileName: string): Promise<ParsedFileContent> {
  try {
    const text = await parsePptxToMarkdown(buffer)
    if (!text) return emptyDocument('pptx', fileName)
    return {
      text,
      summary: `Presentation: ${fileName} (${text.length} chars)`,
      detectedFormat: 'pptx',
    }
  } catch (error) {
    return failedDocument('pptx', fileName, error)
  }
}

/** Format dispatch for `parseFileContent` — byte evidence first, metadata second. */
async function parseFileContentInner(
  buffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<ParsedFileContent> {
  // Ask AnyDoc only about the bytes here. This prevents a truthful image/audio
  // MIME from losing to an unrelated filename extension while still allowing
  // a mislabeled Office/PDF payload to override text/plain.
  const byteFormat = await detectDocumentFormat(buffer, '', undefined)
  if (!byteFormat && mimeType.startsWith('image/')) {
    return {
      text: buffer.toString('base64'),
      summary: `Image: ${fileName}`,
      mediaMimeType: mimeType,
    }
  }

  if (!byteFormat && mimeType.startsWith('audio/')) {
    // Audio is transcribed just-in-time by the turn pipeline; no transcript is
    // silently invented during upload.
    return { text: '', summary: `Voice note: ${fileName}`, mediaMimeType: mimeType }
  }

  const metadataFormat = documentFormatFromMetadata(mimeType, fileName)
  const format = byteFormat ?? metadataFormat

  if (format === 'pdf') {
    // Preserve Brian's native multimodal PDF path: layout, scans, and tables
    // reach Gemini as the original bytes instead of AnyDoc's text-only output.
    return {
      text: buffer.toString('base64'),
      summary: `PDF: ${fileName} (${Math.round(buffer.length / 1024)} KB)`,
      mediaMimeType: 'application/pdf',
      detectedFormat: 'pdf',
    }
  }

  if (format === 'csv') {
    const text = buffer.toString('utf-8')
    return {
      text,
      summary: `CSV: ${fileName} (${countCsvRows(text)} rows)`,
      detectedFormat: 'csv',
    }
  }

  if (format && useBrianXlsxLane(format, buffer, fileName)) {
    return parseModernXlsx(buffer, fileName)
  }

  if (format && useBrianPptxLane(format, buffer, mimeType, fileName)) {
    return parseModernPptx(buffer, fileName)
  }

  if (format) return parseStructuredDocument(buffer, format, fileName)

  // HTML is not an AnyDoc format, so it would otherwise land on the generic
  // `text/*` branch below and be handed back as raw markup — stylesheets,
  // scripts and all — as if it were the document. Placed after byte detection
  // so a mislabeled Office payload named `.html` still parses as what it is.
  // See ./html.ts for what the raw-markup path cost in production.
  if (isHtmlFile(mimeType, fileName)) {
    const text = parseHtmlToMarkdown(buffer.toString('utf-8'))
    if (!text) {
      return {
        text: `[Web page: ${fileName}. No readable text (the page may render entirely through scripts).]`,
        summary: `Web page: ${fileName}`,
      }
    }
    return { text, summary: `Web page: ${fileName} (${text.length} chars)` }
  }

  if (mimeType.startsWith('text/') || mimeType === 'application/json') {
    // Stripped here rather than only in the wrapper below so the `(N chars)`
    // summary describes the text that came back: a Google Docs Markdown export
    // is 99.5% image payload, and reporting its raw size describes the file
    // rather than the document.
    const text = stripDataUris(buffer.toString('utf-8'))
    return { text, summary: `${fileName} (${text.length} chars)` }
  }

  return {
    text: `[File: ${fileName}, type: ${mimeType}. Content type not supported for text extraction.]`,
    summary: `File: ${fileName} (${mimeType})`,
  }
}

/**
 * Parse file content from byte evidence first, with filename/MIME metadata as
 * fallback. Returns `{ text, summary }` for cache storage and inline use.
 *
 * The bytes → text boundary is also the data-URI boundary: every text lane is
 * knowledge, and an inline base64 payload never is (./data-uri.ts carries the
 * two incidents). Guarding here rather than per-branch covers `text/*`, JSON,
 * CSV, Office and whatever format lands next, and it covers the text Pipeline B
 * extracts from — not just the text that gets chunked.
 */
export async function parseFileContent(
  buffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<ParsedFileContent> {
  const parsed = await parseFileContentInner(buffer, mimeType, fileName)
  // The media lanes are the exception, and the reason this is a wrapper rather
  // than a blanket pass: an image or PDF returns its OWN bytes as base64 `text`
  // for a multimodal model to read. There the payload IS the document, and
  // stripping it would erase it.
  if (parsed.mediaMimeType) return parsed
  const text = stripDataUris(parsed.text)
  return text === parsed.text ? parsed : { ...parsed, text }
}

/** Determine whether model-facing text is small enough to inline. */
const INLINE_TOKEN_THRESHOLD = 5000

export function shouldInline(text: string): boolean {
  return estimateStringTokens(text) <= INLINE_TOKEN_THRESHOLD
}
