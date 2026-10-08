/** CRM-only credential lifecycle/authentication. [COMP:api/crm-integration-auth] */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import {
  CrmIntegrationGrantsSchema, CrmOperationsError, crmOperationsSha256,
  type CrmIntegrationAuthority, type CrmIntegrationGrant, type AuthoringAuthority, parseAuthoringAuthority,
  type CrmPage, type CrmPageQuery, type DepartmentReadGrant,
} from '@use-brian/core'
import { applyRLSGucs, getAppPool, getPool } from './client.js'
import { resolveWorkflowAuthoringScope } from '../context-scope/workflow-authority.js'
import { runWithAgentAccess } from './agent-access-context.js'
import { hashSecret, verifySecret } from './api-key-store.js'
import { queryCrmPage } from '../crm-operations/pagination.js'
import { admitCrmIntegrationBinding, renewCrmIntegrationBinding, CrmIntegrationDepartmentSelectionSchema, previewCrmIntegrationBindings, CrmIntegrationBindingOptionsSchema, crmIntegrationExecutionLimits,
  assertCrmCredentialParent, type CrmCredentialParent,
  type CrmIntegrationExecutionLimits,
  type CrmIntegrationDepartmentBinding } from '../crm-operations/integration-department-authority.js'

export const CreateCrmIntegrationCredentialSchema = z.object({
  requestId: z.string().uuid().optional(),
  label: z.string().trim().min(1).max(200),
  expiresAt: z.string().datetime({ offset: true }),
  grants: CrmIntegrationGrantsSchema,
  revokeCredentialId: z.string().uuid().optional(),
  departmentBinding: CrmIntegrationDepartmentSelectionSchema.optional(),
}).strict()
export type CreateCrmIntegrationCredential = z.infer<typeof CreateCrmIntegrationCredentialSchema>
export interface CrmIntegrationCredential {
  id: string
  workspaceId: string
  label: string
  prefix: string
  expiresAt: Date
  revokedAt: Date | null
  createdAt: Date
  createdByUserId: string | null
  lastUsedAt: Date | null
  grants: CrmIntegrationGrant[]
  departmentBinding: CrmIntegrationDepartmentBinding | null
}
export interface CrmIntegrationPrincipal extends CrmIntegrationAuthority {
  workspaceId: string
  /** Resolved by credential authentication/admission, never transport input. */
  departmentRead?: DepartmentReadGrant
  executionLimits?: CrmIntegrationExecutionLimits
}

const COLUMNS = `c.id,c.workspace_id AS "workspaceId",c.label,c.secret_prefix AS prefix,
  c.expires_at AS "expiresAt",c.revoked_at AS "revokedAt",c.created_at AS "createdAt",
  c.created_by_user_id AS "createdByUserId",c.last_used_at AS "lastUsedAt",c.department_binding AS "departmentBinding"`
const GRANTS = `coalesce((SELECT jsonb_agg(jsonb_build_object('operation',g.operation,'selectors',g.selectors) ORDER BY g.operation)
  FROM crm_integration_credential_grants g WHERE g.workspace_id=c.workspace_id AND g.credential_id=c.id),'[]'::jsonb) AS grants`

export function parseCrmIntegrationToken(token: string): { credentialId: string; secret: string } | null {
  const matched = /^sk_crm_([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})_([A-Za-z0-9_-]{43})$/i.exec(token)
  return matched ? { credentialId: matched[1], secret: matched[2] } : null
}

/** Call inside the mutation transaction, before module/domain locks. Check
 * expiry after any credential/grant lock wait, using current database time. */
