/** Durable Office job/event/steering store. [COMP:api/office-generation] */
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
          SELECT id FROM office_generation_jobs
           WHERE job_kind = ANY($3::text[]) AND status IN ('queued','running') AND cancel_requested_at IS NULL
             AND next_attempt_at <= now()
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
      `, [params.leaseToken, params.leaseMs, params.jobKinds ?? ['create']])
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
      const result = await db<{ id: string }>(params.userId, `INSERT INTO office_generation_steering (job_id,workspace_id,sender_user_id,instruction) VALUES ($1,$2,$3,$4) RETURNING id`, [params.jobId, params.workspaceId, params.userId, params.instruction])
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

    async finish(params: { userId: string; jobId: string; leaseToken: string; status: 'completed' | 'failed' | 'cancelled' | 'needs_input'; stage: string; errorCode?: string; errorDetail?: string }): Promise<boolean> {
      const result = await db<{ id: string }>(params.userId, `
        UPDATE office_generation_jobs SET status=$3,stage=$4,error_code=$5,
          error_detail=$6,completed_at=CASE WHEN $3 IN ('completed','failed','cancelled') THEN now() END,
          lease_token=NULL,lease_expires_at=NULL,updated_at=now()
        WHERE id=$1 AND ($2::uuid IS NULL OR lease_token=$2) RETURNING id
      `, [params.jobId, params.leaseToken, params.status, params.stage, params.errorCode ?? null, params.errorDetail ?? null])
      return result.rows.length === 1
    },
  }
}

export const officeGenerationStore = createOfficeGenerationStore()
