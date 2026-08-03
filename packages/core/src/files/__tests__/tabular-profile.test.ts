import { describe, it, expect } from 'vitest'
import {
  isTabular,
  tabularRowsFromText,
  profileTable,
  renderTabularProfile,
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
    it('recognises csv, tsv and xlsx', () => {
      expect(isTabular('text/csv', 'a.csv')).toBe(true)
      expect(isTabular('text/tab-separated-values', 'a.tsv')).toBe(true)
      expect(
        isTabular('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'a.xlsx'),
      ).toBe(true)
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
