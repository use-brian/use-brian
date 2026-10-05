/** Durable Office job/event/steering store. [COMP:api/office-generation] */
import { OfficeImportDiagnosticSchema, type OfficeImportDiagnostic } from '@use-brian/office-model'
import { APP_LEVEL_ASSISTANT_ID } from '@use-brian/shared'
import { defaultOfficeDbQuery, type OfficeDbQuery } from './office-artifacts.js'

export type OfficeGenerationJobRow = {
  id: string
  workspaceId: string
  artifactId: string
  initiatedByUserId: string
  assistantId: string | null
  jobKind: 'create' | 'revise' | 'import' | 'export' | 'template_compile' | 'derivative'
  status: 'queued' | 'running' | 'needs_input' | 'completed' | 'failed' | 'cancelled'
  stage: string
  brief: unknown
  authorityProjection: unknown
  templateVersionId: string | null
  baseArtifactVersion: number
  checkpoint: unknown
  checkpointVersion: number
  leaseToken: string | null
  leaseExpiresAt: Date | null
  cancelRequestedAt: Date | null
  errorCode: string | null
  createdAt: Date
  updatedAt: Date
}

export type OfficeGenerationEventRow = {
  id: string
  jobId: string
  seq: number
  code: string
  params: Record<string, string | number | boolean>
  actorType: 'user' | 'assistant' | 'system'
  safeNarration: string | null
  createdAt: Date
}

const JOB_COLUMNS = `id, workspace_id AS "workspaceId", artifact_id AS "artifactId",
  initiated_by_user_id AS "initiatedByUserId", assistant_id AS "assistantId",
  job_kind AS "jobKind", status, stage, brief,
  authority_projection AS "authorityProjection",
  template_version_id AS "templateVersionId",
  base_artifact_version::int AS "baseArtifactVersion", checkpoint,
  checkpoint_version AS "checkpointVersion", lease_token AS "leaseToken",
  lease_expires_at AS "leaseExpiresAt", cancel_requested_at AS "cancelRequestedAt",
  error_code AS "errorCode", created_at AS "createdAt", updated_at AS "updatedAt"`

// The lease claim updates through a candidate CTE, so every projected column
// must resolve to the UPDATE target rather than the joined candidate row.
const CLAIMED_JOB_COLUMNS = `j.id, j.workspace_id AS "workspaceId", j.artifact_id AS "artifactId",
  j.initiated_by_user_id AS "initiatedByUserId", j.assistant_id AS "assistantId",
  j.job_kind AS "jobKind", j.status, j.stage, j.brief,
  j.authority_projection AS "authorityProjection",
  j.template_version_id AS "templateVersionId",
  j.base_artifact_version::int AS "baseArtifactVersion", j.checkpoint,
  j.checkpoint_version AS "checkpointVersion", j.lease_token AS "leaseToken",
  j.lease_expires_at AS "leaseExpiresAt", j.cancel_requested_at AS "cancelRequestedAt",
  j.error_code AS "errorCode", j.created_at AS "createdAt", j.updated_at AS "updatedAt"`

