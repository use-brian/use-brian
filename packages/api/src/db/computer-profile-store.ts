import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { getPool, query } from './client.js'
import type { PoolClient } from 'pg'

export const ProfilePatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  enabledAssistantIds: z.array(z.string().uuid()).max(200).optional(),
  assistantRoutingNotes: z.record(z.string().uuid(), z.string().trim().max(2000)).optional(),
}).strict()
export const ProfileAssistantPatchSchema = z.object({
  enabled: z.boolean().optional(),
  routingNote: z.string().max(2000).trim().optional(),
}).strict().refine(patch=>patch.enabled!==undefined || patch.routingNote!==undefined, 'At least one field is required')
export type ComputerProfile = {
  id: string; workspaceId: string; name: string; enabledAssistantIds: string[]
  assistantRoutingNotes: Record<string,string>; deviceId: string | null; connected: boolean; canManage: true
}
type ProfileRow = ComputerProfile & { ownerUserId: string; connectionId: string | null; authSessionId: string | null }
export type ProfileChatScope = { userId: string; workspaceId: string; assistantId: string; conversationId: string; toolName: string }
export const liveConnection = `p.connection_id IS NOT NULL AND p.connection_expires_at>now()
 AND EXISTS (SELECT 1 FROM auth_sessions au JOIN users u ON u.id=au.user_id WHERE au.id=p.connection_auth_session_id
 AND au.user_id=p.owner_user_id AND au.revoked_at IS NULL AND au.expires_at>now() AND au.auth_version=u.auth_version)`
export const profileChatAuthorization = `p.deleted_at IS NULL AND p.owner_user_id=$1 AND p.workspace_id=$2
 AND $3::uuid=ANY(p.enabled_assistant_ids)
 AND EXISTS (SELECT 1 FROM workspace_members m WHERE m.user_id=$1 AND m.workspace_id=$2)
 AND EXISTS (SELECT 1 FROM sessions s JOIN assistants a ON a.id=s.assistant_id
 WHERE s.id=$4 AND s.user_id=$1 AND a.id=$3 AND a.workspace_id=$2 AND NOT ($1::uuid=ANY(a.blocked_user_ids)))
 AND EXISTS (SELECT 1 FROM assistant_capabilities c WHERE c.assistant_id=$3 AND c.capability='native_computer' AND c.revoked_at IS NULL)`
const fields = `p.id,p.workspace_id AS "workspaceId",p.owner_user_id AS "ownerUserId",p.name,
 p.enabled_assistant_ids AS "enabledAssistantIds",p.assistant_routing_notes AS "assistantRoutingNotes",
 p.device_id AS "deviceId",p.connection_id AS "connectionId",p.connection_auth_session_id AS "authSessionId",
 (${liveConnection}) AS connected, true AS "canManage"`
const own = `p.owner_user_id=$1 AND p.deleted_at IS NULL
 AND EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=p.workspace_id AND m.user_id=$1)`
export function publicProfile(p: ProfileRow): ComputerProfile {
  return { id:p.id,workspaceId:p.workspaceId,name:p.name,enabledAssistantIds:p.enabledAssistantIds,
    assistantRoutingNotes:p.assistantRoutingNotes,deviceId:p.deviceId,connected:p.connected,canManage:true }
}
/** Expected metadata authorization/constraint denial, never a storage failure. */
export class ComputerProfilesForbiddenError extends Error {}

