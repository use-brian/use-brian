/**
 * Doc v1 — chat tool builders for the user-defined entity layer
 * (Lock #11, `docs/plans/doc-v1-execution.md` §5.2).
 *
 * Nine tools the model uses to manage the brain-first entity types:
 *
 *   - `listEntityTypes`     — discovery; returns built-ins + user-defined.
 *   - `createEntityType`    — declare a new schema.
 *   - `addProperty`         — extend an existing user-defined schema.
 *   - `removeProperty`      — soft-remove a property from a user-defined schema.
 *   - `renameProperty`      — rename a property + data-migrate every row.
 *   - `createEntity`        — create a row of a user-defined entity type.
 *   - `updateEntity`        — patch cells on a user-defined entity row.
 *   - `deleteEntity`        — soft-delete a user-defined entity row.
 *   - `queryEntities`       — typed filter/sort/paginate over rows.
 *
 * These bind only the user-defined half of the doc entity layer. The
 * five built-in primitives (task / contact / company / deal / workflow_run)
 * still flow through their canonical typed tools (`saveTask`,
 * `crmCreateContact`, `runWorkflow`, etc.) — for now this module simply
 * refuses to touch a `builtin:*` id and points the model at the right
 * tool. Phase 2 wires a unified adapter so `createEntity` /
 * `updateEntity` / `deleteEntity` can dispatch over the boundary; until
 * then the rule keeps the typed tools the single source of truth.
 *
 * Separation from `doc/tools.ts` (Agent P1D): those tools operate on
 * **pages** — the document-shaped wire format that wraps a doc
 * surface. This module operates on **entities** — the rows the pages
 * may bind into via `kind: 'data'` blocks. The model picks based on the
 * user's intent: "build me a Recipes page" → `renderPage`; "add a
 * recipe called 'Bolognese'" → `createEntity` on the Recipes type.
 *
 * Pure factory style: `createListEntityTypesTool(deps)` etc. The
 * Phase-1 wire-up (P1I, Batch 3) builds the dep bag and stitches the
 * tools into the per-turn map.
 *
 * [COMP:entities/doc-tools]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import { isAutonomousToolContext } from '../tools/capability-gate.js'
import { isBuiltInEntityTypeId } from './doc-built-ins.js'
import { uuidId } from '../tools/schema-tolerance.js'
import {
  cellValueSchema,
  entityFilterSchema,
  entitySortSchema,
  propertyDefSchema,
} from './doc-schemas.js'
import type {
  CellValue,
  EntityFilter,
  EntityInstance,
  EntitySort,
  EntityStore,
  EntityType,
  PropertyDef,
} from './doc-types.js'

// ── Dep bag ──────────────────────────────────────────────────────────

/**
 * Pure data — no closures keyed on the request. P1I's `inject.ts` will
 * build this from the API package's concrete store + the chat session's
 * workspace + user.
 *
 * `listBuiltInEntityTypes` is injected (rather than imported directly)
 * so tests can pin a fixed roster and so the future P1J/P2 work can
 * filter built-ins by feature-flag.
 */
export type EntityToolDeps = {
  store: EntityStore
  workspaceId: string
  currentUserId: string
  listBuiltInEntityTypes: (workspaceId: string) => EntityType[]
}

// ── Shared shapes ────────────────────────────────────────────────────

const idSchema = z.string().min(1).max(128)
const propertyNameSchema = z.string().min(1).max(128)

const dataPatchSchema = z.record(propertyNameSchema, cellValueSchema)

// ── Input / output types ─────────────────────────────────────────────

export type ListEntityTypesInput = { workspaceId?: string }
export type ListEntityTypesOutput = { types: EntityType[] }

export type CreateEntityTypeInput = {
  workspaceId: string
  name: string
  icon?: string
  properties: PropertyDef[]
}
export type CreateEntityTypeOutput = { entityType: EntityType }

export type AddPropertyInput = {
  workspaceId: string
  entityTypeId: string
  property: PropertyDef
}
export type AddPropertyOutput = { entityType: EntityType }

