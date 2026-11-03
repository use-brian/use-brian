/** Durable native chat commitment analysis. [COMP:api/session-state-jobs] */
import { parseAuthoringAuthority, type AuthoringAuthority, type SessionContextAuthority } from '@use-brian/core'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import type { AuthTokenClaims } from './auth-session-store.js'
import { getPool, query, rollbackAndRelease } from './client.js'

const claimsSchema = z.object({ userId: z.string().uuid(), sessionId: z.string().uuid().optional(), authVersion: z.number().int().nonnegative().optional() }).strict()
export type SessionStateJob = {
 sessionId: string; workspaceId: string; assistantId: string; actorUserId: string; userMessageId: string; assistantMessageId: string; firstSequence: number; throughSequence: number
 claims: AuthTokenClaims; authoring: AuthoringAuthority; generation: string; claimedGeneration: string; leaseToken: string; attempts: number
}
const returning = `j.session_id AS "sessionId",j.workspace_id AS "workspaceId",j.assistant_id AS "assistantId",j.actor_user_id AS "actorUserId",
 j.user_message_id AS "userMessageId",j.assistant_message_id AS "assistantMessageId",j.first_sequence AS "firstSequence",j.through_sequence AS "throughSequence",j.auth_claims AS claims,j.authoring_authority AS authoring,j.generation::text AS generation,
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
export async function enqueueNativeSessionStateJob(input: { authority: SessionContextAuthority; claims: AuthTokenClaims | null; userMessageId: string; assistantMessageId: string }): Promise<boolean> {
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
 const frame = (await client.query<{first:number;through:number}>(`SELECT u.sequence_num AS first,a.sequence_num AS through
  FROM session_messages u JOIN session_messages a ON a.session_id=u.session_id AND a.workspace_id=u.workspace_id
  WHERE u.session_id=$1 AND u.workspace_id=$2 AND u.id=$3 AND a.id=$4 AND u.role='user' AND a.role='assistant'
   AND a.sender_assistant_id=$5 AND a.sequence_num>u.sequence_num`,
  [execution.lifecycle.sessionId,execution.security.access.workspaceId,input.userMessageId,input.assistantMessageId,execution.assistant.id])).rows[0]
 if (!frame) return false
 await client.query(`INSERT INTO session_state_jobs AS j(session_id,workspace_id,assistant_id,actor_user_id,user_message_id,assistant_message_id,
  first_sequence,through_sequence,auth_claims,authoring_authority,available_at)
  VALUES($1,$2,$3,$4,$5,$10,$6,$7,$8,$9,now()+interval '2 seconds')
  ON CONFLICT(session_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,assistant_id=EXCLUDED.assistant_id,
   actor_user_id=EXCLUDED.actor_user_id,user_message_id=EXCLUDED.user_message_id,assistant_message_id=EXCLUDED.assistant_message_id,auth_claims=EXCLUDED.auth_claims,
   first_sequence=CASE WHEN j.status='done' THEN EXCLUDED.first_sequence ELSE LEAST(j.first_sequence,EXCLUDED.first_sequence) END,
   through_sequence=EXCLUDED.through_sequence,
   authoring_authority=EXCLUDED.authoring_authority,generation=j.generation+1,attempts=0,last_error=NULL,
   status=CASE WHEN j.status='processing' THEN 'processing' ELSE 'pending' END,available_at=now()+interval '2 seconds',updated_at=now()
   WHERE j.assistant_message_id IS DISTINCT FROM EXCLUDED.assistant_message_id`,
 [execution.lifecycle.sessionId,execution.security.access.workspaceId,execution.assistant.id,claims.userId,input.userMessageId,
  frame.first,frame.through,claims,authoring,input.assistantMessageId])
 return true
 }) ?? false
}

export async function claimSessionStateJob(): Promise<SessionStateJob | null> {
 // Discovery acquires no queue lock: taking it before workspace/session would
 // invert publication's order. A bounded candidate set avoids a busy workspace.
 const candidates = await query<{workspaceId:string;sessionId:string}>(`SELECT q.workspace_id AS "workspaceId",q.session_id AS "sessionId"
  FROM session_state_jobs q JOIN sessions s ON s.id=q.session_id WHERE s.status<>'running' AND q.available_at<=now()
  AND NOT EXISTS(SELECT 1 FROM session_messages m WHERE m.session_id=s.id AND m.sequence_num>q.through_sequence)
  AND (q.status='pending' AND q.attempts<3 OR q.status='processing' AND q.locked_at<now()-interval '3 minutes')
  ORDER BY q.available_at,q.created_at LIMIT 8`)
 for (const target of candidates.rows) {
  const claimed = await mutateLocked(target,true,async client => {
   // Exhausted crashed claims are terminal, not immortal processing rows.
   await client.query(`UPDATE session_state_jobs SET status='failed',lease_token=NULL,locked_at=NULL,last_error='lease_expired',updated_at=now()
    WHERE session_id=$1 AND status='processing' AND locked_at<now()-interval '3 minutes' AND attempts>=3 AND generation=claimed_generation`,[target.sessionId])
   const result = await client.query<SessionStateJob>(`UPDATE session_state_jobs j SET status='processing',attempts=attempts+1,
    claimed_generation=generation,lease_token=gen_random_uuid(),locked_at=now(),updated_at=now()
    WHERE j.session_id=$1 AND j.available_at<=now() AND j.attempts<3
     AND EXISTS(SELECT 1 FROM sessions s WHERE s.id=j.session_id AND s.status<>'running'
      AND NOT EXISTS(SELECT 1 FROM session_messages m WHERE m.session_id=s.id AND m.sequence_num>j.through_sequence))
     AND (j.status='pending' OR j.status='processing' AND j.locked_at<now()-interval '3 minutes')
    RETURNING ${returning}`,[target.sessionId])
   return result.rows[0] ?? null
  })
  if (claimed) return claimed
 }
 return null
}
export async function sessionStateJobCurrent(job: SessionStateJob): Promise<boolean> {
 return (await query(`SELECT 1 FROM session_state_jobs j JOIN sessions s ON s.id=j.session_id WHERE j.session_id=$1
  AND j.status='processing' AND j.lease_token=$2 AND j.generation=$3 AND j.claimed_generation=$3
  AND j.locked_at>now()-interval '3 minutes' AND s.status<>'running'
  AND EXISTS(SELECT 1 FROM session_messages m WHERE m.session_id=s.id AND m.id=j.user_message_id)
  AND EXISTS(SELECT 1 FROM session_messages m WHERE m.session_id=s.id AND m.id=j.assistant_message_id AND m.sequence_num=j.through_sequence)
  AND NOT EXISTS(SELECT 1 FROM session_messages m WHERE m.session_id=s.id AND m.sequence_num>j.through_sequence)`,[job.sessionId,job.leaseToken,job.claimedGeneration])).rowCount === 1
}
export async function finishSessionStateJob(job: SessionStateJob, failure?: { terminal: boolean; code: string }): Promise<void> {
 const finished = await mutateLocked(job,false,async client => { await client.query(`UPDATE session_state_jobs SET status=CASE WHEN generation<>$3 THEN 'pending'
   WHEN $4::boolean THEN CASE WHEN $5::boolean OR attempts>=3 THEN 'failed' ELSE 'pending' END ELSE 'done' END,
  available_at=CASE WHEN generation<>$3 THEN now()+interval '2 seconds' ELSE now()+attempts*interval '10 seconds' END,
  last_error=$6,locked_at=NULL,lease_token=NULL,updated_at=now()
  WHERE session_id=$1 AND lease_token=$2 AND status='processing'`,
 [job.sessionId,job.leaseToken,job.claimedGeneration,!!failure,failure?.terminal??false,failure?.code??null]); return true })
 if (finished === null) throw new Error('state_queue_busy')
}
export function parseSessionStateJobAuthority(job: SessionStateJob) {
 const parsedClaims = claimsSchema.safeParse(job.claims), authoring = parseAuthoringAuthority(job.authoring)
 if (!parsedClaims.success) throw new Error('invalid_state_authority')
 const claims = parsedClaims.data
 if (!authoring || authoring.assistantId !== job.assistantId || authoring.ceiling.workspaceId !== job.workspaceId
  || authoring.ceiling.userId !== job.actorUserId || claims.userId !== job.actorUserId) throw new Error('invalid_state_authority')
 return { claims, authoring }
}
