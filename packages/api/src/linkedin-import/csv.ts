/**
 * RFC-4180-shaped CSV parsing with record/line provenance. Syntax errors do not
 * drop a record: they mark it malformed and retain its decoded cells + hash.
 *
 * [COMP:brain/linkedin-import]
 */

import { sha256 } from './archive.js'
import type { LinkedInLedgerRow, ParsedCsvRecord, ParsedLinkedInCsv } from './types.js'

export function parseCsv(text: string): ParsedCsvRecord[] {
  if (text.length === 0) return []

  const records: ParsedCsvRecord[] = []
  let cells: string[] = []
  let field = ''
  let inQuotes = false
  let justClosedQuote = false
  let malformedReason: string | undefined
  let recordStart = 0
  let startLine = 1
  let line = 1

  const pushRecord = (endOffset: number, endLine: number) => {
    cells.push(field)
    if (records.length === 0 && cells[0]?.charCodeAt(0) === 0xfeff) {
      cells[0] = cells[0].slice(1)
    }
    const raw = text.slice(recordStart, endOffset)
    records.push({
      rowOrdinal: records.length + 1,
      startLine,
      endLine,
      cells,
      raw,
      rawSha256: sha256(raw),
      ...(malformedReason ? { malformedReason } : {}),
    })
    cells = []
    field = ''
    malformedReason = undefined
    justClosedQuote = false
  }

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
          justClosedQuote = true
        }
      } else {
        field += ch
        if (ch === '\n') line += 1
      }
      continue
    }

    if (ch === '"') {
      if (field.length === 0 && !justClosedQuote) {
        inQuotes = true
      } else {
        malformedReason ??= 'unexpected_quote_in_unquoted_field'
        field += ch
      }
      continue
    }
    if (ch === ',') {
      cells.push(field)
      field = ''
      justClosedQuote = false
      continue
    }
    if (ch === '\r' && text[i + 1] === '\n') {
      pushRecord(i, line)
      i += 1
      line += 1
      recordStart = i + 1
      startLine = line
      continue
    }
    if (ch === '\n' || ch === '\r') {
      pushRecord(i, line)
      line += 1
      recordStart = i + 1
      startLine = line
      continue
    }
    if (justClosedQuote) {
      malformedReason ??= 'unexpected_character_after_closing_quote'
    }
    field += ch
  }

  if (inQuotes) malformedReason ??= 'unclosed_quoted_field'
  // A terminal newline already emitted the final record. Otherwise the tail is
  // a logical record, including a one-cell blank record for text === "" only
  // (handled by the early return above).
  if (recordStart < text.length) pushRecord(text.length, line)
  return records
}
function normalizedHeader(cell: string): string {
  return cell.trim().toLowerCase().replace(/\s+/g, ' ')
}

const KNOWN_REQUIRED_HEADERS: Record<string, readonly string[]> = {
  'connections.csv': ['first name', 'last name', 'url', 'connected on'],
  'messages.csv': ['conversation id', 'from', 'to', 'date', 'content'],
  'importedcontacts.csv': ['first name', 'last name'],
  'contacts.csv': ['first name', 'last name'],
  'profile.csv': ['first name', 'last name'],
}

export function discoverHeaderRow(memberPath: string, records: ParsedCsvRecord[]): number | null {
  const basename = memberPath.split('/').pop()?.toLowerCase() ?? memberPath.toLowerCase()
  const required = KNOWN_REQUIRED_HEADERS[basename]
  const candidates = records.slice(0, 20)
  if (required) {
    for (const record of candidates) {
      const cells = new Set(record.cells.map(normalizedHeader))
      if (required.every((header) => cells.has(header))) return record.rowOrdinal
    }
  }
  const firstNonBlank = candidates.find((record) => record.cells.some((cell) => cell.trim().length > 0))
  return firstNonBlank?.rowOrdinal ?? null
}

export function valuesFromCells(headers: string[], cells: string[]): Record<string, string> {
  const values: Record<string, string> = {}
  const used = new Map<string, number>()
  for (let i = 0; i < Math.max(headers.length, cells.length); i += 1) {
    const base = headers[i]?.trim() || `_column_${i + 1}`
    const seen = (used.get(base) ?? 0) + 1
    used.set(base, seen)
    const key = seen === 1 ? base : `${base}#${seen}`
    values[key] = cells[i] ?? ''
  }
  return values
}

export function parseLinkedInCsv(memberPath: string, bytes: Buffer): ParsedLinkedInCsv {
  const records = parseCsv(bytes.toString('utf8'))
  const headerRowOrdinal = discoverHeaderRow(memberPath, records)
  const headerCells = headerRowOrdinal === null ? null : records[headerRowOrdinal - 1]?.cells ?? null
  let dataOrdinal = 0
  const rows: LinkedInLedgerRow[] = records.map((record) => {
    const blank = record.cells.every((cell) => cell.length === 0)
    const recordKind = blank
      ? 'blank'
      : headerRowOrdinal !== null && record.rowOrdinal < headerRowOrdinal
        ? 'preamble'
        : record.rowOrdinal === headerRowOrdinal
          ? 'header'
          : 'data'
    if (recordKind === 'data') dataOrdinal += 1
    const widthMismatch =
      recordKind === 'data' && headerCells !== null && record.cells.length !== headerCells.length
    const outcome = record.malformedReason || widthMismatch ? 'malformed' : 'stored'
    const reason = record.malformedReason
      ?? (widthMismatch
        ? `column_count_mismatch:${record.cells.length}:${headerCells!.length}`
        : recordKind === 'data'
          ? 'unmapped_source_file'
          : recordKind)
    return {
      memberPath,
      rowOrdinal: record.rowOrdinal,
      dataOrdinal: recordKind === 'data' ? dataOrdinal : null,
      recordKind,
      startLine: record.startLine,
      endLine: record.endLine,
      cells: record.cells,
      values: recordKind === 'data' && headerCells ? valuesFromCells(headerCells, record.cells) : null,
      rawSha256: record.rawSha256,
      outcome,
      outcomeReason: reason,
      entityIds: [],
    }
  })
  return { memberPath, headerRowOrdinal, headerCells, rows }
}
