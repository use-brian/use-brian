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
 * Schema validation and revisions
 * ===============================
 * Strict wire validation is supplemented by canonical SQL schema/value/reference
 * triggers (application_record_contract). Every writer advances revisions and
 * normalized opt-in uniqueness in its transaction. App roles enforce current RLS;
 * a workspace ID is never substituted for an authenticated actor.
 *
 * [COMP:api/doc-entity-store]
 */

import type { PoolClient, QueryResult, QueryResultRow } from 'pg'
import { canonicalGenericResource, queryCanonicalGenericRecords } from '../application-platform/generic-reader.js'
import { readCanonicalGenericRecord } from '../application-platform/field-evidence.js'
import type {
  DocEntityInstance,
  DocEntityStore,
  DocEntityType,
  CellValue,
  PropertyDef,
  DocEntityOperationOptions,
} from '@use-brian/core'
import {
  docEntityInstanceSchema,
  docEntityTypeSchema,
  cellValueSchema,
  validateDocApplicationSchema,
  applicationAuthorityCreationScope,
  bindScopeSources,
  boundScopeSources,
} from '@use-brian/core'
import { getAppPool, applyRLSGucs, queryWithRLS, rollbackAndRelease } from './client.js'
import { currentAgentAccess } from './agent-access-context.js'
import { ApplicationPlatformError, applicationQuerySchema } from '@use-brian/shared'
import { applicationResourceRefSchema, type ApplicationResourceRef } from '@use-brian/shared'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { ApplicationOperationContext } from '@use-brian/core'
import { getApplicationExecutionBinding } from '../application-platform/execution-context.js'

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
  sensitivity,
  compartments,
  project_ids     AS "projectIds",
  created_at      AS "createdAt",
  created_by      AS "createdBy",
  last_edited_at  AS "lastEditedAt",
  last_edited_by  AS "lastEditedBy",
  record_version::text AS "recordVersion"