export class ComputerProfileStore {
  async list(userId:string, workspaceId:string) {
    const r=await query<ProfileRow>(`SELECT ${fields} FROM computer_profiles p WHERE ${own} AND p.workspace_id=$2 ORDER BY p.created_at`,[userId,workspaceId])
    return r.rows.map(publicProfile)
  }
  async create(userId:string, workspaceId:string,name:string) {
    const r=await query<{id:string}>(`INSERT INTO computer_profiles(owner_user_id,workspace_id,name)
      SELECT $1,$2,$3 WHERE EXISTS(SELECT 1 FROM workspace_members WHERE user_id=$1 AND workspace_id=$2) RETURNING id`,[userId,workspaceId,name])
    if(!r.rows[0]) throw new ComputerProfilesForbiddenError('Profile unavailable')
    return (await this.list(userId,workspaceId)).find(p=>p.id===r.rows[0].id)!
  }
  /** Profile row lock serializes connection rotation, request acceptance and revocation. */
  async locked<T>(userId:string,id:string,fn:(c:PoolClient,p:ProfileRow)=>Promise<T>):Promise<T> {
    const c=await getPool().connect()
    try {
      await c.query('BEGIN')
      const r=await c.query<ProfileRow>(`SELECT ${fields} FROM computer_profiles p WHERE ${own} AND p.id=$2 FOR UPDATE OF p`,[userId,id])
      if(!r.rows[0]) throw new ComputerProfilesForbiddenError('Profile unavailable')
      const result=await fn(c,r.rows[0]); await c.query('COMMIT'); return result
    } catch(e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }
  async invalidate(c:PoolClient,id:string) {
    // Keep unknown fences even on delete/disconnect; never infer nonexecution.
    await c.query(`UPDATE native_computer_sessions SET revoked_at=COALESCE(revoked_at,now()),epoch=epoch+1,
      state=CASE WHEN state='execution_unknown' THEN state ELSE 'ended' END WHERE profile_id=$1 AND revoked_at IS NULL`,[id])
    await c.query(`UPDATE computer_profile_requests SET state='ended' WHERE profile_id=$1 AND state IN ('pending','accepted')`,[id])
  }
  async update(userId:string,id:string,raw:unknown) {
    const patch=ProfilePatchSchema.parse(raw)
    return this.locked(userId,id,async(c,p)=>{
      const ids=[...new Set([...(patch.enabledAssistantIds??[]),...Object.keys(patch.assistantRoutingNotes??{})])]
      if(ids.length) {
        // Workspace membership permits access to workspace assistants (including ownerless primary assistants).
        // The profile itself remains owner-private regardless of assistant ownership.
        const r=await c.query(`SELECT id FROM assistants WHERE workspace_id=$1 AND id=ANY($2::uuid[])
          AND NOT ($3::uuid=ANY(blocked_user_ids))`,[p.workspaceId,ids,userId])
        if(r.rows.length!==ids.length) throw new ComputerProfilesForbiddenError('Assistant unavailable')
      }
      await this.invalidate(c,id)
      await c.query(`UPDATE computer_profiles SET name=COALESCE($2,name),enabled_assistant_ids=COALESCE($3,enabled_assistant_ids),
        assistant_routing_notes=COALESCE($4,assistant_routing_notes) WHERE id=$1`,[id,patch.name,patch.enabledAssistantIds,patch.assistantRoutingNotes])
      return {...publicProfile(p),...patch}
    })
  }
  /** Atomic per-assistant management: never merge a caller's stale grant list. */
  async updateAssistant(userId:string,id:string,assistantId:string,raw:unknown) {
    const patch=ProfileAssistantPatchSchema.parse(raw)
    z.string().uuid().parse(assistantId)
    return this.locked(userId,id,async(c,p)=>{
      // locked() already requires the profile owner to be a current member.
      const assistant=await c.query(`SELECT id FROM assistants WHERE id=$1 AND workspace_id=$2
        AND NOT ($3::uuid=ANY(blocked_user_ids))`,[assistantId,p.workspaceId,userId])
      if(!assistant.rows.length) throw new ComputerProfilesForbiddenError('Assistant unavailable')
      const enabledAssistantIds=[...p.enabledAssistantIds]
      if(patch.enabled===true && !enabledAssistantIds.includes(assistantId)) enabledAssistantIds.push(assistantId)
      const nextIds=patch.enabled===false ? enabledAssistantIds.filter(id=>id!==assistantId) : enabledAssistantIds
      if(nextIds.length>200) throw new ComputerProfilesForbiddenError('Too many assistant grants')
      const assistantRoutingNotes={...p.assistantRoutingNotes}
      if(patch.routingNote!==undefined) assistantRoutingNotes[assistantId]=patch.routingNote
      await this.invalidate(c,id)
      await c.query(`UPDATE computer_profiles SET enabled_assistant_ids=$2,assistant_routing_notes=$3 WHERE id=$1`,
        [id,nextIds,assistantRoutingNotes])
      // This is only a profile grant: never insert or change native capability.
      return {...publicProfile(p),enabledAssistantIds:nextIds,assistantRoutingNotes}
    })
  }
  async delete(userId:string,id:string) {
    await this.locked(userId,id,async c=>{ await this.invalidate(c,id); await c.query(`UPDATE computer_profiles SET deleted_at=now(),connection_id=NULL,connection_expires_at=NULL WHERE id=$1`,[id]) })
  }
  async connect(userId:string,authSessionId:string,id:string,workspaceId:string,deviceId:string) {
    return this.locked(userId,id,async(c,p)=>{
      if(p.workspaceId!==workspaceId || p.deviceId && p.deviceId!==deviceId) throw new Error('Device unavailable')
      const auth=await c.query(`SELECT 1 FROM auth_sessions a JOIN users u ON u.id=a.user_id WHERE a.id=$1 AND a.user_id=$2
        AND a.revoked_at IS NULL AND a.expires_at>now() AND a.auth_version=u.auth_version`,[authSessionId,userId])
      if(!auth.rows.length) throw new Error('Connection unavailable')
      await this.invalidate(c,id)
      const connectionId=randomUUID()
      await c.query(`UPDATE computer_profiles SET device_id=COALESCE(device_id,$2),connection_id=$3,connection_auth_session_id=$4,
        connection_expires_at=now()+interval '45 seconds' WHERE id=$1`,[id,deviceId,connectionId,authSessionId])
      return {connectionId}
    })
  }
  checkConnection(p:ProfileRow,authSessionId:string,connectionId:string) {
    if(!p.connected || p.connectionId!==connectionId || p.authSessionId!==authSessionId || !p.deviceId) throw new Error('Connection unavailable')
  }
  async disconnect(userId:string,authSessionId:string,id:string,connectionId:string) {
    await this.locked(userId,id,async(c,p)=>{
      // An expired connection can still be explicitly stopped, but never renewed.
      if(p.connectionId!==connectionId || p.authSessionId!==authSessionId) throw new Error('Connection unavailable')
      await this.invalidate(c,id)
      await c.query(`UPDATE computer_profiles SET connection_id=NULL,connection_expires_at=NULL WHERE id=$1`,[id])
    })
  }
  async poll(userId:string,authSessionId:string,id:string,connectionId:string) {
    return this.locked(userId,id,async(c,p)=>{
      this.checkConnection(p,authSessionId,connectionId)
      await c.query(`UPDATE computer_profiles SET connection_expires_at=now()+interval '45 seconds' WHERE id=$1`,[id])
      const r=await c.query<{id:string;workspaceId:string;assistantId:string;conversationId:string;assistantName:string}>(
        `SELECT r.id,r.workspace_id AS "workspaceId",r.assistant_id AS "assistantId",r.conversation_id AS "conversationId",
          left(a.name,160) AS "assistantName" FROM computer_profile_requests r
        JOIN sessions s ON s.id=r.conversation_id AND s.user_id=r.user_id AND s.assistant_id=r.assistant_id
        JOIN assistants a ON a.id=r.assistant_id AND a.workspace_id=r.workspace_id
        WHERE r.profile_id=$1 AND r.connection_id=$2 AND r.state='pending' AND r.user_id=$3 AND r.workspace_id=$4
          AND a.id=ANY($5::uuid[]) AND NOT ($3::uuid=ANY(a.blocked_user_ids))
          AND EXISTS(SELECT 1 FROM assistant_capabilities c WHERE c.assistant_id=a.id AND c.capability='native_computer' AND c.revoked_at IS NULL)`,
        [id,connectionId,userId,p.workspaceId,p.enabledAssistantIds])
      const row=r.rows[0]
      if(!row) return {request:null}
      // Assistant identity, not private chat title/content. Bound UTF-16 length
      // too (SQL left counts Unicode characters rather than JS code units).
      const {assistantName,...request}=row
      const name=(assistantName?.replace(/[\u0000-\u001f\u007f]/g,' ').trim() || 'Assistant').slice(0,160)
      return {request:{...request,requester:`${name} · chat ${row.conversationId.slice(0,8)}`}}
    })
  }
  async deny(userId:string,authSessionId:string,id:string,connectionId:string,requestId:string) {
    await this.locked(userId,id,async(c,p)=>{
      this.checkConnection(p,authSessionId,connectionId)
      await c.query(`UPDATE computer_profile_requests SET state='denied' WHERE id=$1 AND profile_id=$2 AND connection_id=$3 AND state='pending'`,[requestId,id,connectionId])
    })
  }
  async request(scope:ProfileChatScope,id:string) {
    return this.locked(scope.userId,id,async(c,p)=>{
      const authorized=await c.query(`SELECT 1 FROM computer_profiles p WHERE p.id=$5 AND ${profileChatAuthorization}`,
        [scope.userId,scope.workspaceId,scope.assistantId,scope.conversationId,id])
      if(!authorized.rows.length) throw new Error('Profile unavailable')
      if(!p.connected) return {code:'offline'}
      const uncertain=await c.query(`SELECT 1 FROM native_computer_sessions WHERE device_id=$1 AND
        (state='execution_unknown' OR run_state IN ('running','execution_unknown'))`,[p.deviceId])
      if(uncertain.rows.length) return {code:'execution_unknown'}
      const old=await c.query(`SELECT id,state FROM computer_profile_requests WHERE profile_id=$1 AND connection_id=$2 AND conversation_id=$3 AND state <> 'released'`,[id,p.connectionId,scope.conversationId])
      if(old.rows[0]) return {code:old.rows[0].state==='pending'?'local_consent_required':'reconnect_required',requestId:old.rows[0].id}
      const busy=await c.query(`SELECT 1 FROM native_computer_sessions WHERE device_id=$1 AND
        (state='execution_unknown' OR run_state IN ('running','execution_unknown') OR (revoked_at IS NULL AND expires_at>now()))
        UNION ALL SELECT 1 FROM computer_profile_requests WHERE profile_id=$2 AND state='pending'`,[p.deviceId,id])
      if(busy.rows.length) return {code:'busy'}
      const r=await c.query(`INSERT INTO computer_profile_requests(profile_id,connection_id,user_id,workspace_id,assistant_id,conversation_id,tool_name)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[id,p.connectionId,scope.userId,scope.workspaceId,scope.assistantId,scope.conversationId,scope.toolName])
      return {code:'local_consent_required',requestId:r.rows[0].id}
    })
  }
}