export function createOfficeGenerationStore(db: OfficeDbQuery = defaultOfficeDbQuery) {
  return {
    async create(params: { userId: string; workspaceId: string; artifactId: string; assistantId: string | null; jobKind: OfficeGenerationJobRow['jobKind']; brief: unknown; authorityProjection: unknown; templateVersionId?: string; baseArtifactVersion?: number; idempotencyKey: string }): Promise<OfficeGenerationJobRow> {
      const result = await db<OfficeGenerationJobRow>(params.userId, `
        INSERT INTO office_generation_jobs
          (workspace_id, artifact_id, initiated_by_user_id, assistant_id,
           job_kind, brief, authority_projection, template_version_id,
           base_artifact_version, idempotency_key)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)
        ON CONFLICT (workspace_id, initiated_by_user_id, idempotency_key)
        DO UPDATE SET updated_at = office_generation_jobs.updated_at
        RETURNING ${JOB_COLUMNS}
      `, [params.workspaceId, params.artifactId, params.userId, params.assistantId === APP_LEVEL_ASSISTANT_ID ? null : params.assistantId, params.jobKind, JSON.stringify(params.brief), JSON.stringify(params.authorityProjection), params.templateVersionId ?? null, params.baseArtifactVersion ?? 0, params.idempotencyKey])
      if (!result.rows[0]) throw new Error('Office generation job insert returned no row')
      return result.rows[0]
    },

    async retryTemplateImport(params: import('../office/template-import-recovery.js').TemplateImportRetry): Promise<OfficeGenerationJobRow | null> {
      const result = await db<OfficeGenerationJobRow>(params.userId, `
        INSERT INTO office_generation_jobs
          (workspace_id,artifact_id,initiated_by_user_id,assistant_id,job_kind,brief,authority_projection,base_artifact_version,idempotency_key)
        SELECT j.workspace_id,j.artifact_id,$1,COALESCE($6::uuid,j.assistant_id),'template_compile',
          jsonb_set(j.brief,'{source,fileId}',to_jsonb(COALESCE($5::text,j.brief->'source'->>'fileId'))),
          j.authority_projection || jsonb_build_object('retryScope',$7::jsonb),j.base_artifact_version,'template-import-retry:' || j.id::text
        FROM office_generation_jobs j
        JOIN office_artifacts a ON a.id=j.artifact_id
        JOIN office_templates t ON t.draft_artifact_id=a.id AND t.id::text=j.brief->>'templateId'
        JOIN office_collab_documents d ON d.artifact_id=a.id
        WHERE j.id=$4 AND j.workspace_id=$2 AND j.artifact_id=$3 AND j.initiated_by_user_id=$1
          AND j.status IN ('failed','cancelled') AND j.job_kind='template_compile'
          AND j.brief->'source'->>'kind'='upload' AND t.lifecycle_state='draft'
          AND a.lifecycle_state='active' AND a.head_version=0 AND d.seq=1
          AND NOT EXISTS (SELECT 1 FROM office_generation_jobs later WHERE later.artifact_id=a.id
            AND later.created_at>j.created_at AND later.idempotency_key<>'template-import-retry:' || j.id::text)
        ON CONFLICT (workspace_id,initiated_by_user_id,idempotency_key)
          DO UPDATE SET updated_at=office_generation_jobs.updated_at
          WHERE office_generation_jobs.brief=EXCLUDED.brief
        RETURNING ${JOB_COLUMNS}
      `, [params.userId, params.workspaceId, params.artifactId, params.failedJobId, params.fileId ?? null, params.assistantId === APP_LEVEL_ASSISTANT_ID ? null : params.assistantId ?? null, JSON.stringify({ clearance: params.clearance, compartmentGrant: params.compartmentGrant ?? null, projectGrant: params.projectGrant ?? null })])
      return result.rows[0] ?? null
    },

    async get(userId: string, jobId: string): Promise<OfficeGenerationJobRow | null> {
      const result = await db<OfficeGenerationJobRow>(userId, `SELECT ${JOB_COLUMNS} FROM office_generation_jobs WHERE id = $1`, [jobId])
      return result.rows[0] ?? null
    },

    async latestForArtifact(userId: string, artifactId: string): Promise<OfficeGenerationJobRow | null> {
      const result = await db<OfficeGenerationJobRow>(userId, `SELECT ${JOB_COLUMNS} FROM office_generation_jobs WHERE artifact_id = $1 ORDER BY created_at DESC LIMIT 1`, [artifactId])
      return result.rows[0] ?? null
    },

    async claim(params: { userId: string; leaseToken: string; leaseMs: number; jobKinds?: OfficeGenerationJobRow['jobKind'][] }): Promise<OfficeGenerationJobRow | null> {
      const result = await db<OfficeGenerationJobRow>(params.userId, `
        WITH candidate AS (
          SELECT id FROM office_generation_jobs pending
           WHERE job_kind = ANY($3::text[]) AND status IN ('queued','running') AND cancel_requested_at IS NULL
             AND next_attempt_at <= now()
             AND (authority_projection->'creationBinding'->>'protocol' IS DISTINCT FROM 'office_prompt_only_v1'
               OR (initiated_by_user_id=$4::uuid AND EXISTS (
                 SELECT 1 FROM auth_sessions s JOIN users u ON u.id=s.user_id
                   WHERE s.id::text=pending.authority_projection->'creationBinding'->>'authSessionId'
                     AND s.user_id=pending.initiated_by_user_id AND s.revoked_at IS NULL
                     AND s.expires_at>clock_timestamp() AND s.auth_version=u.auth_version)
                 AND EXISTS (
                 SELECT 1 FROM office_artifacts a WHERE a.id=pending.artifact_id AND a.workspace_id=pending.workspace_id
                   AND a.lifecycle_state='active'
                   AND office_artifact_scope_allows(a.id,a.workspace_id,true)
                   AND to_jsonb(a.compartments)=authority_projection->'compartments'
                   AND to_jsonb(a.project_ids)=authority_projection->'projectIds'
                   AND a.sensitivity=authority_projection->>'sensitivity'
                   AND to_jsonb(a.visibility_user_ids)=authority_projection->'visibilityUserIds')))
             AND (lease_expires_at IS NULL OR lease_expires_at < now())
           ORDER BY next_attempt_at, created_at
           FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE office_generation_jobs j
           SET status = 'running', lease_token = $1,
               lease_expires_at = now() + ($2::text || ' milliseconds')::interval,
               attempt = attempt + 1, started_at = COALESCE(started_at, now()),
               updated_at = now()
          FROM candidate c WHERE j.id = c.id
        RETURNING ${CLAIMED_JOB_COLUMNS}
      `, [params.leaseToken, params.leaseMs, params.jobKinds ?? ['create'], params.userId])
      return result.rows[0] ?? null
    },

    async checkpoint(params: { userId: string; jobId: string; leaseToken: string; stage: string; expectedVersion: number; checkpoint: unknown; status?: OfficeGenerationJobRow['status'] }): Promise<boolean> {
      const result = await db<{ id: string }>(params.userId, `
        UPDATE office_generation_jobs SET
          stage = $4, checkpoint = $5::jsonb,
          checkpoint_version = checkpoint_version + 1,
          status = COALESCE($6, status), updated_at = now()
        WHERE id = $1 AND lease_token = $2 AND checkpoint_version = $3
          AND lease_expires_at > now()
        RETURNING id
      `, [params.jobId, params.leaseToken, params.expectedVersion, params.stage, JSON.stringify(params.checkpoint), params.status ?? null])
      return result.rows.length === 1
    },

    async appendEvent(params: { userId: string; jobId: string; workspaceId: string; code: string; values: Record<string, string | number | boolean>; actorType: 'user' | 'assistant' | 'system'; actorUserId?: string; actorAssistantId?: string; safeNarration?: string }): Promise<OfficeGenerationEventRow> {
      const result = await db<OfficeGenerationEventRow>(params.userId, `
        INSERT INTO office_generation_events
          (job_id, workspace_id, seq, code, params, actor_type,
           actor_user_id, actor_assistant_id, safe_narration)
        SELECT $1,$2,COALESCE(max(seq),0)+1,$3,$4::jsonb,$5,$6,$7,$8
          FROM office_generation_events WHERE job_id = $1
        RETURNING id, job_id AS "jobId", seq::int, code, params,
                  actor_type AS "actorType", safe_narration AS "safeNarration",
                  created_at AS "createdAt"
      `, [params.jobId, params.workspaceId, params.code, JSON.stringify(params.values), params.actorType, params.actorUserId ?? null, params.actorAssistantId ?? null, params.safeNarration ?? null])
      if (!result.rows[0]) throw new Error('Office generation event insert returned no row')
      return result.rows[0]
    },

    async listEvents(userId: string, jobId: string, afterSeq = 0): Promise<OfficeGenerationEventRow[]> {
      const result = await db<OfficeGenerationEventRow>(userId, `
        SELECT id, job_id AS "jobId", seq::int, code, params,
               actor_type AS "actorType", safe_narration AS "safeNarration",
               created_at AS "createdAt"
          FROM office_generation_events WHERE job_id = $1 AND seq > $2
         ORDER BY seq LIMIT 500
      `, [jobId, afterSeq])
      return result.rows
    },

    async steer(params: { userId: string; workspaceId: string; jobId: string; instruction: string }): Promise<{ id: string }> {
      const result = await db<{ id: string }>(params.userId, `WITH resumed AS (
        UPDATE office_generation_jobs SET status='queued',stage='queued',error_code=NULL,error_detail=NULL,
          next_attempt_at=now(),updated_at=now(),
          brief=jsonb_set(brief,'{additionalContext}',to_jsonb(concat_ws(E'\\n',NULLIF(brief->>'additionalContext',''),$4::text)))
        WHERE id=$1 AND workspace_id=$2 AND initiated_by_user_id=$3 AND status='needs_input'
          AND error_code='material_fact_missing' AND job_kind='create'
          AND length(concat_ws(E'\\n',NULLIF(brief->>'additionalContext',''),$4::text))<=4000
        RETURNING id
      ) INSERT INTO office_generation_steering (job_id,workspace_id,sender_user_id,instruction)
        SELECT $1,$2,$3,$4 WHERE EXISTS(SELECT 1 FROM resumed) OR EXISTS(
          SELECT 1 FROM office_generation_jobs WHERE id=$1 AND status IN ('queued','running')) RETURNING id`, [params.jobId, params.workspaceId, params.userId, params.instruction])
      if (!result.rows[0]) throw new Error('Office steering insert returned no row')
      return result.rows[0]
    },

    async drainSteering(params: { userId: string; jobId: string; checkpointVersion: number }): Promise<Array<{ id: string; instruction: string }>> {
      const result = await db<{ id: string; instruction: string }>(params.userId, `
        UPDATE office_generation_steering SET status='applied', handled_at=now(), first_checkpoint_version=$2
         WHERE id IN (SELECT id FROM office_generation_steering WHERE job_id=$1 AND status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED)
        RETURNING id,instruction
      `, [params.jobId, params.checkpointVersion])
      return result.rows
    },

    async cancel(userId: string, jobId: string): Promise<boolean> {
      const result = await db<{ id: string }>(userId, `UPDATE office_generation_jobs SET cancel_requested_at=now(),updated_at=now() WHERE id=$1 AND status IN ('queued','running','needs_input') RETURNING id`, [jobId])
      return result.rows.length === 1
    },

    async finish(params: { userId: string; jobId: string; leaseToken: string; status: 'completed' | 'failed' | 'cancelled' | 'needs_input'; stage: string; errorCode?: string; errorDetail?: string; importDiagnostics?: OfficeImportDiagnostic[] }): Promise<boolean> {
      const result = await db<{ id: string }>(params.userId, `
        UPDATE office_generation_jobs SET status=$3,stage=$4,error_code=$5,
          error_detail=$6,checkpoint=CASE WHEN $7::jsonb IS NULL THEN checkpoint ELSE jsonb_set(checkpoint,'{importDiagnostics}',$7::jsonb) END,completed_at=CASE WHEN $3 IN ('completed','failed','cancelled') THEN now() END,
          lease_token=NULL,lease_expires_at=NULL,updated_at=now()
        WHERE id=$1 AND ($2::uuid IS NULL OR lease_token=$2) RETURNING id
      `, [params.jobId, params.leaseToken, params.status, params.stage, params.errorCode ?? null, params.errorDetail ?? null, params.importDiagnostics ? JSON.stringify(params.importDiagnostics.map(item => OfficeImportDiagnosticSchema.parse(item))) : null])
      return result.rows.length === 1
    },
  }
}

export const officeGenerationStore = createOfficeGenerationStore()

export function officeImportDiagnostics(checkpoint: unknown): OfficeImportDiagnostic[] {
  const value = checkpoint && typeof checkpoint === 'object' ? (checkpoint as { importDiagnostics?: unknown }).importDiagnostics : undefined
  const parsed = OfficeImportDiagnosticSchema.array().max(20).safeParse(value)
  return parsed.success ? parsed.data : []
}
