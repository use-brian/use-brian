/** CRM record subset for manifest/import clients; no general Brain authority.
 * [COMP:api/crm-integration-auth]
 */
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { CrmOperationsError, CrmPageQuerySchema, requireCrmIntegrationOperation, departmentReadGrantJson, intersectDepartmentReadGrants, intersectScopeGrants } from '@use-brian/core'
import { getPool } from './client.js'
import { intersectCrmIntegrationExecutionLimits, type CrmIntegrationExecutionLimits } from '../crm-operations/integration-department-authority.js'
import { currentAgentAccess } from './agent-access-context.js'
import { lockCrmIntegrationCredential, type CrmIntegrationPrincipal } from './crm-integration-store.js'
import { queryCrmPage } from '../crm-operations/pagination.js'
import { readCrmFieldCatalog } from './crm-config-catalog.js'

export const CrmIntegrationRecordsQuerySchema = CrmPageQuerySchema.extend({
  kind: z.enum(['person', 'company', 'deal']).default('person'),
  query: z.string().trim().max(200).optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
}).strict()
const COLUMNS = `e.id,e.kind,e.display_name AS name,e.canonical_id AS "canonicalId",
  e.attributes,e.aliases,e.sensitivity,e.created_at AS "createdAt",e.updated_at AS "updatedAt"`

type MemberProfileRow = {
  id: string
  name: string
  canonicalId: string | null
  attributes: Record<string, unknown> | null
  updatedAt: Date | string
}

export type CrmIntegrationMemberProfile = {
  contactId: string
  name: string
  email: string | null
  phone: string | null
  organisationName: string | null
  position: string | null
  mailingAddress: string | null
  updatedAt: string
}

const optionalText = (max: number) => z.string().trim().min(1).max(max).nullable().optional()
export const CrmIntegrationMemberProfileUpdateSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  name: z.string().trim().min(1).max(200).optional(),
  phone: optionalText(40),
  organisationName: optionalText(200),
  position: optionalText(200),
  mailingAddress: optionalText(600),
}).strict().refine((value) => Object.keys(value).some((key) => key !== 'expectedUpdatedAt'), {
  message: 'At least one profile field is required.',
})
export type CrmIntegrationMemberProfileUpdate = z.infer<typeof CrmIntegrationMemberProfileUpdateSchema>

export const CrmIntegrationMemberVerifiedEmailUpdateSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  verificationId: z.string().uuid(),
}).strict()
export type CrmIntegrationMemberVerifiedEmailUpdate = z.infer<typeof CrmIntegrationMemberVerifiedEmailUpdateSchema>

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function memberProfile(row: MemberProfileRow): CrmIntegrationMemberProfile {
  const attributes = object(row.attributes)
  const fields = object(attributes.custom_fields)
  return {
    contactId: row.id,
    name: row.name,
    email: text(attributes.email) ?? row.canonicalId,
    phone: text(attributes.phone),
    organisationName: text(fields.organisation_name),
    position: text(fields.position),
    mailingAddress: text(fields.mailing_address),
    updatedAt: new Date(row.updatedAt).toISOString(),
  }
}

/** Frozen execution axes remain independent of the credential department grant. */
type RecordAuthority = { department: string | null; executionLimits?: CrmIntegrationExecutionLimits }
function executionPredicate(index: number, limits?: CrmIntegrationExecutionLimits, mutation = false) {
  const access = currentAgentAccess()
  return { sql: `($${index}::text[] IS NULL OR e.project_ids::text[] <@ $${index}::text[])
    AND ($${index + 1}::text[] IS NULL OR e.assistant_id IS NULL OR e.assistant_id::text=ANY($${index + 1}::text[]))
    AND (NOT $${index + 2}::boolean OR e.user_id IS NULL)
    AND ($${index + 3}::text[] IS NULL OR e.compartments <@ $${index + 3}::text[])`,
    params: [intersectScopeGrants(access?.projectIds ?? null, limits?.projectIds ?? null),
      intersectScopeGrants(access?.visibilityAssistantIds ?? null, limits?.visibilityAssistantIds ?? null),
      access?.sharedAudience === true || limits?.sharedAudience === true,
      mutation ? intersectScopeGrants(access?.mutationCompartments ?? null, limits?.mutationCompartments ?? null) : null] }
}

