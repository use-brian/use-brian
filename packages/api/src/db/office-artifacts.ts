/** Office artifact/version/source/grant/audit persistence. [COMP:api/office-store] */
import { queryWithRLS } from './client.js'
import type { QueryResultRow } from 'pg'

export type OfficeDbQuery = <T>(userId: string, sql: string, params: unknown[]) => Promise<{ rows: T[] }>

export const defaultOfficeDbQuery: OfficeDbQuery = async <T>(userId: string, sql: string, params: unknown[]) => {
  const result = await queryWithRLS<T & QueryResultRow>(userId, sql, params)
  return { rows: result.rows as T[] }
}

export type OfficeArtifactRow = {
  id: string
  workspaceId: string
  family: 'document' | 'presentation' | 'spreadsheet'
  mode: 'artifact' | 'template'
  title: string
  creatorUserId: string
  ownerUserId: string
  templateVersionId: string | null
  headVersionId: string | null
  headVersion: number
  capabilityVersion: number
  sensitivity: 'public' | 'internal' | 'confidential'
  lifecycleState: 'active' | 'archived' | 'trash' | 'retained' | 'purged'
  updatedAt: Date
}

export function createOfficeArtifactStore(db: OfficeDbQuery = defaultOfficeDbQuery) {
  return {
    async list(userId: string, workspaceId: string, lifecycleState: 'active' | 'archived' | 'trash' | 'retained'): Promise<OfficeArtifactRow[]> {
      const result = await db<OfficeArtifactRow>(userId, `
        SELECT id, workspace_id AS "workspaceId", family, mode, title,
               creator_user_id AS "creatorUserId", owner_user_id AS "ownerUserId",
               template_version_id AS "templateVersionId",
               head_version_id AS "headVersionId", head_version::int AS "headVersion",
               capability_version AS "capabilityVersion", sensitivity,
               lifecycle_state AS "lifecycleState", updated_at AS "updatedAt"
          FROM office_artifacts
         WHERE workspace_id = $1 AND lifecycle_state = $2
         ORDER BY updated_at DESC
         LIMIT 200
      `, [workspaceId, lifecycleState])
      return result.rows
    },

    async createShell(params: {
      userId: string
      workspaceId: string
      family: 'document' | 'presentation' | 'spreadsheet'
      title: string
      templateVersionId: string | null
      capabilityVersion: number
      sensitivity: 'public' | 'internal' | 'confidential'
      mode?: 'artifact' | 'template'
      visibilityUserIds?: string[]
      requiredCompartments?: string[]
    }): Promise<OfficeArtifactRow> {
      const result = await db<OfficeArtifactRow>(params.userId, `
        INSERT INTO office_artifacts
          (workspace_id, family, mode, title, creator_user_id, owner_user_id,
           template_version_id, capability_version, sensitivity,
           visibility_user_ids, required_compartments)
        VALUES ($1,$2,$10,$3,$4,$4,$5,$6,$7,$8::uuid[],$9::text[])
        RETURNING id, workspace_id AS "workspaceId", family, mode, title,
                  creator_user_id AS "creatorUserId", owner_user_id AS "ownerUserId",
                  template_version_id AS "templateVersionId",
                  head_version_id AS "headVersionId", head_version::int AS "headVersion",
                  capability_version AS "capabilityVersion", sensitivity,
                  lifecycle_state AS "lifecycleState", updated_at AS "updatedAt"
      `, [params.workspaceId, params.family, params.title, params.userId, params.templateVersionId, params.capabilityVersion, params.sensitivity, params.visibilityUserIds ?? [], params.requiredCompartments ?? [], params.mode ?? 'artifact'])
      const row = result.rows[0]
      if (!row) throw new Error('Office artifact shell insert returned no row')
      return row
    },

    async deleteEmptyShell(userId: string, artifactId: string): Promise<boolean> {
      const result = await db<{ id: string }>(userId, `
        DELETE FROM office_artifacts a
         WHERE a.id = $1
           AND a.head_version = 0
           AND a.head_version_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM office_generation_jobs j WHERE j.artifact_id = a.id
           )
        RETURNING a.id
      `, [artifactId])
      return result.rows.length === 1
    },

    async get(userId: string, artifactId: string): Promise<OfficeArtifactRow | null> {
      const result = await db<OfficeArtifactRow>(userId, `
        SELECT id, workspace_id AS "workspaceId", family, mode, title,
               creator_user_id AS "creatorUserId", owner_user_id AS "ownerUserId",
               template_version_id AS "templateVersionId",
               head_version_id AS "headVersionId", head_version::int AS "headVersion",
               capability_version AS "capabilityVersion", sensitivity,
               lifecycle_state AS "lifecycleState", updated_at AS "updatedAt"
          FROM office_artifacts WHERE id = $1
      `, [artifactId])
      return result.rows[0] ?? null
    },

    async listVersions(userId: string, artifactId: string): Promise<Array<Record<string, unknown>>> {
      const result = await db<Record<string, unknown>>(userId, `
        SELECT id, version::int AS version, parent_version_id AS "parentVersionId",
               snapshot_hash AS "snapshotHash", origin, author_type AS "authorType",
               summary, checkpoint_kind AS "checkpointKind", created_at AS "createdAt"
          FROM office_artifact_versions
         WHERE artifact_id = $1
         ORDER BY version DESC
         LIMIT 200
      `, [artifactId])
      return result.rows
    },

    async getHeadVersion(userId: string, artifactId: string): Promise<{ id: string; version: number; snapshotHash: string } | null> {
      const result = await db<{ id: string; version: number; snapshotHash: string }>(userId, `
        SELECT id,version::int AS version,snapshot_hash AS "snapshotHash"
          FROM office_artifact_versions
         WHERE artifact_id=$1 AND id=(SELECT head_version_id FROM office_artifacts WHERE id=$1)
      `, [artifactId])
      return result.rows[0] ?? null
    },

    async getVersionSource(userId: string, artifactId: string, versionId: string): Promise<{ snapshotFileId: string; snapshotHash: string; workspaceId: string } | null> {
      const result = await db<{ snapshotFileId: string; snapshotHash: string; workspaceId: string }>(userId, `
        SELECT v.snapshot_file_id AS "snapshotFileId", v.snapshot_hash AS "snapshotHash",
               v.workspace_id AS "workspaceId"
          FROM office_artifact_versions v
          JOIN office_artifacts a ON a.id=v.artifact_id
         WHERE v.artifact_id=$1 AND v.id=$2 AND a.lifecycle_state='active'
      `, [artifactId, versionId])
      return result.rows[0] ?? null
    },

    async commitVersion(params: {
      userId: string
      artifactId: string
      expectedVersion: number
      snapshotFileId: string
      snapshotHash: string
      operationClock: Uint8Array
      schemaVersion: number
      capabilityVersion: number
      origin: 'manual' | 'ai' | 'import' | 'offline' | 'restore' | 'generation'
      authorType: 'user' | 'assistant' | 'import' | 'system'
      authorUserId?: string
      authorAssistantId?: string
      summary: string
      checkpointKind?: 'named' | 'export' | 'release' | 'generation' | 'revision' | 'restore' | 'template_migration'
    }): Promise<{ id: string; version: number } | null> {
      const result = await db<{ id: string; version: number }>(params.userId, `
        WITH current_head AS (
          SELECT * FROM office_artifacts
           WHERE id = $1 AND head_version = $2 AND lifecycle_state = 'active'
           FOR UPDATE
        ), inserted AS (
          INSERT INTO office_artifact_versions
            (artifact_id, workspace_id, version, parent_version_id,
             snapshot_file_id, snapshot_hash, operation_clock, schema_version,
             capability_version, author_type, author_user_id,
             author_assistant_id, origin, summary, checkpoint_kind)
          SELECT id, workspace_id, head_version + 1, head_version_id,
                 $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
            FROM current_head
          RETURNING id, artifact_id, version
        ), advanced AS (
          UPDATE office_artifacts a
             SET head_version_id = i.id, head_version = i.version, updated_at = now()
            FROM inserted i WHERE a.id = i.artifact_id
          RETURNING i.id, i.version
        )
        SELECT id, version::int AS version FROM advanced
      `, [params.artifactId, params.expectedVersion, params.snapshotFileId, params.snapshotHash, Buffer.from(params.operationClock), params.schemaVersion, params.capabilityVersion, params.authorType, params.authorUserId ?? null, params.authorAssistantId ?? null, params.origin, params.summary, params.checkpointKind ?? null])
      return result.rows[0] ?? null
    },

    async restoreVersion(params: {
      userId: string
      artifactId: string
      targetVersionId: string
      expectedVersion: number
      summary: string
      liveUpdate: Uint8Array
      liveStateVector: Uint8Array
      liveCanonicalHash: string
    }): Promise<{ id: string; version: number } | null> {
      const result = await db<{ id: string; version: number }>(params.userId, `
        WITH current_head AS (
          SELECT * FROM office_artifacts
           WHERE id = $1 AND head_version = $3 AND lifecycle_state = 'active'
           FOR UPDATE
        ), target AS (
          SELECT v.* FROM office_artifact_versions v
          JOIN current_head h ON h.id = v.artifact_id
          WHERE v.id = $2
        ), inserted AS (
          INSERT INTO office_artifact_versions
            (artifact_id, workspace_id, version, parent_version_id,
             snapshot_file_id, snapshot_hash, operation_clock, schema_version,
             capability_version, author_type, author_user_id, origin, summary,
             checkpoint_kind)
          SELECT h.id, h.workspace_id, h.head_version + 1, h.head_version_id,
                 t.snapshot_file_id, t.snapshot_hash, t.operation_clock,
                 t.schema_version, t.capability_version, 'user', $4, 'restore',
                 $5, 'restore'
            FROM current_head h CROSS JOIN target t
          RETURNING id, artifact_id, workspace_id, version
        ), live AS (
          INSERT INTO office_collab_documents
            (artifact_id,workspace_id,ydoc,state_vector,canonical_hash,base_version,seq)
          SELECT i.artifact_id,i.workspace_id,$6,$7,$8,i.version,1 FROM inserted i
          ON CONFLICT (artifact_id) DO UPDATE SET
            ydoc=EXCLUDED.ydoc,state_vector=EXCLUDED.state_vector,
            canonical_hash=EXCLUDED.canonical_hash,base_version=EXCLUDED.base_version,
            seq=office_collab_documents.seq+1,updated_at=now()
          RETURNING artifact_id
        ), advanced AS (
          UPDATE office_artifacts a
             SET head_version_id = i.id, head_version = i.version, updated_at = now()
            FROM inserted i WHERE a.id = i.artifact_id
          RETURNING i.id, i.version
        )
        SELECT a.id, a.version::int AS version FROM advanced a
        JOIN live l ON l.artifact_id=$1
      `, [params.artifactId, params.targetVersionId, params.expectedVersion, params.userId, params.summary, Buffer.from(params.liveUpdate), Buffer.from(params.liveStateVector), params.liveCanonicalHash])
      return result.rows[0] ?? null
    },

    async setGrant(params: { userId: string; artifactId: string; workspaceId: string; targetUserId: string; role: 'view' | 'comment' | 'edit' | 'deny'; reason?: string }): Promise<void> {
      await db(params.userId, `
        INSERT INTO office_artifact_grants
          (artifact_id, workspace_id, user_id, role, granted_by, elevation_reason)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (artifact_id, user_id) DO UPDATE SET
          role = EXCLUDED.role, granted_by = EXCLUDED.granted_by,
          elevation_reason = EXCLUDED.elevation_reason,
          granted_at = now(), revoked_at = NULL
      `, [params.artifactId, params.workspaceId, params.targetUserId, params.role, params.userId, params.reason ?? null])
    },

    async addSource(params: { userId: string; artifactId: string; artifactVersionId: string; workspaceId: string; sourceArtifactId: string; sourceVersion: string; sensitivity: 'public' | 'internal' | 'confidential' }): Promise<void> {
      await db(params.userId, `
        INSERT INTO office_artifact_sources
          (artifact_id,artifact_version_id,workspace_id,source_kind,source_id,source_version,sensitivity)
        VALUES ($1,$2,$3,'artifact',$4,$5,$6)
        ON CONFLICT (artifact_version_id,source_kind,source_id,source_version) DO NOTHING
      `, [params.artifactId, params.artifactVersionId, params.workspaceId, params.sourceArtifactId, params.sourceVersion, params.sensitivity])
    },

    async transitionLifecycle(params: { userId: string; artifactId: string; action: 'archive' | 'unarchive' | 'trash' | 'restore' | 'retain' | 'purge'; reason: string }): Promise<OfficeArtifactRow | null> {
      const result = await db<OfficeArtifactRow>(params.userId, `
        WITH candidate AS (
          SELECT * FROM office_artifacts
           WHERE id=$1 AND legal_hold=FALSE AND (
             ($2='archive' AND lifecycle_state='active') OR
             ($2='unarchive' AND lifecycle_state='archived') OR
             ($2='trash' AND lifecycle_state IN ('active','archived')) OR
             ($2='restore' AND lifecycle_state IN ('trash','retained')) OR
             ($2='retain' AND lifecycle_state='trash' AND retain_at <= now()) OR
             ($2='purge' AND lifecycle_state IN ('trash','retained'))
           ) FOR UPDATE
        ), updated AS (
          UPDATE office_artifacts a SET
            lifecycle_state=CASE $2
              WHEN 'archive' THEN 'archived' WHEN 'unarchive' THEN 'active'
              WHEN 'trash' THEN 'trash' WHEN 'restore' THEN 'active'
              WHEN 'retain' THEN 'retained' WHEN 'purge' THEN 'purged' END,
            archived_at=CASE WHEN $2='archive' THEN now() WHEN $2 IN ('unarchive','restore') THEN NULL ELSE a.archived_at END,
            trashed_at=CASE WHEN $2='trash' THEN now() WHEN $2='restore' THEN NULL ELSE a.trashed_at END,
            retain_at=CASE WHEN $2='trash' THEN now()+interval '30 days' WHEN $2='restore' THEN NULL ELSE a.retain_at END,
            purge_at=CASE WHEN $2='trash' THEN now()+interval '60 days' WHEN $2='restore' THEN NULL ELSE a.purge_at END,
            updated_at=now()
          FROM candidate c WHERE a.id=c.id
          RETURNING a.*, c.lifecycle_state AS prior_state
        ), audited AS (
          INSERT INTO office_audit_events(workspace_id,artifact_id,actor_user_id,event_type,artifact_version,reason,metadata)
          SELECT workspace_id,id,$3,'office.lifecycle.'||$2,head_version,$4,jsonb_build_object('priorState',prior_state,'nextState',lifecycle_state)
          FROM updated
        )
        SELECT id, workspace_id AS "workspaceId", family, mode, title,
               creator_user_id AS "creatorUserId", owner_user_id AS "ownerUserId",
               template_version_id AS "templateVersionId", head_version_id AS "headVersionId",
               head_version::int AS "headVersion", capability_version AS "capabilityVersion",
               sensitivity,lifecycle_state AS "lifecycleState",updated_at AS "updatedAt"
          FROM updated
      `, [params.artifactId, params.action, params.userId, params.reason])
      return result.rows[0] ?? null
    },
  }
}

export const officeArtifactStore = createOfficeArtifactStore()
