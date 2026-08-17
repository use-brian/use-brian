import { describe, expect, it } from 'vitest'
import { applyOfficeCommand } from '../commands.js'
import { recalculateSpreadsheet, spreadsheetCellDisplayValue } from '../spreadsheet.js'
import { id, spreadsheetFixture } from './fixtures.js'

describe('[COMP:office/spreadsheet-model] Spreadsheet model and calculation', () => {
  it('recalculates invoice arithmetic and deterministic supported functions', () => {
    const source = spreadsheetFixture()
    const sheet = source.worksheets[0]
    sheet.cells.push(
      { id: id(27), address: 'A2', valueType: 'number', value: null, formula: 'SUM(A1:B1)', calculatedValue: null, style: {}, locked: false },
      { id: id(28), address: 'B2', valueType: 'number', value: null, formula: 'IF(OR(A1=0,B1=0),0,SUMPRODUCT(A1:B1,A1:B1))', calculatedValue: null, style: {}, locked: false },
    )
    const calculated = recalculateSpreadsheet(source)
    expect(calculated.issues).toEqual([])
    expect(calculated.snapshot.worksheets[0].cells.find((cell) => cell.address === 'C1')?.calculatedValue).toBe(8)
    expect(calculated.snapshot.worksheets[0].cells.find((cell) => cell.address === 'A2')?.calculatedValue).toBe(6)
    expect(calculated.snapshot.worksheets[0].cells.find((cell) => cell.address === 'B2')?.calculatedValue).toBe(20)
  })

  it('applies a cell edit without mutating the base and recalculates dependants', () => {
    const source = spreadsheetFixture()
    const next = applyOfficeCommand(source, { commandId: id(80), artifactId: source.artifactId, baseVersion: 1, actor: { type: 'user', id: id(81) }, origin: 'manual', kind: 'setSpreadsheetCell', sheetId: id(23), cellId: id(24), address: 'A1', valueType: 'number', value: 5 })
    expect(source.worksheets[0].cells[0].value).toBe(2)
    expect(next.family === 'spreadsheet' && next.worksheets[0].cells.find((cell) => cell.address === 'C1')?.calculatedValue).toBe(20)
  })

  it('resizes one sparse row or column without replacing neighboring dimensions', () => {
    const source = spreadsheetFixture()
    const common = { artifactId: source.artifactId, baseVersion: 1, actor: { type: 'user' as const, id: id(81) }, origin: 'manual' as const, sheetId: id(23) }
    const column = applyOfficeCommand(source, { ...common, commandId: id(82), kind: 'setSpreadsheetDimension', axis: 'column', index: 2, size: 31 })
    const row = applyOfficeCommand(column, { ...common, commandId: id(83), kind: 'setSpreadsheetDimension', axis: 'row', index: 4, size: 27 })
    if (row.family !== 'spreadsheet') throw new Error('spreadsheet fixture required')
    expect(source.worksheets[0].columnDimensions).toEqual([])
    expect(row.worksheets[0].columnDimensions).toContainEqual({ index: 2, widthChars: 31, hidden: false })
    expect(row.worksheets[0].rowDimensions).toContainEqual({ index: 4, heightPt: 27, hidden: false })
  })

  it('updates worksheet image layout and accessibility through one bounded command', () => {
    const source = spreadsheetFixture()
    source.worksheets[0].images = [{ id: id(92), resourceId: id(93), altText: 'Logo', decorative: false, from: { row: 1, column: 1 }, to: { row: 2, column: 2 } }]
    const next = applyOfficeCommand(source, { commandId: id(94), artifactId: source.artifactId, baseVersion: 1, actor: { type: 'user', id: id(81) }, origin: 'manual', kind: 'updateSpreadsheetImage', sheetId: source.worksheets[0].id, imageId: id(92), from: { row: 2, column: 0.5 }, to: { row: 3.5, column: 2.5 }, altText: 'Updated logo', decorative: false })
    if (next.family !== 'spreadsheet') throw new Error('spreadsheet fixture required')
    expect(next.worksheets[0].images[0]).toMatchObject({ from: { row: 2, column: 0.5 }, to: { row: 3.5, column: 2.5 }, altText: 'Updated logo', decorative: false })
    expect(source.worksheets[0].images[0]).toMatchObject({ from: { row: 1, column: 1 }, altText: 'Logo' })
    expect(() => applyOfficeCommand(source, { commandId: id(95), artifactId: source.artifactId, baseVersion: 1, actor: { type: 'user', id: id(81) }, origin: 'manual', kind: 'updateSpreadsheetImage', sheetId: source.worksheets[0].id, imageId: id(92), from: { row: 2, column: 2 }, to: { row: 1, column: 3 }, altText: '', decorative: true })).toThrow(/positive width and height/)
  })

  it('surfaces formula errors instead of silently keeping stale values', () => {
    const source = spreadsheetFixture()
    source.worksheets[0].cells[2].formula = 'MISSING(A1)'
    const calculated = recalculateSpreadsheet(source)
    expect(calculated.issues).toContainEqual(expect.objectContaining({ address: 'C1', error: '#NAME?' }))
    expect(calculated.snapshot.worksheets[0].cells[2].calculatedValue).toBeNull()
  })

  it('keeps typed values separate from invoice display formatting', () => {
    expect(spreadsheetCellDisplayValue({ id: id(82), address: 'A1', valueType: 'number', value: 0.125, numberFormat: '0.0%', style: {}, locked: false })).toBe('12.5%')
    expect(spreadsheetCellDisplayValue({ id: id(83), address: 'A2', valueType: 'date', value: '2026-08-05T00:00:00.000Z', numberFormat: 'yyyy-mm-dd', style: {}, locked: false })).toBe('2026-08-05')
    expect(spreadsheetCellDisplayValue({ id: id(90), address: 'A3', valueType: 'number', value: 1_200, numberFormat: '"USD "#,##0.00', style: {}, locked: false })).toBe('USD 1,200.00')
    expect(spreadsheetCellDisplayValue({ id: id(91), address: 'A4', valueType: 'number', value: 1, numberFormat: '0.00', style: {}, locked: false })).toBe('1.00')
  })

  it('adds, renames, reorders, and deletes worksheets without mutating the base', () => {
    const source = spreadsheetFixture()
    const actor = { type: 'user' as const, id: id(84) }
    const worksheet = { ...structuredClone(source.worksheets[0]), id: id(85), name: 'Details', cells: [] }
    const added = applyOfficeCommand(source, { commandId: id(86), artifactId: source.artifactId, baseVersion: 1, actor, origin: 'manual', kind: 'addWorksheet', index: 1, worksheet })
    const renamed = applyOfficeCommand(added, { commandId: id(87), artifactId: source.artifactId, baseVersion: 2, actor, origin: 'manual', kind: 'renameWorksheet', sheetId: worksheet.id, name: 'Line items' })
    const reordered = applyOfficeCommand(renamed, { commandId: id(88), artifactId: source.artifactId, baseVersion: 3, actor, origin: 'manual', kind: 'reorderWorksheet', sheetId: worksheet.id, index: 0 })
    const deleted = applyOfficeCommand(reordered, { commandId: id(89), artifactId: source.artifactId, baseVersion: 4, actor, origin: 'manual', kind: 'deleteWorksheet', sheetId: worksheet.id })

    expect(source.worksheets).toHaveLength(1)
    expect(added.family === 'spreadsheet' && added.worksheets.map((sheet) => sheet.name)).toEqual(['Invoice', 'Details'])
    expect(renamed.family === 'spreadsheet' && renamed.worksheets[1].name).toBe('Line items')
    expect(reordered.family === 'spreadsheet' && reordered.worksheets[0].name).toBe('Line items')
    expect(deleted.family === 'spreadsheet' && deleted.worksheets.map((sheet) => sheet.name)).toEqual(['Invoice'])
  })
})
