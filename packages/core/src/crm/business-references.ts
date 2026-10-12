/**
 * Business reference contracts: definitions, the closed format AST,
 * normalization, partition keys and deterministic formatting.
 *
 * Pure and closed-world. The PostgreSQL service owns allocation; nothing here
 * reserves a number, reads a clock, or evaluates caller-supplied code.
 * Spec: docs/architecture/features/crm-commercial-operations.md
 *
 * [COMP:crm/business-reference-tools]
 */

import { z } from 'zod'

const Uuid = z.string().uuid()
const StableKey = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{0,62}$/)

export const CRM_REFERENCE_TARGET_KINDS = ['company', 'deal'] as const
export const CrmReferenceTargetKindSchema = z.enum(CRM_REFERENCE_TARGET_KINDS)
export type CrmReferenceTargetKind = z.infer<typeof CrmReferenceTargetKindSchema>

export const CRM_REFERENCE_PARTITION_DIMENSIONS = ['business_year', 'parent_target', 'service_category'] as const
export const CrmReferencePartitionDimensionSchema = z.enum(CRM_REFERENCE_PARTITION_DIMENSIONS)
export type CrmReferencePartitionDimension = z.infer<typeof CrmReferencePartitionDimensionSchema>

export const CrmReferenceAssignmentModeSchema = z.enum(['native', 'manual', 'external'])
export const CrmReferenceAssignmentEventSchema = z.enum(['explicit', 'approval', 'issue'])
export const CrmReferenceChangePolicySchema = z.enum(['immutable', 'correctable'])
export const CrmReferenceStatusSchema = z.enum(['active', 'replaced', 'retired'])

