/** Origin-bound application wire contracts. [COMP:shared/application-platform] */
import { z } from 'zod'

const key = z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/)
const opaqueId = z.string().min(1).max(256)
const version = z.string().min(1).max(128)
const fieldKey = z.string().min(1).max(128).refine(value => !['__proto__', 'prototype', 'constructor'].includes(value))
export const applicationDecimalSchema = z.string().max(96).regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/)

/** Decimal text for arithmetic. Numbers use their JSON spelling, never toFixed. */
export function applicationDecimalText(value: string | number): string {
  if (typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) {
    throw new ApplicationPlatformError('invalid_value', 'An unsafe numeric amount requires a decimal string.')
  }
  let text = String(value)
  if (typeof value === 'number' && text.includes('e')) {
    const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/.exec(text)
    if (!match) throw new ApplicationPlatformError('invalid_value', 'Invalid decimal amount.')
    const digits = match[2] + (match[3] ?? ''), point = match[2].length + Number(match[4])
    text = match[1] + (point <= 0 ? '0.' + '0'.repeat(-point) + digits
      : point >= digits.length ? digits + '0'.repeat(point-digits.length) : digits.slice(0,point) + '.' + digits.slice(point))
  }
  if (!applicationDecimalSchema.safeParse(text).success) throw new ApplicationPlatformError('invalid_value', 'Invalid decimal amount.')
  return text
}
function applicationDecimalInteger(value: string | number): bigint {
  const text = applicationDecimalText(value), negative = text.startsWith('-')
  const [whole,fraction = ''] = (negative ? text.slice(1) : text).split('.')
  const units = BigInt(whole + fraction.padEnd(18,'0'))
  return negative ? -units : units
}
/** Exact addition at the shared decimal scale; no currency rounding is implied. */
export function applicationDecimalAdd(left: string | number, right: string | number): string {
  const sum = applicationDecimalInteger(left) + applicationDecimalInteger(right), negative = sum < 0n
  const digits = (negative ? -sum : sum).toString().padStart(19,'0'), fraction = digits.slice(-18).replace(/0+$/,'')
  const result = (negative ? '-' : '') + digits.slice(0,-18) + (fraction ? '.' + fraction : '')
  return applicationDecimalText(result)
}
export function applicationDecimalCompare(left: string | number, right: string | number): -1 | 0 | 1 {
  const a = applicationDecimalInteger(left), b = applicationDecimalInteger(right)
  return a < b ? -1 : a > b ? 1 : 0
}

export const applicationOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('native'), moduleKey: key }).strict(),
  z.object({ kind: z.literal('generic'), entityTypeId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('external'), connectorInstanceId: z.string().uuid(), sourceTenant: opaqueId }).strict(),
])
export const applicationResourceRefSchema = z.object({
  workspaceId: z.string().uuid(), origin: applicationOriginSchema,
  typeKey: key, id: opaqueId, version,
}).strict()
export type ApplicationResourceRef = z.infer<typeof applicationResourceRefSchema>

const commonField = { key: fieldKey, label: z.string().min(1).max(256), required: z.boolean().optional(),
  immutable: z.boolean().optional(), unique: z.boolean().optional() }
