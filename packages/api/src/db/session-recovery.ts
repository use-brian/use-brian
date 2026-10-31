/** Metadata-only, original-owner private continuations. [COMP:api/session-recovery] */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { applyRLSGucs, getAppPool } from './client.js'
import type { AuthTokenClaims } from './auth-session-store.js'
import { createPersonalWebSession, type Session } from './sessions.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'
import { sessionKindSql, clientSessionPolicy, policyFor } from '../session-kind.js'

export const sessionRecoveryInput = z.object({ workspaceId: z.string().uuid(), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const parentShape = z.object({
 sessionId: z.string().uuid(), workspaceId: z.string().uuid(), assistantId: z.string().uuid(), storedWorkspaceId: z.string().uuid().nullable(),
 contextGroupId: z.string().uuid().nullable(), contextProjectId: z.string().uuid().nullable(), contextCompartments: z.array(z.string()),
 effectiveClearance: z.string().nullable(), contextBindingOrigin: z.string(), channelType: z.string(), channelId: z.string(),
 appOrigin: z.string().nullable(), status: z.string(), hasLease: z.boolean(), policyRevision: z.string().nullable(),
}).strict()
type Parent = z.infer<typeof parentShape>
type Input = { claims: Readonly<AuthTokenClaims> | null; sessionId: string; workspaceId: string }
export type SessionRecoveryPreview = {
 sessionId: string; workspaceId: string; revision: string; status: 'available' | 'busy';
 continuationSessionId: string | null; contextGroupId: string | null; contextProjectId: string | null;
}
export type SessionRecoveryResult = {
 sessionId: string; assistantId: string; workspaceId: string; replayed: boolean;
 channelId: string; lastActive: string; status: string; contextGroupId: string | null; contextProjectId: string | null;
 policy: ReturnType<typeof clientSessionPolicy>;
}
type Continuation = Omit<SessionRecoveryResult,'workspaceId'|'replayed'>
function revision(parent: Parent): string {
 return createHash('sha256').update(JSON.stringify(parent)).digest('hex')
}
async function transaction<T>(input: Input, run: (client: PoolClient, parent: Parent) => Promise<T>): Promise<T> {
 const command = structuredClone(input), claims = command.claims
 if (!claims?.sessionId || claims.authVersion === undefined) throw new WorkspaceAccessError('authenticated_session_required', 401)
 const client = await getAppPool().connect()
 try {
  await client.query('BEGIN')
  await applyRLSGucs(client, claims.userId)
  const result = await client.query<{ value: unknown }>('SELECT read_native_session_recovery_parent($1,$2,$3,$4) AS value',
   [command.workspaceId, command.sessionId, claims.sessionId, claims.authVersion])
  const parent = parentShape.parse(result.rows[0]?.value)
  const value = await run(client, parent)
  // Locks preserve stored facts; clock-based device expiry still advances
  // while a replay waits on its target. Recheck before committing any result.
  await client.query('SELECT read_native_session_recovery_parent($1,$2,$3,$4)',
   [command.workspaceId, command.sessionId, claims.sessionId, claims.authVersion])
  await client.query('COMMIT')
  return value
 } catch (error) {
  await client.query('ROLLBACK')
  const sql = error as { code?: string; message?: string }
  if (sql.code === '42501') throw new WorkspaceAccessError(sql.message === 'authenticated_session_required' ? sql.message : 'session_recovery_unavailable', sql.message === 'authenticated_session_required' ? 401 : 404)
  if (['40001','40P01'].includes(sql.code ?? '')) throw new WorkspaceAccessError(sql.message === 'session_recovery_busy' ? sql.message : 'session_recovery_changed', 409)
  throw error
 } finally { client.release() }
}
async function continuation(client: PoolClient, input: Input): Promise<Continuation | null> {
 const found = await client.query<{ workspaceId: string; targetId: string }>(`SELECT workspace_id AS "workspaceId",target_session_id AS "targetId"
  FROM session_recoveries WHERE user_id=$1 AND source_session_id=$2`, [input.claims!.userId,input.sessionId])
 const receipt = found.rows[0]
 if (!receipt) return null
 if (receipt.workspaceId !== input.workspaceId) throw new WorkspaceAccessError('session_recovery_unavailable',404)
 const target = await client.query<Omit<Continuation,'lastActive'|'policy'> & {lastActive:Date} & Pick<Session,'channelType'|'visibility'|'mode'|'anchorKind'|'appOrigin'>>(`SELECT s.id AS "sessionId",s.assistant_id AS "assistantId",
   s.channel_id AS "channelId",s.last_active_at AS "lastActive",s.status,s.context_group_id AS "contextGroupId",s.context_project_id AS "contextProjectId",
   s.channel_type AS "channelType",s.visibility,s.mode,s.anchor_kind AS "anchorKind",s.app_origin AS "appOrigin"
  FROM sessions s JOIN assistants a ON a.id=s.assistant_id
  WHERE s.id=$1 AND s.user_id=$2 AND ${sessionKindSql.personalConversation('s')} AND ${sessionKindSql.surfaceIs('s','$4')}
   AND s.mode IS NULL AND s.workspace_id=$3 AND a.workspace_id=$3
   AND assistant_placement_visible($2,s.assistant_id) AND session_recording_read_allowed(s.id) FOR SHARE OF s,a`,
 [receipt.targetId,input.claims!.userId,input.workspaceId,'chat'])
 if (!target.rows[0]) throw new WorkspaceAccessError('session_recovery_unavailable',404)
 const row=target.rows[0]
 return {sessionId:row.sessionId,assistantId:row.assistantId,channelId:row.channelId,lastActive:row.lastActive.toISOString(),
  status:row.status,contextGroupId:row.contextGroupId,contextProjectId:row.contextProjectId,policy:clientSessionPolicy(policyFor(row))}
}
export async function inspectSessionRecovery(input: Input): Promise<SessionRecoveryPreview> {
 const command = structuredClone(input)
 return transaction(command,async(client,parent)=>({
  sessionId:parent.sessionId,workspaceId:parent.workspaceId,revision:revision(parent),
  status:parent.status==='running'||parent.hasLease?'busy':'available',
  continuationSessionId:(await continuation(client,command))?.sessionId??null,
  contextGroupId:parent.contextGroupId,contextProjectId:parent.contextProjectId,
 }))
}
export async function recoverSession(input: Input & { expectedRevision: string }): Promise<SessionRecoveryResult> {
 const command = structuredClone(input)
 const result = await transaction(command,async(client,parent)=>{
  const existing = await continuation(client,command)
  if (existing) return {...existing,workspaceId:parent.workspaceId,replayed:true}
  if (revision(parent)!==command.expectedRevision) throw new WorkspaceAccessError('session_recovery_changed',409)
  if (parent.status==='running'||parent.hasLease) throw new WorkspaceAccessError('session_recovery_busy',409)
  const claims = command.claims!
  // The new root and receipt share one app-role transaction. Nothing from old
  // history/state/approvals is read or copied, and no old operation is retried.
  const created = await createPersonalWebSession({
   assistantId:parent.assistantId,userId:claims.userId,workspaceId:parent.workspaceId,
   channelType:'web',channelId:randomUUID(),appOrigin:'chat',contextGroupId:parent.contextGroupId,
   contextProjectId:parent.contextProjectId,expectedPolicyRevision:parent.policyRevision??undefined,
  },{actorUserId:claims.userId,authSessionId:claims.sessionId!,authVersion:claims.authVersion!},client)
  await client.query(`INSERT INTO session_recoveries(user_id,workspace_id,source_session_id,target_session_id,source_revision,auth_session_id,auth_version)
   VALUES($1,$2,$3,$4,$5,$6,$7)`,[claims.userId,parent.workspaceId,parent.sessionId,created.id,command.expectedRevision,claims.sessionId,claims.authVersion])
  return {sessionId:created.id,assistantId:created.assistantId,workspaceId:parent.workspaceId,replayed:false,
   channelId:created.channelId,lastActive:created.lastActiveAt.toISOString(),status:created.status,
   contextGroupId:created.contextGroupId??null,contextProjectId:created.contextProjectId??null,policy:clientSessionPolicy(policyFor(created))}
 })
 if (!result.replayed) notifyWorkspaceChange(result.workspaceId,'session','create',result.sessionId)
 return result
}