export type RemovePropertyInput = {
  workspaceId: string
  entityTypeId: string
  propertyName: string
}
export type RemovePropertyOutput = { entityType: EntityType }

export type RenamePropertyInput = {
  workspaceId: string
  entityTypeId: string
  oldName: string
  newName: string
}
export type RenamePropertyOutput = { entityType: EntityType }

export type CreateEntityInput = {
  workspaceId: string
  entityTypeId: string
  data: Record<string, CellValue>
}
export type CreateEntityOutput = { entity: EntityInstance }

export type UpdateEntityInput = {
  workspaceId: string
  entityId: string
  patch: Record<string, CellValue>
}
export type UpdateEntityOutput = { entity: EntityInstance }

export type DeleteEntityInput = { workspaceId: string; entityId: string }
export type DeleteEntityOutput = { deleted: boolean }

export type QueryEntitiesInput = {
  workspaceId: string
  entityTypeId: string
  filters?: EntityFilter[]
  sort?: EntitySort[]
  limit?: number
  cursor?: string
}
export type QueryEntitiesOutput = {
  rows: EntityInstance[]
  nextCursor?: string
}

// ── Zod schemas ──────────────────────────────────────────────────────

const listEntityTypesInputSchema: z.ZodType<ListEntityTypesInput> = z.object({
  workspaceId: idSchema
    .optional()
    .describe(
      'Omit this — the current workspace is resolved from context. (Never pass a workspace name or domain; ids are UUIDs.)',
    ),
})

const createEntityTypeInputSchema: z.ZodType<CreateEntityTypeInput> = z.object({
  workspaceId: idSchema,
  name: z
    .string()
    .min(1)
    .max(256)
    .describe(
      'User-facing name. UNIQUE per workspace (e.g. "Movie", "Recipe", "Habit").',
    ),
  icon: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Optional emoji or short string rendered by the sidebar.'),
  properties: z
    .array(propertyDefSchema)
    .min(1)
    .max(128)
    .describe(
      'The schema. At least one property is required so the entity carries data. Auto kinds (created_time, created_by, last_edited_time, last_edited_by) may be omitted — the server stamps them on every row.',
    ),
})

const addPropertyInputSchema: z.ZodType<AddPropertyInput> = z.object({
  workspaceId: idSchema,
  entityTypeId: idSchema.describe(
    'UUID of the user-defined entity type. Built-in ids (starting with `builtin:`) are rejected — their schemas are fixed.',
  ),
  property: propertyDefSchema.describe(
    'The new property to add. Its `name` must not collide with an existing property on this type.',
  ),
})

const removePropertyInputSchema: z.ZodType<RemovePropertyInput> = z.object({
  workspaceId: idSchema,
  entityTypeId: idSchema.describe(
    'UUID of the user-defined entity type. Built-in ids are rejected.',
  ),
  propertyName: propertyNameSchema.describe(
    'The `name` of the property to remove. The historic cell values stay in `entity_instances.data` JSONB but the schema no longer surfaces them.',
  ),
})

const renamePropertyInputSchema: z.ZodType<RenamePropertyInput> = z.object({
  workspaceId: idSchema,
  entityTypeId: idSchema.describe(
    'UUID of the user-defined entity type. Built-in ids are rejected.',
  ),
  oldName: propertyNameSchema.describe(
    'The current `name` of the property to rename. Must exist on this type.',
  ),
  newName: propertyNameSchema.describe(
    'The new `name` for the property. Must not collide with another property on this type. The property config (type, options, etc.) is preserved.',
  ),
})

const createEntityInputSchema: z.ZodType<CreateEntityInput> = z.object({
  workspaceId: idSchema,
  entityTypeId: idSchema.describe(
    'UUID of the user-defined entity type. For built-ins (`builtin:task`, `builtin:contact`, etc.) use the dedicated typed tool (`saveTask`, `crmCreateContact`, ...).',
  ),
  data: dataPatchSchema.describe(
    'Initial cell values keyed by `PropertyDef.name`. Required properties must be present. Auto kinds are server-stamped — omit them.',
  ),
})

