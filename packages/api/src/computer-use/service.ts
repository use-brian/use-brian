import { ComputerProfileStore, profileChatAuthorization, liveConnection, type ProfileChatScope } from '../db/computer-profile-store.js'
import { safeReadinessUrl, type ReadinessCode } from './readiness.js'
import { z } from 'zod'
import { NativeModelIdSchema, type TaskStore, type Tool, type ToolContext } from '@use-brian/core'
import { randomUUID, createHash } from 'node:crypto'
import { CommonIdentitySchema, CommandSchema, GrantSchema, StatusSchema, NATIVE_PROTOCOL, sameIdentity, type NativeCommand, type NativeGrant, type NativeTaskGrant, ReceiptSchema, MAX_MESSAGE_BYTES, sameTarget } from '@use-brian/computer-control/protocol.js'
import { query, queryWithRLS } from '../db/client.js'
import { resolveWorkspaceViewpoint } from '../db/workspace-viewpoint.js'
import { assertExecutionResourceScope, buildAccessPredicate } from '../db/access-predicate.js'
import { signNativeToken } from '../auth/native-computer-token.js'
export type NativeScope = { userId: string; workspaceId: string; assistantId: string; conversationId: string; taskId: string | null; profileId?: string | null; connectionId?: string | null; toolName?: string }
// Explicit allowlist: never persist provider URLs, exceptions, AX, goals or frames.
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const money = z.number().finite().nonnegative()
export { NativeModelIdSchema } from '@use-brian/core'
export const NativeAttemptSchema = z.object({
  attemptId: z.string().uuid(),
  invocationState: z.enum(['pending', 'settled']),
  interrupted: z.boolean(),
  requestedModel: NativeModelIdSchema,
  model: NativeModelIdSchema.nullable(),
  providerKind: z.enum(['custom', 'openai', 'anthropic', 'gemini', 'openrouter', 'typesafe', 'other']),
  lane: z.enum(['text', 'vision', 'decision']), outcome: z.enum(['pending', 'ok', 'failed']),
  operation: z.enum(['plan', 'decompose', 'next-action', 'verify-progress', 'ground']).nullable(),
  stage: z.enum(['direct', 'primary_decision', 'llm_only', 'generation', 'uncertainty_review', 'operational_failover', 'shadow_legacy']),
  perceptionPath: z.enum(['ax', 'vision']),
  // NULL is unknown/not supplied; none means known not to be a follow-up.
  fallbackReason: z.enum(['none', 'generation_required', 'uncertain', 'inconsistent']).nullable(),
  disposition: z.enum(['complete', 'follow_up', 'unavailable']).nullable(),
  durationMs: count,
  usage: z.object({ inputTokens: count, outputTokens: count, cacheReadTokens: count.optional(), cacheWriteTokens: count.optional() }).nullable(),
  incurredCostUsd: money.nullable(), estimatedBilledCostUsd: money.nullable(),
  providerKeySource: z.enum(['user', 'platform']),
})
export type NativeAttemptRecord = {
  /** Only adapter-owned billing asks for a durable once-only claim. */
  claimBilling?: boolean
  /** Trusted adapter acknowledgement, never inference/provider supplied. */
  billingAcknowledgement?: 'recorded' | 'unknown'
  scope: NativeScope; sessionId: string; grantId: string
  attempt: z.infer<typeof NativeAttemptSchema>
}
type Row = NativeScope & { id: string; deviceId: string; deploymentId: string; challenge: string; epoch: number; state: string; expiresAt: Date; grantId: string | null; authSessionId: string | null; runState: string | null }
const columns = `id,user_id AS "userId",workspace_id AS "workspaceId",assistant_id AS "assistantId",conversation_id AS "conversationId",task_id AS "taskId",profile_id AS "profileId",connection_id AS "connectionId",device_id AS "deviceId",deployment_id AS "deploymentId",challenge,epoch,state,expires_at AS "expiresAt",grant_id AS "grantId",auth_session_id AS "authSessionId",run_state AS "runState"`
export const ExecutionCheckSchema = z.object({
  commandId: z.string().min(1).max(256), grantId: z.string().min(1).max(256),
  epoch: z.number().int().positive(), deadlineAt: z.number().int().positive(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
type ExecutionCheck = z.infer<typeof ExecutionCheckSchema>
export class NativeComputerService {
  // Process-local by design: dispatch and revalidation require one/sticky API instance.
  // A restart or another instance fails closed; the durable unknown fence remains.
  private readonly pending = new Map<string, { check: ExecutionCheck; scope: NativeScope }>()
  async revalidate(id: string, userId: string, authSessionId: string, check: ExecutionCheck) {
    const entry = this.pending.get(id)
    const grant = this.grants.get(id)
    const live = () => entry && this.pending.get(id) === entry && entry.scope.userId === userId &&
      entry.check.deadlineAt > Date.now() &&
      !Object.keys(entry.check).some(k => entry.check[k as keyof ExecutionCheck] !== check[k as keyof ExecutionCheck]) &&
      grant?.allowControl && this.grants.get(id) === grant && grant.expiresAt > Date.now() &&
      grant.grantId === check.grantId && grant.epoch === check.epoch
    if (!live()) throw new Error('Native execution denied')
    const scope = entry!.scope
    // One statement gives the authorization intersection one database snapshot.
    // It is not a claim of instantaneous distributed revocation after this check.
    const result = await query(`SELECT 1 FROM native_computer_sessions n
      WHERE n.id=$1 AND n.user_id=$2 AND n.auth_session_id=$3
        AND n.workspace_id=$4 AND n.assistant_id=$5 AND n.conversation_id=$6 AND n.task_id IS NOT DISTINCT FROM $7::uuid
        AND n.grant_id=$8 AND n.epoch=$9 AND n.deployment_id=$10 AND n.device_id=$11
        AND n.state='execution_unknown' AND n.revoked_at IS NULL AND n.expires_at>now()
        AND EXISTS (SELECT 1 FROM auth_sessions a JOIN users u ON u.id=a.user_id
          WHERE a.id=n.auth_session_id AND a.user_id=n.user_id
            AND a.revoked_at IS NULL AND a.expires_at>now() AND a.auth_version=u.auth_version)
        AND EXISTS (SELECT 1 FROM workspace_members m
          WHERE m.workspace_id=n.workspace_id AND m.user_id=n.user_id)
        AND EXISTS (SELECT 1 FROM sessions s JOIN assistants a ON a.id=s.assistant_id
          WHERE s.id=n.conversation_id AND s.user_id=n.user_id
            AND a.id=n.assistant_id AND a.workspace_id=n.workspace_id
            AND (n.profile_id IS NULL OR NOT (n.user_id=ANY(a.blocked_user_ids))))
        AND EXISTS (SELECT 1 FROM assistant_capabilities c
          WHERE c.assistant_id=n.assistant_id AND c.capability='native_computer' AND c.revoked_at IS NULL)
        AND ((n.profile_id IS NULL AND EXISTS (SELECT 1 FROM tasks t
          WHERE t.id=n.task_id AND t.workspace_id=n.workspace_id AND t.user_id=n.user_id
            AND t.assistant_id=n.assistant_id AND t.valid_to IS NULL AND t.retracted_at IS NULL AND NOT t.scope_held)) OR (n.profile_id=$12 AND n.task_id IS NULL
          AND EXISTS (SELECT 1 FROM computer_profiles p WHERE p.id=n.profile_id AND p.deleted_at IS NULL
            AND p.owner_user_id=n.user_id AND p.workspace_id=n.workspace_id AND n.assistant_id=ANY(p.enabled_assistant_ids)
            AND p.connection_id=n.connection_id AND p.device_id=n.device_id AND p.connection_auth_session_id=n.auth_session_id
            AND ${liveConnection})))
        AND NOT EXISTS (SELECT 1 FROM mcp_tool_settings p
          WHERE p.assistant_id=n.assistant_id AND p.user_id=n.user_id
            AND p.server_name='native_computer' AND p.tool_name=$13 AND p.policy='block')
        AND NOT EXISTS (SELECT 1 FROM workspace_tool_policy p
          WHERE p.workspace_id=n.workspace_id
            AND p.server_name='native_computer' AND p.tool_name=$13 AND p.policy='block')`,
    [id,userId,authSessionId,scope.workspaceId,scope.assistantId,scope.conversationId,scope.taskId,
      check.grantId,check.epoch,this.config.deploymentId,grant!.identity.deviceId,scope.profileId??null,scope.toolName??'nativeComputerTask'])
    if (!live() || !result.rows.length) throw new Error('Native execution denied')
    return { authorized: true as const }
  }
  // allowControl=false is a one-shot LOCAL inspector grant. Remote read-only model tasks
  // were never implemented; pairing does not authorize any API worker or inference.
  private readonly grants = new Map<string, NativeGrant>()
  // Only run() can bind an exact context to a requested session. Renderer/model
  // fields (including channelId) are not authority, and a lost pin never falls back.
  private readonly runBindings = new WeakMap<ToolContext, { grant: NativeTaskGrant; scope: NativeScope }>()
  // Remember only object provenance after cleanup, never grant authority. A late
  // use of a completed direct-run context must not become generic resolution.
  private readonly runContexts = new WeakSet<ToolContext>()
  constructor(private config: { relayUrl: string; relaySecret: string; jwtSecret: string; deploymentId: string }) {}
  /** SELECT-only preflight. Never creates grants, expires sessions or clears unknown fences. */
  async readiness(scope: NativeScope, authSessionId: string, deviceId: string | undefined): Promise<ReadinessCode[]> {
    const blockers: ReadinessCode[] = []
    try {
      safeReadinessUrl(this.config.relayUrl)
      if (!CommonIdentitySchema.shape.deploymentId.safeParse(this.config.deploymentId).success
        || !this.config.deploymentId.trim() || !this.config.relaySecret || !this.config.jwtSecret) return ['configuration_invalid']
    } catch { return ['configuration_invalid'] }
    try {
      const schema = await query(`SELECT name FROM public._migrations WHERE name = ANY($1::text[])`,
        [['620_native_computer_sessions.sql', '621_native_usage_receipts.sql']])
      if (schema.rows.length !== 2) return ['schema_unavailable']
      // Verify actual queried shape, not just migration ledger entries.
      await query(`SELECT n.auth_session_id,n.run_state,n.state,n.device_id,n.deployment_id,
        a.requested_model,b.admission,b.receipt FROM native_computer_sessions n
        CROSS JOIN native_computer_inference_attempts a CROSS JOIN native_computer_billing_intents b LIMIT 0`)
    } catch { return ['schema_unavailable'] }
    try {
      const auth = await query(`SELECT 1 FROM auth_sessions a JOIN users u ON u.id=a.user_id
        WHERE a.id=$1 AND a.user_id=$2 AND a.revoked_at IS NULL AND a.expires_at>now()
        AND a.auth_version=u.auth_version`, [authSessionId, scope.userId])
      if (!auth.rows.length) return ['auth_session_denied']
      if (!await this.authorized(scope)) return ['scope_denied']
      try { await this.assertPolicy(scope) } catch { return ['policy_denied'] }
      if (deviceId !== undefined) {
        const busy = await query(`SELECT 1 FROM native_computer_sessions WHERE deployment_id=$1 AND device_id=$2
          AND (state='execution_unknown' OR run_state IN ('running','execution_unknown')
            OR (revoked_at IS NULL AND expires_at>now())) LIMIT 1`, [this.config.deploymentId, deviceId])
        if (busy.rows.length) return ['device_busy']
      }
      // Exact native_computer_conversation_lease predicate: global across devices
      // and deployments, including expired but not-yet-revoked rows. No cleanup here.
      const conversationBusy = await query(`SELECT 1 FROM native_computer_sessions
        WHERE user_id=$1 AND conversation_id=$2 AND revoked_at IS NULL LIMIT 1`,
      [scope.userId, scope.conversationId])
      if (conversationBusy.rows.length) {
        if (deviceId !== undefined) return ['device_busy']
        blockers.push('device_busy')
      }
    } catch { return ['check_failed'] }
    try {
      const response = await fetch(`${this.config.relayUrl.replace(/\/$/,'')}/internal/native-computer/readiness`, {
        headers: { 'x-relay-secret': this.config.relaySecret }, redirect: 'error', signal: AbortSignal.timeout(5000),
      })
      if (!response.ok || !response.body) { await response.body?.cancel(); return [...blockers, 'relay_unavailable'] }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
      try {
        while (true) { const { done, value } = await reader.read(); if (done) break
          size += value.byteLength; if (size > 1024) throw new Error('Bound exceeded'); chunks.push(value) }
      } finally { await reader.cancel() }
      const parsed = z.object({ enabled: z.boolean(), protocol: z.literal('native-computer-v1') }).strict()
        .parse(JSON.parse(Buffer.concat(chunks).toString()))
      return parsed.enabled ? blockers : [...blockers, 'relay_disabled']
    } catch { return [...blockers, 'relay_unavailable'] }
  }
  async relay(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.config.relayUrl.replace(/\/$/,'')}/internal/native-computer${path}`, { method, headers: { 'x-relay-secret': this.config.relaySecret, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(35_000) })
    if (!response.ok) throw new Error('Native relay unavailable or lease denied')
    // Stream-limit before parsing rather than trusting Content-Length.
    const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let bytes = 0
    try { while (true) { const {done,value} = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > MAX_MESSAGE_BYTES) throw new Error('Native response too large'); chunks.push(value) } }
    finally { await reader.cancel() }
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown
  }
  /** Picker metadata only. Predicates mirror authorized below; dispatch still revalidates. */
  async contextTasks(s: Omit<NativeScope, 'taskId'>): Promise<{ id: string; title: string }[]> {
    // Same member read ceiling and universal task predicate as /brain/tasks,
    // intersected with native ownership. Never disclose titles via the system pool.
    const ctx = await resolveWorkspaceViewpoint(s.userId, s.workspaceId, s.assistantId)
    if (!ctx) return []
    const access = buildAccessPredicate(ctx, { alias: 't', startIdx: 5 })
    const r = await queryWithRLS<{ id: string; title: string }>(s.userId, `SELECT DISTINCT t.id, left(t.title, 256) AS title
      FROM sessions s JOIN assistants a ON a.id=s.assistant_id
      JOIN workspace_members m ON m.workspace_id=$2 AND m.user_id=$1
      JOIN assistant_capabilities c ON c.assistant_id=a.id AND c.capability='native_computer' AND c.revoked_at IS NULL
      JOIN tasks t ON t.workspace_id=$2 AND t.user_id=$1 AND t.assistant_id=a.id AND t.valid_to IS NULL AND t.retracted_at IS NULL AND NOT t.scope_held
      WHERE s.id=$4 AND s.user_id=$1 AND a.id=$3 AND a.workspace_id=$2
      AND ${access.sql}
      ORDER BY t.id LIMIT 500`, [s.userId,s.workspaceId,s.assistantId,s.conversationId,...access.params])
    return r.rows.map(({ id, title }) => ({ id, title }))
  }
  /** Explicit user-authored task, not a model execution or a native grant. */
  async createContextTask(s: Omit<NativeScope, 'taskId'>, title: string, tasks: Pick<TaskStore, 'create'>) {
    const denied = () => Object.assign(new Error('Native context denied'), { code: 'native_context_denied' })
    // Do not let the viewpoint's stale-assistant fallback authorize a different
    // assistant. Require the exact owned conversation and explicit capability.
    const binding = await queryWithRLS(s.userId, `SELECT s.id FROM sessions s
      JOIN assistants a ON a.id=s.assistant_id
      JOIN workspace_members m ON m.workspace_id=a.workspace_id AND m.user_id=$1
      JOIN assistant_capabilities c ON c.assistant_id=a.id AND c.capability='native_computer' AND c.revoked_at IS NULL
      WHERE s.id=$4 AND s.user_id=$1 AND a.id=$3 AND a.workspace_id=$2`,
    [s.userId, s.workspaceId, s.assistantId, s.conversationId])
    if (!binding.rows.length) throw denied()
    const access = await resolveWorkspaceViewpoint(s.userId, s.workspaceId, s.assistantId)
    if (!access || access.assistantId !== s.assistantId) throw denied()
    // This is newly entered text, not derived conversation content. Use the
    // ordinary manual-task internal classification, never downgrade to public.
    const visibility = { userId: s.userId, assistantId: s.assistantId }
    const scope = { workspaceId: s.workspaceId, ...visibility, sensitivity: 'internal' as const, compartments: [], projectIds: [] }
    assertExecutionResourceScope(scope, 'mutation', access)
    assertExecutionResourceScope(scope, 'read', access)
    const task = await tasks.create({ userId: s.userId, workspaceId: s.workspaceId,
      title, status: 'todo', visibility, access, sensitivity: 'internal',
      source: 'user', sourceSessionId: s.conversationId, writtenBy: 'user' })
    return { id: task.id, title: task.title.slice(0, 256) }
  }
  readonly profiles = new ComputerProfileStore()
  async authorized(s: NativeScope, db: {query:typeof query} = {query}): Promise<boolean> {
    if (s.profileId) {
      if (s.taskId) return false
      const r=await db.query(`SELECT 1 FROM computer_profiles p WHERE p.id=$5 AND ${profileChatAuthorization}
        AND ($6::uuid IS NULL OR (p.connection_id=$6 AND ${liveConnection}))`,
        [s.userId,s.workspaceId,s.assistantId,s.conversationId,s.profileId,s.connectionId??null])
      return r.rows.length>0
    }
    if (!s.userId || !s.workspaceId || !s.assistantId || !s.conversationId || !s.taskId) return false
    const r = await db.query(`SELECT 1 FROM sessions s JOIN assistants a ON a.id=s.assistant_id
      JOIN workspace_members m ON m.workspace_id=$2 AND m.user_id=$1
      JOIN assistant_capabilities c ON c.assistant_id=a.id AND c.capability='native_computer' AND c.revoked_at IS NULL
      JOIN tasks t ON t.id=$5 AND t.workspace_id=$2 AND t.user_id=$1 AND t.assistant_id=a.id AND t.valid_to IS NULL AND t.retracted_at IS NULL AND NOT t.scope_held
      WHERE s.id=$4 AND s.user_id=$1 AND a.id=$3 AND a.workspace_id=$2`, [s.userId,s.workspaceId,s.assistantId,s.conversationId,s.taskId])
    return r.rows.length > 0
  }
  async create(input: NativeScope & { deviceId: string; challenge: string; authSessionId: string }) {
    if (!input.taskId || input.profileId) throw new Error('Task scope required')
    if (!await this.authorized(input)) throw new Error('Native scope denied')
    const unresolved = await query(`SELECT id FROM native_computer_sessions WHERE deployment_id=$1 AND device_id=$2 AND (state='execution_unknown' OR run_state IN ('running','execution_unknown')) LIMIT 1`,[this.config.deploymentId,input.deviceId])
    if (unresolved.rows.length) throw new Error('Manual reconciliation required')
    const id = randomUUID(); const expiresAt = new Date(Date.now()+120_000)
    await query(`UPDATE native_computer_sessions SET revoked_at=now(),state=CASE WHEN state='execution_unknown' THEN state ELSE 'ended' END WHERE expires_at<=now() AND revoked_at IS NULL`)
    await query(`INSERT INTO native_computer_sessions(id,user_id,workspace_id,assistant_id,conversation_id,task_id,device_id,deployment_id,challenge,expires_at,auth_session_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id,input.userId,input.workspaceId,input.assistantId,input.conversationId,input.taskId,input.deviceId,this.config.deploymentId,input.challenge,expiresAt,input.authSessionId])
    await this.audit(id,'created')
    return { protocol: NATIVE_PROTOCOL, identity: { deploymentId: this.config.deploymentId, userId: input.userId, workspaceId: input.workspaceId, deviceId: input.deviceId, sessionId: id, conversationId: input.conversationId, taskId: input.taskId }, expiresAt: expiresAt.getTime(), state: 'awaiting_local_consent' }
  }
  async acceptProfile(userId:string,authSessionId:string,profileId:string,connectionId:string,requestId:string,challenge:string) {
    return this.profiles.locked(userId,profileId,async(c,p)=>{
      this.profiles.checkConnection(p,authSessionId,connectionId)
      const r=await c.query<ProfileChatScope>(`SELECT user_id AS "userId",workspace_id AS "workspaceId",assistant_id AS "assistantId",
        conversation_id AS "conversationId",tool_name AS "toolName" FROM computer_profile_requests
        WHERE id=$1 AND profile_id=$2 AND connection_id=$3 AND state='pending'`,[requestId,profileId,connectionId])
      const scope=r.rows[0]
      if(!scope || !await this.authorized({...scope,taskId:null,profileId,connectionId},c)) throw new Error('Profile unavailable')
      await this.assertPolicy({...scope,taskId:null,profileId},c)
      const busy=await c.query(`SELECT 1 FROM native_computer_sessions WHERE deployment_id=$1 AND device_id=$2
        AND (state='execution_unknown' OR run_state IN ('running','execution_unknown'))`,[this.config.deploymentId,p.deviceId])
      if(busy.rows.length) throw new Error('Manual reconciliation required')
      await c.query(`UPDATE native_computer_sessions SET revoked_at=now(),state=CASE WHEN state='execution_unknown' THEN state ELSE 'ended' END
        WHERE expires_at<=now() AND revoked_at IS NULL`)
      const id=randomUUID(), expiresAt=new Date(Date.now()+120_000)
      await c.query(`INSERT INTO native_computer_sessions(id,user_id,workspace_id,assistant_id,conversation_id,profile_id,connection_id,
        device_id,deployment_id,challenge,expires_at,auth_session_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id,userId,scope.workspaceId,scope.assistantId,scope.conversationId,profileId,connectionId,p.deviceId,this.config.deploymentId,challenge,expiresAt,authSessionId])
      await c.query(`UPDATE computer_profile_requests SET state='accepted',session_id=$2 WHERE id=$1`,[requestId,id])
      return {protocol:NATIVE_PROTOCOL,identity:{deploymentId:this.config.deploymentId,userId,workspaceId:scope.workspaceId,
        deviceId:p.deviceId!,sessionId:id,conversationId:scope.conversationId,profileId},expiresAt:expiresAt.getTime(),state:'awaiting_local_consent'}
    })
  }
  async profileBinding(scope:ProfileChatScope,profileId:string) {
    for(const [id,grant] of this.grants) {
      if(!('profileId' in grant.identity) || grant.identity.profileId!==profileId || grant.identity.userId!==scope.userId
        || grant.identity.workspaceId!==scope.workspaceId || grant.identity.conversationId!==scope.conversationId) continue
      const row=await this.get(id,scope.userId).catch(()=>null)
      if(!row || grant.expiresAt<=Date.now()) {
        if(this.grants.get(id)===grant) this.grants.delete(id)
        continue // A disconnected lease must not shadow a later explicit reconnect.
      }
      if(row.assistantId!==scope.assistantId || row.profileId!==profileId || row.taskId!==null || row.state!=='active' || row.grantId!==grant.grantId
        || row.epoch!==grant.epoch || row.deviceId!==grant.identity.deviceId || row.deploymentId!==grant.identity.deploymentId || !grant.allowControl || this.grants.get(id)!==grant) continue
      return {grant,scope:{...scope,taskId:null,profileId,connectionId:row.connectionId} satisfies NativeScope}
    }
    return null
  }
  /** Publication must use the original grant, not resolve a replacement lease.
   * This is read-only: failed publication cannot clear an uncertainty fence. */
  async assertProfilePublication(scope:NativeScope,grant:NativeGrant) {
    const live=()=>this.grants.get(grant.identity.sessionId)===grant && grant.expiresAt>Date.now()
    if(!scope.profileId || !scope.connectionId || !live()) throw new Error('Profile publication denied')
    await this.assertPolicy(scope)
    const row=await this.get(grant.identity.sessionId,scope.userId)
    if(!live() || row.state!=='active' || row.runState==='execution_unknown' || row.taskId!==null
      || row.profileId!==scope.profileId || row.connectionId!==scope.connectionId
      || row.workspaceId!==scope.workspaceId || row.assistantId!==scope.assistantId || row.conversationId!==scope.conversationId
      || row.grantId!==grant.grantId || row.epoch!==grant.epoch
      || !sameIdentity(grant.identity,{deploymentId:row.deploymentId,deviceId:row.deviceId,sessionId:row.id,
        userId:row.userId,workspaceId:row.workspaceId,conversationId:row.conversationId,profileId:row.profileId}))
      throw new Error('Profile publication denied')
  }
  /** Explicit release allows a different chat to request consent, never reuses the old lease. */
  async releaseProfile(scope:ProfileChatScope,profileId:string) {
    const revoked=await this.profiles.locked(scope.userId,profileId,async(c,p)=>{
      const rows=await c.query<Row>(`SELECT ${columns} FROM native_computer_sessions WHERE profile_id=$1 AND user_id=$2
        AND workspace_id=$3 AND assistant_id=$4 AND conversation_id=$5 FOR UPDATE`,
        [profileId,scope.userId,scope.workspaceId,scope.assistantId,scope.conversationId])
      const cleanup:{id:string;released:boolean}[]=[]
      for(const row of rows.rows) {
        const grant=this.grants.get(row.id)
        const released=row.state==='active' && row.runState!== 'execution_unknown' && row.runState!=='running'
          && !this.pending.has(row.id) && !!grant && grant.expiresAt>Date.now() && row.expiresAt.getTime()>Date.now()
          && row.connectionId===p.connectionId && row.deviceId===p.deviceId && row.authSessionId===p.authSessionId && p.connected && row.grantId===grant.grantId && row.epoch===grant.epoch
          && sameIdentity(grant.identity,{deploymentId:row.deploymentId,deviceId:row.deviceId,sessionId:row.id,
            userId:row.userId,workspaceId:row.workspaceId,conversationId:row.conversationId,profileId})
        // No network calls or global-pool queries under these row locks.
        // Forgetting before commit is conservative if the transaction rolls back.
        this.grants.delete(row.id)
        this.pending.delete(row.id)
        const updated=await c.query(`UPDATE native_computer_sessions SET revoked_at=COALESCE(revoked_at,now()),
          state=CASE WHEN state='execution_unknown' THEN state ELSE 'ended' END,epoch=epoch+1
          WHERE id=$1 AND revoked_at IS NULL RETURNING id`,[row.id])
        if(updated.rows.length) await c.query(`INSERT INTO native_computer_audit(session_id,event) VALUES($1,'revoked')`,[row.id])
        const intentionalRelease=!!released && updated.rows.length>0
        if(intentionalRelease) await c.query(`UPDATE computer_profile_requests SET state='released'
          WHERE profile_id=$1 AND connection_id=$2 AND user_id=$3 AND conversation_id=$4
            AND session_id=$5 AND state='accepted'`,[profileId,row.connectionId,scope.userId,scope.conversationId,row.id])
        cleanup.push({id:row.id,released:intentionalRelease})
      }
      await c.query(`UPDATE computer_profile_requests SET state='ended' WHERE profile_id=$1 AND user_id=$2 AND conversation_id=$3 AND state IN ('pending','accepted')`,
        [profileId,scope.userId,scope.conversationId])
      return cleanup
    })
    // A lost relay response never restores database authority. Repeating cleanup
    // uses ordinary revocation (no claim of an intentional idle release).
    const cleanup=await Promise.allSettled(revoked.map(row=>row.released
      ? this.relay(`/sessions/${row.id}`,'DELETE',{reason:'released'})
      : this.relay(`/sessions/${row.id}`,'DELETE')))
    if(cleanup.some(result=>result.status==='rejected')) throw new Error('Native release cleanup unavailable')
  }
  private async get(id: string, userId: string): Promise<Row> {
    const r = await query<Row>(`SELECT ${columns} FROM native_computer_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now()
      AND EXISTS (SELECT 1 FROM auth_sessions a JOIN users u ON u.id=a.user_id
        WHERE a.id=native_computer_sessions.auth_session_id AND a.user_id=$2
        AND a.revoked_at IS NULL AND a.expires_at>now() AND a.auth_version=u.auth_version)
      AND (profile_id IS NULL OR EXISTS(SELECT 1 FROM computer_profiles p WHERE p.id=native_computer_sessions.profile_id
        AND p.connection_id=native_computer_sessions.connection_id AND p.device_id=native_computer_sessions.device_id
        AND p.connection_auth_session_id=native_computer_sessions.auth_session_id AND ${liveConnection}))`,[id,userId])
    const row=r.rows[0]; if (!row || !await this.authorized(row)) throw new Error('Native session unavailable')
    return row
  }
  async exchange(id: string, userId: string, verifier: string, raw: unknown, authSessionId?: string) {
    const row=await this.get(id,userId); const grant=GrantSchema.parse(raw)
    if(row.profileId && authSessionId !== row.authSessionId) throw new Error('Desktop auth session mismatch')
    const identity = { deploymentId: row.deploymentId, userId: row.userId, workspaceId: row.workspaceId, deviceId: row.deviceId, sessionId: row.id, conversationId: row.conversationId, ...(row.profileId ? {profileId:row.profileId} : {taskId:row.taskId!}) }
    if (createHash('sha256').update(verifier).digest('base64url') !== row.challenge || !sameIdentity(identity,grant.identity) || grant.epoch <= 0 || grant.expiresAt <= Date.now() || grant.expiresAt > Date.now()+900_000) throw new Error('Native pairing denied')
    if(row.profileId && (!('purpose' in grant) || grant.purpose!=='chat-tools' || !grant.allowControl || grant.targets.length!==1)) throw new Error('Chat grant denied')
    const consumed=await query(`UPDATE native_computer_sessions SET state='active',grant_id=$3,expires_at=$4,epoch=$5 WHERE id=$1 AND user_id=$2 AND state='awaiting_local_consent' AND revoked_at IS NULL AND expires_at>now() RETURNING id`,[id,userId,grant.grantId,new Date(grant.expiresAt),grant.epoch])
    if (!consumed.rows.length) throw new Error('Pairing already consumed')
    const token=signNativeToken({aud:NATIVE_PROTOCOL,kind:'native-session',identity,grantId:grant.grantId,epoch:grant.epoch,exp:grant.expiresAt,jti:randomUUID()},this.config.jwtSecret)
    try { await this.relay('/register','POST',{grant,token}); await this.audit(id,'paired') }
    catch (error) { await this.revoke(id,userId); throw error }
    this.grants.set(id,grant)
    return { token, relayUrl: this.config.relayUrl.replace(/^http/,'ws').replace(/\/$/,'')+'/native-computer-v1', expiresAt:grant.expiresAt }
  }
  async status(id: string,userId: string) {
    const row=await this.get(id,userId)
    const raw=await this.relay(`/sessions/${id}`) as {active?:boolean;status?:unknown}
    const parsed=StatusSchema.safeParse(raw.status)
    const relay={active:raw.active===true,...(parsed.success?{status:parsed.data}:{})}
    if(row.state==='active' && (relay as {active?:boolean}).active!==true) {
      await this.revoke(id,userId)
      if(row.profileId && row.connectionId && row.authSessionId) await this.profiles.disconnect(userId,row.authSessionId,row.profileId,row.connectionId)
      return {sessionId:id,state:'ended',epoch:row.epoch+1,expiresAt:row.expiresAt.getTime(),relay}
    }
    return {sessionId:id,state:row.state,epoch:row.epoch,expiresAt:row.expiresAt.getTime(),relay}
  }
  async stop(id:string,userId:string) {
    const r=await query<{profileId:string|null;connectionId:string|null;authSessionId:string|null}>(`SELECT profile_id AS "profileId",
      connection_id AS "connectionId",auth_session_id AS "authSessionId" FROM native_computer_sessions WHERE id=$1 AND user_id=$2`,[id,userId])
    const row=r.rows[0]
    if(row?.profileId && row.connectionId && row.authSessionId) {
      await this.profiles.disconnect(userId,row.authSessionId,row.profileId,row.connectionId)
    }
    await this.revoke(id,userId)
  }
  async revoke(id: string,userId: string) {
    if (this.grants.get(id)?.identity.userId === userId) this.grants.delete(id)
    if (this.pending.get(id)?.scope.userId === userId) this.pending.delete(id)
    const r=await query(`UPDATE native_computer_sessions SET revoked_at=now(),state=CASE WHEN state='execution_unknown' THEN state ELSE 'ended' END,epoch=epoch+1 WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id`,[id,userId])
    // Always retry relay revocation, including an earlier failed DELETE.
    const own=await query(`SELECT id FROM native_computer_sessions WHERE id=$1 AND user_id=$2`,[id,userId])
    if (!own.rows.length) throw new Error('Native session unavailable')
    await this.relay(`/sessions/${id}`,'DELETE')
    if(r.rows.length) await this.audit(id,'revoked')
  }
  /** Trusted provider supplies scope from ToolContext, never from model arguments. */
  async dispatch(scope: NativeScope, command: NativeCommand) {
    command = CommandSchema.parse(command)
    const row=await this.get(command.identity.sessionId,scope.userId)
    await this.assertPolicy(scope)
    if (row.workspaceId!==scope.workspaceId || row.assistantId!==scope.assistantId || row.conversationId!==scope.conversationId || row.taskId!==scope.taskId || (row.profileId??null)!==(scope.profileId??null) || row.grantId!==command.grantId || row.epoch!==command.epoch || row.state!=='active') throw new Error('Native command scope denied')
    const grant = this.grants.get(row.id)
    if (!grant?.allowControl || grant.grantId !== command.grantId || grant.epoch !== command.epoch || !sameIdentity(grant.identity, command.identity)) {
      return { commandId: command.commandId, outcome: 'not_executed' as const, code: 'denied' as const }
    }
    // Persist ambiguity BEFORE sending, so an API crash cannot silently clear it.
    const admitted = await query(`UPDATE native_computer_sessions SET state='execution_unknown' WHERE id=$1 AND revoked_at IS NULL AND state='active' RETURNING id`,[row.id])
    if (!admitted.rows.length) throw new Error('Native session busy or revoked')
    const bounded = CommandSchema.parse({...command,deadlineAt:Math.min(command.deadlineAt,Date.now()+29_000,row.expiresAt.getTime())})
    const entry = { scope: {...scope}, check: { commandId: bounded.commandId, grantId: bounded.grantId, epoch: bounded.epoch, deadlineAt: bounded.deadlineAt, digest: createHash('sha256').update(JSON.stringify(bounded)).digest('hex') } }
    this.pending.set(row.id, entry)
    const expiry = setTimeout(() => { if (this.pending.get(row.id) === entry) this.pending.delete(row.id) }, Math.max(0, bounded.deadlineAt - Date.now()))
    try {
      const receipt = ReceiptSchema.parse(await this.relay('/command','POST',bounded))
      if (receipt.commandId !== command.commandId || (receipt.observation && (!sameIdentity(receipt.observation.identity,command.identity) || receipt.observation.epoch !== command.epoch || !sameTarget(receipt.observation.target,command.action.target)))) throw new Error('Native receipt identity mismatch')
      if (receipt.outcome === 'execution_unknown') await this.markUnknown(row.id,scope.userId)
      else await query(`UPDATE native_computer_sessions SET state='active' WHERE id=$1 AND revoked_at IS NULL AND state='execution_unknown'`,[row.id])
      if(row.profileId && row.connectionId && row.authSessionId && ['stopped','expired'].includes(receipt.code)) await this.profiles.disconnect(scope.userId,row.authSessionId,row.profileId,row.connectionId)
      await query('INSERT INTO native_computer_audit(session_id,event,command_id,action_kind,outcome,code) VALUES($1,\'action\',$2,$3,$4,$5)', [row.id,command.commandId,command.action.kind,receipt.outcome,receipt.code])
      return receipt
    } catch (error) { await this.markUnknown(row.id,scope.userId); throw error }
    finally { clearTimeout(expiry); if (this.pending.get(row.id) === entry) this.pending.delete(row.id) }
  }
  async markUnknown(id:string,userId:string) {
    if (this.pending.get(id)?.scope.userId === userId) this.pending.delete(id)
    this.grants.delete(id)
    await query(`UPDATE native_computer_sessions SET state='execution_unknown',revoked_at=COALESCE(revoked_at,now()),epoch=epoch+1 WHERE id=$1 AND user_id=$2`,[id,userId])
    await this.relay(`/sessions/${id}`,'DELETE').catch(()=>{})
  }
  async binding(scope: Omit<NativeScope,'taskId'>, taskIds?: readonly string[], context?: ToolContext) {
    const pinned = context && this.runBindings.get(context)
    // A middleware clone loses the object pin; native-channel metadata can only
    // deny that request, never supply authority or enable generic fallback.
    if (context && !pinned && (this.runContexts.has(context) || context.channelType === 'native-computer')) return null
    const matchesScope = (s: NativeScope) => s.userId === scope.userId && s.workspaceId === scope.workspaceId
      && s.assistantId === scope.assistantId && s.conversationId === scope.conversationId
      && (!taskIds || !!s.taskId && taskIds.includes(s.taskId))
    if (pinned && !matchesScope(pinned.scope)) return null
    let selected: { grant: NativeTaskGrant; scope: NativeScope } | null = null
    const entries = pinned ? [[pinned.grant.identity.sessionId, pinned.grant] as const] : this.grants
    for (const [id,grant] of entries) {
      const live = () => this.grants.get(id) === grant && grant.allowControl && grant.expiresAt > Date.now()
        && (!pinned || this.runBindings.get(context!) === pinned)
      if (grant.expiresAt <= Date.now() && this.grants.get(id) === grant) this.grants.delete(id)
      if (!live()) continue
      if (!('goal' in grant)) continue
      const i=grant.identity
      if(i.userId!==scope.userId || i.workspaceId!==scope.workspaceId || i.conversationId!==scope.conversationId) continue
      const row=await this.get(id,scope.userId).catch(()=>null)
      if (!row && this.grants.get(id) === grant) this.grants.delete(id)
      // Recheck after authorization awaits: revoke/replacement must not revive a
      // cached grant or redirect a direct run to another eligible device.
      if (!row || !live() || !matchesScope(row) || row.state!=='active'
        || row.id !== i.sessionId || row.taskId !== i.taskId || row.deviceId !== i.deviceId
        || row.deploymentId !== i.deploymentId || row.grantId !== grant.grantId || row.epoch !== grant.epoch
        || (pinned && row.taskId !== pinned.scope.taskId)) continue
      if (selected) return null // Generic assistant execution needs an unambiguous grant.
      selected = {grant,scope:{...scope,taskId:row.taskId}}
    }
    return selected && this.grants.get(selected.grant.identity.sessionId) === selected.grant
      && selected.grant.expiresAt > Date.now() ? selected : null
  }
  async assertCurrent(scope:NativeScope,id:string) {
    const row=await this.get(id,scope.userId)
    if(row.state!=='active' || row.workspaceId!==scope.workspaceId || row.assistantId!==scope.assistantId || row.conversationId!==scope.conversationId || row.taskId!==scope.taskId || (row.profileId??null)!==(scope.profileId??null)) throw new Error('Native scope revoked')
  }

  async assertPolicy(scope: NativeScope, db: {query:typeof query} = {query}) {
    const r=await db.query<{policy:string}>(`SELECT policy FROM mcp_tool_settings WHERE assistant_id=$1 AND user_id=$2 AND server_name='native_computer' AND tool_name=$4
      UNION ALL SELECT policy FROM workspace_tool_policy WHERE workspace_id=$3 AND server_name='native_computer' AND tool_name=$4`,[scope.assistantId,scope.userId,scope.workspaceId,scope.toolName??'nativeComputerTask'])
    if(r.rows.some(r=>r.policy==='block')) throw new Error('Native tool blocked')
    // ask is fulfilled by the explicit local grant plus mandatory desktop approval
    // for every side effect; neither allow nor ask bypasses those local prompts.
  }
  async claimRun(scope: NativeScope, grant: NativeGrant) {
    await this.assertCurrent(scope,grant.identity.sessionId)
    await this.assertPolicy(scope)
    const current = this.grants.get(grant.identity.sessionId)
    if (!grant.allowControl || current !== grant || !current.allowControl || current.grantId !== grant.grantId || current.epoch !== grant.epoch || !sameIdentity(current.identity, grant.identity)) return false
    const r=await query(`UPDATE native_computer_sessions SET run_state='running' WHERE id=$1 AND grant_id=$2 AND run_state IS NULL AND state='active' AND revoked_at IS NULL AND expires_at>now() RETURNING id`,[grant.identity.sessionId,grant.grantId])
    return r.rows.length>0
  }
  async finishRun(id:string,userId:string,unknown:boolean) {
    this.grants.delete(id)
    await query(`UPDATE native_computer_sessions SET run_state=CASE WHEN state='execution_unknown' THEN 'execution_unknown' ELSE $3 END WHERE id=$1 AND user_id=$2`,[id,userId,unknown?'execution_unknown':'finished'])
    if(unknown) await this.markUnknown(id,userId)
    else await this.revoke(id,userId)
  }
  async run(id:string,userId:string,authSessionId:string,tool:Tool,signal:AbortSignal) {
    // Completed/revoked runs still return metadata, but only to the original,
    // currently valid auth session and still-authorized scope.
    const r=await query<Row>(`SELECT ${columns} FROM native_computer_sessions WHERE id=$1 AND user_id=$2 AND auth_session_id=$3
      AND EXISTS (SELECT 1 FROM auth_sessions a JOIN users u ON u.id=a.user_id WHERE a.id=$3 AND a.user_id=$2 AND a.revoked_at IS NULL AND a.expires_at>now() AND a.auth_version=u.auth_version)`,[id,userId,authSessionId])
    const row=r.rows[0]
    if(!row || !await this.authorized(row)) throw new Error('Native session unavailable')
    await this.assertPolicy(row)
    if(row.profileId || !row.taskId) throw new Error('Profiles have no autonomous runner')
    if(row.runState) return {sessionId:id,duplicate:true,runState:row.runState}
    await this.get(id,userId)
    const grant=this.grants.get(id)
    if(!grant || !('goal' in grant) || grant.grantId!==row.grantId || grant.epoch!==row.epoch
      || !sameIdentity(grant.identity, { deploymentId:row.deploymentId,deviceId:row.deviceId,sessionId:row.id,
        userId:row.userId,workspaceId:row.workspaceId,conversationId:row.conversationId,taskId:row.taskId! })) throw new Error('Local grant unavailable')
    if (!grant.allowControl) return {sessionId:id,data:{outcome:'unsupported',reason:'local_inspector_only'},isError:true}
    const context:ToolContext={userId,workspaceActorUserId:userId,workspaceId:row.workspaceId,assistantId:row.assistantId,sessionId:row.conversationId,appId:'native-computer',channelType:'native-computer',channelId:id,activeCapabilities:new Set(['native_computer']),abortSignal:signal}
    this.runContexts.add(context)
    this.runBindings.set(context, { grant, scope: { userId, workspaceId: row.workspaceId, assistantId: row.assistantId, conversationId: row.conversationId, taskId:row.taskId } })
    try { return {sessionId:id,...await tool.execute({goal:grant.goal},context)} }
    finally { this.runBindings.delete(context) }
  }

  /** Completion can arrive after cancellation/revocation; retain it against the
   * original trusted binding, without requiring a still-live execution lease. */
  async recordAttempt(record: NativeAttemptRecord): Promise<boolean> {
    const a = NativeAttemptSchema.parse(record.attempt)
    const s = record.scope
    if (record.billingAcknowledgement) {
      const acknowledgement = z.enum(['recorded', 'unknown']).parse(record.billingAcknowledgement)
      // Only the native capability transaction can prove an insertion now.
      if (acknowledgement === 'recorded') return false
      // Neither duplicates nor failures can promote an ambiguous claim later.
      // Only the owner that just received UsageStore success may acknowledge it.
      await query(`UPDATE native_computer_inference_attempts a SET billing_state=$8,
        billed_cost_usd=CASE WHEN $8='recorded' THEN a.estimated_billed_cost_usd ELSE NULL END
        FROM native_computer_sessions s WHERE a.session_id=s.id AND s.id=$1 AND a.attempt_id=$2
          AND s.user_id=$3 AND s.workspace_id=$4 AND s.assistant_id=$5 AND s.conversation_id=$6
          AND s.task_id IS NOT DISTINCT FROM $7::uuid AND s.grant_id=$9 AND s.deployment_id=$10
          AND a.lane IN ('text','vision') AND a.invocation_state='settled' AND a.billing_state='claimed'
          AND a.requested_model=$11 AND a.model IS NOT DISTINCT FROM $12
          AND a.provider_kind=$13 AND a.provider_key_source=$14`,
      [record.sessionId,a.attemptId,s.userId,s.workspaceId,s.assistantId,s.conversationId,s.taskId,
        acknowledgement,record.grantId,this.config.deploymentId,a.requestedModel,a.model,a.providerKind,a.providerKeySource])
      return false
    }
    const result = await query(`INSERT INTO native_computer_inference_attempts
      (session_id,model,provider_kind,lane,outcome,duration_ms,usage,incurred_cost_usd,estimated_billed_cost_usd,provider_key_source,diagnostic_code,operation,stage,perception_path,fallback_reason,disposition,attempt_id,invocation_state,interrupted,billing_state,requested_model)
      SELECT id,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28 FROM native_computer_sessions
      WHERE id=$1 AND user_id=$2 AND workspace_id=$3 AND assistant_id=$4
        AND conversation_id=$5 AND task_id IS NOT DISTINCT FROM $6::uuid AND grant_id=$7 AND deployment_id=$18
      ON CONFLICT (session_id,attempt_id) DO UPDATE SET
        model=CASE WHEN native_computer_inference_attempts.invocation_state='pending' THEN COALESCE(EXCLUDED.model,native_computer_inference_attempts.model) ELSE native_computer_inference_attempts.model END,
        provider_kind=CASE WHEN native_computer_inference_attempts.invocation_state='pending' AND (EXCLUDED.model IS NOT NULL OR native_computer_inference_attempts.model IS NULL) THEN EXCLUDED.provider_kind ELSE native_computer_inference_attempts.provider_kind END,
        billing_state=CASE WHEN native_computer_inference_attempts.billing_state='unclaimed' THEN EXCLUDED.billing_state ELSE native_computer_inference_attempts.billing_state END,
        invocation_state=CASE WHEN native_computer_inference_attempts.invocation_state='settled' THEN 'settled' ELSE EXCLUDED.invocation_state END,
        interrupted=native_computer_inference_attempts.interrupted OR EXCLUDED.interrupted,
        duration_ms=GREATEST(native_computer_inference_attempts.duration_ms,EXCLUDED.duration_ms),
        outcome=CASE WHEN native_computer_inference_attempts.invocation_state='settled' THEN native_computer_inference_attempts.outcome ELSE EXCLUDED.outcome END,
        usage=CASE WHEN native_computer_inference_attempts.invocation_state='pending' THEN COALESCE(EXCLUDED.usage,native_computer_inference_attempts.usage) ELSE COALESCE(native_computer_inference_attempts.usage,EXCLUDED.usage) END,
        incurred_cost_usd=CASE WHEN native_computer_inference_attempts.invocation_state='pending' THEN COALESCE(EXCLUDED.incurred_cost_usd,native_computer_inference_attempts.incurred_cost_usd) ELSE COALESCE(native_computer_inference_attempts.incurred_cost_usd,EXCLUDED.incurred_cost_usd) END,
        estimated_billed_cost_usd=CASE WHEN native_computer_inference_attempts.invocation_state='pending' THEN COALESCE(EXCLUDED.estimated_billed_cost_usd,native_computer_inference_attempts.estimated_billed_cost_usd) ELSE COALESCE(native_computer_inference_attempts.estimated_billed_cost_usd,EXCLUDED.estimated_billed_cost_usd) END,
        disposition=COALESCE(native_computer_inference_attempts.disposition,EXCLUDED.disposition),
        fallback_reason=COALESCE(native_computer_inference_attempts.fallback_reason,EXCLUDED.fallback_reason),
        diagnostic_code=CASE WHEN EXCLUDED.outcome='failed' AND EXCLUDED.invocation_state='settled' THEN 'inference_failed' ELSE native_computer_inference_attempts.diagnostic_code END
      WHERE native_computer_inference_attempts.lane=EXCLUDED.lane
        AND native_computer_inference_attempts.requested_model=EXCLUDED.requested_model
        AND native_computer_inference_attempts.provider_key_source=EXCLUDED.provider_key_source
        AND native_computer_inference_attempts.stage=EXCLUDED.stage
        AND native_computer_inference_attempts.operation IS NOT DISTINCT FROM EXCLUDED.operation
        AND native_computer_inference_attempts.perception_path=EXCLUDED.perception_path
        AND (EXCLUDED.invocation_state='pending' OR native_computer_inference_attempts.invocation_state='pending'
          OR ((native_computer_inference_attempts.usage IS NULL OR EXCLUDED.usage IS NULL OR native_computer_inference_attempts.usage=EXCLUDED.usage)
            AND (native_computer_inference_attempts.incurred_cost_usd IS NULL OR EXCLUDED.incurred_cost_usd IS NULL OR native_computer_inference_attempts.incurred_cost_usd=EXCLUDED.incurred_cost_usd)
            AND (native_computer_inference_attempts.estimated_billed_cost_usd IS NULL OR EXCLUDED.estimated_billed_cost_usd IS NULL OR native_computer_inference_attempts.estimated_billed_cost_usd=EXCLUDED.estimated_billed_cost_usd)))
        AND (native_computer_inference_attempts.invocation_state='pending'
          OR (EXCLUDED.invocation_state='pending' AND EXCLUDED.model IS NULL)
          OR (native_computer_inference_attempts.model IS NOT DISTINCT FROM EXCLUDED.model AND native_computer_inference_attempts.provider_kind=EXCLUDED.provider_kind)) RETURNING id`,
    [record.sessionId,s.userId,s.workspaceId,s.assistantId,s.conversationId,s.taskId,record.grantId,
      a.model,a.providerKind,a.lane,a.outcome,a.durationMs,a.usage === null ? null : JSON.stringify(a.usage),
      a.incurredCostUsd,a.estimatedBilledCostUsd,a.providerKeySource,
      a.outcome === 'failed' && a.invocationState === 'settled' ? 'inference_failed' : null,this.config.deploymentId,
      a.operation,a.stage,a.perceptionPath,a.fallbackReason,a.disposition,a.attemptId,a.invocationState,a.interrupted,
      a.lane === 'decision' && a.invocationState === 'settled' ? 'unknown'
        : !record.claimBilling && a.invocationState === 'settled' && a.model && a.usage && a.providerKeySource === 'user' && a.estimatedBilledCostUsd === 0 ? 'not_required' : 'unclaimed',a.requestedModel])
    if (!result.rows.length) throw new Error('Native attempt scope denied')
    // No new legacy claims: only the native capability can prepare an immutable
    // intent and atomically insert/acknowledge its ledger row. Existing claimed
    // or unknown rows remain ambiguous and are never upgraded by this method.
    return false
  }

  private async audit(id:string,event:string) { await query('INSERT INTO native_computer_audit(session_id,event) VALUES($1,$2)',[id,event]) }
}
