/** Content-free replay state with source-admitted discovery metadata. Actor reads use the native app pool.
 * [COMP:api/research-feedback-replay]
 */
import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { RESEARCH_HEURISTIC_INTERPRETER } from '@use-brian/core'
import { applyRLSGucs, getAppPool, getPool, rollbackAndRelease } from './client.js'
import { classifySession, sessionPolicy, type SessionKindRow } from '../session-kind.js'
import { getUserAssistant, isUserBlockedForAssistant, type UserAssistantView } from './users.js'
import { crossAssistantSendPolicy } from '../routes/_room-binding.js'
import type { ResearchActivity, ResearchFeedback, ResearchMessageRow, RecordResearchFeedbackInput } from './research-store.js'

export type FeedbackAttempt = {
  messageId: string; workspaceId: string; sessionId: string; actorUserId: string; assistantId: string
  messageVersion: number; contextKey: string; state: 'pending' | 'evaluated' | 'complete' | 'blocked'; reason: string | null
  association: RecordResearchFeedbackInput['association'] | null; targetActivityId: string | null; targetOutputKey: string | null
  selectedActivityId: string | null; replyToMessageId: string | null; leaseToken: string | null
}
export type AttemptLease = { messageId: string; messageVersion: number; leaseToken: string }
export type FeedbackFrame = { key: string; activities: ResearchActivity[]; fallbackActor: string | null }
const columns = `a.message_id AS "messageId",a.workspace_id AS "workspaceId",a.session_id AS "sessionId",a.actor_user_id AS "actorUserId",
 a.assistant_id AS "assistantId",a.message_version::int AS "messageVersion",a.context_key AS "contextKey",a.state,a.reason,a.association,
 a.target_activity_id AS "targetActivityId",a.target_output_key AS "targetOutputKey",a.selected_activity_id AS "selectedActivityId",
 a.reply_to_message_id AS "replyToMessageId",a.lease_token AS "leaseToken"`
const sessionColumns = `s.user_id AS "sessionOwner",s.visibility,s.mode,s.channel_type AS "channelType",s.channel_id AS "channelId",
 s.anchor_kind AS "anchorKind",s.anchor_ref AS "anchorRef",s.app_origin AS "appOrigin",s.transient,
 s.assistant_id AS "sessionAssistantId",s.effective_clearance AS "effectiveClearance",s.context_compartments AS "contextCompartments",s.context_project_id AS "contextProjectId"`