export async function lockCrmIntegrationCredential(client: PoolClient, workspaceId: string, credentialId: string): Promise<CrmIntegrationPrincipal> {
  const credential = await client.query(`SELECT id FROM crm_integration_credentials
    WHERE workspace_id=$1 AND id=$2 FOR SHARE`, [workspaceId, credentialId])
  const unavailable = () => new CrmOperationsError('credential_revoked', 'The CRM integration credential is no longer active.')
  if (!credential.rowCount) throw unavailable()
  const rows = await client.query(`SELECT operation,selectors FROM crm_integration_credential_grants
    WHERE workspace_id=$1 AND credential_id=$2 ORDER BY operation FOR SHARE`, [workspaceId, credentialId])
  const grants = CrmIntegrationGrantsSchema.safeParse(rows.rows)
  if (!grants.success) throw unavailable()
  const active = await client.query(`SELECT revoked_at IS NULL AND expires_at>clock_timestamp() AS active,
    created_by_user_id AS issuer,department_binding AS binding,
    (SELECT department_read_v2 FROM workspaces WHERE id=$1) AS v2
    FROM crm_integration_credentials WHERE workspace_id=$1 AND id=$2`, [workspaceId, credentialId])
  if (!active.rows[0]?.active) throw unavailable()
  const row = active.rows[0]
  const departmentRead = row.v2 ? await renewCrmIntegrationBinding(client, workspaceId, row.issuer, row.binding) : undefined
  return { workspaceId, credentialId, grants: grants.data, ...(departmentRead ? { departmentRead, executionLimits: await crmIntegrationExecutionLimits(client, row.binding) } : {}) }
}

/** Pool-backed reads own a short admission transaction; transactional callers
 * keep their exact client. Mutations still use lockCrmIntegrationCredential. */
export async function readCrmIntegrationCredential(client: Pool | PoolClient, workspaceId: string, credentialId: string): Promise<CrmIntegrationPrincipal> {
  if (!('release' in client)) {
    const transaction = await client.connect()
    try {
      await transaction.query('BEGIN')
      await transaction.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])
      const principal = await readCrmIntegrationCredential(transaction, workspaceId, credentialId)
      await transaction.query('COMMIT')
      return principal
    } catch (error) {
      await transaction.query('ROLLBACK')
      throw error
    } finally {
      transaction.release()
    }
  }
  const result = await client.query<CrmIntegrationCredential & { v2: boolean }>(`SELECT ${COLUMNS},${GRANTS},
    (SELECT department_read_v2 FROM workspaces WHERE id=$1) AS v2
    FROM crm_integration_credentials c WHERE c.workspace_id=$1 AND c.id=$2
      AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp()`, [workspaceId, credentialId])
  const row = result.rows[0], grants = CrmIntegrationGrantsSchema.safeParse(row?.grants)
  if (!row || !grants.success) throw new CrmOperationsError('credential_revoked', 'The CRM integration credential is no longer active.')
  const departmentRead = row.v2 ? await renewCrmIntegrationBinding(client, workspaceId, row.createdByUserId, row.departmentBinding) : undefined
  return { workspaceId, credentialId, grants: grants.data, ...(departmentRead ? { departmentRead, executionLimits: await crmIntegrationExecutionLimits(client, row.departmentBinding) } : {}) }
}

