/** Origin-bound application wire contracts. [COMP:shared/application-platform] */
import { z } from 'zod'

const key = z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/)
const opaqueId = z.string().min(1).max(256)
const version = z.string().min(1).max(128)
export const applicationDecimalSchema = z.string().max(96).regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/)

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

const commonField = { key, label: z.string().min(1).max(256), required: z.boolean().optional(),
  immutable: z.boolean().optional(), unique: z.boolean().optional() }
export const applicationFieldSchema = z.discriminatedUnion('kind', [
  z.object({ ...commonField, kind: z.literal('text'), maxLength: z.number().int().min(1).max(8192).optional() }).strict(),
  z.object({ ...commonField, kind: z.literal('number'), minimum: z.number().finite().optional(), maximum: z.number().finite().optional() }).strict(),
  z.object({ ...commonField, kind: z.literal('decimal'), scale: z.number().int().min(0).max(18), currency: z.string().regex(/^[A-Z]{3}$/).optional() }).strict(),
  z.object({ ...commonField, kind: z.literal('boolean') }).strict(),
  z.object({ ...commonField, kind: z.literal('timestamp') }).strict(),
  z.object({ ...commonField, kind: z.literal('enum'), options: z.array(key).min(1).max(128) }).strict(),
  z.object({ ...commonField, kind: z.literal('reference'), targetTypeKey: key }).strict(),
  z.object({ ...commonField, kind: z.literal('file') }).strict(),
  z.object({ ...commonField, kind: z.literal('person') }).strict(),
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
  fields: z.array(key).max(128).optional(),
  filters: z.array(z.object({ field: key, op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains']), value: applicationJsonSchema }).strict()).max(32).default([]),
  sort: z.array(z.object({ field: key, direction: z.enum(['asc', 'desc']) }).strict()).max(8).default([]),
  aggregate: z.array(z.object({ field: key, operation: z.enum(['count', 'sum', 'min', 'max']) }).strict()).max(8).default([]),
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
