/**
 * Doc v1 — user-defined entity types (brain-first β).
 *
 * Lock #11 (`docs/plans/doc-v1-execution.md` §1) split the brain entity
 * model into two coexisting halves:
 *
 *   - Built-in entity types — tasks / contacts / companies / deals /
 *     workflow_runs — keep their existing Postgres tables (the Q1-Q4
 *     company-brain primitives). The chat tools for those tables don't
 *     change shape; this module *names* them via `EntityTypeRef.builtin`
 *     so user-defined entities can `relation`-link to them.
 *   - User-defined entity types — live in `entity_types` /
 *     `entity_instances` (migration 200). The user describes a schema in
 *     chat ("Recipes with title, photo, prep_time, ingredients"); we
 *     materialise an `EntityType` row and CRUD instances of it.
 *
 * Property-type catalog (16 kinds — Lock #13). This is the DSL for
 * entity-schema declarations and the discriminator on cell values.
 *
 * Naming note. The existing `packages/core/src/entities/types.ts` owns the
 * brain-anchor entity layer (`EntityRecord` / `EntityLinksStore` / etc.).
 * Doc v1's user-defined entity types are a separate concept living in
 * separate Postgres tables under a separate RLS policy — they share the
 * "entity" word but not the schema. This file's `EntityStore` interface
 * is re-exported as `DocEntityStore` from `./index.ts` to disambiguate
 * from the brain-anchor `EntityStore` already in scope.
 *
 * Spec: `docs/plans/doc-v1-execution.md` §5.1,
 *       `docs/plans/doc-notion-clone.md` §7.4 (full v1 property list),
 *       `packages/api/migrations/200_doc_v1.sql` (table shapes).
 *
 * [COMP:entities/doc-types]
 */

// ── Property kinds (v1 catalog — 16) ──────────────────────────────────

/**
 * The closed enum of property-type kinds the v1 entity layer supports.
 *
 * Drawn from `docs/plans/doc-notion-clone.md` §7.4 — the `shipped` +
 * `v1` rows, minus compute (`formula`, `rollup`, AI autofill) which are
 * explicitly out of v1 scope.
 *
 * The 4 `*_time` / `*_by` kinds are *auto* properties: the server stamps
 * the value on insert / edit; the user never picks a value for them.
 */
export type PropertyKind =
  | 'text'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'status'
  | 'date'
  | 'person'
  | 'relation'
  | 'files'
  | 'checkbox'
  | 'url'
  | 'email'
  | 'phone'
  | 'created_time'
  | 'created_by'
  | 'last_edited_time'
  | 'last_edited_by'

// ── Option / group helpers ────────────────────────────────────────────

/**
 * One option in a `select` / `multi_select` / `status` property. `id` is
 * stable across renames (cell values reference the id, not the name).
 * `color` is a free-form short token interpreted by the renderer (today:
 * the Tailwind shadcn palette keys).
 */
export type SelectOption = {
  id: string
  name: string
  color?: string
}

/**
 * One group in a `status` property. Mirrors Notion's grouped enum: every
 * status option belongs to one of `pending` / `in_progress` / `done`,
 * which gives Board / Timeline views a stable summary axis even when the
 * user adds custom statuses inside a group.
 */
export type StatusGroup = {
  id: 'pending' | 'in_progress' | 'done'
  label: string
  options: SelectOption[]
}

// ── Entity type reference (for relation properties) ───────────────────

/**
 * Tagged reference to either a built-in entity table or a user-defined
 * `entity_types` row. Used by the `relation` property kind so the
 * referenced type can be resolved across the built-in / user-defined
 * boundary.
 */
export type EntityTypeRef =
  | { kind: 'builtin'; name: 'task' | 'contact' | 'company' | 'deal' | 'workflow_run' }
  | { kind: 'user_defined'; entityTypeId: string }

// ── Per-kind property config ──────────────────────────────────────────

/**
 * Schema-declaration knobs for one property kind. Discriminator: `kind`.
 *
 * For the auto kinds (`created_time`, `created_by`, etc.) the config has
 * no extra knobs — but the variant exists so a `PropertyDef` covering a
 * timestamp can sit in the same union as a user-declared select.
 */