const updateEntityInputSchema: z.ZodType<UpdateEntityInput> = z.object({
  workspaceId: idSchema,
  entityId: idSchema.describe(
    'UUID of the user-defined entity instance to update. Built-in entity rows (tasks / contacts / etc.) are managed through their typed tools.',
  ),
  patch: dataPatchSchema.describe(
    'Partial cell updates keyed by `PropertyDef.name`. Only the keys you include are written — other cells are left intact.',
  ),
})

const deleteEntityInputSchema: z.ZodType<DeleteEntityInput> = z.object({
  workspaceId: idSchema,
  entityId: idSchema.describe(
    'UUID of the user-defined entity instance to soft-delete. Built-in entity rows are managed through their typed tools.',
  ),
})

const queryEntitiesInputSchema: z.ZodType<QueryEntitiesInput> = z.object({
  workspaceId: idSchema,
  entityTypeId: idSchema.describe(
    'UUID of the user-defined entity type. Only user-defined types are queried through this tool — for built-ins use the typed tools (`listTasks`, `crmListContacts`, ...).',
  ),
  filters: z
    .array(entityFilterSchema)
    .max(32)
    .optional()
    .describe(
      'Optional AND-combined filter list. `field` is a `PropertyDef.name`; `value` is coerced against the field\'s property kind by the store.',
    ),
  sort: z
    .array(entitySortSchema)
    .max(8)
    .optional()
    .describe('Optional sort dimensions, applied in array order.'),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe('Optional row cap. Defaults to the store\'s natural limit.'),
  cursor: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe('Opaque pagination cursor from a prior call.'),
})

// ── Helpers ──────────────────────────────────────────────────────────

function errorResult(message: string): { data: string; isError: true } {
  return { data: message, isError: true }
}

