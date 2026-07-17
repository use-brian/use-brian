/**
 * Zod schemas for Q5 Views — BindingConfig + SavedView.
 *
 * The discriminated union mirrors the TS types in `./types.ts`. HTTP route
 * handlers and the chat tools (`renderView`, `saveView`) validate against
 * these. The DB stores `binding JSONB` as raw JSON — these schemas are the
 * single source of truth at the application layer.
 */

import { z } from 'zod'
import { IMAGE_ICON_RE } from '@sidanclaw/shared'
import { TASK_STATUSES } from '../tasks/types.js'
import { DEAL_STAGES } from '../crm/types.js'
import { WORKFLOW_RUN_STATUSES } from '../workflow/types.js'
import {
  COMPANY_COLUMN_IDS,
  CONTACT_COLUMN_IDS,
  DEAL_COLUMN_IDS,
  TASK_COLUMN_IDS,
  VIEW_ENTITIES,
  VIEW_TYPES,
  WORKFLOW_RUN_COLUMN_IDS,
  type BindingConfig,
} from './types.js'

const isoDateString = z.string().datetime({ offset: true })
const uuid = z.string().uuid()

// ── Per-view display state (Notion-database UX) ───────────────────────
//
// Validates `binding.display` — the persisted column widths / order / hidden
// set / frozen-count / sort / filter chips that ride on the data block's
// binding (see `types.ts` → ViewDisplay). Because `renderBinding` POSTs the
// binding UNWRAPPED and the route parses it through `bindingConfigSchema`,
// any field absent here would be silently stripped before it round-trips —
// so this schema is what makes per-view display state durable.

const viewSortSchema = z.object({
  field: z.string().min(1).max(128),
  direction: z.enum(['asc', 'desc']),
})

const viewColumnFilterSchema = z.object({
  propertyName: z.string().min(1).max(128),
  op: z.string().min(1).max(32),
  value: z
    .union([
      z.string().max(512),
      z.number().finite(),
      z.boolean(),
      z.array(z.string().max(256)).max(50),
      z.null(),
    ])
    .optional(),
})

const viewDisplaySchema = z.object({
  // Widths clamp 40..1200px; the renderer further constrains live drag to
  // its own min/max (60/800).
  columnWidths: z.record(z.number().int().min(40).max(1200)).optional(),
  order: z.array(z.string().min(1).max(128)).max(100).optional(),
  hidden: z.array(z.string().min(1).max(128)).max(100).optional(),
  frozenCount: z.number().int().min(0).max(50).optional(),
  sort: viewSortSchema.nullable().optional(),
  filters: z.array(viewColumnFilterSchema).max(50).optional(),
})

// ── Per-entity binding schemas ────────────────────────────────────────

const tasksTableSchema = z.object({
  entity: z.literal('tasks'),
  viewType: z.literal('table'),
  filters: z.object({
    status: z.array(z.enum(TASK_STATUSES)).optional(),
    assigneeId: uuid.optional(),
    tag: z.string().min(1).max(64).optional(),
    dueBefore: isoDateString.optional(),
    dueAfter: isoDateString.optional(),
  }).optional(),
  columns: z.array(z.enum(TASK_COLUMN_IDS)).optional(),
  display: viewDisplaySchema.optional(),
})

const tasksBoardSchema = z.object({
  entity: z.literal('tasks'),
  viewType: z.literal('board'),
  groupBy: z.literal('status'),
  filters: z.object({
    assigneeId: uuid.optional(),
    tag: z.string().min(1).max(64).optional(),
  }).optional(),
  columns: z.array(z.enum(TASK_COLUMN_IDS)).optional(),
})

const contactsTableSchema = z.object({
  entity: z.literal('contacts'),
  viewType: z.literal('table'),
  filters: z.object({
    query: z.string().min(1).max(256).optional(),
    tag: z.string().min(1).max(64).optional(),
    companyId: uuid.optional(),
  }).optional(),
  columns: z.array(z.enum(CONTACT_COLUMN_IDS)).optional(),
  display: viewDisplaySchema.optional(),
})

