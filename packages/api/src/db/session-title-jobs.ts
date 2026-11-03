/** Durable native chat title metadata. [COMP:api/session-title-jobs] */
import { parseAuthoringAuthority, type AuthoringAuthority, type SessionContextAuthority } from '@use-brian/core'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import type { AuthTokenClaims } from './auth-session-store.js'
import { getPool, query, rollbackAndRelease } from './client.js'

const claimsSchema = z.object({ userId: z.string().uuid(), sessionId: z.string().uuid().optional(), authVersion: z.number().int().nonnegative().optional() }).strict()
export type SessionTitleJob = {
 sessionId: string; workspaceId: string; assistantId: string; actorUserId: string; userMessageId: string | null
 claims: AuthTokenClaims; authoring: AuthoringAuthority; generation: string; claimedGeneration: string; leaseToken: string; attempts: number
}
const returning = `j.session_id AS "sessionId",j.workspace_id AS "workspaceId",j.assistant_id AS "assistantId",j.actor_user_id AS "actorUserId",
 j.user_message_id AS "userMessageId",j.auth_claims AS claims,j.authoring_authority AS authoring,j.generation::text AS generation,
 j.claimed_generation::text AS "claimedGeneration",j.lease_token AS "leaseToken",j.attempts`

/** Shared parent guards exclude publication/status writes, but coexist with readers. */
async function mutateLocked<T>(target: {workspaceId: string; sessionId: string}, skipLocked: boolean, run: (client: PoolClient) => Promise<T>): Promise<T | null> {
 const attempts = skipLocked ? 1 : 5
 for (let attempt=0;attempt<attempts;attempt++) {
  const client = await getPool().connect()
  try {
   await client.query('BEGIN')
   // Never wait on a publication lock while occupying an owner connection:
   // publication's app-role transaction needs that pool for its final check.
   if ((await client.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE SKIP LOCKED',[target.workspaceId])).rowCount === 1
    && (await client.query('SELECT id FROM sessions WHERE workspace_id=$1 AND id=$2 FOR SHARE SKIP LOCKED',[target.workspaceId,target.sessionId])).rowCount === 1) {
    const result = await run(client)
    await client.query('COMMIT')
    return result
   }
  } finally { await rollbackAndRelease(client) }
  if (attempt+1<attempts) await new Promise(resolve=>setTimeout(resolve,20))
 }
 return null
}

/** Only a trusted host's live native authority can enqueue. No source bytes are copied. */
export async function enqueueNativeSessionTitleJob(input: { authority: SessionContextAuthority; claims: AuthTokenClaims | null; userMessageId: string }): Promise<boolean> {
 const { execution } = input.authority
 if (!input.claims || execution.identity.kind !== 'attended' || execution.identity.principal.kind !== 'workspace_member'
  || execution.identity.principal.authenticationKind !== 'native_session' || execution.surface.readOnly
  || execution.ownership.kind !== 'workspace' || execution.lifecycle.sessionPersisted === false) return false
 const claims = claimsSchema.parse(input.claims)
 if (claims.userId !== execution.security.access.userId || claims.userId !== execution.identity.principal.userId) return false
 await execution.security.authority.assertCurrent()
 const authoring = { version: 1 as const, assistantId: execution.assistant.id, ceiling: execution.security.ceiling }
 if (!parseAuthoringAuthority(authoring)) return false
 return await mutateLocked({workspaceId:execution.security.access.workspaceId,sessionId:execution.lifecycle.sessionId},false,async client => {
 await client.query(`INSERT INTO session_title_jobs AS j(session_id,workspace_id,assistant_id,actor_user_id,user_message_id,auth_claims,authoring_authority,available_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '2 seconds')
  ON CONFLICT(session_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,assistant_id=EXCLUDED.assistant_id,
   actor_user_id=EXCLUDED.actor_user_id,user_message_id=EXCLUDED.user_message_id,auth_claims=EXCLUDED.auth_claims,
   authoring_authority=EXCLUDED.authoring_authority,generation=j.generation+1,attempts=0,last_error=NULL,
   status=CASE WHEN j.status='processing' THEN 'processing' ELSE 'pending' END,available_at=now()+interval '2 seconds',updated_at=now()
   WHERE j.user_message_id IS DISTINCT FROM EXCLUDED.user_message_id`,
 [execution.lifecycle.sessionId,execution.security.access.workspaceId,execution.assistant.id,claims.userId,input.userMessageId??null,claims,authoring])
 return true
 }) ?? false
}

export async function claimSessionTitleJob(): Promise<SessionTitleJob | null> {
 // Discovery acquires no queue lock: taking it before workspace/session would
 // invert publication's order. A bounded candidate set avoids a busy workspace.
 const candidates = await query<{workspaceId:string;sessionId:string}>(`SELECT q.workspace_id AS "workspaceId",q.session_id AS "sessionId"
  FROM session_title_jobs q JOIN sessions s ON s.id=q.session_id WHERE s.status<>'running' AND q.available_at<=now()
  AND (q.status='pending' AND q.attempts<3 OR q.status='processing' AND q.locked_at<now()-interval '3 minutes')
  ORDER BY q.available_at,q.created_at LIMIT 8`)
 for (const target of candidates.rows) {
  const claimed = await mutateLocked(target,true,async client => {
   // Exhausted crashed claims are terminal, not immortal processing rows.
   await client.query(`UPDATE session_title_jobs SET status='failed',lease_token=NULL,locked_at=NULL,last_error='lease_expired',updated_at=now()
    WHERE session_id=$1 AND status='processing' AND locked_at<now()-interval '3 minutes' AND attempts>=3 AND generation=claimed_generation`,[target.sessionId])
   const result = await client.query<SessionTitleJob>(`UPDATE session_title_jobs j SET status='processing',attempts=attempts+1,
    claimed_generation=generation,lease_token=gen_random_uuid(),locked_at=now(),updated_at=now()
    WHERE j.session_id=$1 AND j.available_at<=now() AND j.attempts<3
     AND EXISTS(SELECT 1 FROM sessions s WHERE s.id=j.session_id AND s.status<>'running')
     AND (j.status='pending' OR j.status='processing' AND j.locked_at<now()-interval '3 minutes')
    RETURNING ${returning}`,[target.sessionId])
   return result.rows[0] ?? null
  })
  if (claimed) return claimed
 }
 return null
}
export async function sessionTitleJobCurrent(job: SessionTitleJob): Promise<boolean> {
 return (await query(`SELECT 1 FROM session_title_jobs j JOIN sessions s ON s.id=j.session_id WHERE j.session_id=$1
  AND j.status='processing' AND j.lease_token=$2 AND j.generation=$3 AND j.claimed_generation=$3
  AND j.locked_at>now()-interval '3 minutes' AND s.status<>'running'`,[job.sessionId,job.leaseToken,job.claimedGeneration])).rowCount === 1
}
export async function finishSessionTitleJob(job: SessionTitleJob, failure?: { terminal: boolean; code: string }): Promise<void> {
 const finished = await mutateLocked(job,false,async client => { await client.query(`UPDATE session_title_jobs SET status=CASE WHEN generation<>$3 THEN 'pending'
   WHEN $4::boolean THEN CASE WHEN $5::boolean OR attempts>=3 THEN 'failed' ELSE 'pending' END ELSE 'done' END,
  available_at=CASE WHEN generation<>$3 THEN now()+interval '2 seconds' ELSE now()+attempts*interval '10 seconds' END,
  last_error=$6,locked_at=NULL,lease_token=NULL,updated_at=now()
  WHERE session_id=$1 AND lease_token=$2 AND status='processing'`,
 [job.sessionId,job.leaseToken,job.claimedGeneration,!!failure,failure?.terminal??false,failure?.code??null]); return true })
 if (finished === null) throw new Error('title_queue_busy')
}
export function parseSessionTitleJobAuthority(job: SessionTitleJob) {
 const parsedClaims = claimsSchema.safeParse(job.claims), authoring = parseAuthoringAuthority(job.authoring)
 if (!parsedClaims.success) throw new Error('invalid_title_authority')
 const claims = parsedClaims.data
 if (!authoring || authoring.assistantId !== job.assistantId || authoring.ceiling.workspaceId !== job.workspaceId
  || authoring.ceiling.userId !== job.actorUserId || claims.userId !== job.actorUserId) throw new Error('invalid_title_authority')
 return { claims, authoring }
}