function builtInRejection(toolName: string): { data: string; isError: true } {
  return errorResult(
    `${toolName} only handles user-defined entity types. The given id targets a built-in primitive — use its typed tool instead: tasks → saveTask/updateTask/closeTask, contacts/companies/deals → crmCreate*/crmUpdate*, workflow runs → runWorkflow. Built-in schemas are fixed; properties cannot be added or removed.`,
  )
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── listEntityTypes ──────────────────────────────────────────────────

/**
 * Discovery — the model calls this first to learn what entity types
 * exist in the workspace. Built-ins precede user-defined so the model
 * sees the canonical primitives (Task / Contact / Company / Deal /
 * Workflow run) before any bespoke types the user has declared.
 */
export function createListEntityTypesTool(
  deps: EntityToolDeps,
): Tool<typeof listEntityTypesInputSchema> {
  return buildTool({
    name: 'listEntityTypes',
    description:
      'List every entity type in the workspace — both built-in primitives (Task / Contact / Company / Deal / Workflow run) and user-defined types (anything the user has declared like "Recipe", "Movie", "Habit"). ' +
      '\n\n' +
      'Use this BEFORE creating an entity instance so you know the available `entityTypeId`s and their property schemas. ' +
      'Built-in types have ids of the form `builtin:<name>`; user-defined types use UUIDs. ' +
      '\n\n' +
      'Returns `{ types: DocEntityType[] }` with built-ins first, then user-defined types.',
    inputSchema: listEntityTypesInputSchema,
    isReadOnly: true,
    isConcurrencySafe: true,
    timeoutMs: 15_000,

    async execute(input, context) {
      // Context-first workspace resolution. The model-supplied workspaceId
      // was the prod failure mode (`{ workspaceId: "fls.com.hk" }` → DB
      // `invalid input syntax for type uuid`): the model has no legitimate
      // reason to pick a workspace — this surface is always injected
      // workspace-bound (see packages/api/src/doc/inject.ts, which gates on
      // `assistant.workspaceId`). Input stays accepted as a deprecated
      // fallback for context-less callers only.
      const workspaceId = context?.workspaceId ?? input.workspaceId
      if (!workspaceId) {
        return {
          data: 'listEntityTypes requires a workspace-bound context.',
          isError: true,
        }
      }
      try {
        const builtIns = deps.listBuiltInEntityTypes(workspaceId)
        const userDefined = await deps.store.listEntityTypes(workspaceId)
        const types: EntityType[] = [...builtIns, ...userDefined]
        return { data: { types } }
      } catch (err) {
        return errorResult(`Failed to list entity types: ${describeError(err)}`)
      }
    },
  })
}

// ── createEntityType ─────────────────────────────────────────────────

/**
 * Declare a new user-defined entity type. The chat surface for the
 * "make me a Recipes DB with title, photo, prep_time, ingredients" turn.
 *
 * `createdBy` is auto-populated from `deps.currentUserId`; `schemaVersion`
 * is initialised to 1 by the store. Auto-property kinds (created_time /
 * created_by / last_edited_time / last_edited_by) need not be declared
 * here — the server stamps them on every row regardless.
 */
export function createCreateEntityTypeTool(
  deps: EntityToolDeps,
): Tool<typeof createEntityTypeInputSchema> {
  return buildTool({
    name: 'createEntityType',
    description:
      'Declare a brand-new user-defined entity type — the schema for a custom database the user has described in chat ("create a Recipes DB", "I want to track movies I\'ve watched"). ' +
      '\n\n' +
      'Use this for ANY entity the user wants that isn\'t one of the built-ins (Task / Contact / Company / Deal / Workflow run). For built-ins, the schema is fixed — just create instances directly with the typed tools. ' +
      '\n\n' +
      'Properties declare the columns and their types (text / number / select / multi_select / status / date / person / relation / files / checkbox / url / email / phone). At least one property is required. ' +
      '\n\n' +
      'Returns `{ entityType: DocEntityType }` — the persisted type with its new UUID. Pass that id to `createEntity` to start populating instances.',
    inputSchema: createEntityTypeInputSchema,
    isReadOnly: false,
    isConcurrencySafe: false,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const entityType = await deps.store.createEntityType({
          workspaceId: input.workspaceId,
          name: input.name,
          icon: input.icon,
          properties: input.properties,
          createdBy: deps.currentUserId,
        })
        return { data: { entityType } }
      } catch (err) {
        return errorResult(
          `Failed to create entity type: ${describeError(err)}`,
        )
      }
    },
  })
}

// ── addProperty ──────────────────────────────────────────────────────

/**
 * Extend a user-defined schema with one more property. Rejects built-in
 * ids — built-in schemas are fixed.
 *
 * Concurrency: this reads the current property list, appends, and
 * writes back. The store's `updateEntityType` is a last-writer-wins
 * patch; for a strict invariant the API adapter can layer a CAS on
 * `schemaVersion` in Phase 2.
 */
export function createAddPropertyTool(
  deps: EntityToolDeps,
): Tool<typeof addPropertyInputSchema> {
  return buildTool({
    name: 'addProperty',
    description:
      'Add a new property (column) to an existing user-defined entity type. ' +
      'Use when the user says "also track prep time on the Recipes DB" — the schema grows. ' +
      '\n\n' +
      'Built-in entity types (Task / Contact / Company / Deal / Workflow run) have fixed schemas and cannot be extended through this tool — call attempts on `builtin:*` ids return an error. ' +
      '\n\n' +
      'The new property\'s `name` must not collide with any existing property on this type. ' +
      '\n\n' +
      'Returns `{ entityType: DocEntityType }` — the updated type with the bumped `schemaVersion`.',
    inputSchema: addPropertyInputSchema,
    isReadOnly: false,
    isConcurrencySafe: false,
    timeoutMs: 15_000,

    async execute(input) {
      if (isBuiltInEntityTypeId(input.entityTypeId)) {
        return builtInRejection('addProperty')
      }
      try {
        const current = await deps.store.getEntityType(
          input.workspaceId,
          input.entityTypeId,
        )
        if (!current) {
          return errorResult(
            `Entity type ${input.entityTypeId} not found in workspace ${input.workspaceId}.`,
          )
        }
        const collision = current.properties.find(
          p => p.name === input.property.name,
        )
        if (collision) {
          return errorResult(
            `Property "${input.property.name}" already exists on entity type "${current.name}". Use a different name or remove the existing property first.`,
          )
        }
        const updated = await deps.store.updateEntityType(
          input.workspaceId,
          input.entityTypeId,
          { properties: [...current.properties, input.property] },
        )
        return { data: { entityType: updated } }
      } catch (err) {
        return errorResult(`Failed to add property: ${describeError(err)}`)
      }
    },
  })
}