async function adminTransaction<T>(pool: Pool, workspaceId: string, userId: string, fn: (client: PoolClient) => Promise<T>, authoring?: AuthoringAuthority, parent?: CrmCredentialParent): Promise<T> {
  const client = await pool.connect()
  try {
    if (parent && !authoring) throw new CrmOperationsError('not_authorized', 'Trusted parent authoring authority is required.')
    await client.query('BEGIN')
    await applyRLSGucs(client, userId)
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])
    const member = await client.query(`SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND role IN ('owner','admin') FOR SHARE`, [workspaceId, userId])
    if (!member.rowCount) throw new CrmOperationsError('not_authorized', 'An owner or admin member is required for integration credentials.')
    const renew = async () => {
      if (parent) await assertCrmCredentialParent(client, parent, workspaceId, userId, authoring)
      const pinned = parseAuthoringAuthority(authoring)
      if (!pinned || pinned.ceiling.workspaceId !== workspaceId || pinned.ceiling.userId !== userId) {
        throw new CrmOperationsError('not_authorized', 'Current credential authoring authority is unavailable.')
      }
      const capabilities = await client.query('SELECT capability FROM assistant_capabilities WHERE assistant_id=$1 AND revoked_at IS NULL AND capability=ANY($2::text[]) ORDER BY capability FOR SHARE',
        [pinned.assistantId, ['configure', 'crm', 'home_app:crm:write']])
      if (new Set(capabilities.rows.map(row => row.capability)).size !== 3) {
        throw new CrmOperationsError('not_authorized', 'Current configure and CRM write grants are required for credential lifecycle operations.')
      }
      const v2 = (await client.query('SELECT department_read_v2 FROM workspaces WHERE id=$1', [workspaceId])).rows[0]?.department_read_v2
      if (!v2) throw new CrmOperationsError('not_authorized', 'Enable department bindings before delegated credential issuance.')
      try {
        return (await resolveWorkflowAuthoringScope({ workspaceId, userId, assistantId: pinned.assistantId,
          authoringAuthority: pinned, contextGroupId: null, contextProjectId: null }, client)).access
      } catch { throw new CrmOperationsError('not_authorized', 'Credential authoring authority changed. Review access and try again.') }
    }
    const access = authoring ? await renew() : undefined
    const result = access ? await runWithAgentAccess({ ...access, clearance: access.clearance, compartments: access.compartments }, () => fn(client)) : await fn(client)
    if (access && JSON.stringify(await renew()) !== JSON.stringify(access)) {
      throw new CrmOperationsError('not_authorized', 'Credential authoring authority changed before commit.')
    }
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { client.release() }
}

const RESOURCE_TABLES = {
  definitionIds: ['crm_intake_definitions', 'id'], purposeKeys: ['crm_consent_purposes', 'purpose_key'],
  planIds: ['association_membership_plans', 'id'], eventIds: ['association_events', 'id'],
} as const

async function validateResourceOwnership(client: PoolClient, workspaceId: string, grants: CrmIntegrationGrant[]) {
  for (const grant of grants) {
    for (const dimension of Object.keys(RESOURCE_TABLES) as Array<keyof typeof RESOURCE_TABLES>) {
      const selection = grant.selectors[dimension]
      if (!selection || selection === 'all') continue
      const [table, column] = RESOURCE_TABLES[dimension]
      const rows = await client.query(`SELECT ${column}::text AS value FROM ${table} WHERE workspace_id=$1 AND ${column}::text=ANY($2::text[])`, [workspaceId, selection])
      const found = new Set(rows.rows.map((row) => String(row.value)))
      if (selection.some((value) => !found.has(value))) throw new CrmOperationsError('invalid_input', 'A selected integration resource is unavailable in this workspace.', { dimension })
    }
  }
}

