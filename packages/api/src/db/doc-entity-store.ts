/**
 * Doc v1 — `DocEntityStore` implementation backed by PostgreSQL
 * (migration 200 — `entity_types` + `entity_instances`).
 *
 * Phase 1 Batch 2 / Agent P1C. Fulfils the `EntityStore` interface
 * declared in `packages/core/src/entities/doc-types.ts` (re-exported
 * as `DocEntityStore` from the package barrel — see file header in
 * doc-types.ts for the naming-collision rationale).
 *
 * RLS strategy
 * ============
 * Migration 200 created `entity_types_workspace_member` and
 * `entity_instances_workspace_member` policies but did NOT add
 * `FORCE ROW LEVEL SECURITY` or `*_system_bypass` (a known Phase 1
 * follow-up flagged by Batch 1 Agent B). For Phase 1 we honor RLS via
 * `queryWithRLS(userId, ...)` — the policy reads `app.current_user_id`
 * which the helper sets per call. There is currently no system-bypass
 * path; if any worker later needs to read across workspaces it should
 * be added explicitly (TODO marker in the relevant method).
 *
 * Schema validation
 * =================
 * The Zod schemas in `doc-schemas.ts` validate the wire shape on
 * write (creation + patch). Validating individual cell values against
 * the entity-type's `properties` (e.g. a `select` cell whose `value`
 * isn't one of the declared option ids) is intentionally deferred to
 * the chat-tool layer (P1H) — the store treats `data` as opaque JSONB
 * once the cell discriminator is type-checked. That keeps the store
 * fast on bulk writes; the tool surface is the right place to surface
 * a useful error.
 *
 * [COMP:api/doc-entity-store]
 */

import type {
  DocEntityFilter,
  DocEntityInstance,
  DocEntitySort,
  DocEntityStore,
  DocEntityType,
  CellValue,
  PropertyDef,
} from '@use-brian/core'
import {
  docEntityInstanceSchema,
  docEntityTypeSchema,
} from '@use-brian/core'
import { getPool, queryWithRLS, rollbackAndRelease } from './client.js'

// ── Row projections ────────────────────────────────────────────────────

const ENTITY_TYPE_SELECT = `
  id,
  workspace_id    AS "workspaceId",
  name,
  icon,
  properties,
  schema_version  AS "schemaVersion",
  created_at      AS "createdAt",
  created_by      AS "createdBy"
`

const ENTITY_INSTANCE_SELECT = `
  id,
  entity_type_id  AS "entityTypeId",
  workspace_id    AS "workspaceId",
  data,
  source_app      AS "sourceApp",
  created_at      AS "createdAt",
  created_by      AS "createdBy",
  last_edited_at  AS "lastEditedAt",
  last_edited_by  AS "lastEditedBy"
`

type EntityTypeRow = {
  id: string
  workspaceId: string
  name: string
  icon: string | null
  properties: PropertyDef[]
  schemaVersion: number
  createdAt: Date
  createdBy: string | null
}

type EntityInstanceRow = {
  id: string
  entityTypeId: string
  workspaceId: string
  data: Record<string, CellValue>
  sourceApp: 'doc' | 'chat' | 'import' | 'api'
  createdAt: Date
  createdBy: string | null
  lastEditedAt: Date
  lastEditedBy: string | null
}

function rowToType(row: EntityTypeRow): DocEntityType {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    icon: row.icon ?? undefined,
    properties: row.properties,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
  }
}

function rowToInstance(row: EntityInstanceRow): DocEntityInstance {
  return {
    id: row.id,
    entityTypeId: row.entityTypeId,
    workspaceId: row.workspaceId,
    data: row.data,
    sourceApp: row.sourceApp,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    lastEditedAt: row.lastEditedAt.toISOString(),
    lastEditedBy: row.lastEditedBy,
  }
}

// ── Filter / sort helpers ─────────────────────────────────────────────

/**
 * The filter operator vocabulary maps directly to JSONB expressions on
 * `entity_instances.data`. We never interpolate the field name into the
 * SQL string raw — it's parameterised. Numeric / date comparisons cast
 * the JSON text via `(data->>'<field>')::numeric` (or text-comparison
 * for ISO dates, which sort lex-correctly).
 */

const ALLOWED_FIELD_RE = /^[A-Za-z0-9_]{1,128}$/

function assertValidFieldName(field: string): void {
  if (!ALLOWED_FIELD_RE.test(field)) {
    throw new Error(
      `Invalid filter/sort field name: ${JSON.stringify(field)}. Property names must match /^[A-Za-z0-9_]{1,128}$/.`,
    )
  }
}