// ── removeProperty ───────────────────────────────────────────────────

/**
 * Soft-remove a property from the schema. Cell values in
 * `entity_instances.data` for that key are preserved by the store
 * (Phase 2 may surface a "restore" path); the schema simply stops
 * listing it.
 */
export function createRemovePropertyTool(
  deps: EntityToolDeps,
): Tool<typeof removePropertyInputSchema> {
  return buildTool({
    name: 'removeProperty',
    description:
      'Remove a property (column) from an existing user-defined entity type. ' +
      'The historical data in already-saved rows is retained at the storage layer but the schema no longer surfaces the column. ' +
      '\n\n' +
      'Built-in entity types have fixed schemas and cannot be edited — call attempts on `builtin:*` ids return an error. ' +
      '\n\n' +
      'Returns `{ entityType: DocEntityType }` — the updated type with the property gone from the list.',
    inputSchema: removePropertyInputSchema,
    isReadOnly: false,
    isConcurrencySafe: false,
    timeoutMs: 15_000,
    // Tier-C write-gate (Posture A, docs/architecture/engine/tool-executor.md
    // §3): removing a property affects EVERY row of the type. Recoverable
    // (cell values stay in JSONB), so no interactive prompt — but a
    // cron/workflow loop rewriting a whole type's schema with no human
    // present must park in Approvals. Gate only on the autonomous path.
    resolveConfirmation: async (context) => isAutonomousToolContext(context),

    async execute(input) {
      if (isBuiltInEntityTypeId(input.entityTypeId)) {
        return builtInRejection('removeProperty')
      }
      try {
        const current = await deps.store.getEntityType(
          input.workspaceId,
          input.entityTypeId,
        )
        if (!current) {
          return errorResult(
            `Entity type ${input.entityTypeId} not found in workspace ${input.workspaceId}.`,
          )
        }
        const remaining = current.properties.filter(
          p => p.name !== input.propertyName,
        )
        if (remaining.length === current.properties.length) {
          return errorResult(
            `Property "${input.propertyName}" does not exist on entity type "${current.name}".`,
          )
        }
        const updated = await deps.store.updateEntityType(
          input.workspaceId,
          input.entityTypeId,
          { properties: remaining },
        )
        return { data: { entityType: updated } }
      } catch (err) {
        return errorResult(`Failed to remove property: ${describeError(err)}`)
      }
    },
  })
}

// ── renameProperty ───────────────────────────────────────────────────

/**
 * Rename a property on a user-defined schema. Rejects built-in ids —
 * built-in schemas are fixed.
 *
 * Unlike `removeProperty` (which only edits the schema and leaves cell
 * values stranded behind the old key), this tool delegates to the
 * store's transactional `renameProperty`: the schema's `PropertyDef`
 * keeps its config but gets the new name, and every existing row's
 * `entity_instances.data` JSONB key is migrated `oldName` → `newName`
 * in the same transaction. The two halves move together so no cell
 * value is orphaned.
 *
 * Validation here mirrors `addProperty` / `removeProperty`: `oldName`
 * must exist, `newName` must not collide with another property. A
 * no-op rename (`oldName === newName`) is rejected — there's nothing to
 * do and it usually signals a model mistake.
 */