export function createCrmIntegrationStore(pool: Pool = getPool(), memberPool: Pool = getAppPool()) {
  return {
    async bindingOptions(workspaceId: string, userId: string, raw: z.input<typeof CrmIntegrationBindingOptionsSchema> = {}, authoring?: AuthoringAuthority, parent?: CrmCredentialParent) {
      if (authoring && raw.assistantId && raw.assistantId !== authoring.assistantId) throw new CrmOperationsError('not_authorized', 'Use the executing assistant for delegated credential binding.')
      return adminTransaction(memberPool, workspaceId, userId, client => previewCrmIntegrationBindings(client, workspaceId, userId,
        authoring ? { ...raw, assistantId: authoring.assistantId } : raw), authoring, parent)
    },
    async create(workspaceId: string, userId: string, raw: CreateCrmIntegrationCredential, authoring?: AuthoringAuthority, parent?: CrmCredentialParent): Promise<CrmIntegrationCredential & { oneTimeSecret: string }> {
      const input = CreateCrmIntegrationCredentialSchema.parse(raw)
      if (parent) {
        if (!authoring) throw new CrmOperationsError('not_authorized', 'Delegated issuance requires trusted authoring authority.')
        if ('expiresAt' in parent && new Date(parent.expiresAt).getTime() < new Date(input.expiresAt).getTime()) input.expiresAt = parent.expiresAt
      }
      if (authoring) {
        if (!input.requestId) throw new CrmOperationsError('invalid_input', 'Delegated issuance requires a stable request identity.')
        if (input.departmentBinding?.assistantId && input.departmentBinding.assistantId !== authoring.assistantId) {
          throw new CrmOperationsError('not_authorized', 'Use the executing assistant for delegated credential binding.')
        }
        input.departmentBinding = { ...input.departmentBinding, cap: input.departmentBinding?.cap ?? 'internal', assistantId: authoring.assistantId }
      }
      // Hash outside the DB transaction; no credential is usable before commit.
      const id = randomUUID()
      const secret = randomBytes(32).toString('base64url')
      const plaintext = `sk_crm_${id}_${secret}`
      const secretHash = await hashSecret(secret)
      return adminTransaction(memberPool, workspaceId, userId, async (client) => {
        if (parent) await assertCrmCredentialParent(client, parent, workspaceId, userId)
        const fingerprint = input.requestId ? crmOperationsSha256(input) : null
        if (input.requestId) {
          const previous = (await client.query<{ id: string; issuer: string; fingerprint: string }>(
            'SELECT id,created_by_user_id AS issuer,request_fingerprint AS fingerprint FROM crm_integration_credentials WHERE workspace_id=$1 AND request_id=$2',
            [workspaceId, input.requestId])).rows[0]
          if (previous) {
            if (previous.issuer !== userId || previous.fingerprint !== fingerprint) throw new CrmOperationsError('conflict', 'The credential request identity is already in use.')
            throw new CrmOperationsError('conflict', 'This credential was already issued. Inspect it before rotating a lost secret.',
              { reason: 'credential_already_issued', credentialId: previous.id })
          }
        }
        const time = await client.query<{ valid: boolean }>('SELECT $1::timestamptz>clock_timestamp() AS valid', [input.expiresAt])
        if (!time.rows[0].valid) throw new CrmOperationsError('invalid_input', 'Credential expiry must be in the future.')
        await validateResourceOwnership(client, workspaceId, input.grants)
        const v2 = (await client.query<{ v2: boolean }>('SELECT department_read_v2 AS v2 FROM workspaces WHERE id=$1', [workspaceId])).rows[0]?.v2
        const binding = v2 ? await admitCrmIntegrationBinding(client, workspaceId, userId, input.departmentBinding, parent) : null
        await client.query(`INSERT INTO crm_integration_credentials (id,workspace_id,label,secret_prefix,secret_hash,expires_at,created_by_user_id,department_binding,request_id,request_fingerprint)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, workspaceId, input.label, plaintext.slice(0, 15), secretHash, input.expiresAt, userId, binding, input.requestId ?? null, fingerprint])
        for (const grant of input.grants) await client.query(`INSERT INTO crm_integration_credential_grants (workspace_id,credential_id,operation,selectors)
          VALUES ($1,$2,$3,$4)`, [workspaceId, id, grant.operation, JSON.stringify(grant.selectors)])
        if (input.revokeCredentialId) {
          const old = await client.query(`UPDATE crm_integration_credentials SET revoked_at=coalesce(revoked_at,now())
            WHERE workspace_id=$1 AND id=$2 RETURNING id`, [workspaceId, input.revokeCredentialId])
          if (!old.rowCount) throw new CrmOperationsError('not_found', 'Credential selected for rotation is unavailable.')
        }
        await client.query(`INSERT INTO workspace_audit_log (workspace_id,actor_user_id,event_type,subject_id,details)
          VALUES ($1,$2,'crm.integration_credential_created',$3,$4)`, [workspaceId, userId, id,
          { subjectKind: 'crm_integration_credential', operationCount: input.grants.length, expiresAt: input.expiresAt, revokedCredentialId: input.revokeCredentialId ?? null }])
        const result = await client.query<CrmIntegrationCredential>(`SELECT ${COLUMNS},${GRANTS} FROM crm_integration_credentials c WHERE c.workspace_id=$1 AND c.id=$2`, [workspaceId, id])
        if (parent) await assertCrmCredentialParent(client, parent, workspaceId, userId)
        return { ...result.rows[0], oneTimeSecret: plaintext }
      }, authoring, parent)
    },
    async listForMember(workspaceId: string, userId: string, filters: CrmPageQuery = {}, authoring?: AuthoringAuthority, parent?: CrmCredentialParent): Promise<CrmPage<'credentials', CrmIntegrationCredential>> {
      return adminTransaction(memberPool, workspaceId, userId, async (client) => {
        return queryCrmPage<'credentials', CrmIntegrationCredential>(client.query.bind(client), {
          workspaceId, resource: 'crm.integration-credentials', key: 'credentials', query: filters,
          sql: `SELECT ${COLUMNS},${GRANTS} FROM crm_integration_credentials c WHERE c.workspace_id=$1`, params: [workspaceId],
        })
      }, authoring, parent)
    },
    async revoke(workspaceId: string, userId: string, credentialId: string, authoring?: AuthoringAuthority, parent?: CrmCredentialParent): Promise<boolean> {
      return adminTransaction(memberPool, workspaceId, userId, async (client) => {
        const result = await client.query(`UPDATE crm_integration_credentials SET revoked_at=now()
          WHERE workspace_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING id`, [workspaceId, credentialId])
        if (!result.rowCount) return false
        await client.query(`INSERT INTO workspace_audit_log (workspace_id,actor_user_id,event_type,subject_id,details)
          VALUES ($1,$2,'crm.integration_credential_revoked',$3,'{"subjectKind":"crm_integration_credential"}')`, [workspaceId, userId, credentialId])
        return true
      }, authoring, parent)
    },
    async authenticate(token: string): Promise<CrmIntegrationPrincipal | null> {
      const parsed = parseCrmIntegrationToken(token)
      if (!parsed) return null
      const result = await pool.query<CrmIntegrationCredential & { secretHash: string }>(
        `SELECT ${COLUMNS},${GRANTS},c.secret_hash AS "secretHash" FROM crm_integration_credentials c
         WHERE c.id=$1 AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp()`, [parsed.credentialId])
      const row = result.rows[0]
      if (!row || !(await verifySecret(parsed.secret, row.secretHash))) return null
      // Unknown/malformed persisted grants fail closed, never partially load.
      const grants = CrmIntegrationGrantsSchema.safeParse(row.grants)
      if (!grants.success) return null
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        // Match administration's workspace-first lock order. Take the write
        // lock before parent admission so simultaneous authentications do not
        // both acquire SHARE and then deadlock while upgrading for telemetry.
        await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[row.workspaceId])
        await client.query('SELECT id FROM crm_integration_credentials WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[row.workspaceId,row.id])
        const principal = await lockCrmIntegrationCredential(client, row.workspaceId, row.id)
        const active = await client.query(`UPDATE crm_integration_credentials SET last_used_at=clock_timestamp()
          WHERE workspace_id=$1 AND id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() RETURNING id`, [row.workspaceId,row.id])
        if (!active.rowCount) throw new CrmOperationsError('credential_revoked','The CRM integration credential is no longer active.')
        await client.query('COMMIT')
        return principal
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        if (error instanceof CrmOperationsError && ['credential_revoked', 'not_authorized'].includes(error.code)) return null
        throw error
      } finally { client.release() }
    },
  }
}
export type CrmIntegrationStore = ReturnType<typeof createCrmIntegrationStore>
