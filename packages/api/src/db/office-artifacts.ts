/** Office artifact/version/source/grant/audit persistence. [COMP:api/office-store] */
import { queryWithRLS, getAppPool, applyRLSGucs, rollbackAndRelease } from './client.js'
import type { PoolClient } from 'pg'
import { admitOfficeShell, officeCreationPolicy, officeProvenanceRequired, type OfficeCreateOptions } from '../workspace-access/office-create-admission.js'
import type { QueryResultRow } from 'pg'
import {officeProjectionQuery} from './office-read-projection.js'

export type OfficeDbQuery = <T>(userId: string, sql: string, params: unknown[]) => Promise<{ rows: T[] }>

export const defaultOfficeDbQuery: OfficeDbQuery = async <T>(userId: string, sql: string, params: unknown[]) => {
  const projection=officeProjectionQuery(userId)
  if(projection)return projection<T>(userId,sql,params)
  const result = await queryWithRLS<T & QueryResultRow>(userId, sql, params)
  return { rows: result.rows as T[] }
}

export type OfficeArtifactRow = {
  id: string
  workspaceId: string
  family: 'document' | 'presentation' | 'spreadsheet' | 'pdf'
  mode: 'artifact' | 'template' | 'session'
  title: string
  creatorUserId: string
  ownerUserId: string
  templateVersionId: string | null
  headVersionId: string | null
  headVersion: number
  capabilityVersion: number
  sensitivity: 'public' | 'internal' | 'confidential'
  compartments: string[]
  projectIds: string[]
  defaultWorkspaceRole: 'view' | 'comment' | 'edit' | 'deny'
  lifecycleState: 'active' | 'archived' | 'trash' | 'retained' | 'purged'
  expiresAt: Date | null
  updatedAt: Date
}

export type DurableOfficeArtifactRow = OfficeArtifactRow & {
  family: 'document' | 'presentation' | 'spreadsheet'
  mode: 'artifact' | 'template'
  defaultWorkspaceRole: 'view' | 'comment' | 'edit'
  expiresAt: null
}

export function isDurableOfficeArtifact(row: OfficeArtifactRow): row is DurableOfficeArtifactRow {
  return row.family !== 'pdf' && row.mode !== 'session' && row.defaultWorkspaceRole !== 'deny' && row.expiresAt === null
}