export type PropertyConfig =
  | { kind: 'text' }
  | {
      kind: 'number'
      format?: 'int' | 'decimal' | 'percent' | 'dollar' | 'comma'
    }
  | { kind: 'select'; options: SelectOption[] }
  | { kind: 'multi_select'; options: SelectOption[] }
  | { kind: 'status'; groups: StatusGroup[] }
  | { kind: 'date'; includeTime?: boolean; supportRange?: boolean }
  | { kind: 'person' }
  | { kind: 'relation'; targetEntityTypeRef: EntityTypeRef }
  | { kind: 'files' }
  | { kind: 'checkbox' }
  | { kind: 'url' }
  | { kind: 'email' }
  | { kind: 'phone' }
  | { kind: 'created_time' }
  | { kind: 'created_by' }
  | { kind: 'last_edited_time' }
  | { kind: 'last_edited_by' }

/**
 * One declared property on an entity type. The `name` is the canonical
 * key used in `EntityInstance.data` and in JSONB filter paths; `label`
 * is the human-facing display name (falls back to `name` when absent).
 *
 * Formula / rollup are intentionally absent — the v1 brief moves compute
 * to chat ("the assistant *is* the compute layer", doc-notion-clone.md
 * §"Premise"). Adding them back is a non-trivial product call, not a
 * shape extension.
 */
export type PropertyDef = {
  /** Unique within the entity type. Snake-case by convention. */
  name: string
  /** Human-facing display name. Defaults to `name` when omitted. */
  label?: string
  config: PropertyConfig
  /** When true, the API rejects writes that don't include a value for this property. */
  required?: boolean
}

// ── EntityType record ─────────────────────────────────────────────────

/**
 * Materialised `entity_types` row — one declared user-defined type per
 * workspace (UNIQUE `(workspace_id, name)`). The chat tool that creates
 * a "Recipes" or "Movies" DB writes one of these.
 *
 * Built-in types (tasks / CRM / workflow_runs) are not represented by
 * `EntityType` rows — they're referenced via `EntityTypeRef.builtin`. A
 * future built-ins adapter (P1B) may project the built-in tables through
 * a runtime `EntityType` shape for read-paths, but the storage stays in
 * the original tables.
 */
export type EntityType = {
  /** UUID — `entity_types.id`. */
  id: string
  workspaceId: string
  /** UNIQUE per workspace. Example: "Movie", "Recipe", "Habit". */
  name: string
  /** Emoji or short string rendered by the sidebar / page header. */
  icon?: string
  properties: PropertyDef[]
  /** Bumped when the property list changes. Lets clients invalidate caches. */
  schemaVersion: number
  /** ISO-8601 timestamp from `entity_types.created_at`. */
  createdAt: string
  /** `users.id` — null on system-seeded types. */
  createdBy: string | null
}

// ── Cell value (per-instance JSONB shape) ─────────────────────────────

/**
 * The value carried in `EntityInstance.data[propertyName]`. Discriminator:
 * `kind` — matches the corresponding `PropertyKind`.
 *
 * `text` is intentionally typed as `unknown`: the doc v1 plan ships
 * rich text as the same `RichText[]` shape used by inline editors, but
 * that type lives in the renderer module and is out of scope here. The
 * server validates structure at the schema layer (zod) — the type stays
 * opaque to the brain layer.
 *
 * `files` references GCP Cloud Storage paths (per the resolutions block
 * in `docs/plans/snuggly-noodling-tiger.md`): the client renders via a
 * server-side signed-URL fetch.
 */
export type CellValue =
  | { kind: 'text'; value: unknown }
  | { kind: 'number'; value: number | null }
  | { kind: 'select'; value: string | null }
  | { kind: 'multi_select'; value: string[] }
  | { kind: 'status'; value: string | null }
  | {
      kind: 'date'
      value: { start: string; end?: string; time?: boolean } | null
    }
  | { kind: 'person'; value: string | null }
  | { kind: 'relation'; value: string | null }
  | {
      kind: 'files'
      value: {
        bucket: string
        path: string
        mimeType: string
        sizeBytes: number
        name: string
      }[]
    }
  | { kind: 'checkbox'; value: boolean }
  | { kind: 'url'; value: string | null }
  | { kind: 'email'; value: string | null }
  | { kind: 'phone'; value: string | null }
  | { kind: 'created_time'; value: string }
  | { kind: 'created_by'; value: string }
  | { kind: 'last_edited_time'; value: string }
  | { kind: 'last_edited_by'; value: string }

// ── EntityInstance record ─────────────────────────────────────────────

/**
 * Materialised `entity_instances` row — one row of a user-defined entity
 * type. The `data` JSONB is keyed by `PropertyDef.name`.
 *
 * Provenance: `sourceApp` records which surface created the row so the
 * brain layer can attribute ingest/import/chat-driven changes. Defaults
 * to `'doc'` (the editor surface), as encoded in the migration.
 */
