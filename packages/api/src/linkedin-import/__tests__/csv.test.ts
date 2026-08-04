import { describe, expect, it } from 'vitest'

import { parseCsv, parseLinkedInCsv, valuesFromCells } from '../csv.js'

describe('[COMP:brain/linkedin-import] lossless CSV ledger', () => {
  it('discovers the Connections preamble and retains every logical record', () => {
    const text = [
      'Notes:',
      'Exported by LinkedIn',
      '',
      'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
      'Ada,Lovelace,https://linkedin.com/in/ada,,Analytical Engines,"Founder, Research",01 Jan 2020',
      'Grace,Hopper,https://linkedin.com/in/grace',
      '',
    ].join('\r\n')
    const parsed = parseLinkedInCsv('Connections.csv', Buffer.from(text))

    expect(parsed.headerRowOrdinal).toBe(4)
    expect(parsed.rows).toHaveLength(6) // terminal CRLF does not invent a seventh row
    expect(parsed.rows.map((row) => row.recordKind)).toEqual([
      'preamble', 'preamble', 'blank', 'header', 'data', 'data',
    ])
    expect(parsed.rows[4].values?.Position).toBe('Founder, Research')
    expect(parsed.rows[5]).toMatchObject({
      outcome: 'malformed',
      outcomeReason: 'column_count_mismatch:3:7',
    })
  })

  it('parses embedded newlines and escaped quotes with physical line provenance', () => {
    const records = parseCsv('A,B\n1,"hello\n""world"""\n')
    expect(records).toHaveLength(2)
    expect(records[1].cells).toEqual(['1', 'hello\n"world"'])
    expect(records[1]).toMatchObject({ startLine: 2, endLine: 3 })
  })

  it('retains malformed quoted records instead of throwing or dropping them', () => {
    const records = parseCsv('A,B\n1,"never closes')
    expect(records).toHaveLength(2)
    expect(records[1].cells).toEqual(['1', 'never closes'])
    expect(records[1].malformedReason).toBe('unclosed_quoted_field')
  })

  it('preserves duplicate and blank headers with deterministic surrogate keys', () => {
    expect(valuesFromCells(['Email', 'Email', ''], ['a@x.test', 'b@x.test', 'tail'])).toEqual({
      Email: 'a@x.test',
      'Email#2': 'b@x.test',
      _column_3: 'tail',
    })
  })

  it('returns no phantom row for an empty member', () => {
    expect(parseLinkedInCsv('Empty.csv', Buffer.alloc(0))).toMatchObject({
      headerRowOrdinal: null,
      headerCells: null,
      rows: [],
    })
  })
})
