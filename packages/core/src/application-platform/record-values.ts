/** Shared typed-record value contract; no CRM tools or store implementation. [COMP:crm/r2-store] */
import { z } from 'zod'
import { applicationDecimalSchema, applicationDecimalText, applicationDecimalCompare } from '@use-brian/shared'
/** Exact decimals remain strings; legacy finite numbers retain their shape. */
export const crmAmountSchema = z.union([
  z.number().finite().nonnegative().refine(value => { try { applicationDecimalText(value); return true } catch { return false } }),
  applicationDecimalSchema.refine(value => !value.startsWith('-') || !/[1-9]/.test(value)),
])
export type CrmAmount = z.infer<typeof crmAmountSchema>

/** Original SQL decimal text recovers precision before a rounded JSON number can escape. */
export function decodeCrmAmount(value: unknown, originalText?: string | null): CrmAmount | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && originalText !== undefined && originalText !== null) {
    if (crmAmountSchema.safeParse(value).success && applicationDecimalCompare(value,originalText) === 0) return value
    return crmAmountSchema.parse(originalText)
  }
  return crmAmountSchema.parse(value)
}

export const DEAL_STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] as const
export type DealStage = (typeof DEAL_STAGES)[number]

/**
 * External-system reference for synced rows. Free-form for v1; the
 * intended shape is `{provider, id, url}` but it is not validated at this
 * layer. Open item #5 (sync engine architecture) will firm up the schema
 * later. Same convention as `TaskExternalRef`.
 */
export type CrmExternalRef = Record<string, unknown>

export const CRM_CUSTOM_FIELD_TYPES = [
  'text', 'number', 'date', 'boolean', 'single_select', 'multi_select',
  'entity_reference',
] as const
export type CrmCustomFieldType = (typeof CRM_CUSTOM_FIELD_TYPES)[number]
export type CrmCustomFieldEntityKind = 'person' | 'company' | 'deal'
export type CrmCustomFieldDefinition = {
  id: string
  entityKind: CrmCustomFieldEntityKind
  fieldKey: string
  label: string
  fieldType: CrmCustomFieldType
  options: string[]
  isRequired: boolean
  position: number
}
export type CrmCustomFieldWriteResult = {
  id: string
  entityKind: CrmCustomFieldEntityKind
  values: Record<string, unknown>
}

/** Canonical shape validator; current references are checked by the CRM writer. */
export function validateCrmCustomFieldValue(
  definition: Pick<CrmCustomFieldDefinition, 'fieldType' | 'options' | 'isRequired'>,
  value: unknown,
): boolean {
  if (value === null || value === undefined || value === '') return !definition.isRequired
  switch (definition.fieldType) {
    case 'text': return typeof value === 'string' && value.length <= 10_000
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'date': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
      const [year, month, day] = value.split('-').map(Number)
      const parsed = new Date(Date.UTC(year, month - 1, day))
      return parsed.getUTCFullYear() === year
        && parsed.getUTCMonth() === month - 1
        && parsed.getUTCDate() === day
    }
    case 'boolean': return typeof value === 'boolean'
    case 'single_select': return typeof value === 'string' && definition.options.includes(value)
    case 'multi_select':
      return Array.isArray(value)
        && value.every((v) => typeof v === 'string' && definition.options.includes(v))
    case 'entity_reference':
      return typeof value === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  }
}
