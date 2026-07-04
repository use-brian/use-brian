/**
 * File content parsers.
 * Convert various document formats to plain text for the model.
 */
import mammoth from 'mammoth'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import { parseXlsxToMarkdown } from './xlsx.js'
import { parsePptxToMarkdown } from './pptx.js'
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

/**
 * Parse file content to text based on MIME type.
 * Returns { text, summary } where summary is a short description for inline use.
 */
export async function parseFileContent(
  buffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<{ text: string; summary: string }> {
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

  if (fileName.endsWith('.csv')) {
    const text = buffer.toString('utf-8')
    return { text, summary: `CSV: ${fileName} (${text.split('\n').length} rows)` }
  }

  if (mimeType === XLSX_MIME || fileName.toLowerCase().endsWith('.xlsx')) {
    // Each worksheet → a Markdown table (computed values, not formulas).
    try {
      const text = await parseXlsxToMarkdown(buffer)
      if (!text) {
        return {
          text: `[Spreadsheet: ${fileName}. No extractable cells (the workbook may be empty).]`,
          summary: `Spreadsheet: ${fileName}`,
        }
      }
      return { text, summary: `Spreadsheet: ${fileName} (${text.length} chars)` }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error'
      return {
        text: `[Spreadsheet: ${fileName}. Could not parse as .xlsx (${reason}).]`,
        summary: `Spreadsheet: ${fileName}`,
      }
    }
  }

  if (mimeType === 'application/vnd.ms-excel' || fileName.toLowerCase().endsWith('.xls')) {
    // Legacy binary .xls (BIFF) — ExcelJS reads only the XML .xlsx format.
    return {
      text: `[Spreadsheet: ${fileName}. The legacy .xls format is not supported; re-save as .xlsx to extract its cells.]`,
      summary: `Spreadsheet: ${fileName}`,
    }
  }

  if (mimeType === PPTX_MIME || fileName.toLowerCase().endsWith('.pptx')) {
    // Slide text + speaker notes → Markdown (the deterministic text track;
    // a deck's visuals are not captured — see pptx.ts).
    try {
      const text = await parsePptxToMarkdown(buffer)
      if (!text) {
        return {
          text: `[Presentation: ${fileName}. No extractable text (the slides may be image-only).]`,
          summary: `Presentation: ${fileName}`,
        }
      }
      return { text, summary: `Presentation: ${fileName} (${text.length} chars)` }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error'
      return {
        text: `[Presentation: ${fileName}. Could not parse as .pptx (${reason}).]`,
        summary: `Presentation: ${fileName}`,
      }
    }
  }

  if (mimeType === 'application/vnd.ms-powerpoint' || fileName.toLowerCase().endsWith('.ppt')) {
    // Legacy binary .ppt predates Office Open XML and is not parsed here.
    return {
      text: `[Presentation: ${fileName}. The legacy .ppt format is not supported; re-save as .pptx to extract its text.]`,
      summary: `Presentation: ${fileName}`,
    }
  }

  if (mimeType === DOCX_MIME || fileName.toLowerCase().endsWith('.docx')) {
    // Modern Word (.docx) is Office Open XML — a zip of structured XML.
    // Born-digital text is extracted deterministically here (no model call):
    // unzip to semantic HTML (mammoth), then convert that to Markdown
    // (turndown). PDFs/scans/images take the native multimodal path instead;
    // see the parser matrix in docs/architecture/engine/file-handling.md.
    try {
      const text = await parseDocxToMarkdown(buffer)
      if (!text) {
        return {
          text: `[Document: ${fileName}. No extractable text (the file may be empty or image-only).]`,
          summary: `Document: ${fileName}`,
        }
      }
      return { text, summary: `Document: ${fileName} (${text.length} chars)` }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error'
      return {
        text: `[Document: ${fileName}. Could not parse as .docx (${reason}).]`,
        summary: `Document: ${fileName}`,
      }
    }
  }

  if (mimeType === 'application/msword' || fileName.toLowerCase().endsWith('.doc')) {
    // Legacy binary .doc predates Office Open XML; mammoth cannot read it.
    // Honest, actionable placeholder beats a silent failure.
    return {
      text: `[Document: ${fileName}. The legacy .doc format is not supported; re-save as .docx to extract its text.]`,
      summary: `Document: ${fileName}`,
    }
  }

  return {
    text: `[File: ${fileName}, type: ${mimeType}. Content type not supported for text extraction.]`,
    summary: `File: ${fileName} (${mimeType})`,
  }
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