/** Reference values are printable text: no control characters, bounded length. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const LITERAL = /^[\p{L}\p{N}\p{P}\p{S} ]{1,32}$/u

export const CrmReferenceFormatSegmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), text: z.string().regex(LITERAL, 'Literal segments are 1 to 32 printable characters') }).strict(),
  z.object({ kind: z.literal('parent'), definitionKey: StableKey }).strict(),
  z.object({ kind: z.literal('date'), part: z.enum(['yyyy', 'yy', 'mm', 'dd']) }).strict(),
  z.object({ kind: z.literal('category') }).strict(),
  z.object({ kind: z.literal('counter'), width: z.number().int().min(1).max(12) }).strict(),
])
export type CrmReferenceFormatSegment = z.infer<typeof CrmReferenceFormatSegmentSchema>
export const CrmReferenceFormatSchema = z.array(CrmReferenceFormatSegmentSchema).min(1).max(24)
export type CrmReferenceFormat = z.infer<typeof CrmReferenceFormatSchema>

export const CrmReferenceCategorySchema = z.object({
  key: StableKey,
  code: z.string().regex(LITERAL, 'Category codes are 1 to 32 printable characters'),
  label: z.string().trim().min(1).max(200),
}).strict()
export type CrmReferenceCategory = z.infer<typeof CrmReferenceCategorySchema>

function validTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true } catch { return false }
}

export const CrmReferenceDefinitionInputSchema = z.object({
  definitionKey: StableKey,
  label: z.string().trim().min(1).max(200),
  targetKinds: z.array(CrmReferenceTargetKindSchema).min(1).max(CRM_REFERENCE_TARGET_KINDS.length)
    .refine((values) => new Set(values).size === values.length, 'Target kinds must be unique'),
  assignmentMode: CrmReferenceAssignmentModeSchema,
  namespaceKey: StableKey,
  format: CrmReferenceFormatSchema.nullable().default(null),
  partitionDimensions: z.array(CrmReferencePartitionDimensionSchema).max(3).default([])
    .refine((values) => new Set(values).size === values.length, 'Partition dimensions must be unique'),
  categories: z.array(CrmReferenceCategorySchema).max(200).default([])
    .refine((values) => new Set(values.map((value) => value.key)).size === values.length, 'Category keys must be unique'),
  timezone: z.string().trim().min(1).max(64).refine(validTimezone, 'Use an IANA timezone such as UTC or Asia/Hong_Kong').default('UTC'),
  assignmentEvent: CrmReferenceAssignmentEventSchema.default('explicit'),
  changePolicy: CrmReferenceChangePolicySchema.default('immutable'),
  counterStart: z.number().int().min(0).max(999_999_999_999).default(1),
  status: z.enum(['draft', 'active', 'archived']).default('active'),
}).strict()
export type CrmReferenceDefinitionInput = z.infer<typeof CrmReferenceDefinitionInputSchema>

export type CrmReferenceDefinitionIssue = { path: string; message: string }

/** Cross-field rules the schema cannot express. Empty means admissible. */
export function crmReferenceDefinitionIssues(input: CrmReferenceDefinitionInput): CrmReferenceDefinitionIssue[] {
  const issues: CrmReferenceDefinitionIssue[] = []
  const format = input.format ?? []
  const counters = format.filter((segment) => segment.kind === 'counter')
  if (input.assignmentMode === 'native') {
    if (!input.format) issues.push({ path: 'format', message: 'A native definition needs a format.' })
    else if (counters.length !== 1) issues.push({ path: 'format', message: 'A native format has exactly one counter segment.' })
  } else if (counters.length) {
    issues.push({ path: 'format', message: 'Only native definitions allocate a counter.' })
  }
  const parents = format.filter((segment) => segment.kind === 'parent')
  if (parents.length > 1) issues.push({ path: 'format', message: 'A format has at most one parent segment.' })
  if (parents.length && input.targetKinds.some((kind) => kind !== 'deal')) {
    issues.push({ path: 'format', message: 'A parent segment requires every target kind to have a parent record (deals).' })
  }
  if (parents.some((segment) => segment.kind === 'parent' && segment.definitionKey === input.definitionKey)) {
    issues.push({ path: 'format', message: 'A definition cannot reference itself as its parent.' })
  }
  if (input.partitionDimensions.includes('parent_target') && input.targetKinds.some((kind) => kind !== 'deal')) {
    issues.push({ path: 'partitionDimensions', message: 'parent_target partitions require every target kind to have a parent record (deals).' })
  }
  const usesCategory = format.some((segment) => segment.kind === 'category') || input.partitionDimensions.includes('service_category')
  if (usesCategory && input.categories.length === 0) {
    issues.push({ path: 'categories', message: 'Category segments and service_category partitions need a declared category catalog.' })
  }
  if (input.assignmentMode !== 'native' && input.partitionDimensions.length) {
    issues.push({ path: 'partitionDimensions', message: 'Only native definitions declare counter partitions.' })
  }
  if (input.assignmentEvent === 'issue') {
    issues.push({ path: 'assignmentEvent', message: 'Issue-time assignment is reserved for invoice definitions.' })
  }
  return issues
}

/** NFKC, trimmed, whitespace runs collapsed. Case is preserved for display. */
export function presentCrmBusinessReference(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
}

/** Namespace uniqueness key: the presentation form, lowercased with the default case mapping. */
export function normalizeCrmBusinessReference(value: string): string {
  return presentCrmBusinessReference(value).toLowerCase().normalize('NFKC')
}

export const CrmBusinessReferenceValueSchema = z.string().max(512).transform(presentCrmBusinessReference)
  .refine((value) => value.length >= 1 && value.length <= 128, 'References are 1 to 128 characters')
  .refine((value) => !CONTROL.test(value), 'References cannot contain control characters')

export type CrmBusinessDate = { date: string; year: number; month: number; day: number }

/**
 * Resolve the explicit business date. A calendar date is used as given; an
 * instant is converted in the definition timezone. Never the host clock.
 */