export function createRenamePropertyTool(
  deps: EntityToolDeps,
): Tool<typeof renamePropertyInputSchema> {
  return buildTool({
    name: 'renameProperty',
    description:
      'Rename a property (column) on an existing user-defined entity type. ' +
      'Use when the user says "rename the Recipes DB\'s prep_time column to cook_time". ' +
      '\n\n' +
      'This migrates the data too: the column keeps its type and options, and the value in every existing row is carried over to the new name in the same transaction — nothing is lost. ' +
      'This is the difference from removing and re-adding a property, which would strand the old values. ' +
      '\n\n' +
      'Built-in entity types (Task / Contact / Company / Deal / Workflow run) have fixed schemas and cannot be edited — call attempts on `builtin:*` ids return an error. ' +
      '\n\n' +
      'The `oldName` must be an existing property; the `newName` must not collide with another property on this type. ' +
      '\n\n' +
      'Returns `{ entityType: DocEntityType }` — the updated type with the renamed property and bumped `schemaVersion`.',
    inputSchema: renamePropertyInputSchema,
    isReadOnly: false,
    isConcurrencySafe: false,
    timeoutMs: 30_000,
    // Tier-C write-gate (see removeProperty): migrates EVERY row's JSONB
    // key in one transaction. Reversible (rename back), so interactive
    // stays silent; the autonomous path gates.
    resolveConfirmation: async (context) => isAutonomousToolContext(context),

    async execute(input) {
      if (isBuiltInEntityTypeId(input.entityTypeId)) {
        return builtInRejection('renameProperty')
      }
      if (input.oldName === input.newName) {
        return errorResult(
          `Property "${input.oldName}" is already named that — nothing to rename.`,
        )
      }
      try {
        const current = await deps.store.getEntityType(
          input.workspaceId,
          input.entityTypeId,
        )
        if (!current) {
          return errorResult(
            `Entity type ${input.entityTypeId} not found in workspace ${input.workspaceId}.`,
          )
        }
        const existing = current.properties.find(
          p => p.name === input.oldName,
        )
        if (!existing) {
          return errorResult(
            `Property "${input.oldName}" does not exist on entity type "${current.name}".`,
          )
        }
        const collision = current.properties.find(
          p => p.name === input.newName,
        )
        if (collision) {
          return errorResult(
            `Property "${input.newName}" already exists on entity type "${current.name}". Choose a different name.`,
          )
        }
        const updated = await deps.store.renameProperty(
          input.workspaceId,
          input.entityTypeId,
          input.oldName,
          input.newName,
        )
        return { data: { entityType: updated } }
      } catch (err) {
        return errorResult(`Failed to rename property: ${describeError(err)}`)
      }
    },
  })
}

// ── createEntity ─────────────────────────────────────────────────────

/**
 * Create one row of a user-defined entity type. Built-in ids are
 * rejected with a redirect to the typed tool — `saveTask` etc. own the
 * dedicated tables.
 *
 * Phase 2 plans a unified adapter so this tool can also dispatch into
 * the built-in tables; until then keeping the rejection means the typed
 * tools stay the canonical write path.
 */
