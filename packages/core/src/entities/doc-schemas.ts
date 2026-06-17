/**
 * Doc v1 — Zod schemas for the user-defined entity type layer.
 *
 * Round-trip parity with the TypeScript types in `./doc-types.ts` is
 * enforced via `z.ZodType<X>` annotations on every top-level schema. The
 * server validates `entity_types` / `entity_instances` writes through
 * these at the API boundary; chat-tool input schemas reuse the same
 * primitives so the model can declare schemas in one call.
 *
 * Spec: `docs/plans/doc-v1-execution.md` §5.1.
 *
 * [COMP:entities/doc-types]
 */

import { z } from 'zod'
import type {
  CellValue,
  EntityFilter,
  EntityInstance,
  EntitySort,
  EntityType,
  EntityTypeRef,
  PropertyConfig,
  PropertyDef,
  PropertyKind,
  SelectOption,
  StatusGroup,
} from './doc-types.js'

// ── Primitive width caps ──────────────────────────────────────────────
//
// Numbers picked to match the project's existing schema posture (see
// `packages/core/src/views/blocks.ts`):
//   - Stable handles capped at 128 chars (UUID + nanoid both fit).
//   - User-visible names capped at 256 chars (Notion limit).
//   - Free text capped at 8192 chars per cell — wider strings should
//     ride the `text` JSONB rich-text shape, not a single string.

const idSchema = z.string().min(1).max(128)
const shortStringSchema = z.string().min(1).max(256)
const colorTokenSchema = z.string().min(1).max(64)

// ── Property kind enum ────────────────────────────────────────────────

export const propertyKindSchema: z.ZodType<PropertyKind> = z.enum([
  'text',
  'number',
  'select',
  'multi_select',
  'status',
  'date',
  'person',
  'relation',
  'files',
  'checkbox',
  'url',
  'email',
  'phone',
  'created_time',
  'created_by',
  'last_edited_time',
  'last_edited_by',
])

// ── Option / group schemas ────────────────────────────────────────────

export const selectOptionSchema: z.ZodType<SelectOption> = z.object({
  id: idSchema,
  name: shortStringSchema,
  color: colorTokenSchema.optional(),
})

export const statusGroupSchema: z.ZodType<StatusGroup> = z.object({
  id: z.enum(['pending', 'in_progress', 'done']),
  label: shortStringSchema,
  options: z.array(selectOptionSchema).max(64),
})

// ── EntityTypeRef ─────────────────────────────────────────────────────

const builtinEntityTypeRefSchema = z.object({
  kind: z.literal('builtin'),
  name: z.enum(['task', 'contact', 'company', 'deal', 'workflow_run']),
})

const userDefinedEntityTypeRefSchema = z.object({
  kind: z.literal('user_defined'),
  entityTypeId: idSchema,
})

export const entityTypeRefSchema: z.ZodType<EntityTypeRef> =
  z.discriminatedUnion('kind', [
    builtinEntityTypeRefSchema,
    userDefinedEntityTypeRefSchema,
  ])

// ── PropertyConfig ────────────────────────────────────────────────────

const textConfigSchema = z.object({ kind: z.literal('text') })

const numberConfigSchema = z.object({
  kind: z.literal('number'),
  format: z.enum(['int', 'decimal', 'percent', 'dollar', 'comma']).optional(),
})

const selectConfigSchema = z.object({
  kind: z.literal('select'),
  options: z.array(selectOptionSchema).max(128),
})

const multiSelectConfigSchema = z.object({
  kind: z.literal('multi_select'),
  options: z.array(selectOptionSchema).max(128),
})

const statusConfigSchema = z.object({
  kind: z.literal('status'),
  groups: z.array(statusGroupSchema).max(8),
})

const dateConfigSchema = z.object({
  kind: z.literal('date'),
  includeTime: z.boolean().optional(),
  supportRange: z.boolean().optional(),
})

const personConfigSchema = z.object({ kind: z.literal('person') })

const relationConfigSchema = z.object({
  kind: z.literal('relation'),
  targetEntityTypeRef: entityTypeRefSchema,
})

const filesConfigSchema = z.object({ kind: z.literal('files') })
const checkboxConfigSchema = z.object({ kind: z.literal('checkbox') })
const urlConfigSchema = z.object({ kind: z.literal('url') })
const emailConfigSchema = z.object({ kind: z.literal('email') })
const phoneConfigSchema = z.object({ kind: z.literal('phone') })

const createdTimeConfigSchema = z.object({ kind: z.literal('created_time') })
const createdByConfigSchema = z.object({ kind: z.literal('created_by') })
const lastEditedTimeConfigSchema = z.object({
  kind: z.literal('last_edited_time'),
})
const lastEditedByConfigSchema = z.object({ kind: z.literal('last_edited_by') })

export const propertyConfigSchema: z.ZodType<PropertyConfig> =
  z.discriminatedUnion('kind', [
    textConfigSchema,
    numberConfigSchema,
    selectConfigSchema,
    multiSelectConfigSchema,
    statusConfigSchema,
    dateConfigSchema,
    personConfigSchema,
    relationConfigSchema,
    filesConfigSchema,
    checkboxConfigSchema,
    urlConfigSchema,
    emailConfigSchema,
    phoneConfigSchema,
    createdTimeConfigSchema,
    createdByConfigSchema,
    lastEditedTimeConfigSchema,
    lastEditedByConfigSchema,
  ])

