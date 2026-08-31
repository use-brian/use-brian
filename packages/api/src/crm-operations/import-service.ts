/**
 * Server-owned CRM import preflight and resumable commit.
 *
 * The browser only stages bytes and proposes a mapping. This service parses
 * the complete immutable file, owns row receipts/chunk checkpoints, and sends
 * operational evidence through CrmOperationsService.
 *
 * [COMP:crm/production-import]
 */

import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type {
  AccessContext,
  CrmOperationsContext,
  CrmOperationsServicePort,
  EntityLinksStore,
  FilesApi,
  StableExternalIdentity,
} from '@use-brian/core'
import { createCompany, createContact, createDeal, updateContact } from '../db/crm.js'
import { updateCrmCustomFields } from '../db/crm-r2.js'
import { getEntityById, updateEntity } from '../db/entities-store.js'
import { query } from '../db/client.js'
import { parseCsv } from '../linkedin-import/csv.js'

const MAX_IMPORT_BYTES = 30 * 1024 * 1024
const MAX_IMPORT_ROWS = 100_000
const CHUNK_ROWS = 50
const SAMPLE_ERRORS = 25

const ImportEntityKindSchema = z.enum(['contact', 'company', 'deal', 'operations'])
export type CrmImportEntityKind = z.infer<typeof ImportEntityKindSchema>

const BASE_TARGETS = new Set([
  'name', 'email', 'phone', 'tags', 'domain', 'companyId', 'contactId',
  'stage', 'amount', 'currencyCode', 'closeDate', 'source', 'pipelineId',
  'stageId', 'identityProvider', 'identityProviderInstance', 'identitySubject',
  'consentPurposeKey', 'consentAction', 'consentSource',
  'suppressionChannel', 'suppressionAction', 'suppressionReasonCode',
  'suppressionSource', 'entitlementPlanId', 'entitlementIdempotencyKey',
  'entitlementStatus', 'entitlementStartsAt', 'entitlementEndsAt',
  'entitlementRenewalMode', 'participationEventId', 'participationSourceId',
  'participationStatus', 'participantName', 'participantEmail',
])

function validTarget(target: string): boolean {
  return BASE_TARGETS.has(target) || /^custom:[a-z][a-z0-9_-]{0,62}$/.test(target)
}

export const CrmImportMappingSchema = z.object({
  columns: z.record(z.string(), z.string().trim().min(1).max(100).nullable()),
  trustedIdentitySource: z.string().trim().toLowerCase()
    .regex(/^[a-z][a-z0-9_-]{0,62}$/).optional(),
}).strict().superRefine((mapping, ctx) => {
  const used = new Set<string>()
  for (const [index, target] of Object.entries(mapping.columns)) {
    if (!/^\d+$/.test(index)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['columns', index], message: 'column index must be a non-negative integer' })
    }
    if (target && !validTarget(target)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['columns', index], message: 'unknown import target' })
    }
    if (target && used.has(target)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['columns', index], message: 'an import target may be mapped once' })
    }
    if (target) used.add(target)
  }
})
export type CrmImportMapping = z.infer<typeof CrmImportMappingSchema>

export const CrmImportPreflightSchema = z.object({
  stagedFileId: z.string().uuid(),
  entityKind: ImportEntityKindSchema,
  mapping: CrmImportMappingSchema,
}).strict()