`
// Metadata retains the legacy wire shape; protected values come only from the
// canonical field reader, never from this SQL selection.
const ENTITY_INSTANCE_METADATA_SELECT = ENTITY_INSTANCE_SELECT.replace('  data,\n', '')

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
  sensitivity: 'public' | 'internal' | 'confidential'
  compartments: string[]
  projectIds: string[]
  createdAt: Date
  createdBy: string | null
  lastEditedAt: Date
  lastEditedBy: string | null
  recordVersion?: string
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
    sensitivity: row.sensitivity ?? 'internal',
    compartments: row.compartments ?? [],
    projectIds: row.projectIds ?? [],
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    lastEditedAt: row.lastEditedAt.toISOString(),
    lastEditedBy: row.lastEditedBy,
    ...(row.recordVersion ? { recordVersion: row.recordVersion } : {}),
  }
}

// ── Factory ───────────────────────────────────────────────────────────

/**
 * Build a `DocEntityStore` backed by PostgreSQL. Stateless — safe to
 * call once at boot and share across requests.
 */
export function createDbDocEntityStore(boundActor?: { actorUserId: string; transaction?: PoolClient }): DocEntityStore {
  let transactionRole: Promise<void> | undefined
  async function canonicalQuery<T extends QueryResultRow>(userId: string, text: string, values?: unknown[]): Promise<QueryResult<T>> {
    if (!boundActor?.transaction) return queryWithRLS<T>(userId,text,values)
    const client = boundActor.transaction
    transactionRole ??= client.query(`SELECT r.rolsuper OR r.rolbypassrls OR c.relowner=r.oid AS bypass
      FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_class c ON c.oid='entity_instances'::regclass WHERE r.rolname=current_user`).then(result => {
      if (result.rows[0]?.bypass !== false) throw new ApplicationPlatformError('access_unavailable', 'A non-owner application transaction is required.')
    })
    await transactionRole
    await applyRLSGucs(client,userId)
    return client.query<T>(text,values)
  }
  function actor(workspaceId: string, options?: DocEntityOperationOptions, creator?: string | null): string {
    const ambient = currentAgentAccess()
    const actorUserId = options?.actorUserId ?? boundActor?.actorUserId ?? ambient?.userId ?? creator
    if (!actorUserId) throw new ApplicationPlatformError('authentication_required', 'A current authenticated actor is required.')
    if (ambient?.workspaceId && ambient.workspaceId !== workspaceId || ambient?.userId && ambient.userId !== actorUserId) {
      throw new ApplicationPlatformError('access_unavailable', 'The resource is unavailable.')
    }
    return actorUserId
  }
  async function canonicalTransaction<T>(userId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = boundActor?.transaction ?? await getAppPool().connect(), own = !boundActor?.transaction
    try {
      if (own) await client.query('BEGIN')
      const role = await client.query(`SELECT r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE') AS bypass
        FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_class c ON c.oid='public.entity_instances'::regclass WHERE r.rolname=current_user`)
      if (role.rows[0]?.bypass !== false) throw new ApplicationPlatformError('access_unavailable', 'A non-owner application transaction is required.')
      await applyRLSGucs(client, userId)
      const value = await operation(client)
      if (own) await client.query('COMMIT')
      return value
    } catch (error) {
      if ((error as { code?: string }).code === '42501') {
        const refusal = new ApplicationPlatformError('access_unavailable', 'The record is unavailable.')
        Object.defineProperty(refusal, 'cause', { value: error })
        throw refusal
      }
      throw error
    } finally { if (own) await rollbackAndRelease(client) }
  }
  async function projectCanonicalRow(client: PoolClient, row: Omit<EntityInstanceRow, 'data'>): Promise<DocEntityInstance> {
    const schemas = await client.query<EntityTypeRow>(`SELECT ${ENTITY_TYPE_SELECT} FROM public.entity_types WHERE workspace_id=$1 AND id=$2`,
      [row.workspaceId, row.entityTypeId])
    if (!schemas.rows[0]) throw new ApplicationPlatformError('access_unavailable', 'The schema is unavailable.')
    const projection = await readCanonicalGenericRecord({ transaction: client, workspaceId: row.workspaceId }, canonicalGenericResource(rowToType(schemas.rows[0])), row.id)
    if (projection.ref.version !== row.recordVersion) throw new ApplicationPlatformError('access_unavailable', 'The record changed.')
    return bindScopeSources(rowToInstance({ ...row, data: projection.values as Record<string, CellValue> }), boundScopeSources(projection))
  }
  return {
    // ── EntityType CRUD ───────────────────────────────────────────────

    async createEntityType(input, options) {
      validateDocApplicationSchema(input.properties)
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

      const result = await canonicalQuery<EntityTypeRow>(
        actor(input.workspaceId, options, input.createdBy),
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

    async getEntityType(workspaceId, id, options) {
      const result = await canonicalQuery<EntityTypeRow>(
        actor(workspaceId, options),
        `SELECT ${ENTITY_TYPE_SELECT} FROM entity_types
         WHERE id = $1 AND workspace_id = $2`,
        [id, workspaceId],
      )
      return result.rows[0] ? rowToType(result.rows[0]) : null
    },

    async getEntityTypeByName(workspaceId, name, options) {
      const result = await canonicalQuery<EntityTypeRow>(
        actor(workspaceId, options),
        `SELECT ${ENTITY_TYPE_SELECT} FROM entity_types
         WHERE workspace_id = $1 AND name = $2`,
        [workspaceId, name],
      )
      return result.rows[0] ? rowToType(result.rows[0]) : null
    },

    async listEntityTypes(workspaceId, options) {
      const result = await canonicalQuery<EntityTypeRow>(
        actor(workspaceId, options),
        `SELECT ${ENTITY_TYPE_SELECT} FROM entity_types
         WHERE workspace_id = $1
         ORDER BY created_at DESC, id DESC`,
        [workspaceId],
      )
      return result.rows.map(rowToType)
    },

    async updateEntityType(workspaceId, id, patch, options) {
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
        validateDocApplicationSchema(patch.properties)
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
        const cur = await canonicalQuery<EntityTypeRow>(
          actor(workspaceId, options),
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
      const idIndex = idx++
      const workspaceIndex = idx++
      const expected = options?.expectedSchemaVersion
      if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 1)) {
        throw new ApplicationPlatformError('schema_version_conflict', 'A valid expected schema version is required.')
      }
      const versionClause = expected === undefined ? '' : ` AND schema_version = $${idx}`
      if (expected !== undefined) values.push(expected)
      const result = await canonicalQuery<EntityTypeRow>(
        actor(workspaceId, options),
        `UPDATE entity_types SET ${sets.join(', ')}
         WHERE id = $${idIndex} AND workspace_id = $${workspaceIndex}${versionClause}
         RETURNING ${ENTITY_TYPE_SELECT}`,
        values,
      )
      if (!result.rows[0]) {
        throw new ApplicationPlatformError(expected === undefined ? 'access_unavailable' : 'schema_version_conflict',
          'The schema is unavailable or its version changed.')
      }
      return rowToType(result.rows[0])
    },

    async renameProperty(workspaceId, entityTypeId, oldName, newName, options) {
      // Atomic schema-rename + data-migration. Two writes that must
      // commit together — a partial rename strands every cell value
      // behind a key the schema no longer lists (or vice-versa). Run both
      // in one transaction.
      //
      const ownTransaction = !boundActor?.transaction
      const client = boundActor?.transaction ?? await getAppPool().connect()
      try {
        if (ownTransaction) await client.query('BEGIN')
        await applyRLSGucs(client, actor(workspaceId, options))
        await client.query('SET CONSTRAINTS application_record_value_valid, application_schema_value_valid DEFERRED')

        // 1. Read the current type (workspace-scoped) so we can rewrite
        //    the matching PropertyDef and re-validate the new list.
        const cur = await client.query<EntityTypeRow>(
          `SELECT ${ENTITY_TYPE_SELECT} FROM entity_types
           WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
          [entityTypeId, workspaceId],
        )
        if (!cur.rows[0]) {
          throw new ApplicationPlatformError('access_unavailable', 'The schema is unavailable.')
        }
        const currentProps = cur.rows[0].properties
        if (!currentProps.some((p) => p.name === oldName)) {
          throw new ApplicationPlatformError('invalid_schema', 'The property rename is unavailable.')
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

        if (options?.expectedSchemaVersion !== undefined && cur.rows[0].schemaVersion !== options.expectedSchemaVersion) {
          throw new ApplicationPlatformError('schema_version_conflict', 'The schema changed. Refresh the preview.')
        }
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
             SET data = (data - $1) || jsonb_build_object($2::text, data -> $1::text),
                 last_edited_at = now()
           WHERE entity_type_id = $3 AND workspace_id = $4 AND data ? $1`,
          [oldName, newName, entityTypeId, workspaceId],
        )

        if (ownTransaction) await client.query('COMMIT')
        return rowToType(updated.rows[0])
      } catch (err) {
        if (ownTransaction) await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        if (ownTransaction) await rollbackAndRelease(client)
      }
    },

    async deleteEntityType(workspaceId, id, options) {
      // Instances cascade-delete via the FK on `entity_instances.entity_type_id`.
      await canonicalQuery(
        actor(workspaceId, options),
        `DELETE FROM entity_types
         WHERE id = $1 AND workspace_id = $2`,
        [id, workspaceId],
      )
    },

    // ── EntityInstance CRUD ───────────────────────────────────────────

    async createEntity(input, options) {
      // Wire shape is checked here; canonical SQL also checks the locked declared schema.
      docEntityInstanceSchema.parse({
        id: input.id ?? '00000000-0000-0000-0000-000000000000',
        entityTypeId: input.entityTypeId,
        workspaceId: input.workspaceId,
        data: input.data,
        sourceApp: input.sourceApp,
        sensitivity: input.sensitivity ?? 'internal',
        compartments: input.compartments ?? [],
        projectIds: input.projectIds ?? [],
        createdAt: new Date().toISOString(),
        createdBy: input.createdBy,
        lastEditedAt: new Date().toISOString(),
        lastEditedBy: input.lastEditedBy,
      })

      return canonicalTransaction(actor(input.workspaceId, options, input.createdBy), async client => {
        const result = await client.query<Omit<EntityInstanceRow, 'data'>>(
          `INSERT INTO entity_instances
             (id, entity_type_id, workspace_id, data, source_app, created_by, last_edited_by,
              sensitivity, compartments, project_ids)
           VALUES ($10, $1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)
           RETURNING ${ENTITY_INSTANCE_METADATA_SELECT}`,
          [
            input.entityTypeId,
            input.workspaceId,
            JSON.stringify(input.data),
            input.sourceApp,
            input.createdBy,
            input.lastEditedBy,
            input.sensitivity ?? 'internal',
            input.compartments ?? [],
            input.projectIds ?? [],
            input.id ?? randomUUID(),
          ],
        )
        return projectCanonicalRow(client, result.rows[0])
      })
    },

    async getEntity(workspaceId, id, options) {
      return canonicalTransaction(actor(workspaceId, options), async client => {
        const result = await client.query<Omit<EntityInstanceRow, 'data'>>(
          `SELECT ${ENTITY_INSTANCE_METADATA_SELECT} FROM public.entity_instances
           WHERE id=$1 AND workspace_id=$2 AND NOT scope_review_state_held('entity_instance',id)`, [id, workspaceId])
        const row = result.rows[0]
        if (!row) return null
        return projectCanonicalRow(client, row)
      })
    },

    async updateEntity(workspaceId, id, patch, options) {
      const sets: string[] = []
      const values: unknown[] = []
      let idx = 1

      if (patch.data !== undefined) {
        sets.push(`data = data || $${idx++}::jsonb`)
        values.push(JSON.stringify(patch.data))
      }
      if (patch.lastEditedBy !== undefined) {
        sets.push(`last_edited_by = $${idx++}`)
        values.push(patch.lastEditedBy)
      }
      if (patch.sensitivity !== undefined) {
        sets.push(`sensitivity = CASE
          WHEN sensitivity_rank(sensitivity) >= sensitivity_rank($${idx}) THEN sensitivity
          ELSE $${idx} END`)
        values.push(patch.sensitivity)
        idx += 1
      }
      if (patch.compartments !== undefined) {
        sets.push(`compartments = ARRAY(
          SELECT DISTINCT value FROM unnest(compartments || $${idx++}::text[]) AS u(value)
          ORDER BY value)`)
        values.push(patch.compartments)
      }
      if (patch.projectIds !== undefined) {
        sets.push(`project_ids = ARRAY(
          SELECT DISTINCT value FROM unnest(project_ids || $${idx++}::uuid[]) AS u(value)
          ORDER BY value)`)
        values.push(patch.projectIds)
      }

      // Always bump `last_edited_at` — column has a server-side default
      // of `now()` on insert, but UPDATE needs an explicit set.
      sets.push(`last_edited_at = now()`)

      if (patch.data !== undefined) {
        for (const cell of Object.values(patch.data)) cellValueSchema.parse(cell)
      }
      const expected = options?.expectedRecordVersion
      if (expected !== undefined && !/^[1-9]\d*$/.test(expected)) {
        throw new ApplicationPlatformError('record_version_conflict', 'A valid expected record version is required.')
      }
      values.push(id, workspaceId)
      const idIndex = idx++
      const workspaceIndex = idx++
      const versionClause = expected === undefined ? '' : ` AND record_version = $${idx}::bigint`
      if (expected !== undefined) values.push(expected)
      return canonicalTransaction(actor(workspaceId, options), async client => {
        const result = await client.query<Omit<EntityInstanceRow, 'data'>>(
          `UPDATE entity_instances SET ${sets.join(', ')}
           WHERE id = $${idIndex} AND workspace_id = $${workspaceIndex}${versionClause}
           RETURNING ${ENTITY_INSTANCE_METADATA_SELECT}`,
          values,
        )
        if (!result.rows[0]) {
          throw new ApplicationPlatformError(expected === undefined ? 'access_unavailable' : 'record_version_conflict',
            'The record is unavailable or its version changed.')
        }
        return projectCanonicalRow(client, result.rows[0])
      })
    },

    async deleteEntity(workspaceId, id, options) {
      const expected = options?.expectedRecordVersion
      if (expected !== undefined && !/^[1-9]\d*$/.test(expected)) {
        throw new ApplicationPlatformError('record_version_conflict', 'A valid expected record version is required.')
      }
      await canonicalTransaction(actor(workspaceId, options), async client => {
        const result = await client.query(
          `DELETE FROM entity_instances
           WHERE id = $1 AND workspace_id = $2${expected === undefined ? '' : ' AND record_version=$3::bigint'}`,
          expected === undefined ? [id, workspaceId] : [id, workspaceId, expected],
        )
        if (expected !== undefined && result.rowCount !== 1) throw new ApplicationPlatformError('record_version_conflict', 'The record is unavailable or its version changed.')
      })
    },

    // ── Query ─────────────────────────────────────────────────────────

    async queryEntities(workspaceId, entityTypeId, filters, sort, limit, cursor, options) {
      return canonicalTransaction(actor(workspaceId, options), async client => {
        const schemas = await client.query<EntityTypeRow>(`SELECT ${ENTITY_TYPE_SELECT} FROM public.entity_types WHERE workspace_id=$1 AND id=$2`, [workspaceId, entityTypeId])
        if (!schemas.rows[0]) throw new ApplicationPlatformError('access_unavailable', 'The schema is unavailable.')
        const definition = canonicalGenericResource(rowToType(schemas.rows[0]))
        const query = applicationQuerySchema.safeParse({ filters, sort, limit, cursor })
        if (!query.success) throw new ApplicationPlatformError('invalid_value', 'The declared query is invalid.')
        const { result } = await queryCanonicalGenericRecords({ transaction: client, workspaceId }, definition, query.data)
        const metadata = await client.query<Omit<EntityInstanceRow, 'data'>>(`SELECT ${ENTITY_INSTANCE_METADATA_SELECT} FROM public.entity_instances
          WHERE workspace_id=$1 AND entity_type_id=$2 AND id=ANY($3::uuid[])`, [workspaceId, entityTypeId, result.records.map(record => record.ref.id)])
        const byId = new Map(metadata.rows.map(row => [row.id, row]))
        const rows = result.records.map(record => {
          const row = byId.get(record.ref.id)
          if (!row || row.recordVersion !== record.ref.version) throw new ApplicationPlatformError('access_unavailable', 'The record changed.')
          return bindScopeSources(rowToInstance({ ...row, data: record.values as Record<string, CellValue> }), boundScopeSources(record))
        })
        const sources = boundScopeSources(result)
        bindScopeSources(rows, sources)
        return bindScopeSources({ rows, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) }, sources)
      })
    },
  }
}

export const canonicalApplicationRecordMutationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create'), type: z.string(), id: z.string().uuid().optional(), data: z.record(cellValueSchema) }).strict(),
  z.object({ operation: z.literal('patch'), type: z.string(), id: z.string().uuid(), expectedVersion: z.string().regex(/^[1-9]\d*$/), data: z.record(cellValueSchema) }).strict(),
  z.object({ operation: z.literal('delete'), type: z.string(), id: z.string().uuid(), expectedVersion: z.string().regex(/^[1-9]\d*$/) }).strict(),
])
export type CanonicalApplicationRecordMutation = z.infer<typeof canonicalApplicationRecordMutationSchema>

/** Same store/SQL constraints for human and exact app releases; never an owner pool. */
export async function applyCanonicalApplicationRecordMutation(context: ApplicationOperationContext<PoolClient>, typeId: string,
  raw: CanonicalApplicationRecordMutation): Promise<ApplicationResourceRef> {
  const input = canonicalApplicationRecordMutationSchema.parse(raw), access = context.execution.security.access
  const id = input.id ?? randomUUID(), data = 'data' in input ? input.data : {}
  if (Object.keys(data).length > 128) throw new ApplicationPlatformError('invalid_value', 'The change is too large.')
  const application = getApplicationExecutionBinding(context.execution)
  if (application) {
    const creation = input.operation === 'create' ? applicationAuthorityCreationScope(application.state.layers,
      { workspaceId: access.workspaceId, origin: { kind: 'generic', entityTypeId: typeId }, typeKey: input.type, id, version: 'new' }, Object.keys(data), access)
      : { sensitivity: 'internal', compartments: [], projectIds: [] }
    const result = await context.transaction.query<{ ref: unknown }>('SELECT application_generic_write($1,$2,$3,$4,$5,$6,$7,$8,$9) AS ref',
      [typeId, input.type, input.operation, id, 'expectedVersion' in input ? input.expectedVersion : null, JSON.stringify(data),
        creation.sensitivity, creation.compartments, creation.projectIds])
    return applicationResourceRefSchema.parse(result.rows[0]?.ref)
  }
  const store = createDbDocEntityStore({ actorUserId: access.userId, transaction: context.transaction })
  let version: string
  if (input.operation === 'create') {
    const record = await store.createEntity({ id, entityTypeId: typeId, workspaceId: access.workspaceId, data: input.data, sourceApp: 'api',
      createdBy: access.userId, lastEditedBy: access.userId, sensitivity: 'internal',
      compartments: [...context.execution.security.writeDefaults.compartments], projectIds: [...context.execution.security.writeDefaults.projectIds] })
    version = record.recordVersion!
  } else {
    const record = await store.getEntity(access.workspaceId, id)
    if (!record || record.entityTypeId !== typeId) throw new ApplicationPlatformError('access_unavailable', 'The record is unavailable.')
    if (input.operation === 'patch') {
      const next = await store.updateEntity(access.workspaceId, id, { data: { ...record.data, ...input.data }, lastEditedBy: access.userId },
        { actorUserId: access.userId, expectedRecordVersion: input.expectedVersion })
      version = next.recordVersion!
    } else {
      await store.deleteEntity(access.workspaceId, id, { actorUserId: access.userId, expectedRecordVersion: input.expectedVersion })
      version = String(BigInt(record.recordVersion!) + 1n)
    }
  }
  return { workspaceId: access.workspaceId, origin: { kind: 'generic', entityTypeId: typeId }, typeKey: input.type, id, version }
}
