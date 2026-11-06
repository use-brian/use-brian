/** Office semantic/spatial discussion and suggestion store. [COMP:api/office-store] */
import { defaultOfficeDbQuery, type OfficeDbQuery } from './office-artifacts.js'
import type { WorkspaceCredentialDelegation } from '@use-brian/core'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'

export type OfficeCommentAnchor = {
  kind: 'text_range' | 'block' | 'table_cell' | 'slide' | 'object' | 'chart_datum' | 'note_range' | 'point' | 'region'
  targetIds: string[]
  range?: { from: number; to: number }
  relative?: { from: Record<string, unknown>; to: Record<string, unknown> }
  geometry?: { x: number; y: number; width?: number; height?: number }
}

type CommentMutationAuthority = {
  userId: string; threadId: string; artifactId?: string; actorAssistantId?: string;
  workspaceDelegation?: WorkspaceCredentialDelegation; admissionObservationId?: string; sharedAudience?: boolean;
}

export function createOfficeCommentStore(db: OfficeDbQuery = defaultOfficeDbQuery) {
  async function mutateThread(params: CommentMutationAuthority & ({ resolved: boolean } | { assignedUserId: string | null; assignedToBrian: boolean; dueAt: string | null })): Promise<boolean> {
    const result = await db<{ id: string; workspace_id: string; artifact_id: string }>(params.userId, `
      WITH root AS (
        SELECT a.id,a.workspace_id,a.head_version FROM office_artifacts a
        JOIN office_comment_threads t ON t.artifact_id=a.id AND t.workspace_id=a.workspace_id
        WHERE t.id=$1 AND ($4::uuid IS NULL OR a.id=$4) AND a.lifecycle_state='active'
          AND ($9::text <> 'assign' OR $10::uuid IS NULL OR EXISTS (
            SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=a.workspace_id AND wm.user_id=$10::uuid))
          AND office_artifact_scope_allows(a.id,a.workspace_id,true)
          AND coalesce((SELECT role FROM office_artifact_grants g WHERE g.artifact_id=a.id
            AND g.user_id=$3::uuid AND g.revoked_at IS NULL),
            CASE WHEN $3::uuid IN(a.creator_user_id,a.owner_user_id) THEN 'edit' ELSE a.default_workspace_role END) IN('comment','edit')
          AND ($6::jsonb IS NULL OR workspace_mcp_parent_current($6::jsonb))
          AND ($7::uuid IS NULL OR read_office_observation_authority(a.workspace_id,$7::uuid,
            CASE WHEN $8::boolean THEN NULL ELSE $3::uuid END,
            coalesce(nullif(current_setting('app.agent_visibility_assistants',true),''),'null')::jsonb))
        FOR SHARE OF a
      ), updated AS (
        UPDATE office_comment_threads t
           SET status=CASE WHEN $9='resolve' THEN $2 ELSE t.status END,
               resolved_by=CASE WHEN $9='resolve' THEN CASE WHEN $2='resolved' AND $5::uuid IS NULL THEN $3::uuid END ELSE t.resolved_by END,
               resolved_at=CASE WHEN $9='resolve' THEN CASE WHEN $2='resolved' THEN now() END ELSE t.resolved_at END,
               assigned_user_id=CASE WHEN $9='assign' THEN $10::uuid ELSE t.assigned_user_id END,
               assigned_to_brian=CASE WHEN $9='assign' THEN $11::boolean ELSE t.assigned_to_brian END,
               due_at=CASE WHEN $9='assign' THEN $12::timestamptz ELSE t.due_at END,updated_at=now()
          FROM root a WHERE t.id=$1 AND t.artifact_id=a.id AND t.status<>'detached'
          RETURNING t.id,t.artifact_id,t.workspace_id
      ), audited AS (
        INSERT INTO office_audit_events(workspace_id,artifact_id,actor_user_id,actor_assistant_id,event_type,artifact_version,metadata)
        SELECT t.workspace_id,t.artifact_id,CASE WHEN $5::uuid IS NULL THEN $3::uuid END,$5::uuid,
          'office.comment.'||$9::text,a.head_version,CASE WHEN $9='resolve'
            THEN jsonb_build_object('threadId',t.id,'status',$2::text)
            ELSE jsonb_build_object('threadId',t.id,'assignedUserId',$10::uuid,'assignedToBrian',$11::boolean,'dueAt',$12::timestamptz) END
        FROM updated t JOIN root a ON a.id=t.artifact_id
      ) SELECT id,workspace_id,artifact_id FROM updated
    `, [params.threadId, 'resolved' in params ? (params.resolved ? 'resolved' : 'open') : null, params.userId, params.artifactId ?? null,
      params.actorAssistantId ?? null, params.workspaceDelegation ? JSON.stringify(params.workspaceDelegation) : null,
      params.admissionObservationId ?? null, params.sharedAudience ?? false, 'resolved' in params ? 'resolve' : 'assign',
      'assignedUserId' in params ? params.assignedUserId : null,
      'assignedToBrian' in params ? params.assignedToBrian : null, 'dueAt' in params ? params.dueAt : null])
    const changed = result.rows[0]
    if (changed) notifyWorkspaceChange(changed.workspace_id, 'office', 'update', changed.artifact_id)
    return !!changed
  }
  return {
    async listThreads(userId: string, artifactId: string): Promise<Array<Record<string, unknown>>> {
      const result = await db<Record<string, unknown>>(userId, `
        SELECT t.id, t.artifact_version_id AS "artifactVersionId",
               t.anchor_kind AS "anchorKind", t.anchor, t.geometry, t.status,
               t.assigned_user_id AS "assignedUserId", t.assigned_to_brian AS "assignedToBrian",
               t.due_at AS "dueAt", t.created_by AS "createdBy", t.created_at AS "createdAt",
               COALESCE(jsonb_agg(jsonb_build_object(
                 'id', m.id, 'authorType', m.author_type, 'authorUserId', m.author_user_id,
                 'authorAssistantId', m.author_assistant_id, 'body', m.body,
                 'mentions', m.mentions, 'reactions', m.reactions,
                 'brianRunStatus', m.brian_run_status,
                 'createdAt', m.created_at
               ) ORDER BY m.created_at) FILTER (WHERE m.id IS NOT NULL), '[]'::jsonb) AS messages
          FROM office_comment_threads t
          LEFT JOIN office_comment_messages m ON m.thread_id = t.id
         WHERE t.artifact_id = $1
         GROUP BY t.id
         ORDER BY t.created_at DESC
         LIMIT 500
      `, [artifactId])
      return result.rows
    },

    async getThreadContext(userId: string, threadId: string): Promise<{ artifactId: string; workspaceId: string; status: 'open' | 'resolved' | 'detached' } | null> {
      const result = await db<{ artifactId: string; workspaceId: string; status: 'open' | 'resolved' | 'detached' }>(userId, `
        SELECT artifact_id AS "artifactId", workspace_id AS "workspaceId", status
          FROM office_comment_threads WHERE id=$1
      `, [threadId])
      return result.rows[0] ?? null
    },

    async getMessageContext(userId: string, messageId: string): Promise<{ artifactId: string; workspaceId: string } | null> {
      const result = await db<{ artifactId: string; workspaceId: string }>(userId, `
        SELECT t.artifact_id AS "artifactId", t.workspace_id AS "workspaceId"
          FROM office_comment_messages m
          JOIN office_comment_threads t ON t.id=m.thread_id
         WHERE m.id=$1
      `, [messageId])
      return result.rows[0] ?? null
    },

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
          SELECT id,$2,'user',$8,$9,$10::uuid[],$11::text,
                 CASE WHEN $11::text IS NULL THEN NULL ELSE 'queued' END
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
        SELECT $1,$2,'user',$3,$4,$5::uuid[],$6::text,
               CASE WHEN $6::text IS NULL THEN NULL ELSE 'queued' END
         WHERE EXISTS (SELECT 1 FROM office_comment_threads WHERE id = $1 AND status <> 'detached')
        ON CONFLICT (thread_id, brian_trigger_key) DO NOTHING
        RETURNING id
      `, [params.threadId, params.workspaceId, params.userId, params.body, params.mentions ?? [], params.brianTriggerKey ?? null])
      return result.rows[0] ?? null
    },

    resolve: (params: CommentMutationAuthority & { resolved: boolean }) => mutateThread(params),

    updateThread: (params: CommentMutationAuthority & { assignedUserId: string | null; assignedToBrian: boolean; dueAt: string | null }) => mutateThread(params),

    async react(params: { userId: string; messageId: string; reaction: 'thumbs_up' | 'heart' | 'check'; active: boolean }): Promise<boolean> {
      const result = await db<{ id: string }>(params.userId, `
        UPDATE office_comment_messages
           SET reactions = CASE WHEN $4 THEN
             jsonb_set(reactions,$3::text[],to_jsonb(ARRAY(
               SELECT DISTINCT value::uuid FROM (
                 SELECT jsonb_array_elements_text(COALESCE(reactions #> $3::text[],'[]'::jsonb)) AS value
                 UNION ALL SELECT $2::text
               ) members
             )),true)
           ELSE jsonb_set(reactions,$3::text[],to_jsonb(ARRAY(
             SELECT value::uuid FROM jsonb_array_elements_text(COALESCE(reactions #> $3::text[],'[]'::jsonb)) value
              WHERE value <> $2::text
           )),true) END
         WHERE id=$1 RETURNING id
      `, [params.messageId, params.userId, [params.reaction], params.active])
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

    async createSuggestion(params: { userId: string; workspaceId: string; artifactId: string; threadId?: string; baseVersionId: string; proposedByType: 'user' | 'assistant'; proposedByAssistantId?: string; commandBatch: unknown; affectedObjectIds: string[] }): Promise<{ id: string }> {
      const result = await db<{ id: string }>(params.userId, `
        INSERT INTO office_suggestions
          (artifact_id, workspace_id, thread_id, base_version_id,
           proposed_by_type, proposed_by_user_id, proposed_by_assistant_id,
           command_batch, affected_object_ids)
        VALUES ($1,$2,$3,$4,$5,CASE WHEN $5='user' THEN $6::uuid END,$7,$8::jsonb,$9::uuid[])
        RETURNING id
      `, [params.artifactId, params.workspaceId, params.threadId ?? null, params.baseVersionId, params.proposedByType, params.userId, params.proposedByAssistantId ?? null, JSON.stringify(params.commandBatch), params.affectedObjectIds])
      if (!result.rows[0]) throw new Error('Office suggestion insert returned no row')
      return result.rows[0]
    },

    async listSuggestions(userId: string, artifactId: string): Promise<Array<Record<string, unknown>>> {
      const result = await db<Record<string, unknown>>(userId, `
        SELECT id,artifact_id AS "artifactId",thread_id AS "threadId",base_version_id AS "baseVersionId",
               proposed_by_type AS "proposedByType",proposed_by_user_id AS "proposedByUserId",
               proposed_by_assistant_id AS "proposedByAssistantId",command_batch AS "commandBatch",
               affected_object_ids AS "affectedObjectIds",status,decided_by AS "decidedBy",
               decided_at AS "decidedAt",created_at AS "createdAt"
          FROM office_suggestions WHERE artifact_id=$1 ORDER BY created_at DESC LIMIT 500
      `, [artifactId])
      return result.rows
    },

    async getSuggestion(userId: string, suggestionId: string): Promise<{ id: string; artifactId: string; status: 'open' | 'accepted' | 'rejected' | 'superseded' | 'conflicted'; commandBatch: unknown } | null> {
      const result = await db<{ id: string; artifactId: string; status: 'open' | 'accepted' | 'rejected' | 'superseded' | 'conflicted'; commandBatch: unknown }>(userId, `
        SELECT id,artifact_id AS "artifactId",status,command_batch AS "commandBatch"
          FROM office_suggestions WHERE id=$1
      `, [suggestionId])
      return result.rows[0] ?? null
    },

    async decideSuggestion(params: { userId: string; suggestionId: string; decision: 'accepted' | 'rejected' | 'conflicted'; expectedStatus?: 'open' | 'conflicted' }): Promise<boolean> {
      const result = await db<{ id: string }>(params.userId, `
        UPDATE office_suggestions SET status=$2,decided_by=$3,decided_at=now()
         WHERE id=$1 AND status=$4 RETURNING id
      `, [params.suggestionId, params.decision, params.userId, params.expectedStatus ?? 'open'])
      return result.rows.length === 1
    },
  }
}

export const officeCommentStore = createOfficeCommentStore()