export const CrmImportConfirmSchema = CrmImportPreflightSchema.extend({
  confirmed: z.literal(true),
  dryRunHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict()

type ImportInput = z.infer<typeof CrmImportPreflightSchema>
type ConfirmInput = z.infer<typeof CrmImportConfirmSchema>

export type CrmImportError = {
  row: number
  code: string
  field?: string
  message: string
}

export type CrmImportDryRun = {
  dryRunHash: string
  bytes: number
  totalRows: number
  validRows: number
  failedRows: number
  headers: string[]
  sampleErrors: CrmImportError[]
}

export type CrmImportJob = {
  id: string
  workspaceId: string
  stagedFileId: string
  entityKind: CrmImportEntityKind
  status: 'ready' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed'
  mapping: CrmImportMapping
  totalRows: number
  processedRows: number
  succeededRows: number
  failedRows: number
  nextChunkIndex: number
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
}

type ImportJobRow = CrmImportJob & {
  mappingHash: string
  sourceHash: string
  createdByUserId: string | null
}

type ParsedImport = {
  bytes: Uint8Array
  sourceHash: string
  headers: string[]
  rows: Array<{ row: number; cells: string[]; malformedReason?: string }>
}

type ImportCustomDefinition = {
  fieldKey: string
  fieldType: 'text' | 'number' | 'date' | 'boolean' | 'single_select' | 'multi_select' | 'entity_reference'
  options: string[]
}

type ImportServiceContext = CrmOperationsContext & { actor: { kind: 'user'; userId: string } }

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function canonicalMapping(mapping: CrmImportMapping): string {
  const columns = Object.fromEntries(Object.entries(mapping.columns)
    .sort(([left], [right]) => Number(left) - Number(right)))
  return JSON.stringify({ columns, trustedIdentitySource: mapping.trustedIdentitySource ?? null })
}

function mappingHash(mapping: CrmImportMapping): string {
  return createHash('sha256').update(canonicalMapping(mapping)).digest('hex')
}

function dryRunHash(sourceHash: string, mapping: CrmImportMapping, entityKind: string): string {
  return createHash('sha256').update(`${sourceHash}:${entityKind}:${mappingHash(mapping)}`).digest('hex')
}

function rowHash(cells: string[], mapping: CrmImportMapping): string {
  return createHash('sha256').update(JSON.stringify([cells, canonicalMapping(mapping)])).digest('hex')
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function mappedValues(cells: string[], mapping: CrmImportMapping): Record<string, string> {
  const output: Record<string, string> = {}
  for (const [rawIndex, target] of Object.entries(mapping.columns)) {
    if (!target) continue
    const value = clean(cells[Number(rawIndex)])
    if (value !== undefined) output[target] = value
  }
  return output
}

function parseCustomValue(definition: ImportCustomDefinition, value: string): unknown {
  switch (definition.fieldType) {
    case 'text':
      if (value.length > 10_000) throw new Error('Text exceeds 10000 characters.')
      return value
    case 'number': {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) throw new Error('Number must be finite.')
      return parsed
    }
    case 'date': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Date must use YYYY-MM-DD.')
      const [year, month, day] = value.split('-').map(Number)
      const parsed = new Date(Date.UTC(year, month - 1, day))
      if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
        throw new Error('Date must be a real calendar day.')
      }
      return value
    }
    case 'boolean': {
      const normalized = value.trim().toLowerCase()
      if (['true', 'yes', '1', 'on'].includes(normalized)) return true
      if (['false', 'no', '0', 'off'].includes(normalized)) return false
      throw new Error('Boolean must be true/false, yes/no, 1/0, or on/off.')
    }
    case 'single_select':
      if (!definition.options.includes(value)) throw new Error(`Value must be one of: ${definition.options.join(', ')}.`)
      return value
    case 'multi_select': {
      const values = value.split(/[|;]/).map((item) => item.trim()).filter(Boolean)
      if (values.some((item) => !definition.options.includes(item))) {
        throw new Error(`Every value must be one of: ${definition.options.join(', ')}.`)
      }
      return values
    }
    case 'entity_reference':
      if (!isUuid(value)) throw new Error('Reference must be a visible CRM entity UUID.')
      return value
  }
}

function customValuesFor(
  values: Record<string, string>,
  catalog: ReadonlyMap<string, ImportCustomDefinition>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [target, value] of Object.entries(values)) {
    if (!target.startsWith('custom:')) continue
    const key = target.slice('custom:'.length)
    const definition = catalog.get(key)
    if (!definition) throw new Error(`Unknown custom field '${key}'.`)
    output[key] = parseCustomValue(definition, value)
  }
  return output
}

function isUuid(value: string | undefined): boolean {
  return !!value && z.string().uuid().safeParse(value).success
}

