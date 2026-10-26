/** Canonical value validation, independent of transport/storage. [COMP:security/application-access] */
import { ApplicationPlatformError, applicationDecimalSchema, applicationJsonSchema,
  type ApplicationResourceDefinition, type ApplicationJson } from '@use-brian/shared'
import { cellValueSchema, propertyDefSchema } from '../entities/doc-schemas.js'
import type { CellValue, PropertyDef } from '../entities/doc-types.js'
import { z } from 'zod'
import { CrmRecordFieldDefinitionSchema } from '../crm/config-commands.js'
import { validateCrmCustomFieldValue, type CrmCustomFieldDefinition } from '../crm/types.js'

const systemKinds = new Set(['created_time', 'created_by', 'last_edited_time', 'last_edited_by'])
const reserved = new Set(['__proto__', 'prototype', 'constructor'])
function invalid(message: string): never { throw new ApplicationPlatformError('invalid_value', message) }

/** Preserve the existing CRM metadata/value vocabulary in application catalogs. */
export function parseApplicationCrmFieldDefinition(raw: Record<string, unknown>): CrmCustomFieldDefinition {
  const { id, position, ...definition } = raw
  const parsed = CrmRecordFieldDefinitionSchema.safeParse(definition)
  if (!parsed.success || !z.string().uuid().safeParse(id).success || !z.number().int().min(0).safeParse(position).success) {
    throw new ApplicationPlatformError('invalid_schema', 'A canonical CRM field is invalid.')
  }
  return { ...parsed.data, id: id as string, position: position as number }
}

export function canonicalApplicationDecimal(value: string, scale?: number): string {
  if (!applicationDecimalSchema.safeParse(value).success) invalid('A lossless decimal string is required.')
  const negative = value.startsWith('-')
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.')
  if (scale !== undefined && (!Number.isInteger(scale) || scale < 0 || scale > 18 || fraction.length > scale)) {
    invalid('The decimal exceeds the declared scale.')
  }
  const trimmed = fraction.replace(/0+$/, '')
  const magnitude = whole + (trimmed ? `.${trimmed}` : '')
  return negative && magnitude !== '0' ? `-${magnitude}` : magnitude
}

/** Integer arithmetic only; callers choose the declared currency scale. */
export function applicationDecimalUnits(value: string, scale: number): bigint {
  const canonical = canonicalApplicationDecimal(value, scale)
  const negative = canonical.startsWith('-')
  const [whole, fraction = ''] = (negative ? canonical.slice(1) : canonical).split('.')
  const units = BigInt(whole + fraction.padEnd(scale, '0'))
  return negative ? -units : units
}

export function validApplicationDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return false
  const day = value.slice(0, 10)
  const parsedDay = new Date(`${day}T00:00:00.000Z`)
  return Number.isFinite(Date.parse(value)) && Number.isFinite(parsedDay.getTime()) && parsedDay.toISOString().slice(0, 10) === day
}

export function validateApplicationValues(schema: ApplicationResourceDefinition, input: Record<string, unknown>,
  previous?: Record<string, ApplicationJson>): Record<string, ApplicationJson> {
  const fields = new Map(schema.fields.map(field => [field.key, field]))
  const parsed = applicationJsonSchema.safeParse(input)
  if (!parsed.success || !parsed.data || Array.isArray(parsed.data) || typeof parsed.data !== 'object') invalid('Invalid record values.')
  const canonical = schema.fields.flatMap(field => {
    if (field.kind !== 'cell') return []
    const property = propertyDefSchema.safeParse(field.property)
    if (!property.success || property.data.name !== field.key) throw new ApplicationPlatformError('invalid_schema', 'A canonical property is invalid.')
    return [property.data]
  })
  for (const [name, value] of Object.entries(input)) {
    const field = fields.get(name)
    if (!field || reserved.has(name)) invalid('An undeclared field was supplied.')
    if (field.immutable && (!previous || JSON.stringify(previous[name]) !== JSON.stringify(value))) invalid('A system field is immutable.')
    if (value === null) { if (field.required) invalid('A required value is missing.'); continue }
    switch (field.kind) {
      case 'text': if (typeof value !== 'string' || value.length > (field.maxLength ?? 8192)) invalid('Invalid text value.'); break
      case 'number': if (typeof value !== 'number' || !Number.isFinite(value)
        || field.minimum !== undefined && value < field.minimum || field.maximum !== undefined && value > field.maximum) invalid('Invalid numeric value.'); break
      case 'decimal': if (typeof value !== 'string') invalid('A decimal must be a string.'); canonicalApplicationDecimal(value, field.scale); break
      case 'boolean': if (typeof value !== 'boolean') invalid('Invalid boolean value.'); break
      case 'timestamp': if (typeof value !== 'string' || !value.includes('T') || !validApplicationDate(value)) invalid('Invalid timestamp value.'); break
      case 'enum': if (typeof value !== 'string' || !field.options.includes(value)) invalid('Invalid enum value.'); break
      case 'reference': case 'file': case 'person':
        if (typeof value !== 'string' || value.length === 0 || value.length > 256) invalid('Invalid reference.'); break
      case 'json':
        if (field.shape === 'array') {
          if (!Array.isArray(value) || field.maxItems !== undefined && value.length > field.maxItems) invalid('Invalid native array value.')
          if (field.items === 'text' && value.some(item => typeof item !== 'string'
            || field.maxItemLength !== undefined && item.length > field.maxItemLength)) invalid('Invalid native array item.')
        } else if (typeof value !== 'object' || Array.isArray(value)) invalid('Invalid native object value.')
        break
      case 'cell': break // Complete canonical cell validation, including missing values, follows below.
      case 'crm': if (!validateCrmCustomFieldValue(parseApplicationCrmFieldDefinition(field.definition), value)) invalid('Invalid canonical CRM value.'); break
    }
  }
  for (const field of schema.fields) {
    if (field.required && !field.immutable && (input[field.key] === undefined || input[field.key] === null || input[field.key] === '')) invalid('A required value is missing.')
    if (field.kind === 'crm' && !validateCrmCustomFieldValue(parseApplicationCrmFieldDefinition(field.definition), input[field.key])) invalid('A required canonical CRM value is missing.')
  }
  if (canonical.length) {
    const cells = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values)
      .filter(([name]) => canonical.some(property => property.name === name))) as Record<string, CellValue>
    validateDocApplicationValues(canonical, cells(input), previous ? cells(previous) : undefined)
  }
  return parsed.data
}

