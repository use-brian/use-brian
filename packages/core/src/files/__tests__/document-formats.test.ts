import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  detectDocumentFormat,
  documentFormatFromMetadata,
  isStructuredDocument,
  isTabularDocument,
} from '../document-formats.js'
import {
  MAX_OFFICE_ARCHIVE_ENTRIES,
  MAX_OFFICE_ARCHIVE_ENTRY_BYTES,
  MAX_OFFICE_ARCHIVE_TOTAL_BYTES,
  OfficeArchiveLimitError,
  assertOfficeArchiveBudget,
} from '../office-archive-safety.js'

const sampleDocx = readFileSync(new URL('./fixtures/sample.docx', import.meta.url))

describe('[COMP:files/document-formats] document format authority', () => {
  it('normalizes case and uses a known extension when transport MIME is generic', () => {
    expect(documentFormatFromMetadata('application/octet-stream', 'REPORT.DOCM')).toBe('docx')
    expect(documentFormatFromMetadata('application/octet-stream', 'DATA.CSV')).toBe('csv')
    expect(isStructuredDocument('application/octet-stream', 'brief.ODT')).toBe(true)
  })

  it('recognizes OpenDocument, legacy Office, ebook, and macro MIME aliases', () => {
    expect(documentFormatFromMetadata('application/vnd.oasis.opendocument.presentation')).toBe('odp')
    expect(documentFormatFromMetadata('application/vnd.ms-excel')).toBe('xlsx')
    expect(documentFormatFromMetadata('application/epub+zip')).toBe('epub')
    expect(documentFormatFromMetadata('application/vnd.ms-word.document.macroEnabled.12')).toBe('docx')
  })

  it('uses byte identity ahead of an incorrect text filename and MIME', async () => {
    expect(await detectDocumentFormat(sampleDocx, 'text/plain', 'notes.txt')).toBe('docx')
    expect(
      await detectDocumentFormat(Buffer.from('%PDF-1.7\nbody'), 'text/plain', 'notes.txt'),
    ).toBe('pdf')
  })

  it('keeps every spreadsheet container in the tabular posture', () => {
    expect(isTabularDocument('application/octet-stream', 'ledger.xlsm')).toBe(true)
    expect(isTabularDocument('application/vnd.oasis.opendocument.spreadsheet')).toBe(true)
    expect(isTabularDocument('application/pdf', 'report.pdf')).toBe(false)
  })
})

describe('[COMP:files/document-formats] Office archive budgets', () => {
  it('accepts entries within every fixed budget', () => {
    expect(() =>
      assertOfficeArchiveBudget([
        { name: 'xl/workbook.xml', uncompressedSize: 1_024 },
        { name: 'xl/worksheets/sheet1.xml', uncompressedSize: 2_048 },
      ]),
    ).not.toThrow()
  })

  it.each([
    [
      'entry count',
      Array.from({ length: MAX_OFFICE_ARCHIVE_ENTRIES + 1 }, (_, index) => ({
        name: `${index}.xml`,
        uncompressedSize: 0,
      })),
    ],
    [
      'single entry',
      [{ name: 'huge.xml', uncompressedSize: MAX_OFFICE_ARCHIVE_ENTRY_BYTES + 1 }],
    ],
    [
      'expanded total',
      [
        { name: 'a.xml', uncompressedSize: MAX_OFFICE_ARCHIVE_ENTRY_BYTES },
        { name: 'b.xml', uncompressedSize: MAX_OFFICE_ARCHIVE_ENTRY_BYTES },
        { name: 'c.xml', uncompressedSize: MAX_OFFICE_ARCHIVE_ENTRY_BYTES },
        { name: 'd.xml', uncompressedSize: MAX_OFFICE_ARCHIVE_ENTRY_BYTES },
        { name: 'e.xml', uncompressedSize: 1 },
      ],
    ],
  ])('rejects an archive over the %s budget', (_case, entries) => {
    expect(() => assertOfficeArchiveBudget(entries)).toThrow(OfficeArchiveLimitError)
  })
})
