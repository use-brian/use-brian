/** Versioned operator configuration input, derived from canonical commands.
 * [COMP:crm/manifest]
 */
import { z } from 'zod'
import {
  CreateCrmRecordFieldCommandSchema, CreateCrmPipelineCommandSchema, CreateCrmPipelineStageCommandSchema,
} from './config-commands.js'
import {
  SaveCrmConsentPurposeCommandSchema, SaveCrmEntitlementPlanCommandSchema, SaveCrmEventCommandSchema,
  SaveCrmIntakeDefinitionCommandSchema, SaveCrmSegmentCommandSchema, isUnverifiedIdentityPolicy,
} from './operations-types.js'
import { CrmSegmentPredicateSchema } from './segments.js'

const Ref = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/)
const Id = z.string().uuid()
const reserved = ['kind', 'actor', 'authority', 'workspaceId', 'expectedVersion', 'definitionId', 'purposeId', 'segmentId']

// A few compatibility schemas strip unknown properties. Manifest input must
// reject those instead of silently claiming the requested change was applied.
function unknownKeys(raw: unknown, parsed: unknown, path: Array<string | number> = []): Array<Array<string | number>> {
  if (!raw || typeof raw !== 'object' || !parsed || typeof parsed !== 'object') return []
  const output: Array<Array<string | number>> = []
  for (const [key, value] of Object.entries(raw)) {
    const next = [...path, Array.isArray(raw) ? Number(key) : key]
    if (!Object.hasOwn(parsed, key)) output.push(next)
    else output.push(...unknownKeys(value, (parsed as Record<string, unknown>)[key], next))
  }
  return output
}

function business<T extends z.ZodTypeAny>(schema: T, kind: string) {
  return z.record(z.unknown()).transform((value, ctx): Omit<z.infer<T>, 'kind'> => {
    for (const key of reserved) if (Object.hasOwn(value, key)) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'This field is derived by the manifest runner, not manifest business data.' })
    }
    const result = schema.safeParse({ ...value, kind })
    if (!result.success) {
      for (const issue of result.error.issues) ctx.addIssue({ ...issue, fatal: true })
      return z.NEVER
    }
    for (const path of unknownKeys(value, result.data)) ctx.addIssue({ code: 'custom', path, message: 'Unknown manifest business property.' })
    const { kind: _kind, ...data } = result.data
    return data
  })
}

const entry = <T extends z.ZodTypeAny>(value: T) => z.object({ ref: Ref, id: Id.optional(), value }).strict()
const definitions = entry(business(SaveCrmIntakeDefinitionCommandSchema, 'save_intake_definition')).extend({
  sensitiveFieldKeys: z.array(Ref).max(100).default([]),
}).superRefine((item, ctx) => {
  if (!isUnverifiedIdentityPolicy(item.value.definition.identityPolicy) || item.value.definition.identityVerification) {
    ctx.addIssue({ code: 'custom', path: ['value', 'definition', 'identityPolicy'], message: 'Trusted identity setup requires the owner-managed settings path; manifests use new_or_review or existing_or_new.' })
  }
  for (const key of item.sensitiveFieldKeys) {
    const field = item.value.definition.fields.find((field: { key: string }) => field.key === key)
    if (!field || field.mapping.kind !== 'submission_only') ctx.addIssue({ code: 'custom', path: ['sensitiveFieldKeys'], message: 'Every sensitive field must exist and use submission_only.' })
  }
})

export const CrmManifestSchema = z.object({
  schemaVersion: z.literal(1),
  sourceLabel: z.string().trim().min(1).max(100),
  recordFields: z.array(entry(business(CreateCrmRecordFieldCommandSchema, 'create_record_field'))).max(150).default([]),
  pipelines: z.array(entry(business(CreateCrmPipelineCommandSchema, 'create_pipeline'))).max(500).default([]),
  pipelineStages: z.array(entry(CreateCrmPipelineStageCommandSchema.omit({ kind: true, pipelineId: true }))
    .extend({ pipelineRef: Ref })).max(1000).default([]),
  consentPurposes: z.array(entry(business(SaveCrmConsentPurposeCommandSchema, 'save_consent_purpose'))
    .refine((item) => !item.value.archived, 'Manifest version 1 does not archive resources; use the settings path.')).max(500).default([]),
  entitlementPlans: z.array(entry(business(SaveCrmEntitlementPlanCommandSchema, 'save_entitlement_plan'))).max(500).default([]),
  events: z.array(entry(business(SaveCrmEventCommandSchema, 'save_event'))).max(500).default([]),
  intakeDefinitions: z.array(definitions).max(500).default([]),
  segments: z.array(entry(business(SaveCrmSegmentCommandSchema, 'save_segment')).superRefine((item, ctx) => {
    const result = CrmSegmentPredicateSchema.safeParse(item.value.predicate)
    if (!result.success) for (const issue of result.error.issues) ctx.addIssue({ ...issue, path: ['value', 'predicate', ...issue.path] })
  })).max(500).default([]),
}).strict().superRefine((manifest, ctx) => {
  const refs = new Set<string>(), identities = new Set<string>()
  const identity = {
    recordFields: (item: { value: Record<string, unknown> }) => `${item.value.entityKind}:${item.value.fieldKey}`,
    pipelines: (item: { value: Record<string, unknown> }) => String(item.value.name),
    pipelineStages: (item: { value: Record<string, unknown>; pipelineRef?: string }) => `${item.pipelineRef}:${item.value.name}`,
    consentPurposes: (item: { value: Record<string, unknown> }) => String(item.value.purposeKey),
    entitlementPlans: (item: { value: Record<string, unknown> }) => String(item.value.key),
    events: (item: { value: Record<string, unknown> }) => String(item.value.slug),
    intakeDefinitions: (item: { value: Record<string, unknown> }) => String(item.value.definitionKey),
    segments: (item: { value: Record<string, unknown> }) => String(item.value.segmentKey),
  }
  for (const key of Object.keys(identity) as Array<keyof typeof identity>) {
    for (const [index, item] of manifest[key].entries()) {
      if (refs.has(item.ref)) ctx.addIssue({ code: 'custom', path: [key, index, 'ref'], message: 'Manifest references must be globally unique.' })
      refs.add(item.ref)
      const name = `${key}:${identity[key](item)}`
      if (identities.has(name)) ctx.addIssue({ code: 'custom', path: [key, index, 'value'], message: 'Manifest business identities must be unique.' })
      identities.add(name)
    }
  }
  for (const [index, item] of manifest.pipelineStages.entries()) {
    if (!manifest.pipelines.some((pipeline) => pipeline.ref === item.pipelineRef)) ctx.addIssue({ code: 'custom', path: ['pipelineStages', index, 'pipelineRef'], message: 'pipelineRef must name a pipeline entry in this manifest.' })
  }
  if (manifest.pipelines.filter((item) => item.value.isDefault).length > 1) ctx.addIssue({ code: 'custom', path: ['pipelines'], message: 'A manifest may select only one default pipeline.' })
})