export function createOfficeArtifactStore(db: OfficeDbQuery = defaultOfficeDbQuery) {
  // The injected query is the existing low-level test seam. Production creation
  // always uses one app-role client; never call the pooling db callback while
  // holding that client, or join an Office read-only projection transaction.
  async function creation<T>(userId: string, write: (query: OfficeDbQuery, client?: PoolClient) => Promise<T>): Promise<T> {
    if (db !== defaultOfficeDbQuery) return write(db)
    if (officeProjectionQuery(userId)) throw new Error('office_creation_in_read_projection')
    const client = await getAppPool().connect()
    try {
      await client.query('BEGIN')
      await applyRLSGucs(client, userId)
      const query: OfficeDbQuery = async <R>(actor: string, sql: string, params: unknown[]) => {
        if (actor !== userId) throw new Error('office_creation_actor_mismatch')
        return { rows: (await client.query(sql, params)).rows as R[] }
      }
      const result = await write(query, client)
      await client.query('COMMIT')
      return result
    } finally { await rollbackAndRelease(client) }
  }
  return {
    async list(userId: string, workspaceId: string, lifecycleState: 'active' | 'archived' | 'trash' | 'retained'): Promise<OfficeArtifactRow[]> {
      const result = await db<OfficeArtifactRow>(userId, `
        SELECT id, workspace_id AS "workspaceId", family, mode, title,
               creator_user_id AS "creatorUserId", owner_user_id AS "ownerUserId",
               template_version_id AS "templateVersionId",
               head_version_id AS "headVersionId", head_version::int AS "headVersion",
               capability_version AS "capabilityVersion", sensitivity,
               compartments, project_ids AS "projectIds",
               default_workspace_role AS "defaultWorkspaceRole",
               lifecycle_state AS "lifecycleState", expires_at AS "expiresAt",
               updated_at AS "updatedAt"
          FROM office_artifacts
         WHERE workspace_id = $1 AND lifecycle_state = $2
           AND mode = 'artifact'
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
      projectIds?: string[]
    }, options?: OfficeCreateOptions): Promise<OfficeArtifactRow> {
      return creation(params.userId, async (query, client) => {
        if (client) params = await admitOfficeShell(client, params, options)
        const result = await query<OfficeArtifactRow & { visibilityUserIds: string[] }>(params.userId, `
          INSERT INTO office_artifacts
            (workspace_id, family, mode, title, creator_user_id, owner_user_id,
             template_version_id, capability_version, sensitivity,
             visibility_user_ids, compartments, project_ids)
          VALUES ($1,$2,$11,$3,$4,$4,$5,$6,$7,$8::uuid[],$9::text[],$10::uuid[])
          RETURNING id, workspace_id AS "workspaceId", family, mode, title,
                    creator_user_id AS "creatorUserId", owner_user_id AS "ownerUserId",
                    template_version_id AS "templateVersionId",
                    head_version_id AS "headVersionId", head_version::int AS "headVersion",
                    capability_version AS "capabilityVersion", sensitivity,
                    compartments, project_ids AS "projectIds", visibility_user_ids AS "visibilityUserIds",
                    default_workspace_role AS "defaultWorkspaceRole",
                    lifecycle_state AS "lifecycleState", expires_at AS "expiresAt",
                    updated_at AS "updatedAt"
        `, [params.workspaceId, params.family, params.title, params.userId, params.templateVersionId, params.capabilityVersion, params.sensitivity, params.visibilityUserIds ?? [], params.requiredCompartments ?? [], params.projectIds ?? [], params.mode ?? 'artifact'])
        const persisted = result.rows[0]
        if (!persisted) throw new Error('Office artifact shell insert returned no row')
        const { visibilityUserIds, ...row } = persisted
        if (client) {
          const same = (a: string[], b: string[]) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort())
          if (row.workspaceId !== params.workspaceId || row.sensitivity !== params.sensitivity
            || !same(row.compartments, params.requiredCompartments ?? [])
            || !same(row.projectIds, params.projectIds ?? [])
            || !same(visibilityUserIds, params.visibilityUserIds ?? [])) throw new Error('office_admission_persistence_mismatch')
        }
        return row
      })
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

    async createCopiedArtifact(params: {
      userId: string
      artifactId: string
      versionId: string
      workspaceId: string
      family: 'document' | 'presentation' | 'spreadsheet'
      title: string
      templateVersionId: string | null
      capabilityVersion: number
      sensitivity: 'public' | 'internal' | 'confidential'
      compartments: string[]
      projectIds: string[]
      snapshotFileId: string
      snapshotHash: string
      operationClock: Uint8Array
      schemaVersion: number
      snapshotCapabilityVersion: number
      liveUpdate: Uint8Array
      liveStateVector: Uint8Array
      sourceArtifactId: string
      sourceVersionId: string
    }): Promise<{ id: string; version: number } | null> {
      return creation(params.userId, async (query, client) => {
        if (client) {
          const policy = await officeCreationPolicy(client, params.workspaceId)
          // The current copy CTE trusts caller labels and does not validate/lock
          // transitive source, snapshot-file and visibility evidence. Preserve it
          // for legacy only. Never default this derived artifact in ready mode.
          if (policy?.setupState === 'ready') officeProvenanceRequired()
        }
        const result=await query<{id:string;version:number}>(params.userId,`
          WITH artifact AS (
            INSERT INTO office_artifacts
              (id,workspace_id,family,mode,title,creator_user_id,owner_user_id,
               template_version_id,head_version_id,head_version,capability_version,
               sensitivity,compartments,project_ids)
            VALUES ($1,$3,$4,'artifact',$5,$6,$6,$7,$2,1,$8,$9,$10::text[],$11::uuid[])
            RETURNING id,workspace_id
          ), version AS (
            INSERT INTO office_artifact_versions
              (id,artifact_id,workspace_id,version,parent_version_id,snapshot_file_id,
               snapshot_hash,operation_clock,schema_version,capability_version,
               author_type,author_user_id,origin,summary,named,checkpoint_kind)
            SELECT $2,id,workspace_id,1,NULL,$12,$13,$14,$15,$16,'user',$6,'manual',$21,TRUE,'named'
              FROM artifact
            RETURNING id,artifact_id,workspace_id,version
          ), live AS (
            INSERT INTO office_collab_documents
              (artifact_id,workspace_id,ydoc,state_vector,canonical_hash,base_version,seq)
            SELECT artifact_id,workspace_id,$17,$18,$13,version,1 FROM version
            RETURNING artifact_id
          ), source AS (
            INSERT INTO office_artifact_sources
              (artifact_id,artifact_version_id,workspace_id,source_kind,source_id,source_version,sensitivity)
            SELECT artifact_id,id,workspace_id,'artifact',$19,$20,$9 FROM version
            RETURNING artifact_id
          )
          SELECT v.id,v.version::int AS version FROM version v
            JOIN live l ON l.artifact_id=v.artifact_id
            JOIN source s ON s.artifact_id=v.artifact_id
        `,[params.artifactId,params.versionId,params.workspaceId,params.family,params.title,params.userId,
          params.templateVersionId,params.capabilityVersion,params.sensitivity,
          params.compartments,params.projectIds,params.snapshotFileId,params.snapshotHash,
          Buffer.from(params.operationClock),params.schemaVersion,params.snapshotCapabilityVersion,
          Buffer.from(params.liveUpdate),Buffer.from(params.liveStateVector),params.sourceArtifactId,
          params.sourceVersionId,`Copied from version ${params.sourceVersionId}`])
        return result.rows[0]??null
      })
    },

    async get(userId: string, artifactId: string): Promise<OfficeArtifactRow | null> {
      const result = await db<OfficeArtifactRow>(userId, `
        SELECT id, workspace_id AS "workspaceId", family, mode, title,
               creator_user_id AS "creatorUserId", owner_user_id AS "ownerUserId",
               template_version_id AS "templateVersionId",
               head_version_id AS "headVersionId", head_version::int AS "headVersion",
               capability_version AS "capabilityVersion", sensitivity,
               compartments, project_ids AS "projectIds",
               default_workspace_role AS "defaultWorkspaceRole",
               lifecycle_state AS "lifecycleState", expires_at AS "expiresAt",
               updated_at AS "updatedAt"
          FROM office_artifacts WHERE id = $1
      `, [artifactId])
      return result.rows[0] ?? null
    },

    async raiseScope(params: {
      userId: string
      artifactId: string
      sensitivity: 'public' | 'internal' | 'confidential'
      compartments: string[]
      projectIds: string[]
    }): Promise<boolean> {
      const result = await db<{ id: string }>(params.userId, `
        UPDATE office_artifacts
           SET sensitivity = CASE
                 WHEN sensitivity_rank(sensitivity) >= sensitivity_rank($2) THEN sensitivity
                 ELSE $2 END,
               compartments = ARRAY(
                 SELECT DISTINCT value FROM unnest(compartments || $3::text[]) AS u(value)
                 ORDER BY value
               ),
               project_ids = ARRAY(
                 SELECT DISTINCT value FROM unnest(project_ids || $4::uuid[]) AS u(value)
                 ORDER BY value
               ),
               updated_at = now()
         WHERE id = $1
         RETURNING id
      `, [params.artifactId, params.sensitivity, params.compartments, params.projectIds])
      return result.rows.length === 1
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
          JOIN workspace_files f ON f.id=v.snapshot_file_id
         WHERE v.artifact_id=$1 AND v.id=$2 AND a.lifecycle_state<>'purged'
      `, [artifactId, versionId])
      return result.rows[0] ?? null
    },

    async nameVersion(params: { userId: string; artifactId: string; versionId: string; summary: string }): Promise<boolean> {
      const result = await db<{ id: string }>(params.userId, `
        UPDATE office_artifact_versions
           SET summary=$3,named=TRUE,checkpoint_kind='named'
         WHERE artifact_id=$1 AND id=$2
         RETURNING id
      `, [params.artifactId, params.versionId, params.summary])
      return result.rows.length === 1
    },

    async listGrants(userId: string, artifactId: string): Promise<Array<{ userId: string; role: 'view' | 'comment' | 'edit' | 'deny'; revokedAt: Date | null }>> {
      const result = await db<{ userId: string; role: 'view' | 'comment' | 'edit' | 'deny'; revokedAt: Date | null }>(userId, `
        SELECT user_id AS "userId",role,revoked_at AS "revokedAt"
          FROM office_artifact_grants
         WHERE artifact_id=$1
         ORDER BY granted_at DESC
      `, [artifactId])
      return result.rows
    },

    async commitVersion(params: {
      userId: string
      artifactId: string
      snapshotTitle: string
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
             SET head_version_id = i.id, head_version = i.version, title = $14, updated_at = now()
            FROM inserted i WHERE a.id = i.artifact_id
          RETURNING i.id, i.version
        )
        SELECT id, version::int AS version FROM advanced
      `, [params.artifactId, params.expectedVersion, params.snapshotFileId, params.snapshotHash, Buffer.from(params.operationClock), params.schemaVersion, params.capabilityVersion, params.authorType, params.authorUserId ?? null, params.authorAssistantId ?? null, params.origin, params.summary, params.checkpointKind ?? null, params.snapshotTitle])
      return result.rows[0] ?? null
    },

    /** Persist a real version-zero anchor without rebasing connected Y.Docs. */
    async anchorDraft(params: {
      userId: string; artifactId: string; expectedSeq: number; expectedUpdate: Uint8Array;
      snapshotFileId: string; snapshotHash: string; operationClock: Uint8Array;
      schemaVersion: number; capabilityVersion: number;
    }): Promise<{ id: string } | null> {
      const result = await db<{ id: string }>(params.userId, `
        WITH draft AS (
          SELECT a.id, a.workspace_id FROM office_artifacts a
          JOIN office_collab_documents d ON d.artifact_id=a.id
          WHERE a.id=$1 AND a.head_version=0 AND a.head_version_id IS NULL
            AND a.lifecycle_state='active' AND a.mode IN ('artifact','template')
            AND d.base_version=0 AND d.seq=$2 AND d.ydoc=$9
          FOR UPDATE OF a, d
        ), version AS (
          INSERT INTO office_artifact_versions
            (artifact_id,workspace_id,version,snapshot_file_id,snapshot_hash,
             operation_clock,schema_version,capability_version,
             author_type,author_user_id,origin,summary)
          SELECT id,workspace_id,0,$3,$4,$5,$6,$7,'user',$8,'manual',
                 'Initial draft comment anchor' FROM draft
          RETURNING id,artifact_id
        )
        UPDATE office_artifacts a SET head_version_id=v.id
          FROM version v WHERE a.id=v.artifact_id RETURNING v.id
      `, [params.artifactId, params.expectedSeq, params.snapshotFileId,
        params.snapshotHash, Buffer.from(params.operationClock), params.schemaVersion,
        params.capabilityVersion, params.userId, Buffer.from(params.expectedUpdate)])
      return result.rows[0] ?? null
    },

    async restoreVersion(params: {
      userId: string
      artifactId: string
      snapshotTitle: string
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
             SET head_version_id = i.id, head_version = i.version, title = $9, updated_at = now()
            FROM inserted i WHERE a.id = i.artifact_id
          RETURNING i.id, i.version
        )
        SELECT a.id, a.version::int AS version FROM advanced a
        JOIN live l ON l.artifact_id=$1
      `, [params.artifactId, params.targetVersionId, params.expectedVersion, params.userId, params.summary, Buffer.from(params.liveUpdate), Buffer.from(params.liveStateVector), params.liveCanonicalHash, params.snapshotTitle])
      return result.rows[0] ?? null
    },

    async setGrant(params: { userId: string; artifactId: string; workspaceId: string; targetUserId: string; role: 'view' | 'comment' | 'edit' | 'deny'; reason?: string }): Promise<boolean> {
      const result=await db<{artifactId:string}>(params.userId, `
        INSERT INTO office_artifact_grants
          (artifact_id, workspace_id, user_id, role, granted_by, elevation_reason)
        SELECT a.id,a.workspace_id,target.user_id,$4,$5,$6
          FROM office_artifacts a
          JOIN workspace_members target ON target.workspace_id=a.workspace_id AND target.user_id=$3
         WHERE a.id=$1 AND a.workspace_id=$2 AND a.owner_user_id<>target.user_id
        ON CONFLICT (artifact_id, user_id) DO UPDATE SET
          role = EXCLUDED.role, granted_by = EXCLUDED.granted_by,
          elevation_reason = EXCLUDED.elevation_reason,
          granted_at = now(), revoked_at = NULL
        RETURNING artifact_id AS "artifactId"
      `, [params.artifactId, params.workspaceId, params.targetUserId, params.role, params.userId, params.reason ?? null])
      return result.rows.length===1
    },

    async revokeGrant(params: { userId: string; artifactId: string; targetUserId: string }): Promise<boolean> {
      const result = await db<{ artifactId: string }>(params.userId, `
        UPDATE office_artifact_grants SET revoked_at=now()
         WHERE artifact_id=$1 AND user_id=$2 AND revoked_at IS NULL
         RETURNING artifact_id AS "artifactId"
      `, [params.artifactId, params.targetUserId])
      return result.rows.length === 1
    },

    async setDefaultWorkspaceRole(params: { userId: string; artifactId: string; role: 'view' | 'comment' | 'edit' }): Promise<boolean> {
      const result = await db<{ id: string }>(params.userId, `
        UPDATE office_artifacts SET default_workspace_role=$2,updated_at=now()
         WHERE id=$1 AND lifecycle_state='active'
         RETURNING id
      `, [params.artifactId, params.role])
      return result.rows.length === 1
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
           WHERE id=$1 AND legal_hold=FALSE
             -- Linked drafts are governed atomically by their template registry.
             AND NOT EXISTS (SELECT 1 FROM office_templates t WHERE t.draft_artifact_id=office_artifacts.id)
             AND (
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
               sensitivity,default_workspace_role AS "defaultWorkspaceRole",
               lifecycle_state AS "lifecycleState",updated_at AS "updatedAt"
          FROM updated
      `, [params.artifactId, params.action, params.userId, params.reason])
      return result.rows[0] ?? null
    },
  }
}

export const officeArtifactStore = createOfficeArtifactStore()