export const applicationFieldSchema = z.discriminatedUnion('kind', [
  z.object({ ...commonField, kind: z.literal('text'), maxLength: z.number().int().min(1).max(8192).optional() }).strict(),
  z.object({ ...commonField, kind: z.literal('number'), minimum: z.number().finite().optional(), maximum: z.number().finite().optional() }).strict(),
  z.object({ ...commonField, kind: z.literal('decimal'), scale: z.number().int().min(0).max(18), currency: z.string().regex(/^[A-Z]{3}$/).optional() }).strict(),
  z.object({ ...commonField, kind: z.literal('boolean') }).strict(),
  z.object({ ...commonField, kind: z.literal('timestamp') }).strict(),
  z.object({ ...commonField, kind: z.literal('enum'), options: z.array(opaqueId).min(1).max(128) }).strict(),
  z.object({ ...commonField, kind: z.literal('reference'), targetTypeKey: key }).strict(),
  z.object({ ...commonField, kind: z.literal('file') }).strict(),
  z.object({ ...commonField, kind: z.literal('person') }).strict(),
  z.object({ ...commonField, kind: z.literal('cell'), property: z.lazy(() => z.record(applicationJsonSchema)), relationshipResolverKey: key.optional() }).strict(),
  z.object({ ...commonField, kind: z.literal('crm'), definition: z.lazy(() => z.record(applicationJsonSchema)) }).strict(),
])
export const applicationResourceSchema = z.object({
  typeKey: key, origin: applicationOriginSchema, schemaVersion: version,
  fields: z.array(applicationFieldSchema).max(128),
}).strict().superRefine((resource, ctx) => {
  const seen = new Set<string>()
  for (const [index, field] of resource.fields.entries()) {
    if (seen.has(field.key) || ['constructor', 'prototype', '__proto__'].includes(field.key)) {
      ctx.addIssue({ code: 'custom', path: ['fields', index, 'key'], message: 'Duplicate or reserved field key' })
    }
    seen.add(field.key)
    if (field.kind === 'cell' && (field.property.name !== field.key || !field.property.config
      || typeof field.property.config !== 'object' || Array.isArray(field.property.config))) {
      ctx.addIssue({ code: 'custom', path: ['fields', index], message: 'A cell requires its canonical property declaration' })
    }
    if (field.kind === 'cell' && field.relationshipResolverKey && ((field.property.config as { kind?: unknown } | null)?.kind !== 'relation'
      || !/^relation\.[a-f0-9]{64}$/.test(field.relationshipResolverKey))) {
      ctx.addIssue({ code: 'custom', path: ['fields', index], message: 'A relationship resolver requires a canonical relation' })
    }
    if (field.kind === 'enum' && new Set(field.options).size !== field.options.length) {
      ctx.addIssue({ code: 'custom', path: ['fields', index, 'options'], message: 'Duplicate enum option' })
    }
    if (field.kind === 'number' && field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) {
      ctx.addIssue({ code: 'custom', path: ['fields', index], message: 'Invalid numeric bounds' })
    }
  }
})
export type ApplicationResourceDefinition = z.infer<typeof applicationResourceSchema>
export type ApplicationFieldDefinition = ApplicationResourceDefinition['fields'][number]

export type ApplicationJson = null | boolean | number | string | ApplicationJson[] | { [key: string]: ApplicationJson }
export const applicationJsonSchema: z.ZodType<ApplicationJson> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(applicationJsonSchema), z.record(applicationJsonSchema),
]))
export const applicationQuerySchema = z.object({
  fields: z.array(fieldKey).max(128).optional(),
  filters: z.array(z.object({ field: fieldKey, op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains']), value: applicationJsonSchema }).strict()).max(32).default([]),
  sort: z.array(z.object({ field: fieldKey, direction: z.enum(['asc', 'desc']) }).strict()).max(8).default([]),
  aggregate: z.array(z.object({ field: fieldKey, operation: z.enum(['count', 'sum', 'min', 'max']) }).strict()).max(8).default([]),
  limit: z.number().int().min(1).max(100).default(50), cursor: z.string().max(4096).optional(),
}).strict()
export type ApplicationQuery = z.infer<typeof applicationQuerySchema>
export const applicationCommandSchema = z.object({
  idempotencyKey: z.string().min(1).max(128), correlationKey: z.string().min(1).max(128).optional(),
  expectedVersion: version.optional(), input: applicationJsonSchema,
}).strict()
export type ApplicationCommand = z.infer<typeof applicationCommandSchema>

export const APPLICATION_ERROR_CODES = ['invalid_schema', 'invalid_value', 'schema_version_conflict',
  'record_version_conflict', 'operation_not_available', 'access_unavailable', 'authentication_required',
  'grant_revoked', 'source_unavailable', 'outcome_uncertain'] as const
export type ApplicationErrorCode = typeof APPLICATION_ERROR_CODES[number]
export type ApplicationEffectStatus = 'none' | 'committed' | 'uncertain'
export class ApplicationPlatformError extends Error {
  constructor(readonly code: ApplicationErrorCode, message: string,
    readonly effect: ApplicationEffectStatus = 'none', readonly retrySafe = effect === 'none') {
    super(message)
    this.name = 'ApplicationPlatformError'
  }
}

export interface ApplicationRecordProjection {
  ref: ApplicationResourceRef
  values: Record<string, ApplicationJson>
  fields: string[]
  /** Readable declared cells observed absent; withheld cells are never listed. */
  absentFields?: string[]
  policyVersion: string
}
export interface ApplicationOperationReceipt {
  id: string
  idempotencyKey: string
  effect: ApplicationEffectStatus
  resources: ApplicationResourceRef[]
}
export interface ApplicationModuleCatalog {
  version: string
  dependencies: string[]
  resources: ApplicationResourceDefinition[]
  queries: string[]
  commands: string[]
  events: string[]
  policyCapabilities: string[]
  backgroundHandlers: string[]
  uiContributions: string[]
}

export const applicationPrincipalSchema = z.object({
  kind: z.enum(['member', 'external_user', 'service']), userId: z.string().uuid(),
}).strict()
export type ApplicationPrincipal = z.infer<typeof applicationPrincipalSchema>
export const applicationSelectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ids'), ids: z.array(opaqueId).min(1).max(100) }).strict(),
  z.object({ kind: z.literal('self') }).strict(),
  z.object({ kind: z.literal('relationship'), resolverKey: key, anchorId: opaqueId }).strict(),
])
export const applicationActionSchema = z.string().regex(/^(?:read|query|create|patch|delete|history|schema|command:[a-z][a-z0-9_.-]{0,127})$/)
export const applicationGrantSchema = z.object({
  id: z.string().uuid(), appId: z.string().uuid(), workspaceId: z.string().uuid(),
  principal: applicationPrincipalSchema, origin: applicationOriginSchema, typeKey: key,
  actions: z.array(applicationActionSchema).min(1).max(128),
  readFields: z.array(fieldKey).max(128), writeFields: z.array(fieldKey).max(128),
  selector: applicationSelectorSchema, version: z.number().int().min(1).safe(),
  status: z.enum(['active', 'suspended', 'revoked']), startsAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }).nullable(), parentGrantId: z.string().uuid().nullable(),
  compartments: z.array(z.string().min(1)).max(128), projectIds: z.array(z.string().uuid()).max(128),
  clearance: z.enum(['public', 'internal', 'confidential']),
}).strict()
export type ApplicationAccessGrant = z.infer<typeof applicationGrantSchema>
/** Human/Brian proposals never supply status, issuer, revisions or captured maxima. */
export const applicationGrantInputSchema = applicationGrantSchema.omit({
  id: true, appId: true, workspaceId: true, version: true, status: true, startsAt: true,
}).superRefine((grant, ctx) => {
  for (const keys of [grant.actions, grant.readFields, grant.writeFields, grant.compartments, grant.projectIds]) {
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'Grant sets cannot contain duplicates.' })
  }
})
export type ApplicationGrantInput = z.infer<typeof applicationGrantInputSchema>
export const applicationCredentialInputSchema = z.object({
  name: z.string().min(1).max(128), kind: z.enum(['service', 'delegated']), serviceUserId: z.string().uuid(),
  grantIds: z.array(z.string().uuid()).min(1).max(128), expiresAt: z.string().datetime({ offset: true }),
}).strict().superRefine((input, ctx) => {
  if (new Set(input.grantIds).size !== input.grantIds.length) ctx.addIssue({ code: 'custom', message: 'Credential grants must be distinct.' })
})