export function resolveCrmBusinessDate(input: string, timezone: string): CrmBusinessDate {
  let date: string
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const parsed = new Date(`${input}T00:00:00.000Z`)
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== input) throw new Error('Business date is not a calendar date')
    date = input
  } else {
    const instant = new Date(input)
    if (!/T/.test(input) || Number.isNaN(instant.getTime())) throw new Error('Business date must be YYYY-MM-DD or an ISO instant')
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant)
    const part = (type: string) => parts.find((item) => item.type === type)?.value ?? ''
    date = `${part('year')}-${part('month')}-${part('day')}`
  }
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  return { date, year, month, day }
}

export function crmReferenceNeedsBusinessDate(format: CrmReferenceFormat | null, dimensions: readonly CrmReferencePartitionDimension[]): boolean {
  return dimensions.includes('business_year') || (format ?? []).some((segment) => segment.kind === 'date')
}

export function crmReferenceNeedsCategory(format: CrmReferenceFormat | null, dimensions: readonly CrmReferencePartitionDimension[]): boolean {
  return dimensions.includes('service_category') || (format ?? []).some((segment) => segment.kind === 'category')
}

/** Canonical partition key in the declared dimension order. */
export function crmReferencePartitionKey(dimensions: readonly CrmReferencePartitionDimension[], values: {
  businessDate?: CrmBusinessDate | null
  parentTargetId?: string | null
  categoryKey?: string | null
}): string {
  const parts: string[] = []
  for (const dimension of CRM_REFERENCE_PARTITION_DIMENSIONS) {
    if (!dimensions.includes(dimension)) continue
    if (dimension === 'business_year') {
      if (!values.businessDate) throw new Error('business_year partition needs a business date')
      parts.push(`year=${values.businessDate.year}`)
    } else if (dimension === 'parent_target') {
      if (!values.parentTargetId) throw new Error('parent_target partition needs a parent record')
      parts.push(`parent=${values.parentTargetId}`)
    } else {
      if (!values.categoryKey) throw new Error('service_category partition needs a category')
      parts.push(`category=${values.categoryKey}`)
    }
  }
  return parts.length ? parts.join('|') : 'all'
}

const pad = (value: number, width: number) => String(value).padStart(width, '0')

/** Deterministic rendering of an admitted format. Throws when a needed input is missing. */
export function formatCrmBusinessReference(format: CrmReferenceFormat, values: {
  counter?: number | null
  businessDate?: CrmBusinessDate | null
  parentValue?: string | null
  categoryCode?: string | null
}): string {
  let output = ''
  for (const segment of format) {
    switch (segment.kind) {
      case 'literal': output += segment.text; break
      case 'parent':
        if (!values.parentValue) throw new Error('The parent record has no active reference in the required definition')
        output += values.parentValue
        break
      case 'date': {
        const date = values.businessDate
        if (!date) throw new Error('A business date is required')
        output += segment.part === 'yyyy' ? String(date.year) : segment.part === 'yy' ? pad(date.year % 100, 2)
          : segment.part === 'mm' ? pad(date.month, 2) : pad(date.day, 2)
        break
      }
      case 'category':
        if (!values.categoryCode) throw new Error('A category is required')
        output += values.categoryCode
        break
      case 'counter': {
        const counter = values.counter
        if (counter === null || counter === undefined || !Number.isSafeInteger(counter) || counter < 0) throw new Error('A counter value is required')
        const text = pad(counter, segment.width)
        if (text.length > segment.width) throw new Error('The counter has outgrown its configured width')
        output += text
        break
      }
    }
  }
  return presentCrmBusinessReference(output)
}

export type CrmReferenceFormatExplanation = {
  segments: Array<{ kind: CrmReferenceFormatSegment['kind']; description: string; example: string }>
  maskedExample: string
  needsBusinessDate: boolean
  needsCategory: boolean
}