export function createCreateEntityTool(
  deps: EntityToolDeps,
): Tool<typeof createEntityInputSchema> {
  return buildTool({
    name: 'createEntity',
    description:
      'Create one row of a user-defined entity type — e.g. add a recipe to the Recipes DB. ' +
      '\n\n' +
      'For BUILT-IN entity types (Task / Contact / Company / Deal / Workflow run) use the typed tools (`saveTask`, `crmCreateContact`, `crmCreateCompany`, `crmCreateDeal`, `runWorkflow`) — they handle the dedicated tables. Built-in ids on this tool return a redirect error. ' +
      '\n\n' +
      'Different from page-level tools: `renderPage` / `patchPage` build the document around the rows; `createEntity` writes the rows themselves. ' +
      '\n\n' +
      'Returns `{ entity: DocEntityInstance }` — the persisted instance with its new UUID + server-stamped auto fields.',
    inputSchema: createEntityInputSchema,
    isReadOnly: false,
    isConcurrencySafe: false,
    timeoutMs: 15_000,

    async execute(input) {
      if (isBuiltInEntityTypeId(input.entityTypeId)) {
        return builtInRejection('createEntity')
      }
      try {
        const entity = await deps.store.createEntity({
          workspaceId: input.workspaceId,
          entityTypeId: input.entityTypeId,
          data: input.data,
          sourceApp: 'chat',
          createdBy: deps.currentUserId,
          lastEditedBy: deps.currentUserId,
        })
        return { data: { entity } }
      } catch (err) {
        return errorResult(`Failed to create entity: ${describeError(err)}`)
      }
    },
  })
}

// ── updateEntity ─────────────────────────────────────────────────────

/**
 * Patch cells on a user-defined entity row. Built-in entity ids are
 * not currently inspectable through this tool — the typed tools own
 * the dedicated tables.
 *
 * The store handles the JSONB merge: only the keys in `patch` are
 * written; other cells are left intact.
 */
export function createUpdateEntityTool(
  deps: EntityToolDeps,
): Tool<typeof updateEntityInputSchema> {
  return buildTool({
    name: 'updateEntity',
    description:
      'Update cells on an existing user-defined entity row — e.g. change a recipe\'s prep_time. ' +
      'Only the keys in `patch` are written; other cells are left intact. ' +
      '\n\n' +
      'For BUILT-IN entity rows (tasks / contacts / companies / deals / workflow runs) use the typed tools (`updateTask`, `crmUpdateContact`, ...) — they read and write the dedicated tables. ' +
      '\n\n' +
      'Returns `{ entity: DocEntityInstance }` — the updated row.',
    inputSchema: updateEntityInputSchema,
    isReadOnly: false,
    isConcurrencySafe: false,
    timeoutMs: 15_000,

    async execute(input) {
      if (isBuiltInEntityTypeId(input.entityId)) {
        return builtInRejection('updateEntity')
      }
      try {
        const current = await deps.store.getEntity(
          input.workspaceId,
          input.entityId,
        )
        if (!current) {
          return errorResult(
            `Entity ${input.entityId} not found in workspace ${input.workspaceId}.`,
          )
        }
        const mergedData: Record<string, CellValue> = {
          ...current.data,
          ...input.patch,
        }
        const entity = await deps.store.updateEntity(
          input.workspaceId,
          input.entityId,
          { data: mergedData, lastEditedBy: deps.currentUserId },
        )
        return { data: { entity } }
      } catch (err) {
        return errorResult(`Failed to update entity: ${describeError(err)}`)
      }
    },
  })
}

// ── deleteEntity ─────────────────────────────────────────────────────

/**
 * Soft-delete a user-defined entity row. The storage layer marks the
 * row inactive; subsequent `queryEntities` / `getEntity` calls return
 * `null`. Built-in ids are rejected.
 */
export function createDeleteEntityTool(
  deps: EntityToolDeps,
): Tool<typeof deleteEntityInputSchema> {
  return buildTool({
    name: 'deleteEntity',
    description:
      'Soft-delete a user-defined entity row. The row stops being returned by reads; the storage layer retains the bytes for future restore. ' +
      '\n\n' +
      'For BUILT-IN entity rows use the typed tools (`closeTask`, `crmDeleteContact`, ...) — they own the dedicated tables. ' +
      '\n\n' +
      'Returns `{ deleted: true }` when the row was found and removed; surfaces an error otherwise.',
    inputSchema: deleteEntityInputSchema,
    isReadOnly: false,
    isConcurrencySafe: false,
    timeoutMs: 15_000,
    // Tier-C write-gate (see removeProperty): soft-delete is recoverable
    // (bytes retained), so interactive stays silent; a headless loop
    // mass-deleting rows parks in Approvals.
    resolveConfirmation: async (context) => isAutonomousToolContext(context),

    async execute(input) {
      if (isBuiltInEntityTypeId(input.entityId)) {
        return builtInRejection('deleteEntity')
      }
      try {
        await deps.store.deleteEntity(input.workspaceId, input.entityId)
        return { data: { deleted: true } }
      } catch (err) {
        return errorResult(`Failed to delete entity: ${describeError(err)}`)
      }
    },
  })
}

