import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { applyOfficeCommand, officeSnapshotPreconditionHash, OfficeArtifactSnapshotSchema, OfficeCommandSchema, recalculateSpreadsheet, type OfficeArtifactSnapshot, type OfficeCommand } from '@use-brian/office-model'
import { resolveObservation, type SourceRecords, type SourceReference } from '../structured-documents/records.js'

// Validate the mapping boundary, not OCR observations (owned by records.ts).
const ReferenceSchema: z.ZodType<SourceReference> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cell'), recordId: z.string().min(1).max(512), cellId: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal('entity'), entityId: z.string().min(1).max(512) }).strict(),
])
export const FillMappingSchema = z.object({
  targetId: z.string().uuid(),
  source: ReferenceSchema,
  meaning: z.string().min(1).max(1_000).refine((text) => text.trim().length > 0),
  reason: z.string().min(1).max(2_000).refine((text) => text.trim().length > 0),
}).strict()
export type FillMapping = z.infer<typeof FillMappingSchema>

// Compare decimal values, not binary floating-point approximations. Normalizing
// coefficient/exponent handles exponent notation and insignificant zeroes without
// allocating a potentially enormous expanded decimal string.
function decimalParts(text: string) {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text)
  if (!match || text.length > 10_000) throw new Error('Unsupported decimal observation')
  let digits = (match[2] + (match[3] ?? '')).replace(/^0+/, '')
  let exponent = BigInt(match[4] ?? '0') - BigInt((match[3] ?? '').length)
  if (!digits) return { key: '0', precision: 1 }
  const trailing = /0+$/.exec(digits)?.[0].length ?? 0
  digits = digits.slice(0, digits.length - trailing)
  exponent += BigInt(trailing)
  return { key: `${match[1] === '-' ? '-' : ''}${digits}e${exponent}`, precision: digits.length }
}
function officeNumber(text: string | undefined): number {
  if (text === undefined) throw new Error('Missing decimal observation')
  const decimal = decimalParts(text)
  const value = Number(text)
  if (decimal.precision > 15 || !Number.isFinite(value) || decimalParts(String(value)).key !== decimal.key) {
    throw new Error('Decimal precision or exact roundtrip is unsupported by Office')
  }
  return Object.is(value, -0) ? 0 : value
}
function officeDate(text: string | undefined): string {
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('Unsupported date observation')
  const timestamp = `${text}T00:00:00.000Z`
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== timestamp) throw new Error('Invalid calendar date')
  return timestamp
}
// Deliberately small whitelist, not an Excel format interpreter. Unknown formats
// (including locale directives, bare $, scaling, or ambiguous symbols) fail closed.
function validateNumericFormat(format: string | undefined, currency: string | null | undefined) {
  const plain = ['General', '0', '0.00', '0.0', '#,##0', '#,##0.00', '#,##0.0']
  if (!format || plain.includes(format)) return
  const markers: Record<string, string[]> = { USD: ['USD', 'US$'], GBP: ['GBP', '£'], EUR: ['EUR', '€'], MYR: ['MYR', 'RM'], SGD: ['SGD'], HKD: ['HKD'], CNY: ['CNY'], JPY: ['JPY'], AUD: ['AUD'], CAD: ['CAD'], CHF: ['CHF'], INR: ['INR'] }
  const allowed = currency ? (markers[currency] ?? []).flatMap((marker) => ['0.00', '#,##0.00'].map((number) => `"${marker} "${number}`)) : []
  if (!allowed.includes(format)) throw new Error('Unsupported or mismatched target currency/number format')
}