export type EntityInstance = {
  /** UUID — `entity_instances.id`. */
  id: string
  entityTypeId: string
  workspaceId: string
  data: Record<string, CellValue>
  sourceApp: 'doc' | 'chat' | 'import' | 'api'
  /** ISO-8601 from `entity_instances.created_at`. */
  createdAt: string
  /** `users.id` — null on system-created rows (e.g. ingest workers). */
  createdBy: string | null
  lastEditedAt: string
  lastEditedBy: string | null
}

// ── Query primitives ──────────────────────────────────────────────────

/**
 * One condition on `queryEntities`. `field` is a `PropertyDef.name`.
 * `value` is opaque at the type layer — the store implementation
 * coerces it against the field's property kind. JSONB-path is the
 * runtime mechanism (see migration 200's `data jsonb_path_ops` GIN
 * index).
 *
 * `contains` is for `multi_select` / array-shaped values; the other
 * operators apply to scalar property kinds.
 */
export type EntityFilter = {
  field: string
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains'
  value: unknown
}

/**
 * One sort dimension on `queryEntities`. Multiple dimensions are
 * applied in array order — first becomes the primary sort.
 */
export type EntitySort = {
  field: string
  direction: 'asc' | 'desc'
}

// ── Store interface ───────────────────────────────────────────────────

/**
 * Persistence boundary for the doc v1 entity layer. Implemented by
 * `packages/api/src/db/entities-store.ts` (P1C in Batch 2). Two
 * sub-surfaces:
 *
 *   - Entity types CRUD — writes to `entity_types`.
 *   - Entity instances CRUD + query — writes to `entity_instances`.
 *
 * RLS is enforced by `entity_types_workspace_member` /
 * `entity_instances_workspace_member` (migration 200). Every method
 * takes the `workspaceId` explicitly so the store can set
 * `app.current_user_id` correctly before issuing the query.
 *
 * Renamed to `DocEntityStore` at the package barrel to avoid
 * shadowing the brain-anchor `EntityStore` already in scope (see file
 * header).
 */
export interface EntityStore {
  // ── Entity types CRUD ───────────────────────────────────────────────
  createEntityType(
    input: Omit<EntityType, 'id' | 'createdAt' | 'schemaVersion'> & {
      schemaVersion?: number
    },
  ): Promise<EntityType>
  getEntityType(workspaceId: string, id: string): Promise<EntityType | null>
  getEntityTypeByName(
    workspaceId: string,
    name: string,
  ): Promise<EntityType | null>
  listEntityTypes(workspaceId: string): Promise<EntityType[]>
  updateEntityType(
    workspaceId: string,
    id: string,
    patch: Partial<Pick<EntityType, 'name' | 'icon' | 'properties'>>,
  ): Promise<EntityType>
  /**
   * Rename a property in one transaction: rewrite the `PropertyDef.name`
   * in `entity_types.properties` (preserving its config + bumping
   * `schema_version`) *and* data-migrate every `entity_instances` row of
   * the type — renaming the JSONB key from `oldName` to `newName` while
   * carrying the cell value across untouched. Rows that don't have the
   * key are left alone.
   *
   * The two writes must be atomic: a partial rename (schema renamed but
   * rows still keyed on the old name, or vice-versa) would orphan every
   * cell value behind a key the schema no longer lists. Returns the
   * updated `EntityType`.
   */
  renameProperty(
    workspaceId: string,
    entityTypeId: string,
    oldName: string,
    newName: string,
  ): Promise<EntityType>
  deleteEntityType(workspaceId: string, id: string): Promise<void>

  // ── Entity instances CRUD ───────────────────────────────────────────
  createEntity(
    input: Omit<EntityInstance, 'id' | 'createdAt' | 'lastEditedAt'>,
  ): Promise<EntityInstance>
  getEntity(
    workspaceId: string,
    id: string,
  ): Promise<EntityInstance | null>
  updateEntity(
    workspaceId: string,
    id: string,
    patch: Partial<Pick<EntityInstance, 'data' | 'lastEditedBy'>>,
  ): Promise<EntityInstance>
  deleteEntity(workspaceId: string, id: string): Promise<void>

  // ── Query ───────────────────────────────────────────────────────────
  queryEntities(
    workspaceId: string,
    entityTypeId: string,
    filters?: EntityFilter[],
    sort?: EntitySort[],
    limit?: number,
    cursor?: string,
  ): Promise<{ rows: EntityInstance[]; nextCursor?: string }>
}