type WhereBuild = {
  clauses: string[]
  values: unknown[]
  nextIdx: number
}

function buildFilterClause(
  filter: DocEntityFilter,
  build: WhereBuild,
): void {
  assertValidFieldName(filter.field)
  const field = filter.field

  // Treat numeric values as numeric comparisons via the ::numeric cast;
  // strings + dates fall through to text comparison. `contains` is for
  // substring search on text properties (case-insensitive ILIKE).
  switch (filter.op) {
    case 'eq': {
      if (typeof filter.value === 'number') {
        build.values.push(filter.value)
        build.clauses.push(
          `(data->>'${field}')::numeric = $${build.nextIdx++}`,
        )
      } else if (typeof filter.value === 'boolean') {
        build.values.push(String(filter.value))
        build.clauses.push(`data->>'${field}' = $${build.nextIdx++}`)
      } else if (filter.value === null) {
        build.clauses.push(`data->>'${field}' IS NULL`)
      } else {
        build.values.push(String(filter.value))
        build.clauses.push(`data->>'${field}' = $${build.nextIdx++}`)
      }
      return
    }
    case 'neq': {
      if (typeof filter.value === 'number') {
        build.values.push(filter.value)
        build.clauses.push(
          `(data->>'${field}')::numeric <> $${build.nextIdx++}`,
        )
      } else if (filter.value === null) {
        build.clauses.push(`data->>'${field}' IS NOT NULL`)
      } else {
        build.values.push(String(filter.value))
        build.clauses.push(`data->>'${field}' <> $${build.nextIdx++}`)
      }
      return
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const op =
        filter.op === 'gt'
          ? '>'
          : filter.op === 'gte'
          ? '>='
          : filter.op === 'lt'
          ? '<'
          : '<='
      if (typeof filter.value === 'number') {
        build.values.push(filter.value)
        build.clauses.push(
          `(data->>'${field}')::numeric ${op} $${build.nextIdx++}`,
        )
      } else {
        // Text comparison — works for ISO-8601 dates (lex-sortable).
        build.values.push(String(filter.value))
        build.clauses.push(`data->>'${field}' ${op} $${build.nextIdx++}`)
      }
      return
    }
    case 'in': {
      const arr = Array.isArray(filter.value)
        ? filter.value.map((v) => String(v))
        : []
      build.values.push(arr)
      build.clauses.push(
        `data->>'${field}' = ANY($${build.nextIdx++}::text[])`,
      )
      return
    }
    case 'contains': {
      // `contains` on a `multi_select` cell — the cell's `value` is an
      // array of option ids. JSONB containment via `@>` on the array.
      // For a `text` field this becomes a substring ILIKE.
      // We can't tell from the filter alone which kind the field is, so
      // we default to substring ILIKE (the more common case in v1).
      build.values.push(`%${String(filter.value)}%`)
      build.clauses.push(`data->>'${field}' ILIKE $${build.nextIdx++}`)
      return
    }
  }
}

function buildOrderBy(sort: DocEntitySort[] | undefined): string {
  if (!sort || sort.length === 0) return 'ORDER BY created_at DESC, id DESC'
  const parts: string[] = []
  for (const s of sort) {
    assertValidFieldName(s.field)
    const dir = s.direction === 'asc' ? 'ASC' : 'DESC'
    parts.push(`data->>'${s.field}' ${dir}`)
  }
  // Always include a stable tie-breaker for cursor pagination.
  parts.push('created_at DESC', 'id DESC')
  return `ORDER BY ${parts.join(', ')}`
}

// ── Cursor encoding ───────────────────────────────────────────────────
//
// Phase-1 cursor is opaque to callers: a base64-encoded `<createdAt>|<id>`
// pair. Stable tie-breaker (id) so identical timestamps don't loop.

function encodeCursor(createdAt: Date, id: string): string {
  const raw = `${createdAt.toISOString()}|${id}`
  return Buffer.from(raw, 'utf8').toString('base64url')
}

function decodeCursor(
  cursor: string,
): { createdAt: string; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const idx = raw.lastIndexOf('|')
    if (idx <= 0) return null
    return { createdAt: raw.slice(0, idx), id: raw.slice(idx + 1) }
  } catch {
    return null
  }
}

// ── Factory ───────────────────────────────────────────────────────────

/**
 * Build a `DocEntityStore` backed by PostgreSQL. Stateless — safe to
 * call once at boot and share across requests.
 */