const feedbackContextKey = (values: unknown): string => createHash('sha256').update(JSON.stringify(['feedback-replay-v1',values])).digest('hex')
// These evaluations change only with the canonical source/interpreter contract.
const sourceOnlyContextKey = feedbackContextKey(['source-only-meaning-v1',RESEARCH_HEURISTIC_INTERPRETER])
async function actorRead<T>(actor: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getAppPool().connect()
  try { await client.query('BEGIN'); await applyRLSGucs(client,actor); const value = await fn(client); await client.query('COMMIT'); return value }
  finally { await rollbackAndRelease(client) }
}
type FeedbackSession = SessionKindRow & {
  sessionOwner:string;sessionAssistantId:string;effectiveClearance:string|null;visibility:string|null;mode:string|null
  contextCompartments:string[];contextProjectId:string|null
}
type AssistantMetadata = Pick<UserAssistantView,'id'|'workspaceId'|'clearance'>
type AssistantAdmission = { assistant:AssistantMetadata;boundWorkspace:string;sessionAssistantId:string }
function assistantMayCapture(row:FeedbackSession, assistant:AssistantMetadata, boundWorkspace:string):boolean {
  const kind=classifySession(row)
  if(kind.lane!=='conversation' || assistant.workspaceId!==boundWorkspace) return false
  if(row.sessionAssistantId===assistant.id) return true
  const policy=sessionPolicy(kind)
  return crossAssistantSendPolicy({isSharedSession:policy.crossAssistantSend==='room',isDocSurfaceSession:policy.crossAssistantSend==='doc',
    ownerOnly:policy.read.rule==='owner',sameWorkspace:assistant.workspaceId===boundWorkspace,
    assistantClearance:assistant.clearance,sessionClearance:row.effectiveClearance})==='allow'
}
/** Resolve current invocation and the full native session gate without holding either pool. */
async function assistantAdmission(actor:string,workspace:string,session:string,assistantId:string):Promise<AssistantAdmission|null> {
  const assistant=await getUserAssistant(actor,assistantId)
  if(!assistant || assistant.workspaceId!==workspace || await isUserBlockedForAssistant(assistantId,actor)) return null
  const row=await actorRead(actor,async client => (await client.query<FeedbackSession>(`SELECT ${sessionColumns} FROM sessions s
    JOIN workspace_members wm ON wm.workspace_id=s.workspace_id AND wm.user_id=$1
    WHERE s.id=$2 AND s.workspace_id=$3`,[actor,session,workspace])).rows[0])
  if(!row) return null
  // Lazy reuse avoids an eager cycle through feed/research learning imports.
  // The actor snapshot connection is released before this canonical gate runs.
  const {gateSessionRead}=await import('../session-read-authority.js')
  if(await gateSessionRead(actor,{...row,id:session,userId:row.sessionOwner,assistantId:row.sessionAssistantId})) return null
  const bound=await getUserAssistant(actor,row.sessionAssistantId)
  if(!bound || bound.workspaceId!==workspace || !assistantMayCapture(row,assistant,bound.workspaceId)) return null
  return {assistant,boundWorkspace:bound.workspaceId,sessionAssistantId:row.sessionAssistantId}
}
function activity(row: Record<string, unknown>): ResearchActivity {
  return Object.fromEntries(Object.entries(row).map(([key,value]) => [key.replace(/_([a-z])/g,(_,c:string) => c.toUpperCase()),value])) as unknown as ResearchActivity
}
export async function readFeedbackFrame(actor: string, workspace: string, session: string, assistant: string): Promise<FeedbackFrame | null> {
  const admission=await assistantAdmission(actor,workspace,session,assistant)
  if(!admission) return null
  return actorRead(actor,async client => {
    const row = (await client.query<FeedbackSession>(`SELECT ${sessionColumns} FROM sessions s
      JOIN workspace_members wm ON wm.workspace_id=s.workspace_id AND wm.user_id=$1
      WHERE s.id=$2 AND s.workspace_id=$3 AND s.assistant_id=$4`,[actor,session,workspace,admission.sessionAssistantId])).rows[0]
    if (!row || !assistantMayCapture(row,admission.assistant,admission.boundWorkspace)) return null
    // Three witnesses suffice after excluding a candidate's own request.
    const rows = await client.query("SELECT to_jsonb(a) AS value FROM research_activities a WHERE a.workspace_id=$1 AND a.session_id=$2 AND a.status<>'running' ORDER BY a.id LIMIT 3",[workspace,session])
    const activities = rows.rows.map(r => activity(r.value))
    return { key: feedbackContextKey(activities.map(a => [a.id,a.outputMessageId,a.revision])),activities,
      fallbackActor: sessionPolicy(classifySession(row)).attribution ? null : row.sessionOwner }
  })
}
export async function readFeedbackMessage(actor: string, workspace: string, session: string, assistant: string, message: string): Promise<ResearchMessageRow | null> {
  const admission=await assistantAdmission(actor,workspace,session,assistant)
  if(!admission) return null
  return actorRead(actor,async client => {
    const row = (await client.query<ResearchMessageRow & FeedbackSession & { stampedSender: string | null }>(`SELECT m.id,m.session_id AS "sessionId",m.role,m.content,m.sender_user_id AS "stampedSender",
      coalesce(m.scope_version,1)::int AS version,m.sensitivity,m.compartments,${sessionColumns}
      FROM session_messages m JOIN sessions s ON s.id=m.session_id
      JOIN workspace_members wm ON wm.workspace_id=s.workspace_id AND wm.user_id=$1
      WHERE m.id=$2 AND s.id=$3 AND s.workspace_id=$4 AND s.assistant_id=$5
        AND m.role='user' AND coalesce(m.scope_held,false)=false
        AND (m.workspace_id IS NULL OR m.workspace_id=s.workspace_id) AND (m.assistant_id IS NULL OR m.assistant_id=s.assistant_id)`,[actor,message,session,workspace,admission.sessionAssistantId])).rows[0]
    if (!row || !assistantMayCapture(row,admission.assistant,admission.boundWorkspace)) return null
    const author = row.stampedSender ?? (sessionPolicy(classifySession(row)).attribution ? null : row.sessionOwner)
    return author === actor ? { id:row.id,sessionId:row.sessionId,role:row.role,content:row.content,senderUserId:author,
      version:row.version,sensitivity:row.sensitivity,compartments:row.compartments } : null
  })
}
export async function replyActivity(actor: string, workspace: string, output: string): Promise<string | null> {
  return actorRead(actor,async client => (await client.query<{id:string}>("SELECT id FROM research_activities WHERE workspace_id=$1 AND output_message_id=$2 AND status<>'running' ORDER BY id LIMIT 1",[workspace,output])).rows[0]?.id ?? null)
}
/** Native RLS and column-scoped metadata access filter receipts before LIMIT. */
export async function discoverFeedbackMessages(actor: string, workspace: string, session: string, assistant: string, frame: FeedbackFrame, exclude: string | null): Promise<string[]> {
  const admission=await assistantAdmission(actor,workspace,session,assistant)
  if(!admission) return []
  return actorRead(actor,async client => (await client.query<{id:string}>(`SELECT m.id FROM session_messages m JOIN sessions s ON s.id=m.session_id
    WHERE s.id=$1 AND s.workspace_id=$2 AND s.assistant_id=$3 AND m.role='user' AND coalesce(m.scope_held,false)=false
      AND coalesce(m.sender_user_id,$4::uuid)=$5 AND ($6::uuid IS NULL OR m.id<>$6)
      AND EXISTS(SELECT 1 FROM research_activities a JOIN session_messages o ON o.id=a.output_message_id AND o.session_id=s.id
        WHERE a.workspace_id=$2 AND a.session_id=s.id AND a.status<>'running' AND o.sequence_num<m.sequence_num)
      AND NOT EXISTS(SELECT 1 FROM research_feedback f WHERE f.message_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM research_feedback_attempts a WHERE a.message_id=m.id
        AND (a.state IN ('complete','blocked','pending') OR (a.message_version=coalesce(m.scope_version,1)
          AND a.state='evaluated' AND a.context_key IN ($7,$8))))
    ORDER BY m.sequence_num,m.id LIMIT 40`,[session,workspace,admission.sessionAssistantId,frame.fallbackActor,actor,exclude,frame.key,sourceOnlyContextKey])).rows.map(r => r.id))
}
export async function claimFeedbackRetries(actor: string, workspace: string, session: string, exclude: string | null): Promise<FeedbackAttempt[]> {
  const token = randomUUID()
  return (await getPool().query<FeedbackAttempt>(`WITH picked AS (SELECT a.message_id FROM research_feedback_attempts a
    WHERE a.workspace_id=$1 AND a.session_id=$2 AND a.actor_user_id=$3 AND a.state='pending'
      AND (a.lease_until IS NULL OR a.lease_until<=now()) AND ($4::uuid IS NULL OR a.message_id<>$4)
      AND NOT EXISTS(SELECT 1 FROM research_feedback f WHERE f.message_id=a.message_id)
    ORDER BY a.last_attempt_at NULLS FIRST,a.created_at,a.message_id LIMIT 10 FOR UPDATE SKIP LOCKED)
    UPDATE research_feedback_attempts a SET lease_token=$5,lease_until=now()+interval '60 seconds',attempt_count=a.attempt_count+1,
      last_attempt_at=clock_timestamp(),updated_at=now() FROM picked p WHERE a.message_id=p.message_id RETURNING ${columns}`,
    [workspace,session,actor,exclude,token])).rows
}
export async function prepareFeedbackAttempt(input: { workspaceId:string;sessionId:string;assistantId:string;actorUserId:string;messageId:string;messageVersion:number;contextKey:string;
  targetActivityId?:string;targetOutputKey?:string;association?:RecordResearchFeedbackInput['association'];selectedActivityId?:string|null;replyToMessageId?:string|null;reason?:string;sourceOnlyEvaluation?:boolean }): Promise<FeedbackAttempt | null> {
  const token = input.targetActivityId ? randomUUID() : null
  const r = await getPool().query<FeedbackAttempt>(`INSERT INTO research_feedback_attempts AS a
    (message_id,workspace_id,session_id,actor_user_id,assistant_id,message_version,context_key,state,reason,association,target_activity_id,target_output_key,
      selected_activity_id,reply_to_message_id,lease_token,lease_until,last_attempt_at,attempt_count)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,CASE WHEN $15::uuid IS NOT NULL THEN now()+interval '60 seconds' END,
      CASE WHEN $15::uuid IS NOT NULL THEN clock_timestamp() END,CASE WHEN $15::uuid IS NOT NULL THEN 1 ELSE 0 END)
    ON CONFLICT(message_id) DO UPDATE SET message_version=excluded.message_version,context_key=excluded.context_key,state=excluded.state,
      assistant_id=CASE WHEN excluded.target_activity_id IS NOT NULL AND excluded.target_output_key IS NOT NULL AND excluded.association IS NOT NULL
        AND (a.association IS NULL OR (a.state='blocked' AND a.target_output_key IS NULL)) THEN excluded.assistant_id ELSE a.assistant_id END,
      reason=excluded.reason,association=excluded.association,target_activity_id=excluded.target_activity_id,target_output_key=excluded.target_output_key,
      selected_activity_id=excluded.selected_activity_id,reply_to_message_id=excluded.reply_to_message_id,lease_token=excluded.lease_token,
      lease_until=excluded.lease_until,last_attempt_at=excluded.last_attempt_at,attempt_count=a.attempt_count+excluded.attempt_count,updated_at=now()
    WHERE a.actor_user_id=excluded.actor_user_id AND a.workspace_id=excluded.workspace_id AND a.session_id=excluded.session_id
      AND a.state<>'complete' AND (
        (a.state<>'blocked' AND a.message_version<>excluded.message_version AND (a.association IS NULL OR (excluded.target_activity_id IS NOT NULL
          AND ((a.target_activity_id=excluded.target_activity_id AND a.target_output_key=excluded.target_output_key AND a.association=excluded.association)
            OR (excluded.association='explicit_selection' AND excluded.selected_activity_id=excluded.target_activity_id)
            OR (excluded.association='explicit_reply' AND excluded.reply_to_message_id IS NOT NULL)))))
        OR (a.state='evaluated' AND a.association IS NULL)
        OR (a.state='blocked' AND a.target_output_key IS NULL AND excluded.selected_activity_id IS NOT NULL)
        OR (a.state='pending' AND a.message_version=excluded.message_version AND a.target_activity_id=excluded.target_activity_id
          AND a.target_output_key=excluded.target_output_key AND a.association=excluded.association AND (a.lease_until IS NULL OR a.lease_until<=now())))
      AND NOT EXISTS(SELECT 1 FROM research_feedback f WHERE f.message_id=a.message_id)
    RETURNING ${columns}`,[input.messageId,input.workspaceId,input.sessionId,input.actorUserId,input.assistantId,input.messageVersion,input.sourceOnlyEvaluation && !input.targetActivityId ? sourceOnlyContextKey : input.contextKey,
    token ? 'pending':'evaluated',input.reason ?? null,input.association ?? null,input.targetActivityId ?? null,input.targetOutputKey ?? null,
    input.selectedActivityId ?? null,input.replyToMessageId ?? null,token])
  return r.rows[0] ?? null
}
export async function releaseFeedbackAttempt(attempt: AttemptLease, tombstone = false): Promise<void> {
  await getPool().query(`UPDATE research_feedback_attempts SET lease_token=NULL,lease_until=NULL,updated_at=now(),
    state=CASE WHEN $4 THEN 'blocked' ELSE state END,reason=CASE WHEN $4 THEN 'context_changed' ELSE reason END
    WHERE message_id=$1 AND message_version=$2 AND lease_token=$3`,[attempt.messageId,attempt.messageVersion,attempt.leaseToken,tombstone])
}
/** A source edit/hold renewal gets fresh admission, preserving the original linked intent. */
export async function renewFeedbackAttempt(lease: AttemptLease, version: number, context: string): Promise<FeedbackAttempt | null> {
  return (await getPool().query<FeedbackAttempt>(`UPDATE research_feedback_attempts a SET message_version=$4,context_key=$5,updated_at=now()
    WHERE a.message_id=$1 AND a.message_version=$2 AND a.lease_token=$3 AND a.state='pending' RETURNING ${columns}`,
    [lease.messageId,lease.messageVersion,lease.leaseToken,version,context])).rows[0] ?? null
}
export async function feedbackTargetExists(id: string): Promise<boolean> {
  return (await getPool().query('SELECT id FROM research_activities WHERE id=$1',[id])).rows.length>0
}
/** Same native write transaction: only lease/source identity pins, never owner-GUC read authority. */
export async function pinFeedbackAttempt(client: pg.PoolClient, input: RecordResearchFeedbackInput, lease: AttemptLease): Promise<void> {
  const attempt = (await client.query<FeedbackAttempt>(`SELECT ${columns} FROM research_feedback_attempts a WHERE a.message_id=$1 AND a.message_version=$2 AND a.lease_token=$3 AND state='pending' AND lease_until>now() FOR UPDATE`,[lease.messageId,lease.messageVersion,lease.leaseToken])).rows[0]
  if (!attempt || attempt.messageId!==input.messageId || attempt.actorUserId!==input.actorUserId || attempt.workspaceId!==input.workspaceId || attempt.sessionId!==input.sessionId
    || attempt.assistantId!==input.assistantId || attempt.targetActivityId!==input.activityId || attempt.targetOutputKey!==input.outputKey || attempt.association!==input.association) throw new Error('research_feedback_attempt_stale')
  const row = (await client.query<FeedbackSession & { stampedSender:string|null;version:number;boundWorkspace:string;assistantWorkspace:string;assistantClearance:UserAssistantView['clearance'] }>(`SELECT ${sessionColumns},m.sender_user_id AS "stampedSender",coalesce(m.scope_version,1)::int AS version,
    ba.workspace_id AS "boundWorkspace",ea.workspace_id AS "assistantWorkspace",ea.clearance AS "assistantClearance"
    FROM session_messages m JOIN sessions s ON s.id=m.session_id JOIN workspace_members wm ON wm.workspace_id=s.workspace_id AND wm.user_id=$1
    JOIN assistants ba ON ba.id=s.assistant_id AND ba.workspace_id=s.workspace_id
    JOIN assistants ea ON ea.id=$5 AND ea.workspace_id=s.workspace_id
    WHERE m.id=$2 AND s.id=$3 AND s.workspace_id=$4 AND m.role='user' AND coalesce(m.scope_held,false)=false
    AND NOT($1=ANY(ea.blocked_user_ids))
    AND (m.workspace_id IS NULL OR m.workspace_id=s.workspace_id) AND (m.assistant_id IS NULL OR m.assistant_id=s.assistant_id)
    FOR SHARE OF m,s,wm,ba,ea`,[input.actorUserId,input.messageId,input.sessionId,input.workspaceId,input.assistantId])).rows[0]
  if (!row || !assistantMayCapture(row,{id:input.assistantId,workspaceId:row.assistantWorkspace,clearance:row.assistantClearance},row.boundWorkspace)
    || row.version!==input.messageVersion || row.version!==lease.messageVersion
    || (row.stampedSender ?? (sessionPolicy(classifySession(row)).attribution ? null : row.sessionOwner))!==input.actorUserId) throw new Error('research_feedback_source_changed')
}
export async function completeFeedbackAttempt(client: pg.PoolClient, lease: AttemptLease): Promise<void> {
  const r = await client.query(`UPDATE research_feedback_attempts SET state='complete',reason=NULL,lease_token=NULL,lease_until=NULL,updated_at=now()
    WHERE message_id=$1 AND message_version=$2 AND lease_token=$3 AND state='pending'`,[lease.messageId,lease.messageVersion,lease.leaseToken])
  if (r.rowCount!==1) throw new Error('research_feedback_attempt_stale')
}

