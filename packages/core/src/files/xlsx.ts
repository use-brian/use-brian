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

// Large sheets would blow the context window; cap rows per sheet and note the
// omission rather than silently truncating. Wide sheets are left uncapped.
const MAX_ROWS_PER_SHEET = 1000

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

export async function parseXlsxToMarkdown(buffer: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook()
  // ExcelJS's bundled types pin `load(buffer: Buffer)` against a different
  // Buffer specialization than @types/node's generic `Buffer<ArrayBufferLike>`;
  // the runtime accepts our Buffer fine. Cast to the exact declared param type.
  await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0])

  const parts: string[] = []
  wb.eachSheet((ws) => {
    const rows: string[][] = []
    let omitted = 0
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (rows.length >= MAX_ROWS_PER_SHEET) {
        omitted++
        return
      }
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
      if (omitted > 0) section += `\n\n_(${omitted} more rows omitted; ask to read the full sheet)_`
    }
    parts.push(section)
  })

  return parts.join('\n\n').trim()
}
