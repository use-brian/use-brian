import { describe, it, expect } from 'vitest'
import {
  isTabular,
  tabularRowsFromText,
  profileTable,
  renderTabularProfile,
  profileWorkbook,
  renderWorkbookProfile,
} from '../tabular-profile.js'

// The profile replaces the ROWS in an attachment turn. Its whole job is to let
// the model answer "what is in this file" honestly and refuse to answer "what
// does it total" from the prompt. See issue #273.
describe('[COMP:files/tabular-profile] Tabular profile', () => {
  const csv = [
    'date,account,amount,note',
    '6/26/23,0012,17.50,opening',
    '7/02/23,0013,-4.25,',
    '8/15/23,0012,100.00,deposit',
  ].join('\n')

  describe('isTabular', () => {
    it('recognises csv, tsv, Excel, and OpenDocument spreadsheets', () => {
      expect(isTabular('text/csv', 'a.csv')).toBe(true)
      expect(isTabular('text/tab-separated-values', 'a.tsv')).toBe(true)
      expect(
        isTabular('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'a.xlsx'),
      ).toBe(true)
      expect(isTabular('application/octet-stream', 'a.XLSM')).toBe(true)
      expect(isTabular('application/vnd.oasis.opendocument.spreadsheet', 'a.ods')).toBe(true)
    })

    it('does not claim prose or binary formats', () => {
      expect(isTabular('text/plain', 'notes.txt')).toBe(false)
      expect(isTabular('application/pdf', 'report.pdf')).toBe(false)
      expect(isTabular('text/markdown', 'readme.md')).toBe(false)
    })

    it('falls back to the extension when the mime is generic', () => {
      expect(isTabular('application/octet-stream', 'ledger.csv')).toBe(true)
    })
  })

  describe('tabularRowsFromText', () => {
    it('reads delimited text', () => {
      const rows = tabularRowsFromText(csv, 'text/csv')
      expect(rows).toHaveLength(4)
      expect(rows[0]).toEqual(['date', 'account', 'amount', 'note'])
      expect(rows[3][3]).toBe('deposit')
    })

    it('reads the markdown tables the xlsx parser produces', () => {
      const md = ['## Ledger', '', '| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'].join('\n')
      const rows = tabularRowsFromText(md, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      expect(rows[0]).toEqual(['a', 'b'])
      expect(rows).toHaveLength(3)
    })
  })

  describe('profileTable', () => {
    it('reports the true row count, excluding the header', () => {
      expect(profileTable(tabularRowsFromText(csv, 'text/csv')).rowCount).toBe(3)
    })

    it('names every column', () => {
      const p = profileTable(tabularRowsFromText(csv, 'text/csv'))
      expect(p.columns.map((c) => c.name)).toEqual(['date', 'account', 'amount', 'note'])
    })

    it('keeps zero-padded codes as text rather than coercing them to numbers', () => {
      const p = profileTable(tabularRowsFromText(csv, 'text/csv'))
      expect(p.columns.find((c) => c.name === 'account')?.type).toBe('text')
    })

    it('types a decimal money column as decimal, not integer', () => {
      const p = profileTable(tabularRowsFromText(csv, 'text/csv'))
      expect(p.columns.find((c) => c.name === 'amount')?.type).toBe('decimal')
    })

    it('counts nulls per column', () => {
      const p = profileTable(tabularRowsFromText(csv, 'text/csv'))
      expect(p.columns.find((c) => c.name === 'note')?.nullCount).toBe(1)
    })

    it('carries at most three sample rows', () => {
      const many = ['h', ...Array.from({ length: 50 }, (_, i) => String(i))].join('\n')
      expect(profileTable(tabularRowsFromText(many, 'text/csv')).sampleRows).toHaveLength(3)
    })
  })

  describe('date handling', () => {
    it('resolves an unambiguous month-first column and reports its range', () => {
      const p = profileTable(tabularRowsFromText(csv, 'text/csv'))
      expect(p.dateRange?.column).toBe('date')
      expect(p.dateRange?.format).toBe('M/D/Y')
      expect(p.dateRange?.min).toBe('2023-06-26')
      expect(p.dateRange?.max).toBe('2023-08-15')
    })

    it('resolves day-first when a day exceeds 12', () => {
      const t = ['d', '26/06/23', '02/07/23'].join('\n')
      expect(profileTable(tabularRowsFromText(t, 'text/csv')).dateRange?.format).toBe('D/M/Y')
    })

    it('refuses to guess when every row is ambiguous, and says so', () => {
      // 1/2/23 could be 1 Feb or 2 Jan. Guessing shifts a fiscal period.
      const t = ['d', '1/2/23', '3/4/23'].join('\n')
      const p = profileTable(tabularRowsFromText(t, 'text/csv'))
      expect(p.dateRange?.format).toBe('ambiguous')
      expect(p.dateRange?.min).toBeUndefined()
      expect(p.needsSchemaConfirmation).toBe(true)
    })

    it('reads ISO dates without ambiguity', () => {
      const t = ['d', '2024-03-01', '2023-11-30'].join('\n')
      const p = profileTable(tabularRowsFromText(t, 'text/csv'))
      expect(p.dateRange?.format).toBe('ISO')
      expect(p.dateRange?.min).toBe('2023-11-30')
      expect(p.dateRange?.max).toBe('2024-03-01')
    })
  })

  describe('renderTabularProfile', () => {
    const p = profileTable(tabularRowsFromText(csv, 'text/csv'))
    const block = renderTabularProfile(p, { fileId: 'f_1', fileName: 'ledger.csv', mime: 'text/csv' })

    it('states the true row count and date range', () => {
      expect(block).toContain('3')
      expect(block).toContain('2023-06-26')
      expect(block).toContain('2023-08-15')
    })

    it('carries the fileId so the model can query the file', () => {
      expect(block).toContain('f_1')
    })

    it('says plainly that the rows are absent', () => {
      expect(block).toMatch(/not in this message/i)
    })

    it('forbids computing figures from the sample', () => {
      expect(block).toMatch(/do not/i)
      expect(block).toMatch(/total|sum|aggregate/i)
    })

    it('does not dump the data', () => {
      // A profile must stay small no matter how large the file is.
      const big = ['a,b', ...Array.from({ length: 100_000 }, (_, i) => `${i},${i * 2}`)].join('\n')
      const bigBlock = renderTabularProfile(
        profileTable(tabularRowsFromText(big, 'text/csv')),
        { fileId: 'f_2', fileName: 'big.csv', mime: 'text/csv' },
      )
      expect(bigBlock.length).toBeLessThan(2000)
      expect(bigBlock).toContain('100000')
    })

    it('uses no em dash (block can surface in user-facing renders)', () => {
      expect(block).not.toContain('—')
    })
  })
})

// Found by running the profiler over a corpus of real exports plus synthetic
// edge cases (2026-08-03). Each of these shipped wrong before the fix.
describe('[COMP:files/tabular-profile] Real-world CSV shapes', () => {
  it('detects a semicolon delimiter (European exports)', () => {
    const t = ['Datum;Konto;Betrag', '15.01.2024;0012;1,50', '16.01.2024;0013;2,50'].join('\n')
    const rows = tabularRowsFromText(t, 'text/csv')
    expect(rows[0]).toEqual(['Datum', 'Konto', 'Betrag'])
    expect(profileTable(rows).columns).toHaveLength(3)
  })

  it('detects a tab delimiter', () => {
    const t = ['a\tb\tc', '1\t2\t3'].join('\n')
    expect(tabularRowsFromText(t, 'text/csv')[0]).toEqual(['a', 'b', 'c'])
  })

  it('does not switch to tabs because one field happens to contain a tab', () => {
    // The old heuristic was `text.includes('\t') ? '\t' : ','`, so a single
    // stray tab collapsed an entire comma CSV into one column.
    const t = ['a,b,c', '1,we\tird,3', '4,5,6'].join('\n')
    expect(tabularRowsFromText(t, 'text/csv')[0]).toEqual(['a', 'b', 'c'])
  })

  it('skips a leading comment preamble and finds the real header (GA4 exports)', () => {
    const t = [
      '# ----------------------------------------',
      '# Reports snapshot',
      '# Account: Example Co',
      '# ----------------------------------------',
      '',
      'date,sessions,users',
      '2024-01-01,10,5',
      '2024-01-02,20,9',
    ].join('\n')
    const rows = tabularRowsFromText(t, 'text/csv')
    expect(rows[0]).toEqual(['date', 'sessions', 'users'])
    expect(profileTable(rows).rowCount).toBe(2)
  })

  it('counts a quoted field containing a newline as ONE row', () => {
    // The row count is the profile's central claim. Splitting on \n first
    // doubled it, which is precisely the kind of confident wrong number the
    // whole lane exists to prevent.
    const t = ['id,note,amount', '1,"line one\nline two",5.00', '2,"plain",6.00'].join('\n')
    const rows = tabularRowsFromText(t, 'text/csv')
    expect(rows).toHaveLength(3)
    expect(profileTable(rows).rowCount).toBe(2)
    expect(rows[1][1]).toBe('line one\nline two')
  })

  it('handles doubled quotes inside a quoted field', () => {
    const t = ['a,b', '1,"he said ""hi"", then left"'].join('\n')
    expect(tabularRowsFromText(t, 'text/csv')[1][1]).toBe('he said "hi", then left')
  })

  it('strips a BOM from the first header cell', () => {
    const t = '﻿id,amount\n1,2'
    expect(tabularRowsFromText(t, 'text/csv')[0][0]).toBe('id')
  })

  it('handles CRLF line endings without leaving carriage returns in cells', () => {
    const t = 'id,amount\r\n1,2\r\n3,4'
    const rows = tabularRowsFromText(t, 'text/csv')
    expect(rows[0]).toEqual(['id', 'amount'])
    expect(rows[2]).toEqual(['3', '4'])
  })
})

describe('[COMP:files/tabular-profile] Profile size is bounded', () => {
  it('stays under 2KB even with many columns', () => {
    // A 29-column workbook produced a 2,506-char block, breaking the size
    // guarantee the spec states.
    const cols = Array.from({ length: 60 }, (_, i) => `a_fairly_long_column_name_${i}`)
    const t = [cols.join(','), ...Array.from({ length: 100 }, () => cols.map(() => 'value').join(','))].join('\n')
    const block = renderTabularProfile(profileTable(tabularRowsFromText(t, 'text/csv')), {
      fileId: 'f',
      fileName: 'wide.csv',
      mime: 'text/csv',
    })
    expect(block.length).toBeLessThan(2000)
    // It must still say how many columns there really are.
    expect(block).toContain('60')
  })

  it('still names the columns when there are few', () => {
    const t = ['alpha,beta', '1,2'].join('\n')
    const block = renderTabularProfile(profileTable(tabularRowsFromText(t, 'text/csv')), {
      fileName: 'n.csv',
      mime: 'text/csv',
    })
    expect(block).toContain('alpha')
    expect(block).toContain('beta')
  })
})

describe('[COMP:files/tabular-profile] Multi-sheet workbooks', () => {
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  // A real 4-sheet finance workbook profiled as ONE 798-row table with every
  // column typed `text`, because rows from unrelated sheets were stacked under
  // the first sheet's header. A query over that shape is nonsense.
  const workbook = [
    '## Summary',
    '',
    '| org | bookings | total |',
    '| --- | --- | --- |',
    '| Acme | 1 | 700 |',
    '| Globex | 2 | 1400 |',
    '',
    '## Charges',
    '',
    '| date | item | amount |',
    '| --- | --- | --- |',
    '| 2024-01-15 | Room | 250.50 |',
    '| 2024-02-20 | Catering | 90.00 |',
    '| 2024-03-01 | Room | 250.50 |',
  ].join('\n')

  it('profiles each sheet separately', () => {
    const sheets = profileWorkbook(workbook, XLSX)
    expect(sheets).toHaveLength(2)
    expect(sheets[0].name).toBe('Summary')
    expect(sheets[1].name).toBe('Charges')
  })

  it('reports each sheet its own row count', () => {
    const sheets = profileWorkbook(workbook, XLSX)
    expect(sheets[0].profile.rowCount).toBe(2)
    expect(sheets[1].profile.rowCount).toBe(3)
  })

  it('types each sheet against its own header rather than collapsing to text', () => {
    const sheets = profileWorkbook(workbook, XLSX)
    expect(sheets[1].profile.columns.find((c) => c.name === 'amount')?.type).toBe('decimal')
    expect(sheets[1].profile.dateRange?.min).toBe('2024-01-15')
  })

  it('renders every sheet, named, within the size budget', () => {
    const block = renderWorkbookProfile(profileWorkbook(workbook, XLSX), {
      fileId: 'f',
      fileName: 'finance.xlsx',
      mime: XLSX,
    })
    expect(block).toContain('Summary')
    expect(block).toContain('Charges')
    expect(block).toMatch(/do not compute or state any total/i)
    expect(block.length).toBeLessThan(2000)
  })

  it('treats a plain CSV as a single unnamed sheet', () => {
    const sheets = profileWorkbook('a,b\n1,2\n3,4', 'text/csv')
    expect(sheets).toHaveLength(1)
    expect(sheets[0].name).toBeUndefined()
    expect(sheets[0].profile.rowCount).toBe(2)
  })
})