export function createDbDocEntityStore(): DocEntityStore {
  return {
    // ── EntityType CRUD ───────────────────────────────────────────────

    async createEntityType(input) {
      const schemaVersion = input.schemaVersion ?? 1

      // Validate the wire shape before write. The zod schema asserts the
      // discriminated union over `properties[].config.kind` so a
      // malformed property definition is rejected here rather than at
      // read time.
      const validated = docEntityTypeSchema.parse({
        // The DB column produces the id/createdAt; we synthesise
        // placeholders just for the round-trip validation.
        id: '00000000-0000-0000-0000-000000000000',
        workspaceId: input.workspaceId,
        name: input.name,
        icon: input.icon,
        properties: input.properties,
        schemaVersion,
        createdAt: new Date().toISOString(),
        createdBy: input.createdBy,
      })

      const result = await queryWithRLS<EntityTypeRow>(
        input.createdBy ?? input.workspaceId,
        `INSERT INTO entity_types
           (workspace_id, name, icon, properties, schema_version, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         RETURNING ${ENTITY_TYPE_SELECT}`,
        [
          validated.workspaceId,
          validated.name,
          validated.icon ?? null,
          JSON.stringify(validated.properties),
          validated.schemaVersion,
          validated.createdBy,
        ],
      )
      return rowToType(result.rows[0])
    },

    async getEntityType(workspaceId, id) {
      const result = await queryWithRLS<EntityTypeRow>(
        workspaceId,
        `SELECT ${ENTITY_TYPE_SELECT} FROM entity_types
         WHERE id = $1 AND workspace_id = $2`,
        [id, workspaceId],
      )
      return result.rows[0] ? rowToType(result.rows[0]) : null
    },

    async getEntityTypeByName(workspaceId, name) {
      const result = await queryWithRLS<EntityTypeRow>(
        workspaceId,
        `SELECT ${ENTITY_TYPE_SELECT} FROM entity_types
         WHERE workspace_id = $1 AND name = $2`,
        [workspaceId, name],
      )
      return result.rows[0] ? rowToType(result.rows[0]) : null
    },

    async listEntityTypes(workspaceId) {
      const result = await queryWithRLS<EntityTypeRow>(
        workspaceId,
        `SELECT ${ENTITY_TYPE_SELECT} FROM entity_types
         WHERE workspace_id = $1
         ORDER BY created_at DESC, id DESC`,
        [workspaceId],
      )
      return result.rows.map(rowToType)
    },

    async updateEntityType(workspaceId, id, patch) {
      const sets: string[] = []
      const values: unknown[] = []
      let idx = 1

      if (patch.name !== undefined) {
        sets.push(`name = $${idx++}`)
        values.push(patch.name)
      }
      if (patch.icon !== undefined) {
        sets.push(`icon = $${idx++}`)
        values.push(patch.icon)
      }
      if (patch.properties !== undefined) {
        // Re-validate the property list — partial updates that swap the
        // schema must still produce a well-formed `PropertyDef[]`.
        docEntityTypeSchema.parse({
          id,
          workspaceId,
          name: patch.name ?? 'placeholder',
          icon: patch.icon,
          properties: patch.properties,
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
          createdBy: null,
        })
        sets.push(`properties = $${idx++}::jsonb`)
        values.push(JSON.stringify(patch.properties))
        // Bump schema_version whenever the property list changes so
        // clients can invalidate caches that key on (entityTypeId,
        // schemaVersion).
        sets.push(`schema_version = schema_version + 1`)
      }

      if (sets.length === 0) {
        // No-op — read back the current row so the API contract is
        // consistent (always returns the EntityType, never null on a
        // round-trip update).
        const cur = await queryWithRLS<EntityTypeRow>(
          workspaceId,
          `SELECT ${ENTITY_TYPE_SELECT} FROM entity_types
           WHERE id = $1 AND workspace_id = $2`,
          [id, workspaceId],
        )
        if (!cur.rows[0]) {
          throw new Error(
            `updateEntityType: entity_type ${id} not found in workspace ${workspaceId}`,
          )
        }
        return rowToType(cur.rows[0])
      }

      values.push(id, workspaceId)
      const result = await queryWithRLS<EntityTypeRow>(
        workspaceId,
        `UPDATE entity_types SET ${sets.join(', ')}
         WHERE id = $${idx++} AND workspace_id = $${idx}
         RETURNING ${ENTITY_TYPE_SELECT}`,
        values,
      )
      if (!result.rows[0]) {
        throw new Error(
          `updateEntityType: entity_type ${id} not found in workspace ${workspaceId}`,
        )
      }
      return rowToType(result.rows[0])
    },

    async renameProperty(workspaceId, entityTypeId, oldName, newName) {
      // Atomic schema-rename + data-migration. Two writes that must
      // commit together — a partial rename strands every cell value
      // behind a key the schema no longer lists (or vice-versa). Run both
      // in one transaction.
      //
      // SYSTEM operation: a workspace-schema change, scoped by explicit
      // `WHERE workspace_id = $` clauses (not by per-user RLS), authorized at
      // the chat-tool layer (`renameProperty` tool). It runs on the system
      // pool (owner, bypasses RLS) — there is no acting USER here, so scoping
      // it by `app.current_user_id` would be meaningless (a workspace id is not
      // a user id; the per-user policy would hide the rows).
      //
      // The validation (oldName exists, newName free) lives in the chat-tool
      // layer; the store performs the rewrite and re-validates the resulting
      // `PropertyDef[]` shape.
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')

        // 1. Read the current type (workspace-scoped) so we can rewrite
        //    the matching PropertyDef and re-validate the new list.
        const cur = await client.query<EntityTypeRow>(
          `SELECT ${ENTITY_TYPE_SELECT} FROM entity_types
           WHERE id = $1 AND workspace_id = $2`,
          [entityTypeId, workspaceId],
        )
        if (!cur.rows[0]) {
          throw new Error(
            `renameProperty: entity_type ${entityTypeId} not found in workspace ${workspaceId}`,
          )
        }
        const currentProps = cur.rows[0].properties
        if (!currentProps.some((p) => p.name === oldName)) {
          throw new Error(
            `renameProperty: property "${oldName}" not found on entity_type ${entityTypeId}`,
          )
        }
        if (currentProps.some((p) => p.name === newName)) {
          throw new Error(
            `renameProperty: property "${newName}" already exists on entity_type ${entityTypeId}`,
          )
        }
        // Preserve config/label/required — only the `name` key changes.
        const nextProps: PropertyDef[] = currentProps.map((p) =>
          p.name === oldName ? { ...p, name: newName } : p,
        )
        // Re-validate the rewritten list against the discriminated-union
        // schema, same as `updateEntityType` does on a property swap.
        docEntityTypeSchema.parse({
          id: entityTypeId,
          workspaceId,
          name: cur.rows[0].name,
          icon: cur.rows[0].icon ?? undefined,
          properties: nextProps,
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
          createdBy: null,
        })

        // 2. Write the schema back + bump schema_version (a property
        //    rename is a schema change — clients keying caches on
        //    (entityTypeId, schemaVersion) must invalidate).
        const updated = await client.query<EntityTypeRow>(
          `UPDATE entity_types
             SET properties = $1::jsonb,
                 schema_version = schema_version + 1
           WHERE id = $2 AND workspace_id = $3
           RETURNING ${ENTITY_TYPE_SELECT}`,
          [JSON.stringify(nextProps), entityTypeId, workspaceId],
        )

        // 3. Data-migrate every row of this type: rename the JSONB key,
        //    carrying the value across. `WHERE data ? $old` skips rows
        //    that never had the key. Parameterised — the key names are
        //    bind values, never interpolated into the SQL string.
        await client.query(
          `UPDATE entity_instances
             SET data = (data - $1) || jsonb_build_object($2, data -> $1),
                 last_edited_at = now()
           WHERE entity_type_id = $3 AND workspace_id = $4 AND data ? $1`,
          [oldName, newName, entityTypeId, workspaceId],
        )

        await client.query('COMMIT')
        return rowToType(updated.rows[0])
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        await rollbackAndRelease(client)
      }
    },

    async deleteEntityType(workspaceId, id) {
      // Instances cascade-delete via the FK on `entity_instances.entity_type_id`.
      await queryWithRLS(
        workspaceId,
        `DELETE FROM entity_types
         WHERE id = $1 AND workspace_id = $2`,
        [id, workspaceId],
      )
    },

    // ── EntityInstance CRUD ───────────────────────────────────────────

    async createEntity(input) {
      // Validate the wire shape of every cell against the doc-schema
      // discriminated union. We do NOT cross-check `data` keys against
      // the entity-type's `properties` here — that's a tool-layer
      // concern (P1H surfaces a useful error to the chat model). See the
      // file header for the rationale.
      docEntityInstanceSchema.parse({
        id: '00000000-0000-0000-0000-000000000000',
        entityTypeId: input.entityTypeId,
        workspaceId: input.workspaceId,
        data: input.data,
        sourceApp: input.sourceApp,
        createdAt: new Date().toISOString(),
        createdBy: input.createdBy,
        lastEditedAt: new Date().toISOString(),
        lastEditedBy: input.lastEditedBy,
      })

      const result = await queryWithRLS<EntityInstanceRow>(
        input.createdBy ?? input.workspaceId,
        `INSERT INTO entity_instances
           (entity_type_id, workspace_id, data, source_app, created_by, last_edited_by)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6)
         RETURNING ${ENTITY_INSTANCE_SELECT}`,
        [
          input.entityTypeId,
          input.workspaceId,
          JSON.stringify(input.data),
          input.sourceApp,
          input.createdBy,
          input.lastEditedBy,
        ],
      )
      return rowToInstance(result.rows[0])
    },

    async getEntity(workspaceId, id) {
      const result = await queryWithRLS<EntityInstanceRow>(
        workspaceId,
        `SELECT ${ENTITY_INSTANCE_SELECT} FROM entity_instances
         WHERE id = $1 AND workspace_id = $2`,
        [id, workspaceId],
      )
      return result.rows[0] ? rowToInstance(result.rows[0]) : null
    },

    async updateEntity(workspaceId, id, patch) {
      const sets: string[] = []
      const values: unknown[] = []
      let idx = 1

      if (patch.data !== undefined) {
        sets.push(`data = $${idx++}::jsonb`)
        values.push(JSON.stringify(patch.data))
      }
      if (patch.lastEditedBy !== undefined) {
        sets.push(`last_edited_by = $${idx++}`)
        values.push(patch.lastEditedBy)
      }

      // Always bump `last_edited_at` — column has a server-side default
      // of `now()` on insert, but UPDATE needs an explicit set.
      sets.push(`last_edited_at = now()`)

      values.push(id, workspaceId)
      const result = await queryWithRLS<EntityInstanceRow>(
        workspaceId,
        `UPDATE entity_instances SET ${sets.join(', ')}
         WHERE id = $${idx++} AND workspace_id = $${idx}
         RETURNING ${ENTITY_INSTANCE_SELECT}`,
        values,
      )
      if (!result.rows[0]) {
        throw new Error(
          `updateEntity: entity_instance ${id} not found in workspace ${workspaceId}`,
        )
      }
      return rowToInstance(result.rows[0])
    },

    async deleteEntity(workspaceId, id) {
      await queryWithRLS(
        workspaceId,
        `DELETE FROM entity_instances
         WHERE id = $1 AND workspace_id = $2`,
        [id, workspaceId],
      )
    },

    // ── Query ─────────────────────────────────────────────────────────

    async queryEntities(workspaceId, entityTypeId, filters, sort, limit, cursor) {
      const cap = Math.min(Math.max(limit ?? 100, 1), 500)
      const build: WhereBuild = {
        clauses: [],
        values: [],
        nextIdx: 1,
      }
      build.values.push(workspaceId)
      build.clauses.push(`workspace_id = $${build.nextIdx++}`)
      build.values.push(entityTypeId)
      build.clauses.push(`entity_type_id = $${build.nextIdx++}`)

      if (filters && filters.length > 0) {
        for (const f of filters) buildFilterClause(f, build)
      }

      // Cursor: tie-breaker pagination. The cursor encodes the last
      // row's (created_at, id) — we ask for everything strictly less
      // than that pair (under DESC order).
      if (cursor) {
        const decoded = decodeCursor(cursor)
        if (decoded) {
          build.values.push(decoded.createdAt)
          const createdAtIdx = build.nextIdx++
          build.values.push(decoded.id)
          const idIdx = build.nextIdx++
          build.clauses.push(
            `(created_at, id) < ($${createdAtIdx}::timestamptz, $${idIdx})`,
          )
        }
      }

      build.values.push(cap + 1) // fetch one extra to detect more pages
      const limitIdx = build.nextIdx++

      const result = await queryWithRLS<EntityInstanceRow>(
        workspaceId,
        `SELECT ${ENTITY_INSTANCE_SELECT} FROM entity_instances
         WHERE ${build.clauses.join(' AND ')}
         ${buildOrderBy(sort)}
         LIMIT $${limitIdx}`,
        build.values,
      )

      const rows = result.rows.map(rowToInstance)
      let nextCursor: string | undefined
      if (rows.length > cap) {
        rows.pop()
        const last = result.rows[result.rows.length - 2]
        nextCursor = encodeCursor(last.createdAt, last.id)
      }
      return { rows, nextCursor }
    },
  }
}