const companiesTableSchema = z.object({
  entity: z.literal('companies'),
  viewType: z.literal('table'),
  filters: z.object({
    query: z.string().min(1).max(256).optional(),
    tag: z.string().min(1).max(64).optional(),
  }).optional(),
  columns: z.array(z.enum(COMPANY_COLUMN_IDS)).optional(),
  display: viewDisplaySchema.optional(),
})

const dealsTableSchema = z.object({
  entity: z.literal('deals'),
  viewType: z.literal('table'),
  filters: z.object({
    stage: z.array(z.enum(DEAL_STAGES)).optional(),
    contactId: uuid.optional(),
    companyId: uuid.optional(),
  }).optional(),
  columns: z.array(z.enum(DEAL_COLUMN_IDS)).optional(),
  display: viewDisplaySchema.optional(),
})

const dealsBoardSchema = z.object({
  entity: z.literal('deals'),
  viewType: z.literal('board'),
  groupBy: z.literal('stage'),
  filters: z.object({
    contactId: uuid.optional(),
    companyId: uuid.optional(),
  }).optional(),
  columns: z.array(z.enum(DEAL_COLUMN_IDS)).optional(),
})

const workflowRunsTableSchema = z.object({
  entity: z.literal('workflow_runs'),
  viewType: z.literal('table'),
  filters: z.object({
    workflowId: uuid,
    status: z.array(z.enum(WORKFLOW_RUN_STATUSES)).optional(),
  }),
  columns: z.array(z.enum(WORKFLOW_RUN_COLUMN_IDS)).optional(),
  display: viewDisplaySchema.optional(),
})

// User-defined entity table (Phase B). `columns` is a free string array (the
// property names), not a closed enum — the schema is user-authored.
const customEntityTableSchema = z.object({
  entity: z.literal('custom'),
  entityTypeId: uuid,
  viewType: z.literal('table'),
  columns: z.array(z.string().min(1).max(128)).max(200).optional(),
  display: viewDisplaySchema.optional(),
})

// ── Public schemas ────────────────────────────────────────────────────

/**
 * BindingConfig discriminated union. Two-key discrimination
 * (`entity` + `viewType`) — Zod handles this via composed unions.
 */
export const bindingConfigSchema: z.ZodType<BindingConfig> = z.union([
  tasksTableSchema,
  tasksBoardSchema,
  contactsTableSchema,
  companiesTableSchema,
  dealsTableSchema,
  dealsBoardSchema,
  workflowRunsTableSchema,
  customEntityTableSchema,
]) as z.ZodType<BindingConfig>

export const viewEntitySchema = z.enum(VIEW_ENTITIES)
export const viewTypeSchema = z.enum(VIEW_TYPES)

/** SavedView CRUD inputs validated at HTTP route boundaries. */
export const savedViewCreateInputSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(2000).nullable().optional(),
  binding: bindingConfigSchema,
})

/**
 * A page icon value: an emoji grapheme (≤16 chars) OR an image token
 * `img:<workspaceId>/<fileId>` (a workspace-files image minted by the
 * `fetchSiteIcon` doc tool — see `@sidanclaw/shared` `page-icon.ts` and
 * doc.md → "Image icons"). One definition, reused by the REST update
 * schema and the `patchPage` `setIcon` op.
 */
export const pageIconValueSchema = z.union([
  z.string().max(16),
  z.string().regex(IMAGE_ICON_RE),
])

export const savedViewUpdateInputSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(2000).nullable().optional(),
  /** Per-page icon — emoji grapheme or `img:` token, `null` to clear. */
  icon: pageIconValueSchema.nullable().optional(),
  /** Notion-style per-page width toggle (migration 220). */
  fullWidth: z.boolean().optional(),
  /** Page-level clearance (migration 212). The route rejects a value above
   *  the setter's own workspace clearance. */
  clearance: z.enum(['public', 'internal', 'confidential']).optional(),
  binding: bindingConfigSchema.optional(),
  /** Per-page "Sync to brain" toggle (migration 001_doc_brain_sync). */
  brainSyncEnabled: z.boolean().optional(),
})
