/** Logical CRM rows and their exact source byte ranges. [COMP:crm/production-import] */
import { createHash } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { scanCsvRecords } from '../linkedin-import/csv.js'

export const CRM_CSV_PARSER_VERSION = 1
export const CRM_CSV_CHUNK_ROWS = 50
export const MAX_CRM_CSV_ROWS = 100_000

export type CrmCsvRow = { row: number; cells: string[]; malformedReason?: string }
export type CrmCsvSpan = { start: number; end: number; hash: string }
export type CrmCsvLayout = { headers: string[]; totalRows: number; sourceHash: string }

export const hashCsvBytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

function* records(bytes: Buffer, firstSourceRecord = false) {
  // CSV syntax is ASCII. The one-code-unit-per-byte view preserves offsets,
  // including invalid UTF-8 the original member importer decoded as replacement characters.
  const utf8 = isUtf8(bytes)
  for (const record of scanCsvRecords(bytes.toString('latin1'))) {
    // The decoder used to precede CSV syntax handling. For invalid UTF-8,
    // decode the raw record so removing a quote cannot join invalid byte sequences.
    const decoded = utf8 ? undefined : scanCsvRecords(bytes.subarray(record.startOffset, record.endOffset).toString('utf8')).next().value
    const cells = decoded?.cells ?? record.cells.map(cell => Buffer.from(cell, 'latin1').toString('utf8'))
    if (firstSourceRecord && record.rowOrdinal === 1 && cells[0]?.startsWith('\uFEFF')) cells[0] = cells[0].slice(1)
    if (cells.some(cell => cell.trim())) yield { ...record, cells, malformedReason: decoded ? decoded.malformedReason : record.malformedReason }
  }
}

export function indexCrmCsv(bytes: Buffer): CrmCsvLayout & { spans: CrmCsvSpan[] } {
  const iterator = records(bytes, true)
  const first = iterator.next()
  if (first.done) throw new Error('The staged CSV is empty.')
  const headers = first.value.cells.map((header, index) => header.trim() || `Column ${index + 1}`)
  const spans: CrmCsvSpan[] = []
  let totalRows = 0
  let start = 0, end = 0
  const finishChunk = () => spans.push({ start, end, hash: hashCsvBytes(bytes.subarray(start, end)) })
  for (const record of iterator) {
    if (totalRows % CRM_CSV_CHUNK_ROWS === 0) start = record.startOffset
    end = record.endOffset
    totalRows += 1
    if (totalRows > MAX_CRM_CSV_ROWS) throw new Error('CRM imports are limited to 100000 data rows per job.')
    if (totalRows % CRM_CSV_CHUNK_ROWS === 0) finishChunk()
  }
  if (!totalRows || totalRows % CRM_CSV_CHUNK_ROWS !== 0) finishChunk()
  return { headers, spans, totalRows, sourceHash: hashCsvBytes(bytes) }
}

export function readCrmCsvChunk(bytes: Buffer, span: CrmCsvSpan, chunkIndex: number, totalRows: number): CrmCsvRow[] {
  if (bytes.byteLength !== span.end - span.start || hashCsvBytes(bytes) !== span.hash) {
    throw new Error('The staged import file failed its chunk integrity check.')
  }
  const start = chunkIndex * CRM_CSV_CHUNK_ROWS
  const rows = Array.from(records(bytes), ({ cells, malformedReason }, index) => ({ row: start + index + 2, cells, malformedReason }))
  if (rows.length !== Math.min(CRM_CSV_CHUNK_ROWS, totalRows - start)) throw new Error('The staged CSV chunk has an unexpected row count.')
  return rows
}
