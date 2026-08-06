// [COMP:files/tabular-profile] — the schema block a turn carries INSTEAD of a
// tabular file's rows.
//
// Third sibling of artifact-manifest (here is where the rest lives) and
// inline-truncation (the rest is gone, do not pretend otherwise). This one
// says: the rows were never in the prompt and never will be, here is the
// shape, ask the query tool for any figure.
//
// The premise (issue #273): precision on tabular data cannot come from putting
// rows in a prompt. Whole, truncated, or retrieved, any row subset lets the
// model state a total it cannot support. A 4,159-row workout CSV delivered at
// 8% produced a total understated by 88.7% and a wrong personal record, stated
// as fact. A profile is ~200 tokens regardless of file size and cannot be
// mistaken for the data.
//
// No em dash anywhere (block text can surface in user-facing renders).

import { isTabularDocument } from './document-formats.js'

export type ColumnType = 'integer' | 'decimal' | 'date' | 'boolean' | 'text' | 'empty'

export type ColumnProfile = {
  name: string
  type: ColumnType
  /** Rows where this column is blank. */
  nullCount: number
}

export type DateRange = {
  column: string
  /** Resolved ordering. `ambiguous` means it must NOT be guessed. */
  format: 'ISO' | 'M/D/Y' | 'D/M/Y' | 'ambiguous'
  /** ISO bounds. Absent when the format is ambiguous. */
  min?: string
  max?: string
}

export type TableProfile = {
  /** Data rows, excluding the header. */
  rowCount: number
  columns: ColumnProfile[]
  dateRange?: DateRange
  sampleRows: string[][]
  /**
   * True when a type could not be resolved safely. An ambiguous date column
   * shifts a whole fiscal period if guessed, so the user confirms instead.
   */
  needsSchemaConfirmation: boolean
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export function isTabular(mime: string, fileName: string): boolean {
  return (
    mime === 'text/tab-separated-values' ||
    fileName.toLowerCase().endsWith('.tsv') ||
    isTabularDocument(mime, fileName)
  )
}

const DELIMITER_CANDIDATES = [',', ';', '\t', '|'] as const

/**
 * Full quote-aware reader. Splits on rows AND fields in one pass, so a newline
 * inside a quoted field does not start a new row.
 *
 * Splitting on `\n` first (the previous approach) inflated the row count of
 * any export with a multi-line note field. The row count is the profile's
 * central claim, so an inflated one is exactly the confident wrong number this
 * whole lane exists to prevent: a 2,000-row file reported 4,000.
 */
function readDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let inQuotes = false
  let sawField = false

  const endField = () => {
    row.push(cur.trim())
    cur = ''
    sawField = true
  }
  const endRow = () => {
    endField()
    if (row.length > 1 || row[0].length > 0) rows.push(row)
    row = []
    sawField = false
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"'
          i++
        } else inQuotes = false
      } else cur += ch
      continue
    }
    if (ch === '"') inQuotes = true
    else if (ch === delim) endField()
    else if (ch === '\n') endRow()
    else if (ch === '\r') {
      /* CRLF: the \n does the work */
    } else cur += ch
  }
  if (cur.length > 0 || sawField || row.length > 0) endRow()
  return rows
}

/** Rows that look like a comment preamble or a blank spacer, not data. */
function isPreamble(line: string): boolean {
  const t = line.trim()
  return t.length === 0 || t.startsWith('#')
}

/**
 * Pick the delimiter by how well it explains the file, not by whether the
 * character merely appears. `text.includes('\t')` used to switch an entire
 * comma CSV to tab-splitting because one field contained a stray tab, which
 * collapsed real files (GA4 exports, 44k rows) to a single column.
 */