/** Idempotent replay is still projected under the actor's actual current RLS. */
export async function readFeedbackReceipt(actor: string, message: string): Promise<ResearchFeedback | null> {
  return actorRead(actor,async client => {
    const row = (await client.query(`SELECT to_jsonb(f) || jsonb_build_object('kind',r.kind,'uncertain',r.uncertain,'origin',r.origin,
      'version',(SELECT max(revision)::int FROM research_feedback_revisions WHERE feedback_id=f.id)) AS value
      FROM research_feedback f JOIN research_feedback_revisions r ON r.feedback_id=f.id AND r.revision=f.current_revision
      WHERE f.message_id=$1 AND f.actor_user_id=$2`,[message,actor])).rows[0]
    return row ? activity(row.value) as unknown as ResearchFeedback : null
  })
}

/** An unadmitted explicit selection cannot later become automatic local feedback. */
export async function rejectFeedbackSelection(input: {messageId:string;workspaceId:string;sessionId:string;actorUserId:string;assistantId:string;messageVersion:number;contextKey:string;selectedActivityId:string}): Promise<void> {
  await getPool().query(`INSERT INTO research_feedback_attempts AS a
    (message_id,workspace_id,session_id,actor_user_id,assistant_id,message_version,context_key,state,reason,association,target_activity_id,selected_activity_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,'blocked','context_changed','explicit_selection',$8,$8)
    ON CONFLICT(message_id) DO UPDATE SET message_version=excluded.message_version,context_key=excluded.context_key,state='blocked',reason='context_changed',
      association='explicit_selection',target_activity_id=excluded.target_activity_id,selected_activity_id=excluded.selected_activity_id,updated_at=now()
    WHERE a.actor_user_id=excluded.actor_user_id AND a.workspace_id=excluded.workspace_id AND a.session_id=excluded.session_id
      AND ((a.state='evaluated' AND a.association IS NULL) OR (a.state='blocked' AND a.target_output_key IS NULL))
      AND NOT EXISTS(SELECT 1 FROM research_feedback f WHERE f.message_id=a.message_id)`,
    [input.messageId,input.workspaceId,input.sessionId,input.actorUserId,input.assistantId,input.messageVersion,input.contextKey,input.selectedActivityId])
}