async function readMemberProfile(
  client: Pick<PoolClient, 'query'> | Pool,
  workspaceId: string,
  id: string,
  lock = false,
  authority: RecordAuthority = { department: null },
): Promise<MemberProfileRow | null> {
  const execution = executionPredicate(4, authority.executionLimits, lock)
  const result = await client.query<MemberProfileRow>(
    `SELECT e.id,e.display_name AS name,e.canonical_id AS "canonicalId",e.attributes,e.updated_at AS "updatedAt"
       FROM entities e
      WHERE e.workspace_id=$1 AND e.id=$2 AND e.kind='person'
        AND e.valid_to IS NULL AND e.retracted_at IS NULL
        AND NOT e.scope_held
        AND ($3::jsonb IS NULL OR public.department_row_allows($3::jsonb,e.workspace_id,e.sensitivity,e.compartments,e.user_id))
        AND ${execution.sql}
        AND NOT (e.attributes ? 'crm_archived_at')
      ${lock ? 'FOR UPDATE' : ''}`,
    [workspaceId, id, authority.department, ...execution.params],
  )
  return result.rows[0] ?? null
}

export function createCrmIntegrationRecordReadStore(principal: CrmIntegrationPrincipal, pool: Pool = getPool()) {
  const authorize = () => requireCrmIntegrationOperation(principal, 'crm.records.read')
  // Credential and membership changes serialize before protected row locks.
  const admission = async (client: PoolClient, write = false) => {
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [principal.workspaceId])
    const current = await lockCrmIntegrationCredential(client, principal.workspaceId, principal.credentialId)
    requireCrmIntegrationOperation(current, 'crm.records.read')
    if (write) requireCrmIntegrationOperation(current, 'crm.records.write')
    const grant = current.departmentRead && principal.departmentRead
      ? intersectDepartmentReadGrants(current.departmentRead, principal.departmentRead) : current.departmentRead
    return { department: grant ? departmentReadGrantJson(grant) : null,
      executionLimits: intersectCrmIntegrationExecutionLimits(current.executionLimits, principal.executionLimits) }
  }
  const renew = async (client: PoolClient, before: RecordAuthority, write = false) => {
    if (JSON.stringify(await admission(client, write)) !== JSON.stringify(before)) {
      throw new CrmOperationsError('not_authorized', 'The integration authority changed. Reload before retrying.')
    }
  }
  const readTransaction = async <T>(read: (client: PoolClient, authority: RecordAuthority) => Promise<T>): Promise<T> => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const authority = await admission(client)
      const result = await read(client, authority)
      await renew(client, authority)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally { client.release() }
  }
  return {
    async list(raw: unknown) {
      authorize()
      const input = CrmIntegrationRecordsQuerySchema.parse(raw)
      return readTransaction((client, authority) => { const execution = executionPredicate(6, authority.executionLimits); return queryCrmPage(client.query.bind(client), { workspaceId: principal.workspaceId, resource: 'crm.records', key: 'records',
        query: { limit: input.limit, cursor: input.cursor, createdAfter: input.createdAfter, createdBefore: input.createdBefore },
        sql: `SELECT ${COLUMNS}
         FROM entities e WHERE e.workspace_id=$1 AND e.kind=$2 AND e.valid_to IS NULL AND e.retracted_at IS NULL
           AND ($3::boolean OR NOT (e.attributes ? 'crm_archived_at'))
           AND ($4::text IS NULL OR e.display_name ILIKE '%' || $4 || '%' OR e.canonical_id ILIKE '%' || $4 || '%')
           AND NOT e.scope_held
           AND ($5::jsonb IS NULL OR public.department_row_allows($5::jsonb,e.workspace_id,e.sensitivity,e.compartments,e.user_id)) AND ${execution.sql}`,
        params: [principal.workspaceId, input.kind, input.includeArchived === 'true', input.query || null, authority.department, ...execution.params] }) })
    },
    async get(rawId: unknown, rawQuery: unknown = {}) {
      authorize()
      const id = z.string().uuid().parse(rawId)
      const input = CrmIntegrationRecordsQuerySchema.pick({ includeArchived: true }).parse(rawQuery)
      return readTransaction(async (client, authority) => {
        const execution = executionPredicate(5, authority.executionLimits)
        const result = await client.query<Record<string, unknown>>(`SELECT ${COLUMNS} FROM entities e WHERE e.workspace_id=$1 AND e.id=$2
          AND e.kind IN ('person','company','deal') AND e.valid_to IS NULL AND e.retracted_at IS NULL
          AND ($3::boolean OR NOT (e.attributes ? 'crm_archived_at')) AND NOT e.scope_held
          AND ($4::jsonb IS NULL OR public.department_row_allows($4::jsonb,e.workspace_id,e.sensitivity,e.compartments,e.user_id)) AND ${execution.sql}`,
          [principal.workspaceId, id, input.includeArchived === 'true', authority.department, ...execution.params])
        return result.rows[0] ?? null
      })
    },
    async fields(raw: unknown = {}) {
      authorize()
      return readTransaction(client => readCrmFieldCatalog(principal.workspaceId, raw, client.query.bind(client)))
    },
    async getMemberProfile(rawId: unknown): Promise<CrmIntegrationMemberProfile | null> {
      authorize()
      const id = z.string().uuid().parse(rawId)
      return readTransaction(async (client, authority) => {
        const row = await readMemberProfile(client, principal.workspaceId, id, false, authority)
        return row ? memberProfile(row) : null
      })
    },
    async updateMemberProfile(rawId: unknown, rawUpdate: unknown): Promise<CrmIntegrationMemberProfile | null> {
      authorize()
      requireCrmIntegrationOperation(principal, 'crm.records.write')
      const id = z.string().uuid().parse(rawId)
      const update = CrmIntegrationMemberProfileUpdateSchema.parse(rawUpdate)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const authority = await admission(client, true)
        const before = await readMemberProfile(client, principal.workspaceId, id, true, authority)
        if (!before) {
          await client.query('ROLLBACK')
          return null
        }
        if (new Date(before.updatedAt).toISOString() !== new Date(update.expectedUpdatedAt).toISOString()) {
          throw new CrmOperationsError('conflict', 'The member profile changed; reload before saving.')
        }

        const attributes = { ...object(before.attributes) }
        const customFields = { ...object(attributes.custom_fields) }
        const changed: string[] = []
        let name = before.name
        if (update.name !== undefined && update.name !== before.name) {
          name = update.name
          changed.push('name')
        }
        if (update.phone !== undefined && text(attributes.phone) !== update.phone) {
          if (update.phone === null) delete attributes.phone
          else attributes.phone = update.phone
          changed.push('phone')
        }
        for (const [inputKey, fieldKey] of [
          ['organisationName', 'organisation_name'],
          ['position', 'position'],
          ['mailingAddress', 'mailing_address'],
        ] as const) {
          const next = update[inputKey]
          if (next === undefined || text(customFields[fieldKey]) === next) continue
          if (next === null) delete customFields[fieldKey]
          else customFields[fieldKey] = next
          changed.push(inputKey)
        }
        if (changed.length === 0) {
          await renew(client, authority, true)
          await client.query('COMMIT')
          return memberProfile(before)
        }
        if (Object.keys(customFields).length === 0) delete attributes.custom_fields
        else attributes.custom_fields = customFields

        const result = await client.query<MemberProfileRow>(
          `UPDATE entities
              SET display_name=$3,attributes=$4::jsonb,updated_at=clock_timestamp()
            WHERE workspace_id=$1 AND id=$2 AND kind='person'
              AND valid_to IS NULL AND retracted_at IS NULL
          RETURNING id,display_name AS name,canonical_id AS "canonicalId",attributes,updated_at AS "updatedAt"`,
          [principal.workspaceId, id, name, JSON.stringify(attributes)],
        )
        await client.query(
          `INSERT INTO association_audit_log
             (workspace_id,action,subject_kind,subject_id,actor_kind,actor_credential_id,metadata)
           VALUES($1,'crm.member_profile.updated','contact',$2,'integration_key',$3,$4::jsonb)`,
          [principal.workspaceId, id, principal.credentialId, JSON.stringify({ fields: changed.sort() })],
        )
        await renew(client, authority, true)
        await client.query('COMMIT')
        return memberProfile(result.rows[0])
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async updateMemberVerifiedEmail(rawId: unknown, rawUpdate: unknown): Promise<CrmIntegrationMemberProfile | null> {
      authorize()
      requireCrmIntegrationOperation(principal, 'crm.records.write')
      const id = z.string().uuid().parse(rawId)
      const update = CrmIntegrationMemberVerifiedEmailUpdateSchema.parse(rawUpdate)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const authority = await admission(client, true)
        const before = await readMemberProfile(client, principal.workspaceId, id, true, authority)
        if (!before) {
          await client.query('ROLLBACK')
          return null
        }
        const oldEmail = text(object(before.attributes).email) ?? before.canonicalId
        if (oldEmail?.trim().toLowerCase() === update.email) {
          await renew(client, authority, true)
          await client.query('COMMIT')
          return memberProfile(before)
        }
        if (new Date(before.updatedAt).toISOString() !== new Date(update.expectedUpdatedAt).toISOString()) {
          throw new CrmOperationsError('conflict', 'The member profile changed; request a new email verification link.')
        }
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          JSON.stringify(['crm-intake-identity', principal.workspaceId, 'email', update.email]),
        ])
        const collision = await client.query<{ id: string }>(
          `SELECT id FROM (
             SELECT e.id
               FROM entities e
              WHERE e.workspace_id=$1 AND e.id<>$2 AND e.kind='person'
                AND e.valid_to IS NULL AND e.retracted_at IS NULL
                AND NOT (e.attributes ? 'crm_archived_at')
                AND lower(btrim(COALESCE(NULLIF(btrim(e.attributes->>'email'),''),e.canonical_id,'')))=$3
             UNION
             SELECT e.id
               FROM entity_external_identities i
               JOIN entities e ON e.workspace_id=i.workspace_id AND e.id=i.entity_id
              WHERE i.workspace_id=$1 AND i.entity_id<>$2 AND i.identity_kind='email'
                AND lower(btrim(i.normalized_value))=$3 AND e.kind='person'
                AND e.valid_to IS NULL AND e.retracted_at IS NULL
                AND NOT (e.attributes ? 'crm_archived_at')
           ) matches LIMIT 1`,
          [principal.workspaceId, id, update.email],
        )
        if (collision.rows[0]) {
          throw new CrmOperationsError('conflict', 'That verified email is already linked to another contact.', {
            reason: 'email_already_linked',
          })
        }
        const attributes = { ...object(before.attributes), email: update.email }
        const result = await client.query<MemberProfileRow>(
          `UPDATE entities
              SET canonical_id=$3,attributes=$4::jsonb,updated_at=clock_timestamp()
            WHERE workspace_id=$1 AND id=$2 AND kind='person'
              AND valid_to IS NULL AND retracted_at IS NULL
          RETURNING id,display_name AS name,canonical_id AS "canonicalId",attributes,updated_at AS "updatedAt"`,
          [principal.workspaceId, id, update.email, JSON.stringify(attributes)],
        )
        await client.query(
          `INSERT INTO association_audit_log
             (workspace_id,action,subject_kind,subject_id,actor_kind,actor_credential_id,metadata)
           VALUES($1,'crm.member_profile.email_verified','contact',$2,'integration_key',$3,$4::jsonb)`,
          [principal.workspaceId, id, principal.credentialId, JSON.stringify({
            fields: ['email'], verificationId: update.verificationId,
          })],
        )
        await renew(client, authority, true)
        await client.query('COMMIT')
        return memberProfile(result.rows[0])
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
  }
}