// ── PropertyDef ───────────────────────────────────────────────────────

export const propertyDefSchema: z.ZodType<PropertyDef> = z.object({
  name: z.string().min(1).max(128),
  label: shortStringSchema.optional(),
  config: propertyConfigSchema,
  required: z.boolean().optional(),
})

// ── EntityType ────────────────────────────────────────────────────────

export const entityTypeSchema: z.ZodType<EntityType> = z.object({
  id: idSchema,
  workspaceId: idSchema,
  name: shortStringSchema,
  icon: z.string().min(1).max(64).optional(),
  properties: z.array(propertyDefSchema).max(128),
  schemaVersion: z.number().int().nonnegative(),
  createdAt: z.string().min(1).max(64),
  createdBy: idSchema.nullable(),
})

// ── CellValue ─────────────────────────────────────────────────────────
//
// Each variant mirrors the discriminated union in doc-types.ts. `text`
// is left open (`z.unknown()`) because the rich-text shape ships from
// the renderer module and the brain layer treats it opaquely. The other
// variants are tightly typed.

const textCellSchema = z.object({
  kind: z.literal('text'),
  value: z.unknown(),
})

const numberCellSchema = z.object({
  kind: z.literal('number'),
  value: z.number().nullable(),
})

const selectCellSchema = z.object({
  kind: z.literal('select'),
  value: idSchema.nullable(),
})

const multiSelectCellSchema = z.object({
  kind: z.literal('multi_select'),
  value: z.array(idSchema).max(128),
})

const statusCellSchema = z.object({
  kind: z.literal('status'),
  value: idSchema.nullable(),
})

const dateCellSchema = z.object({
  kind: z.literal('date'),
  value: z
    .object({
      start: z.string().min(1).max(64),
      end: z.string().min(1).max(64).optional(),
      time: z.boolean().optional(),
    })
    .nullable(),
})

const personCellSchema = z.object({
  kind: z.literal('person'),
  value: idSchema.nullable(),
})

const relationCellSchema = z.object({
  kind: z.literal('relation'),
  value: idSchema.nullable(),
})

const fileAttachmentSchema = z.object({
  bucket: z.string().min(1).max(256),
  path: z.string().min(1).max(1024),
  mimeType: z.string().min(1).max(128),
  sizeBytes: z.number().int().nonnegative(),
  name: shortStringSchema,
})

const filesCellSchema = z.object({
  kind: z.literal('files'),
  value: z.array(fileAttachmentSchema).max(64),
})

const checkboxCellSchema = z.object({
  kind: z.literal('checkbox'),
  value: z.boolean(),
})

const urlCellSchema = z.object({
  kind: z.literal('url'),
  value: z.string().min(0).max(2048).nullable(),
})

const emailCellSchema = z.object({
  kind: z.literal('email'),
  value: z.string().min(0).max(256).nullable(),
})

const phoneCellSchema = z.object({
  kind: z.literal('phone'),
  value: z.string().min(0).max(64).nullable(),
})

const createdTimeCellSchema = z.object({
  kind: z.literal('created_time'),
  value: z.string().min(1).max(64),
})

const createdByCellSchema = z.object({
  kind: z.literal('created_by'),
  value: idSchema,
})

const lastEditedTimeCellSchema = z.object({
  kind: z.literal('last_edited_time'),
  value: z.string().min(1).max(64),
})

const lastEditedByCellSchema = z.object({
  kind: z.literal('last_edited_by'),
  value: idSchema,
})

export const cellValueSchema: z.ZodType<CellValue> = z.discriminatedUnion(
  'kind',
  [
    textCellSchema,
    numberCellSchema,
    selectCellSchema,
    multiSelectCellSchema,
    statusCellSchema,
    dateCellSchema,
    personCellSchema,
    relationCellSchema,
    filesCellSchema,
    checkboxCellSchema,
    urlCellSchema,
    emailCellSchema,
    phoneCellSchema,
    createdTimeCellSchema,
    createdByCellSchema,
    lastEditedTimeCellSchema,
    lastEditedByCellSchema,
  ],
)

// ── EntityInstance ────────────────────────────────────────────────────

export const entityInstanceSchema: z.ZodType<EntityInstance> = z.object({
  id: idSchema,
  entityTypeId: idSchema,
  workspaceId: idSchema,
  data: z.record(z.string().min(1).max(128), cellValueSchema),
  sourceApp: z.enum(['doc', 'chat', 'import', 'api']),
  createdAt: z.string().min(1).max(64),
  createdBy: idSchema.nullable(),
  lastEditedAt: z.string().min(1).max(64),
  lastEditedBy: idSchema.nullable(),
})

// ── Query primitives ──────────────────────────────────────────────────

// `z.unknown()` makes the field optional in the inferred output type,
// which clashes with the TS shape (`value: unknown` is *present* but
// untyped). The cast pins the parity. Same trick used in `views/schemas.ts`
// for the open-shape patch on `editOpSchema`.
export const entityFilterSchema: z.ZodType<EntityFilter> = z.object({
  field: z.string().min(1).max(128),
  op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains']),
  value: z.unknown(),
}) as unknown as z.ZodType<EntityFilter>

export const entitySortSchema: z.ZodType<EntitySort> = z.object({
  field: z.string().min(1).max(128),
  direction: z.enum(['asc', 'desc']),
})
