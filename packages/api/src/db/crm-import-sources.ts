/** Immutable CRM processing artifacts, separate from general Files access.
 * [COMP:crm/production-import]
 */
import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import type { CrmIntegrationGrant } from '@use-brian/core/crm/integration-authority.js'
import { CrmOperationsError, type CrmOperationsContext } from '@use-brian/core/crm/operations-types.js'
import { importGrantSnapshot, requireImportCeiling, requireImportOperation } from '../crm-operations/import-authority.js'
import { getPool } from './client.js'

export const MAX_CRM_IMPORT_SOURCE_BYTES = 30 * 1024 * 1024
type CrmImportSourceMetadata = {
  id: string; workspaceId: string; sourceHash: string; credentialId: string
  integrationGrants: CrmIntegrationGrant[]; createdAt: Date; byteCount: number; privacyErased: boolean
}
export type CrmImportSource = CrmImportSourceMetadata & { bytes: Buffer }
const COLUMNS = `id,workspace_id AS "workspaceId",source_hash AS "sourceHash",credential_id AS "credentialId",
  integration_grants AS "integrationGrants",created_at AS "createdAt",octet_length(content_bytes) AS "byteCount",privacy_erased AS "privacyErased"`

const retiredSource = () => new CrmOperationsError('conflict', 'The CRM import source was erased. Its receipt cannot restore the CSV.', { reason: 'import_source_retired' })

export function createCrmImportSources(pool: Pool = getPool()) {
  return {
    async stage(context: CrmOperationsContext, rawSourceKey: unknown, rawBytes: Uint8Array) {
      requireImportOperation(context, 'crm.imports.write')
      if (context.actor.kind !== 'integration_key' || !context.authority.integration) throw new CrmOperationsError('not_authorized', 'Machine CRM sources require an integration credential.')
      const sourceKey = z.string().uuid().parse(rawSourceKey)
      if (!rawBytes.byteLength || rawBytes.byteLength > MAX_CRM_IMPORT_SOURCE_BYTES) throw new CrmOperationsError('payload_too_large', 'A CRM CSV source must contain 1 byte to 30 MiB.')
      let csv: string
      try { csv = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes) }
      catch { throw new CrmOperationsError('invalid_input', 'CRM import sources must be UTF-8 CSV.') }
      if (csv.includes('\0')) throw new CrmOperationsError('invalid_input', 'CRM import sources cannot contain NUL characters.')
      const bytes = Buffer.from(rawBytes)
      const sourceHash = createHash('sha256').update(bytes).digest('hex')
      const grants = importGrantSnapshot(context.authority.integration)
      const inserted = await pool.query<CrmImportSourceMetadata>(`INSERT INTO crm_import_sources
        (workspace_id,source_key,content_bytes,source_hash,credential_id,integration_grants)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (workspace_id,source_key) DO NOTHING RETURNING ${COLUMNS}`,
        [context.workspaceId, sourceKey, bytes, sourceHash, context.actor.credentialId, JSON.stringify(grants)])
      const source = inserted.rows[0] ?? (await pool.query<CrmImportSourceMetadata>(`SELECT ${COLUMNS} FROM crm_import_sources
        WHERE workspace_id=$1 AND source_key=$2`, [context.workspaceId, sourceKey])).rows[0]
      if (!source) throw new CrmOperationsError('conflict', 'The source changed during upload. Retry with the same source key.')
      if (source.privacyErased) throw retiredSource()
      requireImportCeiling(context.authority.integration, source.integrationGrants)
      if (source.sourceHash !== sourceHash) throw new CrmOperationsError('idempotency_conflict', 'This source key was already used for different CSV bytes.')
      return { sourceId: source.id, sourceHash: source.sourceHash, bytes: source.byteCount, created: inserted.rowCount === 1 }
    },
    async read(context: CrmOperationsContext, rawId: unknown, mode: 'read' | 'write' = 'write'): Promise<CrmImportSource> {
      requireImportOperation(context, mode === 'read' ? 'crm.imports.read' : 'crm.imports.write')
      const id = z.string().uuid().parse(rawId)
      const result = await pool.query<CrmImportSource>(`SELECT ${COLUMNS},content_bytes AS bytes FROM crm_import_sources WHERE workspace_id=$1 AND id=$2`, [context.workspaceId, id])
      const source = result.rows[0]
      if (!source) throw new CrmOperationsError('not_found', 'CRM import source is unavailable.')
      if (source.privacyErased) throw retiredSource()
      if (context.authority.integration) requireImportCeiling(context.authority.integration, source.integrationGrants, mode)
      const bytes = source.bytes
      if (createHash('sha256').update(bytes).digest('hex') !== source.sourceHash) throw new CrmOperationsError('conflict', 'CRM import source integrity check failed.')
      return { ...source, bytes }
    },
    async attributionUser(context: CrmOperationsContext, transactionClient?: PoolClient): Promise<string> {
      if (context.actor.kind === 'user') return context.actor.userId
      if (context.actor.kind !== 'integration_key') throw new CrmOperationsError('not_authorized', 'Unsupported import principal.')
      const result = await (transactionClient ?? pool).query<{ userId: string }>(`SELECT coalesce(c.created_by_user_id,w.owner_user_id) AS "userId"
        FROM crm_integration_credentials c JOIN workspaces w ON w.id=c.workspace_id
        WHERE c.workspace_id=$1 AND c.id=$2`, [context.workspaceId, context.actor.credentialId])
      if (!result.rows[0]?.userId) throw new CrmOperationsError('not_authorized', 'Import storage attribution is unavailable.')
      return result.rows[0].userId
    },
  }
}
export type CrmImportSources = ReturnType<typeof createCrmImportSources>
