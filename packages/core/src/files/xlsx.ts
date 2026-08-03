/**
 * Excel (.xlsx) → Markdown.
 *
 * Spreadsheets are grid data, so the model-facing representation the industry
 * converged on is one Markdown table per worksheet (sheet name as a heading).
 * We read with ExcelJS (maintained + npm-published; the npm build of SheetJS
 * carries unpatched advisories) and emit the *computed* value of each cell —
 * formula results, not formula text, which is what the user sees.
 */
import ExcelJS from 'exceljs'

// NO ROW CAP. This function's output is what gets chunked into file_segments
// and stored, so a row dropped here is lost permanently — no downstream tool
// can page back to it, and the artifact itself is short forever.
//
// A cap lived here until 2026-08-03 (1,000 rows/sheet) with a note reading
// "ask to read the full sheet", promising a capability that could not exist
// because the rows were never parsed. Measured on a 4,159-row workbook it
// discarded 3,129 rows (75%) before storage. See issue #273.
//
// Context-window pressure is a PRESENTATION concern and is handled downstream
// by the inline gate and the tabular profile. Storage stays complete.

function cellToString(value: ExcelJS.CellValue): string {
  if (value == null) return ''
  if (value instanceof Date) {
    const iso = value.toISOString()
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso
  }
  if (typeof value === 'object') {
    const v = value as {
      result?: ExcelJS.CellValue
      text?: string
      richText?: { text: string }[]
      error?: string
    }
    if (v.richText) return v.richText.map((rt) => rt.text).join('')
    if (v.result !== undefined) return cellToString(v.result)
    if (v.text !== undefined) return String(v.text)
    if (v.error !== undefined) return String(v.error)
    return ''
  }
  return String(value)
}

// Escape Markdown table delimiters and flatten newlines so a cell stays in one column.
function cell(value: ExcelJS.CellValue): string {
  return cellToString(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

export type XlsxParseResult = {
  text: string
  /** Per-sheet row counts, including the header row. */
  sheets: { name: string; rows: number }[]
  /** Rows across every sheet. The number the summary must state. */
  totalRows: number
}

export async function parseXlsxToMarkdown(buffer: Buffer): Promise<XlsxParseResult> {
  const wb = new ExcelJS.Workbook()
  // ExcelJS's bundled types pin `load(buffer: Buffer)` against a different
  // Buffer specialization than @types/node's generic `Buffer<ArrayBufferLike>`;
  // the runtime accepts our Buffer fine. Cast to the exact declared param type.
  await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0])

  const parts: string[] = []
  const sheets: { name: string; rows: number }[] = []
  wb.eachSheet((ws) => {
    const rows: string[][] = []
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals: string[] = []
      row.eachCell({ includeEmpty: true }, (c) => vals.push(cell(c.value)))
      rows.push(vals)
    })

    let section = `## ${ws.name}`
    if (rows.length === 0) {
      section += '\n\n(empty sheet)'
    } else {
      const width = Math.max(...rows.map((r) => r.length))
      const pad = (r: string[]) => {
        while (r.length < width) r.push('')
        return r
      }
      const [head, ...body] = rows.map(pad)
      section += `\n\n| ${head.join(' | ')} |`
      section += `\n| ${head.map(() => '---').join(' | ')} |`
      for (const r of body) section += `\n| ${r.join(' | ')} |`
    }
    sheets.push({ name: ws.name, rows: rows.length })
    parts.push(section)
  })

  return {
    text: parts.join('\n\n').trim(),
    sheets,
    totalRows: sheets.reduce((a, s) => a + s.rows, 0),
  }
}