export function validateDocApplicationSchema(properties: PropertyDef[]): void {
  const names = new Set<string>()
  for (const property of properties) {
    if (!propertyDefSchema.safeParse(property).success || names.has(property.name) || reserved.has(property.name)) {
      throw new ApplicationPlatformError('invalid_schema', 'Invalid, duplicate or reserved property.')
    }
    names.add(property.name)
    const config = property.config
    if (config.kind === 'number' && config.minimum !== undefined && config.maximum !== undefined && config.minimum > config.maximum) {
      throw new ApplicationPlatformError('invalid_schema', 'Invalid numeric bounds.')
    }
    const options = config.kind === 'select' || config.kind === 'multi_select' ? config.options
      : config.kind === 'status' ? config.groups.flatMap(group => group.options) : []
    if (new Set(options.map(option => option.id)).size !== options.length
      || config.kind === 'status' && new Set(config.groups.map(group => group.id)).size !== config.groups.length) {
      throw new ApplicationPlatformError('invalid_schema', 'Duplicate option or status group.')
    }
    if (property.unique && !['text', 'number', 'select', 'status', 'email', 'phone', 'url', 'person', 'relation'].includes(config.kind)) {
      throw new ApplicationPlatformError('invalid_schema', 'Uniqueness requires a scalar property.')
    }
  }
}

/** Validate the final row, including unchanged required cells on patch/import. */
export function validateDocApplicationValues(properties: PropertyDef[], data: Record<string, CellValue>,
  previous?: Record<string, CellValue>): void {
  validateDocApplicationSchema(properties)
  const declared = new Map(properties.map(property => [property.name, property]))
  for (const [name, cell] of Object.entries(data)) {
    const property = declared.get(name)
    if (!property || reserved.has(name)) invalid('An undeclared field was supplied.')
    if (!cellValueSchema.safeParse(cell).success || cell.kind !== property.config.kind) invalid('A cell does not match its declared kind.')
    if (!applicationJsonSchema.safeParse(cell.value).success) invalid('A cell must contain JSON data.')
    if (systemKinds.has(cell.kind) && (!previous || JSON.stringify(previous[name]) !== JSON.stringify(cell))) invalid('A system field is immutable.')
    if (cell.value === null) continue
    const config = property.config
    if (cell.kind === 'number' && config.kind === 'number' && cell.value !== null) {
      if (!Number.isFinite(cell.value) || config.format === 'int' && !Number.isInteger(cell.value)
        || config.minimum !== undefined && cell.value < config.minimum || config.maximum !== undefined && cell.value > config.maximum) invalid('Invalid numeric value.')
    }
    if ((cell.kind === 'select' || cell.kind === 'multi_select' || cell.kind === 'status')
      && (config.kind === 'select' || config.kind === 'multi_select' || config.kind === 'status')) {
      const options = new Set((config.kind === 'status' ? config.groups.flatMap(group => group.options) : config.options).map(option => option.id))
      const selected = Array.isArray(cell.value) ? cell.value : [cell.value]
      if (new Set(selected).size !== selected.length || selected.some(value => !options.has(value))) invalid('Invalid enum value.')
    }
    if (cell.kind === 'date' && cell.value && config.kind === 'date') {
      if (!validApplicationDate(cell.value.start) || cell.value.end !== undefined
        && (!config.supportRange || !validApplicationDate(cell.value.end) || Date.parse(cell.value.end) < Date.parse(cell.value.start))
        || cell.value.time && !config.includeTime) invalid('Invalid date or date range.')
    }
    if (cell.kind === 'files' && cell.value.some(file => !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0)) invalid('Invalid file size.')
  }
  for (const property of properties) {
    if (!property.required || systemKinds.has(property.config.kind)) continue
    const value = data[property.name]?.value
    if (value === undefined || value === null || value === '' || Array.isArray(value) && value.length === 0) invalid('A required value is missing.')
  }
}
