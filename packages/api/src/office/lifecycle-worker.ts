/** Retention clock: Trash -> Retained -> Purged, preserving legal holds and
 * pinned template dependencies. Covered by [COMP:api/office-release]. */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { parseStorageKey } from '../files/gcs-client.js'

export type OfficeTimedLifecycle = { state: 'trash' | 'retained'; retainAt: Date | null; purgeAt: Date | null; legalHold: boolean }

export function nextOfficeLifecycleState(value: OfficeTimedLifecycle, now: Date): 'retained' | 'purged' | null {
  if (value.legalHold) return null
  if (value.state === 'trash' && value.retainAt && value.retainAt <= now) return 'retained'
  if (value.state === 'retained' && value.purgeAt && value.purgeAt <= now) return 'purged'
  return null
}

export function createOfficeLifecycleWorker(deps: { sweep(): Promise<number>; intervalMs?: number }) {
  let timer: ReturnType<typeof setInterval> | null = null
  const run = () => void deps.sweep().then((count) => { if (count) console.log(`[office-lifecycle] advanced ${count} retained item(s)`) }).catch((error) => console.error('[office-lifecycle] sweep failed:', error))
  return {
    start() { if (!timer) { run(); timer = setInterval(run, deps.intervalMs ?? 60 * 60 * 1000); timer.unref?.() } },
    stop() { if (timer) clearInterval(timer); timer = null },
  }
}

type ExpiredPdfSession = {
  intakeState?: string
  id: string
  workspaceId: string
  ownerUserId: string
  expiresAt: Date
  legalHold: boolean
}

type PdfPurgeAsset = {
  fileId: string
  role: 'source' | 'signature' | 'snapshot' | 'preview' | 'release'
  contentSha256: string
  path: string
  storageUri: string
  metadata: Record<string, unknown>
}