function detectDelimiter(text: string): string {
  const sample = text
    .split('\n')
    .filter((l) => !isPreamble(l))
    .slice(0, 50)
    .join('\n')
  let best = ','
  let bestScore = 0
  for (const d of DELIMITER_CANDIDATES) {
    const rows = readDelimited(sample, d).slice(0, 50)
    if (rows.length === 0) continue
    const counts = rows.map((r) => r.length)
    const modal = counts.sort((a, b) => counts.filter((c) => c === a).length - counts.filter((c) => c === b).length).pop()!
    if (modal < 2) continue
    const consistent = counts.filter((c) => c === modal).length / counts.length
    const score = modal * consistent
    if (score > bestScore) {
      bestScore = score
      best = d
    }
  }
  return best
}

function rowsFromMarkdownTable(text: string): string[][] {
  const rows: string[][] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('|')) continue
    const cells = t
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.replace(/\\\|/g, '|').trim())
    // Skip the |---|---| separator.
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue
    rows.push(cells)
  }
  return rows
}

export function tabularRowsFromText(text: string, mime: string): string[][] {
  if (mime === XLSX_MIME || /^\s*(##\s|\|)/.test(text)) {
    const md = rowsFromMarkdownTable(text)
    if (md.length > 0) return md
  }
  // Strip a UTF-8 BOM so it does not ride into the first header cell.
  let body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  // Drop a leading comment/blank preamble. Analytics exports (GA4 and friends)
  // open with several `#` banner lines; treating the first of them as the
  // header yields a one-column file and a meaningless profile.
  const lines = body.split('\n')
  let start = 0
  while (start < lines.length && isPreamble(lines[start])) start++
  body = lines.slice(start).join('\n')

  const delim = mime === 'text/tab-separated-values' ? '\t' : detectDelimiter(body)
  const rows = readDelimited(body, delim)

  // A header must have the same shape as the data under it. Anything above the
  // first row matching the modal field count is residual preamble.
  if (rows.length > 2) {
    const counts = rows.slice(0, 50).map((r) => r.length)
    const modal = counts
      .slice()
      .sort((a, b) => counts.filter((c) => c === a).length - counts.filter((c) => c === b).length)
      .pop()!
    const headerIdx = rows.findIndex((r) => r.length === modal)
    if (headerIdx > 0) return rows.slice(headerIdx)
  }
  return rows
}

const INT_RE = /^-?\d+$/
const DEC_RE = /^-?\d*\.\d+$/
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})/
const SLASH_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})/
const BOOL_RE = /^(true|false|yes|no)$/i

function classify(values: string[]): ColumnType {
  const nonEmpty = values.filter((v) => v.length > 0)
  if (nonEmpty.length === 0) return 'empty'
  if (nonEmpty.every((v) => ISO_RE.test(v) || SLASH_RE.test(v))) return 'date'
  if (nonEmpty.every((v) => BOOL_RE.test(v))) return 'boolean'
  if (nonEmpty.every((v) => DEC_RE.test(v) || INT_RE.test(v))) {
    // A leading zero is an identifier, not a number. Coercing "0012" to 12
    // silently merges distinct accounts, so it stays text.
    if (nonEmpty.some((v) => /^-?0\d/.test(v))) return 'text'
    return nonEmpty.some((v) => DEC_RE.test(v)) ? 'decimal' : 'integer'
  }
  return 'text'
}

