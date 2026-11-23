import { describe, expect, it } from 'vitest'
import { parseCsv } from '../../linkedin-import/csv.js'
import { CRM_CSV_CHUNK_ROWS, indexCrmCsv, readCrmCsvChunk } from '../import-csv.js'

describe('[COMP:crm/production-import] logical CSV index', () => {
  it('preserves the old parser and receipt ordinals across byte boundaries', () => {
    const prefix = Buffer.from('\uFEFF\r\nName,Notes\r\n,\r\n' + Array.from({ length: 49 }, (_, i) => `Row ${i},example\r\n`).join(''))
    const suffix = Buffer.from('"spans\r\nlines","escaped ""quote"""\r\n\r\n\uFEFFutf8,π 😀\nmalformed,"closed"tail\ra,b\r"unclosed')
    const bytes = Buffer.concat([prefix, Buffer.from([0x22, 0xc2, 0x22, 0xa2, 0x0a]), suffix, Buffer.from([0xff])])
    const old = parseCsv(bytes.toString('utf8')).filter(record => record.cells.some(cell => cell.trim())).slice(1)
      .map((record, index) => ({ row: index + 2, cells: record.cells, malformedReason: record.malformedReason }))
    const index = indexCrmCsv(bytes)
    const rows = index.spans.flatMap((span, i) => readCrmCsvChunk(bytes.subarray(span.start, span.end), span, i, index.totalRows))
    expect(index.headers).toEqual(['Name', 'Notes'])
    expect(rows).toEqual(old)
    expect(rows[49]).toMatchObject({ row: 51, cells: ['��'] })
    expect(rows[50]).toMatchObject({ row: 52, cells: ['spans\r\nlines', 'escaped "quote"'] })
    expect(rows[51]).toMatchObject({ row: 53, cells: ['\uFEFFutf8', 'π 😀'] })
  })

  it('consumes only its own span for every one of 2,000 resumes and a retry', () => {
    const bytes = Buffer.from('Name,Notes\n' + Array.from({ length: 100_000 }, (_, i) => `Row ${i},π\n`).join(''))
    const index = indexCrmCsv(bytes)
    expect(index.spans).toHaveLength(2_000)
    expect(index.totalRows).toBe(100_000)
    let bytesRead = 0
    function resume(chunkIndex: number) {
      const span = index.spans[chunkIndex]!
      const range = bytes.subarray(span.start, span.end)
      bytesRead += range.length
      return readCrmCsvChunk(range, span, chunkIndex, index.totalRows)
    }
    for (const [chunkIndex] of index.spans.entries()) {
      const rows = resume(chunkIndex)
      expect(rows).toHaveLength(CRM_CSV_CHUNK_ROWS)
      expect(rows[0]?.row).toBe(chunkIndex * CRM_CSV_CHUNK_ROWS + 2)
    }
    expect(bytesRead).toBe(bytes.length - Buffer.byteLength('Name,Notes\n') - index.spans.length)
    const beforeRetry = bytesRead
    const last = index.spans.at(-1)!
    expect(resume(1999).at(-1)).toMatchObject({ row: 100_001, cells: ['Row 99999', 'π'] })
    expect(bytesRead - beforeRetry).toBe(last.end - last.start)
    const changed = Buffer.from(bytes.subarray(last.start, last.end))
    changed[0] = changed[0]! ^ 1
    expect(() => readCrmCsvChunk(changed, last, 1999, index.totalRows)).toThrow('chunk integrity')
  })

  it('keeps an empty checkpoint for a header-only file', () => {
    const index = indexCrmCsv(Buffer.from('Name\n\n'))
    expect(index.totalRows).toBe(0)
    expect(index.spans).toHaveLength(1)
    expect(readCrmCsvChunk(Buffer.alloc(0), index.spans[0]!, 0, 0)).toEqual([])
  })
})