function coordinates(address: string): [number, number] {
  const match = /^([A-Z]+)(\d+)$/.exec(address)!
  return [[...match[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0), Number(match[2])]
}

/** Prepare only: the caller must create an Office suggestion, never apply directly.
 * Live version and source/destination authorization are caller preconditions.
 */
export function prepareStructuredFill(input: {
  snapshot: OfficeArtifactSnapshot
  records: SourceRecords
  artifactId: string
  assistantId: string
  expectedVersion: number
  mappings: FillMapping[]
}) {
  const snapshot = OfficeArtifactSnapshotSchema.parse(input.snapshot)
  if (snapshot.family !== 'spreadsheet') throw new Error('Structured fill requires an existing spreadsheet')
  if (snapshot.artifactId !== input.artifactId) throw new Error('Artifact ID mismatch')
  const mappings = z.array(FillMappingSchema).min(1).max(100).parse(input.mappings)
    .sort((a, b) => a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0)
  const envelope = {
    artifactId: z.string().uuid().parse(input.artifactId),
    baseVersion: z.number().int().nonnegative().safe().parse(input.expectedVersion),
    actor: { type: 'assistant' as const, id: z.string().uuid().parse(input.assistantId) },
    origin: 'ai' as const,
  }
  const targets = new Set<string>()
  const sources = new Set<string>()
  const provenance = new Set<string>()
  // Resolve aliases conservatively to their underlying cells/OCR regions. Whole
  // parent regions are reserved, even when two slices might not overlap.
  function provenanceKeys(source: SourceReference, refs: string[]): Set<string> {
    const keys = new Set(refs)
    if (source.kind === 'cell') keys.add(source.cellId)
    else for (const id of input.records.entities?.find((entity) => entity.id === source.entityId)?.linked_cell_ids ?? []) keys.add(id)
    const pending = [...keys]
    while (pending.length) {
      const key = pending.pop()!
      const parent = input.records.evidence?.find((item) => item.id === key)?.parent_ref
      const cell = input.records.records?.flatMap((record) => record.cells).find((item) => item.id === key)
      for (const ref of [...(parent ? [parent] : []), ...(cell?.source.ocr_refs ?? [])]) {
        if (!keys.has(ref)) { keys.add(ref); pending.push(ref) }
      }
    }
    return keys
  }
  const assignments = mappings.map((mapping) => {
    if (targets.has(mapping.targetId)) throw new Error('Duplicate target ID')
    targets.add(mapping.targetId)
    const sourceKey = JSON.stringify(mapping.source)
    if (sources.has(sourceKey)) throw new Error('Duplicate source reference')
    sources.add(sourceKey)
    const matches = snapshot.worksheets.flatMap((sheet) => sheet.cells.filter((cell) => cell.id === mapping.targetId).map((cell) => ({ sheet, cell })))
    if (matches.length !== 1) throw new Error('Unknown or ambiguous target ID')
    const { sheet, cell } = matches[0]
    if (snapshot.worksheets.filter((candidate) => candidate.id === sheet.id).length !== 1) throw new Error('Ambiguous worksheet ID')
    if (cell.locked || cell.formula !== undefined) throw new Error('Target is locked or contains a formula')
    // Merged regions do not provide independent assignment targets in this slice.
    const [x, y] = coordinates(cell.address)
    if (sheet.merges.some((range) => {
      const [start, end] = range.split(':').map(coordinates)
      return x >= start[0] && x <= end[0] && y >= start[1] && y <= end[1]
    })) throw new Error('Merged target assignments are unsupported')
    const observation = resolveObservation(input.records, mapping.source)
    if (observation.valueType === 'number' && cell.numberFormat?.includes('%')) {
      throw new Error('Percentage target requires explicit compatible scaling; no implicit percent conversion')
    }
    const keys = provenanceKeys(mapping.source, observation.sourceRefs)
    if ([...keys].some((key) => provenance.has(key))) throw new Error('Overlapping source provenance')
    for (const key of keys) provenance.add(key)
    if (observation.valueType === 'number') validateNumericFormat(cell.numberFormat, observation.currency)
    const proposedValue = observation.valueType === 'string' ? observation.rawText
      : observation.valueType === 'number' ? officeNumber(observation.decimalValue)
        : officeDate(observation.dateValue)
    return {
      sheetId: sheet.id,
      preview: {
        targetId: cell.id, sheet: sheet.name, address: cell.address,
        previousValue: cell.value, proposedValue, valueType: observation.valueType,
        source: mapping.source, meaning: mapping.meaning, reason: mapping.reason,
        rawText: observation.rawText, currency: observation.currency ?? null, page: observation.page,
        sourceRefs: [...observation.sourceRefs], flags: [...observation.flags],
      },
      currency: observation.currency ?? null,
    }
  })
  const command: OfficeCommand = OfficeCommandSchema.parse({
    ...envelope, commandId: randomUUID(), kind: 'batch', expectedSnapshotHash: officeSnapshotPreconditionHash(snapshot),
    commands: assignments.map(({ sheetId, preview }) => ({
      ...envelope, commandId: randomUUID(), kind: 'setSpreadsheetCell',
      sheetId, cellId: preview.targetId, address: preview.address,
      valueType: preview.valueType, value: preview.proposedValue,
    })),
  })
  const applied = applyOfficeCommand(snapshot, command)
  if (applied.family !== 'spreadsheet') throw new Error('Spreadsheet validation failed')
  const calculated = recalculateSpreadsheet(applied)
  if (calculated.issues.length || calculated.snapshot.worksheets.some((sheet) => sheet.cells.some((cell) => cell.error))) {
    throw new Error('Structured fill produces spreadsheet formula errors')
  }
  // Stable mapping order and explicitly constructed objects exclude all random IDs.
  const evidenceHash = createHash('sha256').update(JSON.stringify({ version: 1, ...envelope, expectedSnapshotHash: officeSnapshotPreconditionHash(snapshot), assignments })).digest('hex')
  return { command, preview: assignments.map(({ preview }) => preview), evidenceHash }
}