const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`

/** Hard-delete one due session and durably enqueue every owned blob. The
 * transaction intentionally discovers foreign keys at runtime: a new file
 * consumer blocks erasure until its ownership semantics are reviewed. */
export async function purgeExpiredPdfSessions(client: PoolClient, limit = 25): Promise<number> {
  let purged = 0
  for (let index = 0; index < limit; index += 1) {
    await client.query('BEGIN')
    try {
      const session = (await client.query<ExpiredPdfSession>(`
        SELECT id,workspace_id AS "workspaceId",owner_user_id AS "ownerUserId",
               expires_at AS "expiresAt",legal_hold AS "legalHold",pdf_intake_state AS "intakeState"
          FROM office_artifacts
         WHERE mode='session' AND family='pdf' AND lifecycle_state='active'
           AND expires_at<=now()
         ORDER BY expires_at,id
         FOR UPDATE SKIP LOCKED LIMIT 1
      `)).rows[0]
      if (!session) {
        await client.query('ROLLBACK')
        return purged
      }
      if (session.legalHold || session.expiresAt.getTime() > Date.now()) {
        await client.query('ROLLBACK')
        continue
      }
      const assets = (await client.query<PdfPurgeAsset>(`
        SELECT a.file_id AS "fileId",a.role,a.content_sha256 AS "contentSha256",
               f.path,f.storage_uri AS "storageUri",f.metadata
          FROM office_pdf_session_assets a
          JOIN workspace_files f ON f.id=a.file_id AND f.workspace_id=a.workspace_id
         WHERE a.artifact_id=$1
         ORDER BY a.created_at,a.file_id
         FOR UPDATE OF f
      `, [session.id])).rows
      if (session.intakeState !== 'pending' && session.intakeState !== 'abandoned' && (assets.length < 2 || !assets.some((asset) => asset.role === 'source') || !assets.some((asset) => asset.role === 'snapshot'))) {
        throw new Error('pdf_purge_incomplete_asset_set')
      }
      for (const asset of assets) {
        if (!asset.path.startsWith(`/office/sessions/${session.id}/`)
          || asset.metadata.officeSession !== true || asset.metadata.noIndex !== true
          || parseStorageKey(asset.storageUri) !== `${session.workspaceId}/${asset.fileId}`) {
          throw new Error('pdf_purge_noncanonical_asset')
        }
      }

      const references = await client.query<{ schema: string; table: string; columns: string[]; target: string[] }>(`
        SELECT n.nspname schema,c.relname "table",
          ARRAY(SELECT a.attname::text FROM unnest(f.conkey) WITH ORDINALITY k(id,ord)
            JOIN pg_attribute a ON a.attrelid=f.conrelid AND a.attnum=k.id ORDER BY k.ord) columns,
          ARRAY(SELECT a.attname::text FROM unnest(f.confkey) WITH ORDINALITY k(id,ord)
            JOIN pg_attribute a ON a.attrelid=f.confrelid AND a.attnum=k.id ORDER BY k.ord) target
          FROM pg_constraint f
          JOIN pg_class c ON c.oid=f.conrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE f.contype='f' AND f.confrelid='workspace_files'::regclass
         ORDER BY n.nspname,c.relname,f.conname
      `)
      const fileIds = assets.map((asset) => asset.fileId)
      for (const reference of references.rows) {
        const predicate = reference.columns.map((column, position) =>
          `c.${quoteIdentifier(column)}=f.${quoteIdentifier(reference.target[position]!)}`).join(' AND ')
        const owned = reference.schema === 'public' && ['office_pdf_session_assets', 'office_artifact_versions', 'office_release_records', 'workspace_file_session_bindings'].includes(reference.table)
          ? `AND c.artifact_id IS DISTINCT FROM $3` : ''
        const count = Number((await client.query(`
          SELECT count(*)::int count
            FROM ${quoteIdentifier(reference.schema)}.${quoteIdentifier(reference.table)} c
            JOIN workspace_files f ON ${predicate}
           WHERE f.workspace_id=$1 AND f.id=ANY($2::uuid[]) ${owned}
        `, [session.workspaceId, fileIds, ...(owned ? [session.id] : [])])).rows[0]?.count ?? 0)
        if (count > 0) throw new Error('pdf_purge_foreign_file_reference')
      }
      const duplicateObject = Number((await client.query(`
        SELECT count(*)::int count FROM workspace_files
         WHERE workspace_id=$1 AND id<>ALL($2::uuid[])
           AND storage_uri=ANY($3::text[])
      `, [session.workspaceId, fileIds, assets.map((asset) => asset.storageUri)])).rows[0]?.count ?? 0)
      if (duplicateObject > 0) throw new Error('pdf_purge_foreign_file_reference')

      for (const asset of assets) {
        await client.query(`
          INSERT INTO office_pdf_purge_objects
            (artifact_id,workspace_id,owner_user_id,file_id,role,storage_uri,content_sha256)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (artifact_id,file_id) DO NOTHING
        `, [session.id, session.workspaceId, session.ownerUserId, asset.fileId, asset.role, asset.storageUri, asset.contentSha256])
      }
      await client.query(`
        INSERT INTO office_audit_events
          (workspace_id,artifact_id,actor_user_id,event_type,metadata)
        VALUES ($1,$2::uuid,NULL,'office_pdf_session_purged',
          jsonb_build_object('formerArtifactId',($2::uuid)::text,'expiredAt',$3::timestamptz,
            'purgedAt',clock_timestamp(),'assetCount',$4::int,
            'sourceHashes',$5::text[],'outputHashes',$6::text[]))
      `, [session.workspaceId, session.id, session.expiresAt, assets.length,
        assets.filter((asset) => asset.role === 'source').map((asset) => asset.contentSha256),
        assets.filter((asset) => asset.role === 'release').map((asset) => asset.contentSha256)])
      const deletedArtifact = await client.query(`DELETE FROM office_artifacts WHERE id=$1 AND mode='session' RETURNING id`, [session.id])
      if (deletedArtifact.rowCount !== 1) throw new Error('pdf_purge_session_changed')
      const deletedFiles = await client.query(`DELETE FROM workspace_files WHERE workspace_id=$1 AND id=ANY($2::uuid[]) RETURNING id`, [session.workspaceId, fileIds])
      if (deletedFiles.rowCount !== assets.length) throw new Error('pdf_purge_asset_changed')
      await client.query('COMMIT')
      purged += 1
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  }
  return purged
}

export type PdfPurgeObject = {
  id: string
  storageUri: string
  workspaceId: string
  fileId: string
  leaseToken: string
}

export async function claimPdfPurgeObjects(client: PoolClient, limit = 50, leaseMs = 60_000): Promise<PdfPurgeObject[]> {
  const leaseToken = randomUUID()
  const result = await client.query<PdfPurgeObject>(`
    WITH due AS (
      SELECT id FROM office_pdf_purge_objects
       WHERE completed_at IS NULL AND next_attempt_at<=now()
         AND (lease_token IS NULL OR lease_expires_at<=now())
       ORDER BY next_attempt_at,created_at
       FOR UPDATE SKIP LOCKED LIMIT $1
    )
    UPDATE office_pdf_purge_objects q SET
      lease_token=$2,lease_expires_at=now()+($3::int*interval '1 millisecond'),
      attempts=attempts+1,updated_at=now()
      FROM due WHERE q.id=due.id
    RETURNING q.id,q.storage_uri AS "storageUri",q.workspace_id AS "workspaceId",
              q.file_id AS "fileId",q.lease_token AS "leaseToken"
  `, [limit, leaseToken, leaseMs])
  return result.rows
}

export async function runPdfPurgeBlobWorker(deps: {
  client: PoolClient
  deleteObject(storageUri: string, storageKey: string): Promise<void>
  limit?: number
}): Promise<number> {
  const claimed = await claimPdfPurgeObjects(deps.client, deps.limit)
  let completed = 0
  for (const item of claimed) {
    try {
      if (!item.storageUri || parseStorageKey(item.storageUri) !== `${item.workspaceId}/${item.fileId}`) {
        throw new Error('noncanonical_purge_object')
      }
      await deps.deleteObject(item.storageUri, `${item.workspaceId}/${item.fileId}`)
      const result = await deps.client.query(`
        UPDATE office_pdf_purge_objects SET
          completed_at=now(),storage_uri=NULL,lease_token=NULL,lease_expires_at=NULL,
          last_error_code=NULL,updated_at=now()
         WHERE id=$1 AND lease_token=$2 AND completed_at IS NULL
        RETURNING id
      `, [item.id, item.leaseToken])
      if (result.rowCount === 1) completed += 1
    } catch (error) {
      const code = error instanceof Error && error.message === 'noncanonical_purge_object'
        ? 'noncanonical_purge_object' : 'blob_delete_failed'
      await deps.client.query(`
        UPDATE office_pdf_purge_objects SET
          lease_token=NULL,lease_expires_at=NULL,last_error_code=$3,
          next_attempt_at=now()+(LEAST(3600,power(2,LEAST(attempts,12)))::int*interval '1 second'),
          updated_at=now()
         WHERE id=$1 AND lease_token=$2 AND completed_at IS NULL
      `, [item.id, item.leaseToken, code])
    }
  }
  return completed
}