/** Informational preview. The counter is masked; nothing is reserved or promised. */
export function explainCrmReferenceFormat(format: CrmReferenceFormat, values: {
  businessDate?: CrmBusinessDate | null
  parentValue?: string | null
  categoryCode?: string | null
}, dimensions: readonly CrmReferencePartitionDimension[] = []): CrmReferenceFormatExplanation {
  const segments = format.map((segment) => {
    switch (segment.kind) {
      case 'literal': return { kind: segment.kind, description: 'Fixed text', example: segment.text }
      case 'parent': return { kind: segment.kind, description: `Parent record reference (${segment.definitionKey})`, example: values.parentValue ?? `<${segment.definitionKey}>` }
      case 'date': {
        const date = values.businessDate
        const example = !date ? segment.part.toUpperCase() : segment.part === 'yyyy' ? String(date.year)
          : segment.part === 'yy' ? pad(date.year % 100, 2) : segment.part === 'mm' ? pad(date.month, 2) : pad(date.day, 2)
        return { kind: segment.kind, description: `Business date part ${segment.part}`, example }
      }
      case 'category': return { kind: segment.kind, description: 'Service category code', example: values.categoryCode ?? '<CATEGORY>' }
      case 'counter': return { kind: segment.kind, description: `Counter padded to ${segment.width} digits`, example: '#'.repeat(segment.width) }
    }
  })
  return {
    segments,
    maskedExample: segments.map((segment) => segment.example).join(''),
    needsBusinessDate: crmReferenceNeedsBusinessDate(format, dimensions),
    needsCategory: crmReferenceNeedsCategory(format, dimensions),
  }
}

// ── Commands ────────────────────────────────────────────────────────

const OperationId = Uuid
const Reason = z.string().trim().min(1).max(2000)
const Target = z.object({ kind: CrmReferenceTargetKindSchema, id: Uuid }).strict()
const BusinessDateInput = z.string().trim().min(10).max(40)
const ExternalEvidence = z.object({
  provider: StableKey,
  remoteId: z.string().trim().min(1).max(500),
}).strict()

export const SaveCrmReferenceDefinitionCommandSchema = z.object({
  kind: z.literal('save_reference_definition'),
  operationId: OperationId,
  definitionId: Uuid.optional(),
  expectedVersion: z.number().int().min(1).optional(),
  definition: CrmReferenceDefinitionInputSchema,
}).strict().refine((value) => (value.definitionId === undefined) === (value.expectedVersion === undefined),
  'definitionId and expectedVersion are supplied together')

export const AssignCrmBusinessReferenceCommandSchema = z.object({
  kind: z.literal('assign_business_reference'),
  operationId: OperationId,
  definitionKey: StableKey,
  target: Target,
  expectedTargetUpdatedAt: z.string().datetime({ offset: true }).optional(),
  businessDate: BusinessDateInput.optional(),
  categoryKey: StableKey.optional(),
  value: CrmBusinessReferenceValueSchema.optional(),
  external: ExternalEvidence.optional(),
}).strict()

export const ReplaceCrmBusinessReferenceCommandSchema = z.object({
  kind: z.literal('replace_business_reference'),
  operationId: OperationId,
  referenceId: Uuid,
  expectedVersion: z.number().int().min(1),
  reason: Reason,
  value: CrmBusinessReferenceValueSchema.optional(),
  businessDate: BusinessDateInput.optional(),
  categoryKey: StableKey.optional(),
  external: ExternalEvidence.optional(),
}).strict()

export const RetireCrmBusinessReferenceCommandSchema = z.object({
  kind: z.literal('retire_business_reference'),
  operationId: OperationId,
  referenceId: Uuid,
  expectedVersion: z.number().int().min(1),
  reason: Reason,
}).strict()

export const ImportCrmBusinessReferencesCommandSchema = z.object({
  kind: z.literal('import_business_references'),
  operationId: OperationId,
  definitionKey: StableKey,
  rows: z.array(z.object({
    target: Target,
    value: CrmBusinessReferenceValueSchema,
    status: z.enum(['active', 'retired']).default('active'),
    businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    categoryKey: StableKey.optional(),
  }).strict()).max(1000).default([]),
  partitionCounters: z.array(z.object({
    partitionKey: z.string().trim().min(1).max(300),
    nextValue: z.number().int().min(0).max(999_999_999_999),
  }).strict()).max(1000).default([]),
}).strict().refine((value) => value.rows.length > 0 || value.partitionCounters.length > 0,
  'An import needs rows or partition counters')

