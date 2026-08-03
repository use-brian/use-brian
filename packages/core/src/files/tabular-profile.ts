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
const TABULAR_MIMES = new Set(['text/csv', 'text/tab-separated-values', XLSX_MIME])
const TABULAR_EXTS = ['.csv', '.tsv', '.xlsx']

export function isTabular(mime: string, fileName: string): boolean {
  if (TABULAR_MIMES.has(mime)) return true
  const lower = fileName.toLowerCase()
  return TABULAR_EXTS.some((e) => lower.endsWith(e))
}

/** Quote-aware split of one delimited line. Accounting exports quote freely. */
function splitDelimited(line: string, delim: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else inQuotes = false
      } else cur += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === delim) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim())
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
  const delim = mime === 'text/tab-separated-values' || text.includes('\t') ? '\t' : ','
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => splitDelimited(l, delim))
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
export function renderTabularProfile(profile: TableProfile, meta: TabularProfileMeta): string {
  const attrs = [
    'kind="tabular"',
    meta.fileId ? `id="${meta.fileId}"` : '',
    `name="${meta.fileName}"`,
    `type="${meta.mime}"`,
    meta.sheet ? `sheet="${meta.sheet}"` : '',
  ]
    .filter(Boolean)
    .join(' ')

  const cols = profile.columns
    .map((c) => `${c.name} (${c.type}${c.nullCount > 0 ? `, ${c.nullCount} blank` : ''})`)
    .join(', ')

  const lines: string[] = []
  lines.push(`<attached_file ${attrs}>`)
  lines.push(`rows: ${profile.rowCount}`)
  lines.push(`columns: ${cols}`)
  if (profile.dateRange) {
    lines.push(
      profile.dateRange.format === 'ambiguous'
        ? `date column "${profile.dateRange.column}": ORDERING AMBIGUOUS (day-first vs month-first cannot be determined). Confirm with the user before using any date filter.`
        : `date column "${profile.dateRange.column}" [${profile.dateRange.format}]: ${profile.dateRange.min} to ${profile.dateRange.max}`,
    )
  }
  if (profile.sampleRows.length > 0) {
    lines.push(`sample rows (illustrative only, ${profile.sampleRows.length} of ${profile.rowCount}):`)
    for (const r of profile.sampleRows) lines.push(`  ${r.join(' | ')}`)
  }
  lines.push('')
  lines.push(
    'The rows of this file are NOT in this message and cannot be read from it. ' +
      'Do NOT compute or state any total, sum, count, average, maximum, or trend ' +
      'from the sample rows above: they are three rows out of ' +
      `${profile.rowCount} and describe nothing. ` +
      (meta.fileId
        ? 'Query the file for any figure, and report the figure with the rows it matched.'
        : 'No file handle is available, so say you cannot compute exact figures for this file.'),
  )
  lines.push('</attached_file>')
  return lines.join('\n')
}