/** Leaf first, followed by every immutable parent binding at consent/issuance. */
export const applicationGrantMaximumSchema = z.object({
  version: z.literal(1), grants: z.array(applicationGrantSchema).min(1).max(16),
}).strict().superRefine((maximum, ctx) => {
  const ids = new Set<string>()
  for (const [index, grant] of maximum.grants.entries()) {
    if (ids.has(grant.id) || grant.status !== 'active'
      || grant.appId !== maximum.grants[0].appId || grant.workspaceId !== maximum.grants[0].workspaceId
      || grant.parentGrantId !== (maximum.grants[index + 1]?.id ?? null)) {
      ctx.addIssue({ code: 'custom', message: 'A maximum must contain the complete bound grant path.' })
    }
    ids.add(grant.id)
  }
})
export type ApplicationGrantMaximum = z.infer<typeof applicationGrantMaximumSchema>

function exactPublicUrl(value: string, originOnly: boolean): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      && !url.username && !url.password && !url.hash && !value.includes('*')
      && (!originOnly || url.origin === value)
  } catch { return false }
}
export const applicationClientInputSchema = z.object({
  workspaceId: z.string().uuid(), moduleKey: key, name: z.string().min(1).max(128),
  mode: z.enum(['home_app', 'external_frontend', 'api_client']),
  origins: z.array(z.string().url().refine(value => exactPublicUrl(value, true))).max(16),
  redirectUris: z.array(z.string().url().refine(value => exactPublicUrl(value, false))).max(16),
  homeAppId: z.string().uuid().nullable().optional(),
  executingAssistantId: z.string().uuid().nullable().optional(),
}).strict().superRefine((client, ctx) => {
  if (client.mode === 'external_frontend' && (!client.origins.length || !client.redirectUris.length)) {
    ctx.addIssue({ code: 'custom', message: 'A browser client requires exact origins and redirects.' })
  }
  if (client.mode !== 'home_app' && client.homeAppId) ctx.addIssue({ code: 'custom', message: 'Only a Home client can bind a Home app.' })
  if (client.redirectUris.some(uri => !client.origins.includes(new URL(uri).origin))) {
    ctx.addIssue({ code: 'custom', message: 'Every redirect must belong to a registered origin.' })
  }
})
export type ApplicationClientInput = z.infer<typeof applicationClientInputSchema>