function validateMappedRow(
  kind: CrmImportEntityKind,
  row: { row: number; cells: string[]; malformedReason?: string },
  mapping: CrmImportMapping,
  customCatalog: ReadonlyMap<string, ImportCustomDefinition> = new Map(),
): CrmImportError[] {
  const values = mappedValues(row.cells, mapping)
  const errors: CrmImportError[] = []
  const add = (code: string, message: string, field?: string) => errors.push({ row: row.row, code, message, ...(field ? { field } : {}) })
  if (row.malformedReason) add('malformed_csv', 'The CSV record is malformed.')
  if (kind !== 'operations' && !values.name) add('required_field', 'Name is required.', 'name')
  if (values.amount !== undefined && (!Number.isFinite(Number(values.amount)) || Number(values.amount) < 0)) {
    add('invalid_number', 'Amount must be a non-negative number.', 'amount')
  }
  if (values.closeDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.closeDate)) {
    add('invalid_date', 'Close date must use YYYY-MM-DD.', 'closeDate')
  }
  for (const field of ['companyId', 'contactId', 'pipelineId', 'stageId', 'entitlementPlanId', 'participationEventId']) {
    if (values[field] !== undefined && !isUuid(values[field])) add('invalid_id', 'The value must be a UUID.', field)
  }
  if ((values.pipelineId === undefined) !== (values.stageId === undefined)) {
    add('incomplete_pipeline', 'Pipeline and stage IDs must be mapped together.', 'pipelineId')
  }
  const identity = [values.identityProvider, values.identityProviderInstance, values.identitySubject]
  if (identity.some(Boolean) && !identity.every(Boolean)) {
    add('incomplete_identity', 'Provider, provider instance, and subject are required together.', 'identityProvider')
  }
  if (mapping.trustedIdentitySource && values.identityProvider
    && values.identityProvider !== mapping.trustedIdentitySource) {
    add('identity_source_mismatch', 'The mapped identity provider must match the confirmed trusted source.', 'identityProvider')
  }
  const hasConsent = values.consentPurposeKey || values.consentAction || values.consentSource
  if (hasConsent && !(values.consentPurposeKey && values.consentAction && values.consentSource)) {
    add('incomplete_consent', 'Consent purpose, action, and source are required together.', 'consentPurposeKey')
  }
  if (values.consentAction && !['granted', 'withdrawn'].includes(values.consentAction)) {
    add('invalid_consent_action', 'Consent action must be granted or withdrawn.', 'consentAction')
  }
  if (values.consentPurposeKey && !/^[a-z][a-z0-9_-]{0,62}$/.test(values.consentPurposeKey)) {
    add('invalid_catalog_key', 'Consent purpose must be a stable catalog key.', 'consentPurposeKey')
  }
  const hasSuppression = values.suppressionChannel || values.suppressionAction || values.suppressionReasonCode || values.suppressionSource
  if (hasSuppression && !(values.suppressionChannel && values.suppressionAction && values.suppressionReasonCode && values.suppressionSource)) {
    add('incomplete_suppression', 'Suppression channel, action, reason, and source are required together.', 'suppressionChannel')
  }
  if (values.suppressionChannel && !['all', 'email', 'sms', 'phone', 'whatsapp', 'telegram', 'slack'].includes(values.suppressionChannel)) {
    add('invalid_suppression_channel', 'Suppression channel is outside the supported catalog.', 'suppressionChannel')
  }
  if (values.suppressionAction && !['suppressed', 'released'].includes(values.suppressionAction)) {
    add('invalid_suppression_action', 'Suppression action must be suppressed or released.', 'suppressionAction')
  }
  if (values.suppressionReasonCode && ![
    'manual_do_not_contact', 'hard_bounce', 'soft_bounce', 'complaint',
    'provider_block', 'legal', 'invalid_address', 'other',
  ].includes(values.suppressionReasonCode)) {
    add('invalid_suppression_reason', 'Suppression reason is outside the supported catalog.', 'suppressionReasonCode')
  }
  const hasEntitlement = values.entitlementPlanId || values.entitlementIdempotencyKey || values.entitlementStartsAt
  if (hasEntitlement && !(values.entitlementPlanId && values.entitlementIdempotencyKey && values.entitlementStartsAt)) {
    add('incomplete_entitlement', 'Entitlement plan, idempotency key, and start time are required together.', 'entitlementPlanId')
  }
  if (values.entitlementStatus && !['pending', 'active', 'expired', 'cancelled'].includes(values.entitlementStatus)) {
    add('invalid_entitlement_status', 'Entitlement status is outside the supported catalog.', 'entitlementStatus')
  }
  if (values.entitlementRenewalMode && !['none', 'manual', 'auto'].includes(values.entitlementRenewalMode)) {
    add('invalid_renewal_mode', 'Renewal mode must be none, manual, or auto.', 'entitlementRenewalMode')
  }
  for (const field of ['entitlementStartsAt', 'entitlementEndsAt']) {
    if (values[field] && Number.isNaN(Date.parse(values[field]))) add('invalid_instant', 'Value must be an ISO timestamp.', field)
  }
  const hasParticipation = values.participationEventId || values.participationSourceId || values.participationStatus
  if (hasParticipation && !(values.participationEventId && values.participationSourceId && values.participantName)) {
    add('incomplete_participation', 'Participation event, source, and attendee name are required together.', 'participationEventId')
  }
  if (values.participationStatus && !['registered', 'attended', 'cancelled', 'no_show'].includes(values.participationStatus)) {
    add('invalid_participation_status', 'Participation status is outside the supported catalog.', 'participationStatus')
  }
  if (values.participantEmail && !z.string().email().safeParse(values.participantEmail).success) {
    add('invalid_email', 'Participant email is invalid.', 'participantEmail')
  }
  if (values.currencyCode && !/^[a-z]{3}$/i.test(values.currencyCode)) {
    add('invalid_currency', 'Currency must be a three-letter ISO code.', 'currencyCode')
  }
  try {
    customValuesFor(values, customCatalog)
  } catch (error) {
    add('invalid_custom_value', error instanceof Error ? error.message : 'Custom field value is invalid.')
  }
  if (kind === 'operations' && !isUuid(values.contactId)) {
    add('required_field', 'Operations rows require a contact UUID.', 'contactId')
  }
  if (kind === 'operations' && !(hasConsent || hasSuppression || hasEntitlement || hasParticipation)) {
    add('required_operation', 'An operations row must contain consent, suppression, entitlement, or participation evidence.')
  }
  return errors
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function jobProjection(row: ImportJobRow): CrmImportJob {
  const { mappingHash: _mappingHash, sourceHash: _sourceHash, createdByUserId: _createdBy, ...job } = row
  return job
}