export const CRM_BUSINESS_REFERENCE_COMMAND_KINDS = [
  'save_reference_definition', 'assign_business_reference', 'replace_business_reference',
  'retire_business_reference', 'import_business_references',
] as const
export type CrmBusinessReferenceCommandKind = typeof CRM_BUSINESS_REFERENCE_COMMAND_KINDS[number]

export const CrmBusinessReferenceCommandSchema = z.union([
  SaveCrmReferenceDefinitionCommandSchema,
  AssignCrmBusinessReferenceCommandSchema,
  ReplaceCrmBusinessReferenceCommandSchema,
  RetireCrmBusinessReferenceCommandSchema,
  ImportCrmBusinessReferencesCommandSchema,
])
export type CrmBusinessReferenceCommand = z.infer<typeof CrmBusinessReferenceCommandSchema>

export function isCrmBusinessReferenceCommand(command: { kind: string }): command is CrmBusinessReferenceCommand {
  return (CRM_BUSINESS_REFERENCE_COMMAND_KINDS as readonly string[]).includes(command.kind)
}

// ── Read shapes ─────────────────────────────────────────────────────

export const CrmReferencePreviewQuerySchema = z.object({
  definitionKey: StableKey,
  targetKind: CrmReferenceTargetKindSchema.optional(),
  targetId: Uuid.optional(),
  businessDate: BusinessDateInput.optional(),
  categoryKey: StableKey.optional(),
}).strict()
export type CrmReferencePreviewQuery = z.infer<typeof CrmReferencePreviewQuerySchema>

export const CrmReferenceLookupQuerySchema = z.object({
  q: z.string().trim().min(1).max(128).optional(),
  match: z.enum(['exact', 'prefix']).default('exact'),
  definitionKey: StableKey.optional(),
  targetId: Uuid.optional(),
  includeFormer: z.union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')]).default(true),
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict().refine((value) => value.q !== undefined || value.targetId !== undefined, 'Supply q or targetId')
export type CrmReferenceLookupQuery = z.infer<typeof CrmReferenceLookupQuerySchema>

export type CrmBusinessReferenceRecord = {
  id: string
  definitionId: string
  definitionKey: string
  definitionVersion: number
  targetKind: CrmReferenceTargetKind
  targetId: string
  targetName: string | null
  value: string
  origin: 'native' | 'manual' | 'external' | 'import'
  status: z.infer<typeof CrmReferenceStatusSchema>
  businessDate: string | null
  categoryKey: string | null
  counterValue: number | null
  partitionKey: string | null
  parentSnapshot: { referenceId: string; value: string; version: number; targetId: string } | null
  version: number
  createdAt: string
  updatedAt: string
}

/** The viewer is the authenticated acting user; reads apply the target's current scope. */
export type CrmReferenceViewer = { userId: string; canConfigure?: boolean }

export type CrmReferenceReadPort = {
  listDefinitions(workspaceId: string, viewer: CrmReferenceViewer, options?: { includeArchived?: boolean; allowedDefinitionKeys?: readonly string[] }): Promise<{ schemaVersion: 1; definitions: Array<Record<string, unknown>> }>
  preview(workspaceId: string, viewer: CrmReferenceViewer, query: CrmReferencePreviewQuery): Promise<Record<string, unknown>>
  lookup(workspaceId: string, viewer: CrmReferenceViewer, query: CrmReferenceLookupQuery, allowedDefinitionKeys?: readonly string[]): Promise<{ schemaVersion: 1; references: CrmBusinessReferenceRecord[]; nextCursor: string | null }>
  history(workspaceId: string, viewer: CrmReferenceViewer, referenceId: string, allowedDefinitionKeys?: readonly string[]): Promise<{ schemaVersion: 1; reference: CrmBusinessReferenceRecord; history: Array<Record<string, unknown>> } | null>
}
