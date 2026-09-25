import { recordsFixture, setCellText } from '../../structured-documents/__tests__/fixtures.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyOfficeCommand, applyOfficeSuggestion, snapshotToYDoc, yDocToSnapshot, type SpreadsheetSnapshot } from '@use-brian/office-model'
import { resolveObservation, type SourceRecords } from '../../structured-documents/records.js'
import { FillMappingSchema, prepareStructuredFill, type FillMapping } from '../structured-fill.js'

// Source conflict/ambiguity validation belongs to the parser's own suite. These
// fixtures exercise the binder at its typed-observation boundary.
vi.mock('../../structured-documents/records.js', () => ({ resolveObservation: vi.fn() }))
const uid = (n: number) => `38000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function workbook(): SpreadsheetSnapshot {
  return {
    schemaVersion: 1, capabilityVersion: 1, workspaceId: uid(2), locale: 'en-US', defaultLanguage: 'en-US', templateVersionId: null,
    resources: [], accessibility: { title: 'Synthetic' }, artifactId: uid(1), family: 'spreadsheet', rootId: uid(3), title: 'Synthetic',
    activeSheetId: uid(4), calculationMode: 'automatic', worksheets: [{
      id: uid(4), name: 'Inputs', visibility: 'visible',
      cells: [
        { id: uid(5), address: 'A1', valueType: 'number', value: 2, numberFormat: '0.00', style: { fill: "#EEEEEE" }, locked: false },
        { id: uid(6), address: 'B1', valueType: 'number', value: 4, style: {}, locked: false },
        { id: uid(7), address: 'C1', valueType: 'number', value: null, formula: 'B1*2', calculatedValue: 8, style: {}, locked: false },
      ],
      merges: [], rowDimensions: [], columnDimensions: [], freeze: { rows: 0, columns: 0 }, images: [], validations: [], conditionalFormats: [],
      print: { paperSize: 'A4', orientation: 'portrait', fitToWidth: 1, fitToHeight: 1, margins: { leftIn: 0.7, rightIn: 0.7, topIn: 0.75, bottomIn: 0.75, headerIn: 0.3, footerIn: 0.3 }, horizontalCentered: false, verticalCentered: false, showGridLines: false, showHeadings: false },
    }],
  }
}
const mapping = (targetId = uid(5), cellId = 'c1'): FillMapping => ({ targetId, source: { kind: 'cell', recordId: 'r1', cellId }, meaning: 'Reported amount', reason: 'Selected evidence' })
const observation = { valueType: 'number' as const, rawText: '12.50', decimalValue: '12.50', page: 1, sourceRefs: ['ocr:1'], flags: ['requires_review'] }
function input() { return { snapshot: workbook(), records: {} as SourceRecords, artifactId: uid(1), assistantId: uid(90), expectedVersion: 7, mappings: [mapping()] } }
beforeEach(() => { vi.mocked(resolveObservation).mockReset(); vi.mocked(resolveObservation).mockReturnValue(observation) })

describe('[COMP:office/structured-fill] deterministic proposal binder', () => {
  it('binds actual records and accepts the source-backed batch into a live workbook', async () => {
    const real = await vi.importActual<typeof import('../../structured-documents/records.js')>('../../structured-documents/records.js')
    vi.mocked(resolveObservation).mockImplementation(real.resolveObservation)
    const args = input()
    args.records = real.parseSourceRecords(recordsFixture())
    const result = prepareStructuredFill(args)
    expect(result.preview[0]).toMatchObject({ valueType: 'string', proposedValue: '00123', rawText: '00123', sourceRefs: ['c1', 'o1'] })
    const doc = snapshotToYDoc(args.snapshot)
    applyOfficeSuggestion(doc, result.command, uid(91))
    expect(yDocToSnapshot(doc)).toMatchObject({ worksheets: [{ cells: [{ value: '00123', valueType: 'string' }, {}, {}] }] })
  })

  it.each(['shared evidence', 'linked cell'] as const)('rejects cell/entity double assignment via %s using real records', async (alias) => {
    const real = await vi.importActual<typeof import('../../structured-documents/records.js')>('../../structured-documents/records.js')
    vi.mocked(resolveObservation).mockImplementation(real.resolveObservation)
    const args = input()
    const records = recordsFixture()
    if (alias === 'shared evidence') {
      records.entities[0].raw_text = '00123'
      records.entities[0].lines = [{ ...records.entities[0].lines[0], source_ref: 'o1', start: 0, end: 5, raw_text: '00123', bbox: records.evidence[0].bbox }]
    } else records.entities[0].linked_cell_ids = ['c1']
    args.records = real.parseSourceRecords(records)
    args.mappings.push({ ...mapping(uid(6)), source: { kind: 'entity', entityId: 'e1' } })
    expect(() => prepareStructuredFill(args)).toThrow(/Overlapping source/)
  })
  it.each(['"GBP "#,##0.00', '"EUR "#,##0.00', '$#,##0.00', '"$ "0.00', '[$GBP]0.00'])('rejects RM/MYR into incompatible or ambiguous format %s', async (format) => {
    const real = await vi.importActual<typeof import('../../structured-documents/records.js')>('../../structured-documents/records.js')
    vi.mocked(resolveObservation).mockImplementation(real.resolveObservation)
    const args = input()
    const records = recordsFixture()
    setCellText(records, 'RM 1,234.50')
    Object.assign(records.records[0].cells[0].typed_value, { data_type: 'decimal', status: 'parsed', decimal_value: '1234.50', currency: 'MYR', currency_raw: 'RM', unit: 'MYR' })
    args.records = real.parseSourceRecords(records)
    args.snapshot.worksheets[0].cells[0].numberFormat = format
    expect(() => prepareStructuredFill(args)).toThrow(/currency/)
    args.snapshot.worksheets[0].cells[0].numberFormat = '0.00'
    expect(prepareStructuredFill(args).preview[0]).toMatchObject({ proposedValue: 1234.5, currency: 'MYR' })
    args.snapshot.worksheets[0].cells[0].numberFormat = '"RM "#,##0.00'
    expect(prepareStructuredFill(args).preview[0]).toMatchObject({ proposedValue: 1234.5, currency: 'MYR' })
  })

  it('returns one server-owned atomic batch without mutating the workbook or records', () => {
    const args = input()
    const before = structuredClone(args)
    const result = prepareStructuredFill(args)
    expect(args).toEqual(before)
    expect(result.command).toMatchObject({ kind: 'batch', artifactId: uid(1), baseVersion: 7, actor: { type: 'assistant', id: uid(90) }, origin: 'ai', commands: [{ kind: 'setSpreadsheetCell', cellId: uid(5), sheetId: uid(4), address: 'A1', value: 12.5, valueType: 'number', baseVersion: 7, actor: { type: 'assistant', id: uid(90) }, origin: 'ai' }] })
    expect(result.preview[0]).toMatchObject({ sheet: 'Inputs', previousValue: 2, proposedValue: 12.5, rawText: '12.50', flags: ['requires_review'], sourceRefs: ['ocr:1'] })
    const applied = applyOfficeCommand(args.snapshot, result.command) as SpreadsheetSnapshot
    expect(applied.worksheets[0].cells[0]).toMatchObject({ style: { fill: "#EEEEEE" }, numberFormat: '0.00' })
    expect(applied.worksheets[0].cells.slice(1)).toEqual(args.snapshot.worksheets[0].cells.slice(1))
    expect(resolveObservation).toHaveBeenCalledWith(args.records, args.mappings[0].source)
  })

  it.each(['001234', '=SUM(A1:A4)', '+44 020 0123', '-Example Ltd', '@Address\n001 Main St'])('keeps exact untrusted string %s', (rawText) => {
    vi.mocked(resolveObservation).mockReturnValue({ ...observation, valueType: 'string', rawText })
    const result = prepareStructuredFill(input())
    expect(result.preview[0].proposedValue).toBe(rawText)
    if (result.command.kind !== 'batch') throw new Error('batch expected')
    expect(result.command.commands[0]).not.toHaveProperty('formula')
  })

  it.each(['00012.5000', '1.25e1', '125E-1', '+12.5', '0.000000000000001', '999999999999999', '1e+21', '-0.000', '0.1', '1e-7'])('exact decimal roundtrip accepts %s', (decimalValue) => {
    vi.mocked(resolveObservation).mockReturnValue({ ...observation, decimalValue })
    expect(prepareStructuredFill(input()).preview[0].proposedValue).toBe(Number(decimalValue) || 0)
  })
  it.each(['1234567890123456', '0.1234567890123456', '1e309', '1e-400', '4e-324', 'NaN', 'Infinity', '1,234', ' 12 ', '1e', ''])('rejects unsupported decimal %s', (decimalValue) => {
    vi.mocked(resolveObservation).mockReturnValue({ ...observation, decimalValue })
    expect(() => prepareStructuredFill(input())).toThrow()
  })

  it('retains date raw text while emitting validated UTC midnight', () => {
    vi.mocked(resolveObservation).mockReturnValue({ ...observation, valueType: 'date', rawText: '29 February 2024', dateValue: '2024-02-29' })
    const args = input()
    args.mappings[0].source = { kind: 'entity', entityId: 'date:1' }
    expect(prepareStructuredFill(args).preview[0]).toMatchObject({ proposedValue: '2024-02-29T00:00:00.000Z', rawText: '29 February 2024', valueType: 'date' })
  })
  it.each(['2023-02-29', '2024-13-01', '2024-04-31', '2024-00-01', '2024-01-00', '24-01-01', '2024-01-01T12:00:00Z'])('rejects invalid date %s', (dateValue) => {
    vi.mocked(resolveObservation).mockReturnValue({ ...observation, valueType: 'date', dateValue })
    expect(() => prepareStructuredFill(input())).toThrow(/date/)
  })

  it.each(['value', 'formula', 'valueType', 'commandId', 'actor', 'origin', 'baseVersion'])('rejects free literal/authority key %s', (key) => {
    expect(FillMappingSchema.safeParse({ ...mapping(), [key]: '=BAD()' }).success).toBe(false)
    expect(() => prepareStructuredFill({ ...input(), mappings: [{ ...mapping(), [key]: '=BAD()' }] })).toThrow()
  })
  it('enforces strict nested references and bounded nonempty explanations', () => {
    expect(FillMappingSchema.safeParse({ ...mapping(), source: { kind: 'entity', entityId: 'e1', value: 'injected' } }).success).toBe(false)
    for (const invalid of [{ meaning: '' }, { reason: ' ' }, { meaning: 'x'.repeat(1001) }, { reason: 'x'.repeat(2001) }, { targetId: 'bad' }]) {
      expect(FillMappingSchema.safeParse({ ...mapping(), ...invalid }).success).toBe(false)
    }
  })
  it('rejects empty/oversized mappings, duplicate sources, duplicate/unknown targets', () => {
    for (const mappings of [[], Array.from({ length: 101 }, () => mapping()), [mapping(), mapping()], [mapping(), mapping(uid(6))], [mapping(uid(99))]]) {
      expect(() => prepareStructuredFill({ ...input(), mappings })).toThrow()
    }
  })
  it('rejects wrong family/artifact and invalid server envelope', () => {
    for (const patch of [{ artifactId: uid(99) }, { assistantId: 'bad' }, { expectedVersion: -1 }, { expectedVersion: 1.5 }]) {
      expect(() => prepareStructuredFill({ ...input(), ...patch })).toThrow()
    }
    expect(() => prepareStructuredFill({ ...input(), snapshot: { ...workbook(), family: 'document' } as never })).toThrow()
  })
  it('rejects locked, formula, merged and ambiguous targets', () => {
    for (const kind of ['locked', 'formula', 'merged', 'duplicate']) {
      const args = input()
      const sheet = args.snapshot.worksheets[0]
      if (kind === 'locked') sheet.cells[0].locked = true
      if (kind === 'formula') sheet.cells[0].formula = '1+1'
      if (kind === 'merged') sheet.merges = ['A1:B1']
      if (kind === 'duplicate') sheet.cells[1].id = uid(5)
      expect(() => prepareStructuredFill(args)).toThrow()
    }
  })
  it('does not scale percentage-formatted amounts or infer FX', () => {
    const args = input()
    args.snapshot.worksheets[0].cells[0].numberFormat = '0.0%'
    expect(() => prepareStructuredFill(args)).toThrow(/Percentage/)
    args.snapshot.worksheets[0].cells[0].numberFormat = '0.00'
    vi.mocked(resolveObservation).mockReturnValue({ ...observation, currency: 'EUR' })
    expect(prepareStructuredFill(args).preview[0].proposedValue).toBe(12.5)
  })
  it('propagates parser conflicts without turning them into empty success', () => {
    vi.mocked(resolveObservation).mockImplementation(() => { throw new Error('conflicting source') })
    expect(() => prepareStructuredFill(input())).toThrow('conflicting source')
  })
  it('rejects downstream and pre-existing formula errors with no mutation', () => {
    const args = input()
    args.snapshot.worksheets[0].cells[2].formula = '1/(A1-12.5)'
    const before = structuredClone(args.snapshot)
    expect(() => prepareStructuredFill(args)).toThrow(/formula errors/)
    expect(args.snapshot).toEqual(before)
    args.snapshot.worksheets[0].cells[2].formula = 'MISSING(A1)'
    expect(() => prepareStructuredFill(args)).toThrow(/formula errors/)
  })
  it('hashes canonical content, not random IDs or mapping order', () => {
    const args = input()
    vi.mocked(resolveObservation).mockImplementation((_records, ref) => ({ ...observation, sourceRefs: [ref.kind === 'cell' ? ref.cellId : ref.entityId] }))
    args.mappings.push(mapping(uid(6), 'c2'))
    const first = prepareStructuredFill(args)
    const second = prepareStructuredFill({ ...args, mappings: [...args.mappings].reverse() })
    expect(first.evidenceHash).toMatch(/^[a-f0-9]{64}$/)
    expect(first.evidenceHash).toBe(second.evidenceHash)
    expect(first.command.commandId).not.toBe(second.command.commandId)
    expect(first.preview).toEqual(second.preview)
    expect(prepareStructuredFill({ ...args, expectedVersion: 8 }).evidenceHash).not.toBe(first.evidenceHash)
    args.mappings[0].reason = 'Different rationale'
    expect(prepareStructuredFill(args).evidenceHash).not.toBe(first.evidenceHash)
    vi.mocked(resolveObservation).mockImplementation((_records, ref) => ({ ...observation, rawText: '12.500', sourceRefs: [ref.kind === 'cell' ? ref.cellId : ref.entityId] }))
    expect(prepareStructuredFill(args).evidenceHash).not.toBe(second.evidenceHash)
  })
})
