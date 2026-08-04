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
  family: 'document' | 'presentation'
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
    async createShell(params: {
      userId: string
      workspaceId: string
      family: 'document' | 'presentation'
      title: string
      templateVersionId: string | null
      capabilityVersion: number
      sensitivity: 'public' | 'internal' | 'confidential'
      visibilityUserIds?: string[]
      requiredCompartments?: string[]
    }): Promise<OfficeArtifactRow> {
      const result = await db<OfficeArtifactRow>(params.userId, `
        INSERT INTO office_artifacts
          (workspace_id, family, title, creator_user_id, owner_user_id,
           template_version_id, capability_version, sensitivity,
           visibility_user_ids, required_compartments)
        VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8::uuid[],$9::text[])
        RETURNING id, workspace_id AS "workspaceId", family, mode, title,
                  creator_user_id AS "creatorUserId", owner_user_id AS "ownerUserId",
                  template_version_id AS "templateVersionId",
                  head_version_id AS "headVersionId", head_version AS "headVersion",
                  capability_version AS "capabilityVersion", sensitivity,
                  lifecycle_state AS "lifecycleState", updated_at AS "updatedAt"
      `, [params.workspaceId, params.family, params.title, params.userId, params.templateVersionId, params.capabilityVersion, params.sensitivity, params.visibilityUserIds ?? [], params.requiredCompartments ?? []])
      const row = result.rows[0]
      if (!row) throw new Error('Office artifact shell insert returned no row')
      return row
    },

    async get(userId: string, artifactId: string): Promise<OfficeArtifactRow | null> {
      const result = await db<OfficeArtifactRow>(userId, `
        SELECT id, workspace_id AS "workspaceId", family, mode, title,
               creator_user_id AS "creatorUserId", owner_user_id AS "ownerUserId",
               template_version_id AS "templateVersionId",
               head_version_id AS "headVersionId", head_version AS "headVersion",
               capability_version AS "capabilityVersion", sensitivity,
               lifecycle_state AS "lifecycleState", updated_at AS "updatedAt"
          FROM office_artifacts WHERE id = $1
      `, [artifactId])
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
          RETURNING id, artifact_id, version
        ), advanced AS (
          UPDATE office_artifacts a
             SET head_version_id = i.id, head_version = i.version, updated_at = now()
            FROM inserted i WHERE a.id = i.artifact_id
          RETURNING i.id, i.version
        )
        SELECT id, version::int AS version FROM advanced
      `, [params.artifactId, params.targetVersionId, params.expectedVersion, params.userId, params.summary])
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
  }
}

export const officeArtifactStore = createOfficeArtifactStore()
