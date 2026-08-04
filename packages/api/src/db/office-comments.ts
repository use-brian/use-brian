/** Office semantic/spatial discussion and suggestion store. [COMP:api/office-store] */
import { defaultOfficeDbQuery, type OfficeDbQuery } from './office-artifacts.js'

export type OfficeCommentAnchor = {
  kind: 'text_range' | 'block' | 'table_cell' | 'slide' | 'object' | 'chart_datum' | 'note_range' | 'point' | 'region'
  targetIds: string[]
  range?: { from: number; to: number }
  geometry?: { x: number; y: number; width?: number; height?: number }
}

export function createOfficeCommentStore(db: OfficeDbQuery = defaultOfficeDbQuery) {
  return {
    async createThread(params: { userId: string; workspaceId: string; artifactId: string; artifactVersionId: string; anchor: OfficeCommentAnchor; snapshotFileId?: string; body: string; mentions?: string[]; brianTriggerKey?: string }): Promise<{ threadId: string; messageId: string }> {
      const result = await db<{ threadId: string; messageId: string }>(params.userId, `
        WITH thread AS (
          INSERT INTO office_comment_threads
            (artifact_id, workspace_id, artifact_version_id, anchor_kind,
             anchor, geometry, target_snapshot_file_id, created_by,
             last_valid_version_id)
          VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$3)
          RETURNING id
        ), message AS (
          INSERT INTO office_comment_messages
            (thread_id, workspace_id, author_type, author_user_id, body,
             mentions, brian_trigger_key,
             brian_run_status)
          SELECT id,$2,'user',$8,$9,$10::uuid[],$11,
                 CASE WHEN $11 IS NULL THEN NULL ELSE 'queued' END
            FROM thread RETURNING id, thread_id
        )
        SELECT thread_id AS "threadId", id AS "messageId" FROM message
      `, [params.artifactId, params.workspaceId, params.artifactVersionId, params.anchor.kind, JSON.stringify(params.anchor), params.anchor.geometry ? JSON.stringify(params.anchor.geometry) : null, params.snapshotFileId ?? null, params.userId, params.body, params.mentions ?? [], params.brianTriggerKey ?? null])
      const row = result.rows[0]
      if (!row) throw new Error('Office comment transaction returned no row')
      return row
    },

    async reply(params: { userId: string; workspaceId: string; threadId: string; body: string; mentions?: string[]; brianTriggerKey?: string }): Promise<{ id: string } | null> {
      const result = await db<{ id: string }>(params.userId, `
        INSERT INTO office_comment_messages
          (thread_id, workspace_id, author_type, author_user_id, body,
           mentions, brian_trigger_key, brian_run_status)
        SELECT $1,$2,'user',$3,$4,$5::uuid[],$6,
               CASE WHEN $6 IS NULL THEN NULL ELSE 'queued' END
         WHERE EXISTS (SELECT 1 FROM office_comment_threads WHERE id = $1 AND status <> 'detached')
        ON CONFLICT (thread_id, brian_trigger_key) DO NOTHING
        RETURNING id
      `, [params.threadId, params.workspaceId, params.userId, params.body, params.mentions ?? [], params.brianTriggerKey ?? null])
      return result.rows[0] ?? null
    },

    async resolve(params: { userId: string; threadId: string; resolved: boolean }): Promise<boolean> {
      const result = await db<{ id: string }>(params.userId, `
        UPDATE office_comment_threads
           SET status = $2, resolved_by = CASE WHEN $2 = 'resolved' THEN $3::uuid END,
               resolved_at = CASE WHEN $2 = 'resolved' THEN now() END,
               updated_at = now()
         WHERE id = $1 RETURNING id
      `, [params.threadId, params.resolved ? 'resolved' : 'open', params.userId])
      return result.rows.length === 1
    },

    async detachMissingTargets(params: { userId: string; artifactId: string; validTargetIds: string[] }): Promise<number> {
      const result = await db<{ id: string }>(params.userId, `
        UPDATE office_comment_threads
           SET status = 'detached', detached_at = now(), updated_at = now()
         WHERE artifact_id = $1 AND status <> 'detached'
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(anchor->'targetIds') target
              WHERE NOT (target = ANY($2::text[]))
           )
        RETURNING id
      `, [params.artifactId, params.validTargetIds])
      return result.rows.length
    },
  }
}

export const officeCommentStore = createOfficeCommentStore()