function toIso(v: string, format: DateRange['format']): string | undefined {
  const iso = ISO_RE.exec(v)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const m = SLASH_RE.exec(v)
  if (!m) return undefined
  const a = Number(m[1])
  const b = Number(m[2])
  const rawY = m[3]
  const y = rawY.length === 2 ? 2000 + Number(rawY) : Number(rawY)
  const [mo, d] = format === 'D/M/Y' ? [b, a] : [a, b]
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function resolveDateColumn(name: string, values: string[]): DateRange {
  const nonEmpty = values.filter((v) => v.length > 0)
  if (nonEmpty.every((v) => ISO_RE.test(v))) {
    const isos = nonEmpty.map((v) => toIso(v, 'ISO')!).sort()
    return { column: name, format: 'ISO', min: isos[0], max: isos[isos.length - 1] }
  }
  let format: DateRange['format'] = 'ambiguous'
  for (const v of nonEmpty) {
    const m = SLASH_RE.exec(v)
    if (!m) continue
    if (Number(m[1]) > 12) {
      format = 'D/M/Y'
      break
    }
    if (Number(m[2]) > 12) format = 'M/D/Y'
  }
  // Never guess: a wrong ordering shifts an entire fiscal period silently.
  if (format === 'ambiguous') return { column: name, format }
  const isos = nonEmpty.map((v) => toIso(v, format)).filter((s): s is string => !!s).sort()
  return { column: name, format, min: isos[0], max: isos[isos.length - 1] }
}

export function profileTable(rows: string[][]): TableProfile {
  if (rows.length === 0) {
    return { rowCount: 0, columns: [], sampleRows: [], needsSchemaConfirmation: false }
  }
  const header = rows[0]
  const body = rows.slice(1)
  const columns: ColumnProfile[] = header.map((name, i) => {
    const values = body.map((r) => (r[i] ?? '').trim())
    return {
      name: name || `column_${i + 1}`,
      type: classify(values),
      nullCount: values.filter((v) => v.length === 0).length,
    }
  })

  const dateIdx = columns.findIndex((c) => c.type === 'date')
  const dateRange =
    dateIdx >= 0
      ? resolveDateColumn(columns[dateIdx].name, body.map((r) => (r[dateIdx] ?? '').trim()))
      : undefined

  return {
    rowCount: body.length,
    columns,
    ...(dateRange ? { dateRange } : {}),
    sampleRows: body.slice(0, 3),
    needsSchemaConfirmation: dateRange?.format === 'ambiguous',
  }
}

export type SheetProfile = { name?: string; profile: TableProfile }

/**
 * Profile a file as a LIST of tables, one per worksheet.
 *
 * A workbook is not one table. The xlsx parser emits `## <sheet>` sections, and
 * flattening them stacks unrelated rows under the first sheet's header: a real
 * 4-sheet finance workbook (27 / 26 / 113 / 633 rows) profiled as a single
 * 798-row table with every column typed `text`, because no column was
 * consistent across sheets. Any figure queried from that shape is meaningless.
 */
export function profileWorkbook(text: string, mime: string): SheetProfile[] {
  const isWorkbook = mime === XLSX_MIME || /^\s*##\s/m.test(text)
  if (!isWorkbook) return [{ profile: profileTable(tabularRowsFromText(text, mime)) }]

  const sections: { name?: string; body: string[] }[] = []
  for (const line of text.split('\n')) {
    const heading = /^##\s+(.*)$/.exec(line.trim())
    if (heading) sections.push({ name: heading[1].trim(), body: [] })
    else if (sections.length > 0) sections[sections.length - 1].body.push(line)
  }
  if (sections.length === 0) return [{ profile: profileTable(tabularRowsFromText(text, mime)) }]

  return sections
    .map((s) => ({
      ...(s.name ? { name: s.name } : {}),
      profile: profileTable(rowsFromMarkdownTable(s.body.join('\n'))),
    }))
    .filter((s) => s.profile.columns.length > 0)
}

export type TabularProfileMeta = {
  fileId?: string
  fileName: string
  mime: string
  sheet?: string
}

/**
 * Render the profile as the attachment block. Stays small regardless of file
 * size: columns and three sample rows, never the data.
 */
function openTag(meta: TabularProfileMeta): string {
  const attrs = [
    'kind="tabular"',
    meta.fileId ? `id="${meta.fileId}"` : '',
    `name="${meta.fileName}"`,
    `type="${meta.mime}"`,
    meta.sheet ? `sheet="${meta.sheet}"` : '',
  ]
    .filter(Boolean)
    .join(' ')
  return `<attached_file ${attrs}>`
}

/**
 * Describe one table. Bounded at ANY shape, wide as well as long: a 29-column
 * workbook overran the size budget by listing every column in full. Trim the
 * list, never the count, so the model still knows how wide the table is.
 */
function describeTable(profile: TableProfile, budget: { columns: number; columnChars: number; sampleRows: number }): string[] {
  const described = profile.columns.map(
    (c) => `${c.name} (${c.type}${c.nullCount > 0 ? `, ${c.nullCount} blank` : ''})`,
  )
  let listed = described.slice(0, budget.columns)
  while (listed.join(', ').length > budget.columnChars && listed.length > 1) listed = listed.slice(0, -1)
  const hidden = profile.columns.length - listed.length
  const cols = listed.join(', ') + (hidden > 0 ? `, and ${hidden} more` : '')

  const lines: string[] = []
  lines.push(`rows: ${profile.rowCount}`)
  lines.push(`columns: ${profile.columns.length} total: ${cols}`)
  if (profile.dateRange) {
    lines.push(
      profile.dateRange.format === 'ambiguous'
        ? `date column "${profile.dateRange.column}": ORDERING AMBIGUOUS (day-first vs month-first cannot be determined). Confirm with the user before using any date filter.`
        : `date column "${profile.dateRange.column}" [${profile.dateRange.format}]: ${profile.dateRange.min} to ${profile.dateRange.max}`,
    )
  }
  const samples = profile.sampleRows.slice(0, budget.sampleRows)
  if (samples.length > 0) {
    lines.push(`sample rows (illustrative only, ${samples.length} of ${profile.rowCount}):`)
    const MAX_SAMPLE_CHARS = 260
    for (const r of samples) {
      const joined = r.join(' | ')
      lines.push(`  ${joined.length > MAX_SAMPLE_CHARS ? `${joined.slice(0, MAX_SAMPLE_CHARS)} ...` : joined}`)
    }
  }
  return lines
}

function closingInstruction(meta: TabularProfileMeta, subject: string): string {
  return (
    `The rows of ${subject} are NOT in this message and cannot be read from it. ` +
    'Do NOT compute or state any total, sum, count, average, maximum, or trend ' +
    'from the sample rows above: they are a handful of rows and describe nothing. ' +
    (meta.fileId
      ? 'Query the file for any figure, and report the figure with the rows it matched.'
      : 'No file handle is available, so say you cannot compute exact figures for this file.')
  )
}

export function renderTabularProfile(profile: TableProfile, meta: TabularProfileMeta): string {
  const lines: string[] = [openTag(meta)]
  lines.push(...describeTable(profile, { columns: 18, columnChars: 700, sampleRows: 3 }))
  lines.push('')
  lines.push(closingInstruction(meta, 'this file'))
  lines.push('</attached_file>')
  return lines.join('\n')
}

/**
 * Render one block covering every worksheet. Each sheet keeps its own row
 * count, columns and date range, so a figure can be attributed to the sheet it
 * came from.
 */
export function renderWorkbookProfile(sheets: SheetProfile[], meta: TabularProfileMeta): string {
  if (sheets.length === 1 && !sheets[0].name) return renderTabularProfile(sheets[0].profile, meta)

  // Share the budget across sheets so a many-sheet workbook stays bounded.
  const perSheet = Math.max(4, Math.floor(24 / Math.max(1, sheets.length)))
  const lines: string[] = [openTag(meta)]
  lines.push(`sheets: ${sheets.length}`)
  for (const s of sheets) {
    lines.push('')
    lines.push(`### sheet "${s.name ?? 'unnamed'}"`)
    lines.push(
      ...describeTable(s.profile, {
        columns: perSheet,
        columnChars: Math.max(160, Math.floor(1200 / sheets.length)),
        sampleRows: sheets.length > 3 ? 1 : 2,
      }),
    )
  }
  lines.push('')
  lines.push(closingInstruction(meta, 'these sheets'))
  lines.push('</attached_file>')
  return lines.join('\n')
}