// ── queryEntities ────────────────────────────────────────────────────

/**
 * Typed query over a user-defined entity type's rows. Different from
 * the generic brain `search`: filters / sorts work on declared
 * `PropertyDef.name`s and are coerced against the property kind by
 * the store. Use when the answer requires schema-aware row access.
 */
export function createQueryEntitiesTool(
  deps: EntityToolDeps,
): Tool<typeof queryEntitiesInputSchema> {
  return buildTool({
    name: 'queryEntities',
    description:
      'Filter, sort and paginate rows of a user-defined entity type. ' +
      'Different from the generic brain `search`: filters work on declared property names and are coerced against each property\'s kind. ' +
      '\n\n' +
      'Use when the user asks a question that needs schema-aware row access — e.g. "show me Recipes with prep_time under 20 minutes sorted by title". ' +
      'For full-text or semantic search over the brain, use `search` instead. For data block rows on a doc page, use `queryDataBlock`. ' +
      '\n\n' +
      'Built-in ids (`builtin:task`, etc.) are NOT supported by this tool — use the typed list tools (`listTasks`, `crmListContacts`, ...) which already understand the dedicated tables. ' +
      '\n\n' +
      'Returns `{ rows: DocEntityInstance[], nextCursor?: string }`.',
    inputSchema: queryEntitiesInputSchema,
    isReadOnly: true,
    isConcurrencySafe: true,
    timeoutMs: 30_000,

    async execute(input) {
      if (isBuiltInEntityTypeId(input.entityTypeId)) {
        return builtInRejection('queryEntities')
      }
      try {
        const result = await deps.store.queryEntities(
          input.workspaceId,
          input.entityTypeId,
          input.filters,
          input.sort,
          input.limit,
          input.cursor,
        )
        return {
          data: {
            rows: result.rows,
            ...(result.nextCursor !== undefined
              ? { nextCursor: result.nextCursor }
              : {}),
          },
        }
      } catch (err) {
        return errorResult(`Failed to query entities: ${describeError(err)}`)
      }
    },
  })
}

// ── Aggregate factory ───────────────────────────────────────────────

/**
 * Build all nine doc entity tools at once. The Phase-1 inject site
 * (P1I) calls this and merges the result into the per-turn tool map.
 */
export function createDocEntityTools(deps: EntityToolDeps): {
  listEntityTypes: Tool<typeof listEntityTypesInputSchema>
  createEntityType: Tool<typeof createEntityTypeInputSchema>
  addProperty: Tool<typeof addPropertyInputSchema>
  removeProperty: Tool<typeof removePropertyInputSchema>
  renameProperty: Tool<typeof renamePropertyInputSchema>
  createEntity: Tool<typeof createEntityInputSchema>
  updateEntity: Tool<typeof updateEntityInputSchema>
  deleteEntity: Tool<typeof deleteEntityInputSchema>
  queryEntities: Tool<typeof queryEntitiesInputSchema>
} {
  return {
    listEntityTypes: createListEntityTypesTool(deps),
    createEntityType: createCreateEntityTypeTool(deps),
    addProperty: createAddPropertyTool(deps),
    removeProperty: createRemovePropertyTool(deps),
    renameProperty: createRenamePropertyTool(deps),
    createEntity: createCreateEntityTool(deps),
    updateEntity: createUpdateEntityTool(deps),
    deleteEntity: createDeleteEntityTool(deps),
    queryEntities: createQueryEntitiesTool(deps),
  }
}