export type CrmProductionImportService = ReturnType<typeof createCrmProductionImportService>

export function createCrmProductionImportService(deps: {
  filesApi: FilesApi
  operations: CrmOperationsServicePort
  entityLinks?: EntityLinksStore
}) {
  async function customCatalogFor(
    context: ImportServiceContext,
    input: ImportInput,
  ): Promise<ReadonlyMap<string, ImportCustomDefinition>> {
    const requested = [...new Set(Object.values(input.mapping.columns)
      .filter((target): target is string => typeof target === 'string' && target.startsWith('custom:'))
      .map((target) => target.slice('custom:'.length)))]
    if (requested.length === 0) return new Map()
    if (input.entityKind === 'operations') throw new Error('Operations-only imports cannot map custom entity fields.')
    const entityKind = input.entityKind === 'contact' ? 'person' : input.entityKind
    const result = await query<{
      fieldKey: string
      fieldType: ImportCustomDefinition['fieldType']
      options: unknown
    }>(
      `SELECT field_key AS "fieldKey",field_type AS "fieldType",options
         FROM crm_field_definitions
        WHERE workspace_id=$1 AND entity_kind=$2 AND archived_at IS NULL
          AND field_key=ANY($3::text[])`,
      [context.workspaceId, entityKind, requested],
    )
    const catalog = new Map(result.rows.map((field) => [field.fieldKey, {
      fieldKey: field.fieldKey,
      fieldType: field.fieldType,
      options: Array.isArray(field.options)
        ? field.options.filter((option): option is string => typeof option === 'string') : [],
    }]))
    const missing = requested.filter((key) => !catalog.has(key))
    if (missing.length > 0) throw new Error(`Unknown custom import fields: ${missing.join(', ')}.`)
    return catalog
  }

  async function parseStaged(context: ImportServiceContext, input: ImportInput): Promise<ParsedImport> {
    const read = await deps.filesApi.readBytes({
      workspaceId: context.workspaceId,
      userId: context.actor.userId,
      assistantKind: 'primary',
      clearance: 'confidential',
    }, input.stagedFileId)
    if (!read.ok) throw new Error('The staged import file is unavailable.')
    const bytes = read.value.bytes
    if (bytes.byteLength > MAX_IMPORT_BYTES) throw new Error('CRM imports are limited to 30 MB per staged file.')
    const records = parseCsv(Buffer.from(bytes).toString('utf8'))
    const headerIndex = records.findIndex((record) => record.cells.some((cell) => cell.trim()))
    if (headerIndex < 0) throw new Error('The staged CSV is empty.')
    const headers = records[headerIndex].cells.map((header, index) => clean(header) ?? `Column ${index + 1}`)
    const rows = records.slice(headerIndex + 1)
      .filter((record) => record.cells.some((cell) => cell.trim()))
      .map((record, index) => ({ row: index + 2, cells: record.cells, malformedReason: record.malformedReason }))
    if (rows.length > MAX_IMPORT_ROWS) throw new Error('CRM imports are limited to 100000 data rows per job.')
    for (const rawIndex of Object.keys(input.mapping.columns)) {
      if (Number(rawIndex) >= headers.length) throw new Error(`Mapped column ${rawIndex} does not exist in the staged file.`)
    }
    return { bytes, sourceHash: hashBytes(bytes), headers, rows }
  }

  async function dryRun(context: ImportServiceContext, rawInput: ImportInput): Promise<CrmImportDryRun> {
    const input = CrmImportPreflightSchema.parse(rawInput)
    if (input.mapping.trustedIdentitySource && !context.authority.canConfigure) {
      throw new Error('Trusted identity imports require workspace owner or admin authority.')
    }
    const parsed = await parseStaged(context, input)
    const customCatalog = await customCatalogFor(context, input)
    let failedRows = 0
    const sampleErrors: CrmImportError[] = []
    for (const row of parsed.rows) {
      const errors = validateMappedRow(input.entityKind, row, input.mapping, customCatalog)
      if (errors.length > 0) {
        failedRows += 1
        sampleErrors.push(...errors.slice(0, Math.max(0, SAMPLE_ERRORS - sampleErrors.length)))
      }
    }
    return {
      dryRunHash: dryRunHash(parsed.sourceHash, input.mapping, input.entityKind),
      bytes: parsed.bytes.byteLength,
      totalRows: parsed.rows.length,
      validRows: parsed.rows.length - failedRows,
      failedRows,
      headers: parsed.headers,
      sampleErrors,
    }
  }

  async function loadJob(workspaceId: string, jobId: string): Promise<ImportJobRow | null> {
    const result = await query<ImportJobRow>(
      `SELECT id, workspace_id AS "workspaceId", staged_file_id AS "stagedFileId",
              entity_kind AS "entityKind", status, mapping, mapping_hash AS "mappingHash",
              source_hash AS "sourceHash", total_rows AS "totalRows",
              processed_rows AS "processedRows", succeeded_rows AS "succeededRows",
              failed_rows AS "failedRows", next_chunk_index AS "nextChunkIndex",
              created_by_user_id AS "createdByUserId", created_at AS "createdAt",
              updated_at AS "updatedAt", completed_at AS "completedAt"
         FROM crm_import_jobs WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, jobId],
    )
    return result.rows[0] ?? null
  }

  async function confirm(context: ImportServiceContext, rawInput: ConfirmInput): Promise<CrmImportJob> {
    const input = CrmImportConfirmSchema.parse(rawInput)
    const preflightInput: ImportInput = {
      stagedFileId: input.stagedFileId,
      entityKind: input.entityKind,
      mapping: input.mapping,
    }
    const checked = await dryRun(context, preflightInput)
    if (checked.dryRunHash !== input.dryRunHash) throw new Error('The staged file or mapping changed after dry run. Run the dry run again.')
    const parsed = await parseStaged(context, preflightInput)
    const id = randomUUID()
    const result = await query<ImportJobRow>(
      `INSERT INTO crm_import_jobs (
         id, workspace_id, staged_file_id, entity_kind, status, mapping,
         mapping_hash, source_hash, trusted_identity, total_rows,
         created_by_user_id, confirmed_by_user_id
       ) VALUES ($1,$2,$3,$4,'ready',$5::jsonb,$6,$7,$8,$9,$10,$10)
       RETURNING id, workspace_id AS "workspaceId", staged_file_id AS "stagedFileId",
         entity_kind AS "entityKind", status, mapping, mapping_hash AS "mappingHash",
         source_hash AS "sourceHash", total_rows AS "totalRows",
         processed_rows AS "processedRows", succeeded_rows AS "succeededRows",
         failed_rows AS "failedRows", next_chunk_index AS "nextChunkIndex",
         created_by_user_id AS "createdByUserId", created_at AS "createdAt",
         updated_at AS "updatedAt", completed_at AS "completedAt"`,
      [id, context.workspaceId, input.stagedFileId, input.entityKind, JSON.stringify(input.mapping),
        mappingHash(input.mapping), parsed.sourceHash, !!input.mapping.trustedIdentitySource,
        parsed.rows.length, context.actor.userId],
    )
    console.info('[crm-import] job confirmed', { workspaceId: context.workspaceId, jobId: id, totalRows: parsed.rows.length })
    return jobProjection(result.rows[0])
  }

  async function findImportedEntity(workspaceId: string, importKey: string): Promise<string | null> {
    const found = await query<{ id: string }>(
      `SELECT id FROM entities
        WHERE workspace_id=$1 AND valid_to IS NULL
          AND attributes->'external_ref'->>'import_key'=$2
        ORDER BY created_at LIMIT 1`,
      [workspaceId, importKey],
    )
    return found.rows[0]?.id ?? null
  }

  async function findUniqueTrustedEmailContact(
    workspaceId: string,
    email: string,
  ): Promise<{ id: string; attributes: Record<string, unknown> } | null> {
    const found = await query<{ id: string; attributes: Record<string, unknown> }>(
      `SELECT id,attributes FROM entities
        WHERE workspace_id=$1 AND kind='person' AND valid_to IS NULL
          AND retracted_at IS NULL
          AND lower(COALESCE(attributes->>'email',canonical_id,''))=$2
        ORDER BY created_at,id LIMIT 2`,
      [workspaceId, email.trim().toLowerCase()],
    )
    return found.rows.length === 1 ? found.rows[0]! : null
  }

  async function executeRow(
    context: ImportServiceContext,
    job: ImportJobRow,
    row: { row: number; cells: string[] },
    customCatalog: ReadonlyMap<string, ImportCustomDefinition>,
  ): Promise<string | null> {
    const values = mappedValues(row.cells, job.mapping)
    const access: AccessContext = {
      workspaceId: context.workspaceId,
      userId: context.actor.userId,
      assistantId: '',
      assistantKind: 'primary',
      clearance: 'confidential',
    }
    const importKey = `${job.id}:${row.row}`
    let entityId = await findImportedEntity(context.workspaceId, importKey)
    if (!entityId && job.entityKind === 'contact') {
      let stableIdentity: StableExternalIdentity | undefined
      if (job.mapping.trustedIdentitySource && values.identityProvider && values.identityProviderInstance && values.identitySubject) {
        stableIdentity = {
          provider: values.identityProvider,
          providerInstanceKey: values.identityProviderInstance,
          subjectId: values.identitySubject,
        }
      }
      const tags = values.tags?.split(/[|;]/).map((tag) => tag.trim()).filter(Boolean)
      const externalRef = { import_key: importKey, import_job_id: job.id, row_number: row.row }
      const trustedMatch = !stableIdentity && job.mapping.trustedIdentitySource && values.email
        ? await findUniqueTrustedEmailContact(context.workspaceId, values.email)
        : null
      if (trustedMatch) {
        const currentTags = Array.isArray(trustedMatch.attributes.tags)
          ? trustedMatch.attributes.tags.filter((tag): tag is string => typeof tag === 'string') : []
        const currentExternalRef = trustedMatch.attributes.external_ref
          && typeof trustedMatch.attributes.external_ref === 'object'
          && !Array.isArray(trustedMatch.attributes.external_ref)
          ? trustedMatch.attributes.external_ref as Record<string, unknown> : {}
        const record = await updateContact(context.actor.userId, trustedMatch.id, {
          name: values.name,
          email: values.email,
          phone: values.phone,
          companyId: values.companyId,
          tags: [...new Set([...currentTags, ...(tags ?? [])])],
          externalRef: { ...currentExternalRef, ...externalRef },
        }, deps.entityLinks)
        if (!record) throw new Error('The trusted email contact is no longer available.')
        entityId = record.id
      } else {
        const record = await createContact(context.actor.userId, {
          workspaceId: context.workspaceId,
          name: values.name,
          email: values.email,
          phone: values.phone,
          companyId: values.companyId,
          tags,
          externalRef,
          stableIdentity,
          access,
        }, deps.entityLinks)
        entityId = record.id
      }
    } else if (!entityId && job.entityKind === 'company') {
      const record = await createCompany(context.actor.userId, {
        workspaceId: context.workspaceId,
        name: values.name,
        domain: values.domain,
        tags: values.tags?.split(/[|;]/).map((tag) => tag.trim()).filter(Boolean),
        externalRef: { import_key: importKey, import_job_id: job.id, row_number: row.row },
        access,
      })
      entityId = record.id
    } else if (!entityId && job.entityKind === 'deal') {
      const legacyStage = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'].includes(values.stage)
        ? values.stage as 'lead' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost'
        : 'lead'
      const record = await createDeal(context.actor.userId, {
        workspaceId: context.workspaceId,
        contactId: values.contactId,
        companyId: values.companyId,
        stage: legacyStage,
        amount: values.amount ? Number(values.amount) : undefined,
        closeDate: values.closeDate ? new Date(`${values.closeDate}T00:00:00Z`) : undefined,
        externalRef: { import_key: importKey, import_job_id: job.id, row_number: row.row },
      }, deps.entityLinks)
      entityId = record.id
      const entity = await getEntityById(access, entityId)
      if (entity) {
        await updateEntity(context.actor.userId, entityId, {
          displayName: values.name,
          attributes: {
            ...entity.attributes,
            ...(values.currencyCode ? { currency_code: values.currencyCode.toUpperCase() } : {}),
            ...(values.source ? { source: values.source } : {}),
          },
        }, access)
      }
    }

    const customValues = customValuesFor(values, customCatalog)
    if (entityId && Object.keys(customValues).length > 0) {
      await updateCrmCustomFields({ ctx: access, entityId, values: customValues })
    }

    const contactId = job.entityKind === 'contact' ? entityId : values.contactId
    const importContext: CrmOperationsContext = {
      ...context,
      actor: { kind: 'import', jobId: job.id, userId: context.actor.userId },
    }
    if (job.entityKind === 'deal' && entityId && values.pipelineId && values.stageId) {
      await deps.operations.execute(importContext, {
        kind: 'set_deal_pipeline_stage', dealId: entityId,
        pipelineId: values.pipelineId, stageId: values.stageId,
      })
    }
    if (contactId && values.consentPurposeKey) {
      await deps.operations.execute(importContext, {
        kind: 'record_consent', contactId, purposeKey: values.consentPurposeKey,
        action: values.consentAction as 'granted' | 'withdrawn', source: values.consentSource,
        provider: 'import', providerEventId: `${job.id}:${row.row}:consent:${values.consentPurposeKey}`,
        metadata: { importJobId: job.id, importRow: row.row },
      })
    }
    if (contactId && values.suppressionChannel) {
      await deps.operations.execute(importContext, {
        kind: 'record_suppression', contactId,
        channel: values.suppressionChannel as 'all' | 'email' | 'sms' | 'phone' | 'whatsapp' | 'telegram' | 'slack',
        action: values.suppressionAction as 'suppressed' | 'released',
        reasonCode: values.suppressionReasonCode as 'manual_do_not_contact' | 'hard_bounce' | 'soft_bounce' | 'complaint' | 'provider_block' | 'legal' | 'invalid_address' | 'other',
        source: values.suppressionSource,
        provider: 'import', providerEventId: `${job.id}:${row.row}:suppression:${values.suppressionChannel}`,
        metadata: { importJobId: job.id, importRow: row.row },
      })
    }
    if (contactId && values.entitlementPlanId) {
      await deps.operations.execute(importContext, {
        kind: 'grant_entitlement', contactId, planId: values.entitlementPlanId,
        idempotencyKey: values.entitlementIdempotencyKey,
        status: (values.entitlementStatus || 'pending') as 'pending' | 'active' | 'expired' | 'cancelled',
        startsAt: values.entitlementStartsAt,
        endsAt: values.entitlementEndsAt || undefined,
        renewalMode: (values.entitlementRenewalMode || 'none') as 'none' | 'manual' | 'auto',
      })
    }
    if (contactId && values.participationEventId) {
      await deps.operations.execute(importContext, {
        kind: 'record_participation', contactId, eventId: values.participationEventId,
        sourceKind: 'import', sourceId: values.participationSourceId,
        status: (values.participationStatus || 'registered') as 'registered' | 'attended' | 'cancelled' | 'no_show',
        attendeeName: values.participantName,
        attendeeEmail: values.participantEmail,
        metadata: { importJobId: job.id, importRow: row.row },
      })
    }
    return entityId ?? contactId ?? null
  }

  async function resume(context: ImportServiceContext, jobId: string): Promise<CrmImportJob> {
    const job = await loadJob(context.workspaceId, jobId)
    if (!job) throw new Error('Import job was not found.')
    if (job.status === 'completed' || job.status === 'cancelled') return jobProjection(job)
    const claimed = await query<{ id: string }>(
      `UPDATE crm_import_jobs SET status='running'
        WHERE workspace_id=$1 AND id=$2
          AND (status IN ('ready','paused','failed') OR updated_at < now() - interval '5 minutes')
        RETURNING id`,
      [context.workspaceId, jobId],
    )
    if (!claimed.rows[0]) throw new Error('Import job is already processing.')
    const parsed = await parseStaged(context, {
      stagedFileId: job.stagedFileId,
      entityKind: job.entityKind,
      mapping: job.mapping,
    })
    if (parsed.sourceHash !== job.sourceHash) {
      await query(`UPDATE crm_import_jobs SET status='failed' WHERE workspace_id=$1 AND id=$2`, [context.workspaceId, job.id])
      throw new Error('The staged import file changed after confirmation.')
    }
    const customCatalog = await customCatalogFor(context, {
      stagedFileId: job.stagedFileId,
      entityKind: job.entityKind,
      mapping: job.mapping,
    })
    const start = job.nextChunkIndex * CHUNK_ROWS
    const rows = parsed.rows.slice(start, start + CHUNK_ROWS)
    const chunkHash = hashBytes(Buffer.from(JSON.stringify(rows.map((row) => row.cells))))
    const chunk = await query<{ id: string; status: string; inputHash: string }>(
      `INSERT INTO crm_import_chunks (workspace_id,job_id,chunk_index,input_hash,status,started_at)
       VALUES ($1,$2,$3,$4,'running',now())
       ON CONFLICT (job_id,chunk_index) DO UPDATE SET
         status=CASE WHEN crm_import_chunks.status='completed' THEN 'completed' ELSE 'running' END,
         started_at=CASE WHEN crm_import_chunks.status='completed' THEN crm_import_chunks.started_at ELSE now() END
       RETURNING id,status,input_hash AS "inputHash"`,
      [context.workspaceId, job.id, job.nextChunkIndex, chunkHash],
    )
    if (chunk.rows[0].inputHash !== chunkHash) throw new Error('Import chunk input changed after confirmation.')
    if (chunk.rows[0].status === 'completed') {
      const current = await loadJob(context.workspaceId, job.id)
      return jobProjection(current ?? job)
    }
    let succeeded = 0
    let failed = 0
    for (const row of rows) {
      const inputHash = rowHash(row.cells, job.mapping)
      const receipt = await query<{ status: string; inputHash: string }>(
        `SELECT status,input_hash AS "inputHash" FROM crm_import_rows
          WHERE workspace_id=$1 AND job_id=$2 AND row_number=$3`,
        [context.workspaceId, job.id, row.row],
      )
      if (receipt.rows[0]) {
        if (receipt.rows[0].inputHash !== inputHash) throw new Error('Import row input changed after confirmation.')
        if (receipt.rows[0].status === 'completed') succeeded += 1
        else failed += 1
        continue
      }
      const validation = validateMappedRow(job.entityKind, row, job.mapping, customCatalog)
      try {
        if (validation.length > 0) throw new Error(validation.map((error) => error.message).join(' '))
        const entityId = await executeRow(context, job, row, customCatalog)
        await query(
          `INSERT INTO crm_import_rows (workspace_id,job_id,row_number,input_hash,status,entity_id)
           VALUES ($1,$2,$3,$4,'completed',$5)
           ON CONFLICT (job_id,row_number) DO NOTHING`,
          [context.workspaceId, job.id, row.row, inputHash, entityId],
        )
        succeeded += 1
      } catch (error) {
        const first = validation[0]
        const message = error instanceof Error ? error.message.slice(0, 1000) : 'Import row failed.'
        await query(
          `INSERT INTO crm_import_rows (workspace_id,job_id,row_number,input_hash,status)
           VALUES ($1,$2,$3,$4,'failed') ON CONFLICT (job_id,row_number) DO NOTHING`,
          [context.workspaceId, job.id, row.row, inputHash],
        )
        await query(
          `INSERT INTO crm_import_errors (workspace_id,job_id,row_number,error_code,field_key,message,row_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
          [context.workspaceId, job.id, row.row, first?.code ?? 'command_failed',
            first?.field?.replace(/[^a-z0-9_]/gi, '_').toLowerCase() ?? null,
            message, JSON.stringify(mappedValues(row.cells, job.mapping))],
        )
        failed += 1
      }
    }
    const processed = rows.length
    const terminal = start + processed >= parsed.rows.length
    await query(
      `UPDATE crm_import_chunks SET status='completed',processed_rows=$4,succeeded_rows=$5,
         failed_rows=$6,completed_at=now() WHERE workspace_id=$1 AND job_id=$2 AND chunk_index=$3`,
      [context.workspaceId, job.id, job.nextChunkIndex, processed, succeeded, failed],
    )
    await query(
      `UPDATE crm_import_jobs SET status=$3,processed_rows=processed_rows+$4,
         succeeded_rows=succeeded_rows+$5,failed_rows=failed_rows+$6,
         next_chunk_index=next_chunk_index+1,completed_at=CASE WHEN $3='completed' THEN now() ELSE NULL END
       WHERE workspace_id=$1 AND id=$2 AND status <> 'cancelled'`,
      [context.workspaceId, job.id, terminal ? 'completed' : 'paused', processed, succeeded, failed],
    )
    console.info('[crm-import] chunk processed', {
      workspaceId: context.workspaceId, jobId: job.id, chunkIndex: job.nextChunkIndex,
      processedRows: processed, failedRows: failed,
    })
    return jobProjection((await loadJob(context.workspaceId, job.id))!)
  }

  async function cancel(context: ImportServiceContext, jobId: string): Promise<CrmImportJob> {
    await query(
      `UPDATE crm_import_jobs SET status='cancelled'
        WHERE workspace_id=$1 AND id=$2 AND status NOT IN ('completed','cancelled')`,
      [context.workspaceId, jobId],
    )
    const job = await loadJob(context.workspaceId, jobId)
    if (!job) throw new Error('Import job was not found.')
    return jobProjection(job)
  }

  async function list(workspaceId: string): Promise<CrmImportJob[]> {
    const result = await query<ImportJobRow>(
      `SELECT id,workspace_id AS "workspaceId",staged_file_id AS "stagedFileId",
         entity_kind AS "entityKind",status,mapping,mapping_hash AS "mappingHash",
         source_hash AS "sourceHash",total_rows AS "totalRows",processed_rows AS "processedRows",
         succeeded_rows AS "succeededRows",failed_rows AS "failedRows",
         next_chunk_index AS "nextChunkIndex",created_by_user_id AS "createdByUserId",
         created_at AS "createdAt",updated_at AS "updatedAt",completed_at AS "completedAt"
       FROM crm_import_jobs WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50`,
      [workspaceId],
    )
    return result.rows.map(jobProjection)
  }

  async function get(workspaceId: string, jobId: string): Promise<CrmImportJob | null> {
    const job = await loadJob(workspaceId, jobId)
    return job ? jobProjection(job) : null
  }

  async function errorsCsv(workspaceId: string, jobId: string): Promise<string | null> {
    if (!await loadJob(workspaceId, jobId)) return null
    const result = await query<{ rowNumber: number; errorCode: string; fieldKey: string | null; message: string; rowSnapshot: Record<string, unknown> }>(
      `SELECT row_number AS "rowNumber",error_code AS "errorCode",field_key AS "fieldKey",
              message,row_snapshot AS "rowSnapshot"
         FROM crm_import_errors WHERE workspace_id=$1 AND job_id=$2 ORDER BY row_number,id`,
      [workspaceId, jobId],
    )
    return [
      ['row', 'error_code', 'field', 'message', 'mapped_values'].join(','),
      ...result.rows.map((row) => [row.rowNumber, row.errorCode, row.fieldKey, row.message, JSON.stringify(row.rowSnapshot)].map(csvCell).join(',')),
    ].join('\r\n')
  }

  return { dryRun, confirm, resume, cancel, list, get, errorsCsv }
}
