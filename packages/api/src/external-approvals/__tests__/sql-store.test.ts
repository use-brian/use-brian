/** Real SQL against an ephemeral in-memory PostgreSQL engine; no live DB or env discovery. */
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
vi.mock('../../db/client.js',()=>({getPool:()=>pool}))
vi.mock('../../brain-stream/notify.js',()=>({notifyWorkspaceChange:vi.fn()}))
import { createExternalApprovalSqlStore, canReadExternalApproval } from '../sql-store.js'
import { ExternalApprovalService, configureExternalApprovals } from '../service.js'
import { createExternalApprovalSourceRegistry } from '../source-registry.js'
import { normalizeExternalInput,type ExternalApprovalSource } from '../contracts.js'
const db = new PGlite()
// PGlite is one connection: serialize transactions like a pool with max=1.
let tail = Promise.resolve()
const pool = {
  query:(sql:string,args?:unknown[])=>db.query(sql,args),
  async connect(){ let release!:()=>void; const previous=tail; tail=new Promise<void>(r=>release=r); await previous
    return {query:(sql:string,args?:unknown[])=>db.query(sql,args),release}
  },
}
const source:ExternalApprovalSource & { approverUserId: string } = {id:'00000000-0000-4000-8000-000000000004',tokenSha256:createHash('sha256').update('unit-test-token').digest('hex'),workspaceId:'00000000-0000-4000-8000-000000000001',assistantId:'00000000-0000-4000-8000-000000000002',approverUserId:'00000000-0000-4000-8000-000000000003',channelType:'web',channelId:'queue'}
const store=createExternalApprovalSqlStore()
const notify=vi.fn(async(_source:ExternalApprovalSource,_state:import('../service.js').ExternalApprovalState)=>{})
const sources=createExternalApprovalSourceRegistry({notify:()=>{}})
const service=new ExternalApprovalService(sources,store,notify)
const sessionId='00000000-0000-4000-8000-000000000007'
const siblingId='00000000-0000-4000-8000-000000000005'
let sequence=0
const input=()=>({externalRequestId:`external-${++sequence}`,taskId:'external-task',sessionId:'external-session',request:{method:'confirm' as const,title:'Allow?'},expiresAt:new Date(Date.now()+600_000).toISOString()})
const actor={userId:source.approverUserId,human:true,origin:'ui' as const}
beforeAll(async()=>{
  await db.exec(`CREATE TABLE users(id uuid PRIMARY KEY,auth_version integer DEFAULT 0);
    CREATE TABLE workspaces(id uuid PRIMARY KEY);
    CREATE TABLE application_policy_workspace_epochs(workspace_id uuid PRIMARY KEY);
    CREATE TABLE department_edges(id uuid,workspace_id uuid,user_id uuid,expires_at timestamptz);
    CREATE TABLE auth_sessions(id uuid PRIMARY KEY,user_id uuid,auth_version integer DEFAULT 0,expires_at timestamptz,revoked_at timestamptz);
    CREATE TABLE workspace_members(workspace_id uuid,user_id uuid,role text DEFAULT 'admin');
    CREATE TABLE assistants(id uuid PRIMARY KEY,workspace_id uuid);
    CREATE TABLE channels(id uuid PRIMARY KEY,workspace_id uuid,channel_id text,status text,display_name text);
    CREATE TABLE channel_integrations(id uuid PRIMARY KEY,channel_id uuid,channel_type text,status text,bot_user_id text,team_id text);
    CREATE TABLE channel_assistants(id uuid PRIMARY KEY,channel_id uuid,assistant_id uuid,external_surface_id text,model_alias text);
    CREATE TABLE linked_identities(id uuid PRIMARY KEY,user_id uuid,provider text,provider_id text);
    CREATE FUNCTION assistant_placement_visible(uuid,uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true';
    CREATE FUNCTION pg_advisory_xact_lock(bigint) RETURNS void LANGUAGE sql AS 'SELECT';
    CREATE TABLE pending_approvals(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid,kind text,approver_user_id uuid,originating_assistant_id uuid,
      tool_name text,arguments jsonb,approval_payload jsonb,delivery_channel_type text,delivery_channel_id text,expires_at timestamptz,
      status text DEFAULT 'pending',responded_at timestamptz,responded_by uuid,resolution_origin text);
  `)
  await db.query('INSERT INTO users(id) VALUES($1)',[source.approverUserId])
  await db.query('INSERT INTO workspaces VALUES($1)',[source.workspaceId])
  await db.query('INSERT INTO application_policy_workspace_epochs VALUES($1)',[source.workspaceId])
  await db.query('INSERT INTO auth_sessions(id,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval \'1 hour\')',[sessionId,source.approverUserId])
  await db.query('INSERT INTO workspace_members(workspace_id,user_id) VALUES($1,$2)',[source.workspaceId,source.approverUserId])
  await db.query('INSERT INTO assistants VALUES($1,$2)',[source.assistantId,source.workspaceId])
  await db.exec(readFileSync(new URL('../../../migrations/8241_external_human_approvals.sql',import.meta.url),'utf8'))
  await db.exec(readFileSync(new URL('../../../migrations/8242_workspace_external_approval_sources.sql',import.meta.url),'utf8'))
  // Lightweight store fixture. Full migration and RLS behavior is covered by
  // the lightweight destination migration suite (canonical helpers mocked).
  await db.exec(`ALTER TABLE workspace_external_approval_sources ALTER COLUMN approver_user_id DROP NOT NULL,
      ADD COLUMN audience text, ADD COLUMN destination_session_id uuid, ADD COLUMN thread_ref text;
    CREATE TABLE sessions(id uuid PRIMARY KEY,workspace_id uuid,assistant_id uuid,user_id uuid,
      channel_type text,channel_id text,visibility text DEFAULT 'workspace',mode text DEFAULT 'chat',
      app_origin text,anchor_kind text DEFAULT 'none',recording_revision integer,transient boolean DEFAULT false);
    CREATE FUNCTION session_recording_read_allowed(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true';
    CREATE FUNCTION session_context_parent_snapshot(uuid,uuid) RETURNS jsonb LANGUAGE sql AS $$
      SELECT '{}'::jsonb FROM sessions s WHERE s.workspace_id=$1 AND s.id=$2
        AND (s.visibility='workspace' OR s.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid) $$;
    CREATE FUNCTION workflow_evidence_envelope_visible(uuid,jsonb) RETURNS boolean LANGUAGE sql AS 'SELECT $2 IS NOT NULL';
  `)
  for(const id of [source.id,siblingId]) await db.query(`INSERT INTO workspace_external_approval_sources
    (id,workspace_id,name,assistant_id,approver_user_id,channel_type,channel_id,token_sha256,prefix,created_by)
    VALUES($1,$2,'Fixture source',$3,$4,'web','queue',$5,'test-prefix',$4)`,
    [id,source.workspaceId,source.assistantId,source.approverUserId,id===source.id?source.tokenSha256:'f'.repeat(64)])
  configureExternalApprovals(service)
},30_000)
afterAll(()=>db.close())
describe('external approval durable SQL lifecycle',()=>{
  it('inserts sidecar + queue atomically, caps TTL, freezes only display snapshot and replays without notifying twice',async()=>{
    const raw=input(); const a=await service.create(source,raw); const b=await service.create(source,raw)
    expect(a).toEqual(b);expect(a.status).toBe('pending');expect(Date.parse(a.expiresAt)).toBeLessThanOrEqual(Date.now()+300_000)
    expect(a.payloadHash).toBe(normalizeExternalInput(raw).payloadHash)
    const p=(await db.query<Record<string,unknown>>('SELECT * FROM pending_approvals WHERE id=$1',[a.approvalId])).rows[0]
    expect(p.kind).toBe('external_action');expect(p.tool_name).toBeNull();expect(p.arguments).toEqual({});expect(p.approval_payload).toEqual({request:raw.request,allowPersistentApproval:false})
    expect(notify.mock.calls.filter(c=>c[1].approvalId===a.approvalId)).toHaveLength(1)
    await expect(service.create(source,{...raw,request:{method:'confirm',title:'changed'}})).rejects.toMatchObject({status:409})
  })
  it('concurrent idempotent ingest leaves exactly one pending row',async()=>{
    const raw=input();const rows=await Promise.all(Array.from({length:5},()=>service.create(source,raw)))
    expect(new Set(rows.map(r=>r.approvalId)).size).toBe(1)
    expect((await db.query('SELECT * FROM external_approval_requests WHERE external_request_id=$1',[raw.externalRequestId])).rows).toHaveLength(1)
  })
  it('isolates source IDs and invalidates authority/destination changes',async()=>{
    const raw=input();const a=await service.create(source,raw)
    await expect(store.read({...source,id:'foreign'},raw.externalRequestId)).rejects.toMatchObject({status:404})
    await expect(store.read({...source,channelId:'foreign'},raw.externalRequestId)).rejects.toMatchObject({status:404})
    await expect(service.create({...source,channelId:'foreign'},raw)).rejects.toMatchObject({status:404})
    await expect(service.resolve(a.approvalId,'approved',{...actor,userId:source.assistantId})).rejects.toMatchObject({status:404})
    const siblingSource=(await sources.get(siblingId))!
    const sibling=await service.create(siblingSource,raw);expect(sibling.approvalId).not.toBe(a.approvalId)
  })
  it('forbids model, delegated, unattended and permanent decisions',async()=>{
    const raw=input();const a=await service.create(source,raw)
    for(const bad of [{...actor,human:false},{...actor,origin:'model' as const},{...actor,origin:'delegated' as const},{...actor,grantAlways:true}]) await expect(service.resolve(a.approvalId,'approved',bad)).rejects.toMatchObject({status:403})
    expect((await store.read(source,raw.externalRequestId))?.status).toBe('pending')
  })
  it('allows exactly one human winner and records receipt independently',async()=>{
    const raw=input();const a=await service.create(source,raw)
    const [first,second]=await Promise.all([service.resolve(a.approvalId,'approved',actor),service.resolve(a.approvalId,'rejected',actor)])
    expect(first.status).toBe('approved');expect(second.status).toBe('approved');expect(first.ackStatus).toBeUndefined()
    expect((await store.ack(source,raw.externalRequestId,'applied'))?.status).toBe('approved')
    expect((await store.ack(source,raw.externalRequestId,'applied'))?.ackStatus).toBe('applied')
    await expect(store.ack(source,raw.externalRequestId,'failed')).rejects.toMatchObject({status:409})
  })
  it('expires on decision and read, rejects elapsed ingest and applied receipt without approval',async()=>{
    const raw=input();const a=await service.create(source,raw)
    await expect(store.ack(source,raw.externalRequestId,'applied')).rejects.toMatchObject({status:409})
    await db.query("UPDATE pending_approvals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[a.approvalId])
    expect((await service.resolve(a.approvalId,'approved',actor)).status).toBe('expired')
    expect((await store.read(source,raw.externalRequestId))?.status).toBe('expired')
    await expect(store.ack(source,raw.externalRequestId,'applied')).rejects.toMatchObject({status:409})
    expect((await store.ack(source,raw.externalRequestId,'stale'))?.ackStatus).toBe('stale')
    await expect(service.create(source,{...input(),expiresAt:'2000-01-01T00:00:00Z'})).rejects.toMatchObject({status:400})
  })
  it('cancels pending and approved requests without ever granting permission',async()=>{
    const raw=input();const a=await service.create(source,raw)
    expect((await store.cancel(source,raw.externalRequestId))?.status).toBe('superseded')
    expect((await service.resolve(a.approvalId,'approved',actor)).status).toBe('superseded')
    const r2=input();const a2=await service.create(source,r2);await service.resolve(a2.approvalId,'approved',actor)
    expect((await store.cancel(source,r2.externalRequestId))?.status).toBe('superseded')
    expect((await store.read(source,r2.externalRequestId))?.status).toBe('superseded')
    expect((await db.query<{status:string}>('SELECT status FROM pending_approvals WHERE id=$1',[a2.approvalId])).rows[0].status).toBe('approved')
    await expect(store.ack(source,r2.externalRequestId,'applied')).rejects.toMatchObject({status:409})
  })
  it('applies denials and never cancels an applied human approval',async()=>{
    const raw=input();const a=await service.create(source,raw)
    await service.resolve(a.approvalId,'rejected',actor)
    expect((await store.ack(source,raw.externalRequestId,'applied'))?.status).toBe('rejected')
    const raw2=input();const b=await service.create(source,raw2)
    await service.resolve(b.approvalId,'approved',actor)
    await store.ack(source,raw2.externalRequestId,'applied')
    expect((await store.cancel(source,raw2.externalRequestId))?.status).toBe('approved')
  })
  it('projects expired decisions without rewriting recorded human status',async()=>{
    const raw=input();const a=await service.create(source,raw)
    await service.resolve(a.approvalId,'approved',actor)
    await db.query("UPDATE external_approval_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE approval_id=$1",[a.approvalId])
    expect((await store.read(source,raw.externalRequestId))?.status).toBe('expired')
    await expect(store.ack(source,raw.externalRequestId,'applied')).rejects.toMatchObject({status:409})
    expect((await db.query<{status:string}>('SELECT status FROM pending_approvals WHERE id=$1',[a.approvalId])).rows[0].status).toBe('approved')
  })
  it('does not turn a transient authority read failure into definitive permission loss',async()=>{
    const approval=await service.create(source,input())
    const read=vi.spyOn(pool,'query').mockRejectedValueOnce(new Error('temporary database failure'))
    try { await expect(canReadExternalApproval(actor.userId,approval.approvalId)).rejects.toThrow('temporary database failure') }
    finally { read.mockRestore() }
    expect(await canReadExternalApproval(actor.userId,approval.approvalId)).toBe(true)
  })
  it('blocks sidecar reads for non-owner runtime role even with table SELECT',async()=>{
    await db.exec('CREATE ROLE unit_app_user; GRANT SELECT ON external_approval_requests,workspace_external_approval_sources TO unit_app_user; SET ROLE unit_app_user;')
    try {
      expect((await db.query('SELECT * FROM external_approval_requests')).rows).toHaveLength(0)
      expect((await db.query('SELECT * FROM workspace_external_approval_sources')).rows).toHaveLength(0)
    }
    finally { await db.exec('RESET ROLE') }
  })
  it('uses workspace-issued credentials live, preserves human evidence across rotation and revokes applicability',async()=>{
    const manager={userId:source.approverUserId,sessionId}
    const issued=await sources.create(manager,source.workspaceId,{name:'Live registration',assistantId:source.assistantId,approverUserId:source.approverUserId,notification:'web'})
    const registered=(await sources.authenticate(`Bearer ${issued.token}`))!
    const raw=input();const approval=await service.create(registered,raw)
    expect(await canReadExternalApproval(actor.userId,approval.approvalId)).toBe(true)
    await service.resolve(approval.approvalId,'approved',actor)
    const rotated=await sources.rotate(manager,source.workspaceId,registered.id)
    expect(await sources.authenticate(`Bearer ${issued.token}`)).toBeNull()
    await expect(store.ack(registered,raw.externalRequestId,'applied')).rejects.toMatchObject({status:404})
    const current=(await sources.authenticate(`Bearer ${rotated.token}`))!
    expect((await store.read(current,raw.externalRequestId))?.status).toBe('approved')
    await sources.revoke(manager,source.workspaceId,current.id)
    expect(await sources.authenticate(`Bearer ${rotated.token}`)).toBeNull()
    expect(await canReadExternalApproval(actor.userId,approval.approvalId)).toBe(false)
    await expect(service.resolve(approval.approvalId,'approved',actor)).rejects.toMatchObject({status:404})
    await expect(store.ack(current,raw.externalRequestId,'applied')).rejects.toMatchObject({status:404})
    expect((await db.query<{status:string}>('SELECT status FROM pending_approvals WHERE id=$1',[approval.approvalId])).rows[0].status).toBe('approved')
  })
  it('blocks a stale human card when its registration is revoked while pending',async()=>{
    const manager={userId:source.approverUserId,sessionId}
    const issued=await sources.create(manager,source.workspaceId,{name:'Pending registration',assistantId:source.assistantId,approverUserId:source.approverUserId,notification:'web'})
    const registered=(await sources.get(issued.source.id))!
    const approval=await service.create(registered,input())
    await sources.revoke(manager,source.workspaceId,registered.id)
    await expect(service.resolve(approval.approvalId,'approved',actor)).rejects.toMatchObject({status:404})
    expect(await canReadExternalApproval(actor.userId,approval.approvalId)).toBe(false)
  })
  it('rechecks current membership at poll, human response and ingest',async()=>{
    const raw=input();const a=await service.create(source,raw)
    await db.query('DELETE FROM workspace_members WHERE user_id=$1',[source.approverUserId])
    await expect(store.read(source,raw.externalRequestId)).rejects.toMatchObject({status:404})
    await expect(service.resolve(a.approvalId,'approved',actor)).rejects.toMatchObject({status:404})
    await expect(service.create(source,input())).rejects.toMatchObject({status:404})
    await db.query('INSERT INTO workspace_members(workspace_id,user_id) VALUES($1,$2)',[source.workspaceId,source.approverUserId])
    await db.query('DELETE FROM assistants WHERE id=$1',[source.assistantId])
    await expect(store.read(source,raw.externalRequestId)).rejects.toMatchObject({status:404})
    await db.query('INSERT INTO assistants VALUES($1,$2)',[source.assistantId,source.workspaceId])
  })
})

describe('conversation-member external human authority', () => {
  const member = '00000000-0000-4000-8000-000000000011'
  const memberSession = '00000000-0000-4000-8000-000000000012'
  const destination = '00000000-0000-4000-8000-000000000013'
  const human = { ...actor, authSessionId: sessionId }
  const teammate = { userId: member, human: true, origin: 'ui' as const, authSessionId: memberSession }
  beforeAll(async () => {
    await db.query('INSERT INTO users(id) VALUES($1)', [member])
    await db.query('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,\'member\')', [source.workspaceId,member])
    await db.query('INSERT INTO auth_sessions(id,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval \'1 hour\')', [memberSession,member])
    await db.query(`INSERT INTO sessions(id,workspace_id,assistant_id,user_id,channel_type,channel_id)
      VALUES($1,$2,$3,$4,'web','chat')`, [destination,source.workspaceId,source.assistantId,source.approverUserId])
  })
  async function request(overrides:Partial<ExternalApprovalSource>={}) {
    const s: ExternalApprovalSource = { ...source, id: randomUUID(), approverUserId: null,
      audience: 'conversation_members', destinationSessionId: destination, channelId: destination, ...overrides }
    await db.query(`INSERT INTO workspace_external_approval_sources
      (id,workspace_id,name,assistant_id,approver_user_id,audience,destination_session_id,channel_type,channel_id,token_sha256,prefix,created_by,channel_integration_id,thread_ref)
      VALUES($1,$2,'Shared conversation',$3,NULL,'conversation_members',$4,$7,$8,$5,'test',$6,$9,$10)`,
      [s.id,s.workspaceId,s.assistantId,s.destinationSessionId,createHash('sha256').update(s.id).digest('hex'),actor.userId,s.channelType,s.channelId,s.channelIntegrationId??null,s.threadRef??null])
    s.tokenSha256 = createHash('sha256').update(s.id).digest('hex')
    return { source: s, state: await service.create(s,input()) }
  }
  it('has no assigned approver, permits current members and records exactly one human winner', async () => {
    const { source: s,state } = await request()
    expect((await db.query<{approver_user_id:string|null}>('SELECT approver_user_id FROM pending_approvals WHERE id=$1',[state.approvalId])).rows[0].approver_user_id).toBeNull()
    expect(await canReadExternalApproval(member,state.approvalId)).toBe(true)
    const [first,second] = await Promise.all([service.resolve(state.approvalId,'approved',teammate),service.resolve(state.approvalId,'rejected',human)])
    expect(first.status).toBe('approved'); expect(second.status).toBe('approved')
    expect((await db.query<{responded_by:string}>('SELECT responded_by FROM pending_approvals WHERE id=$1',[state.approvalId])).rows[0].responded_by).toBe(member)
    expect((await store.read(s,state.externalRequestId))?.status).toBe('approved')
  })
  it('requires the exact live provider identity, not a cached sender or another linked account',async()=>{
    const channelDestination=randomUUID(),integration=randomUUID(),route=randomUUID(),identity=randomUUID()
    await db.query("INSERT INTO channels(id,workspace_id,channel_id,status) VALUES($1,$2,'room','active')",[integration,source.workspaceId])
    await db.query("INSERT INTO channel_integrations(id,channel_id,channel_type,status) VALUES($1,$1,'slack','active')",[integration])
    await db.query('INSERT INTO channel_assistants VALUES($1,$2,$3,NULL,NULL)',[route,integration,source.assistantId])
    await db.query("INSERT INTO sessions(id,workspace_id,assistant_id,user_id,channel_type,channel_id) VALUES($1,$2,$3,$4,'slack','room:thread:root')",[channelDestination,source.workspaceId,source.assistantId,actor.userId])
    await db.query("INSERT INTO linked_identities VALUES($1,$2,'slack','current-provider-sender')",[identity,member])
    const {state}=await request({channelType:'slack',channelId:'room',channelIntegrationId:integration,destinationSessionId:channelDestination,threadRef:'root'})
    const channelActor={userId:member,human:true,origin:'channel' as const,channelId:'room',channelIntegrationId:integration,threadRef:'root',providerUserId:'current-provider-sender'}
    for(const providerUserId of [undefined,'old-cached-sender']) {
      await expect(service.resolve(state.approvalId,'approved',{...channelActor,providerUserId})).rejects.toMatchObject({status:403})
    }
    await db.query('DELETE FROM linked_identities WHERE id=$1',[identity])
    await expect(service.resolve(state.approvalId,'approved',channelActor)).rejects.toMatchObject({status:403})
    await db.query("INSERT INTO linked_identities VALUES($1,$2,'slack','current-provider-sender')",[identity,member])
    await expect(service.resolve(state.approvalId,'rejected',channelActor)).resolves.toMatchObject({status:'rejected'})
  })
  it('rejects missing, mismatched, revoked and expired browser session evidence', async () => {
    const {state} = await request()
    await expect(service.resolve(state.approvalId,'approved',{...teammate,authSessionId:undefined})).rejects.toMatchObject({status:403})
    await expect(service.resolve(state.approvalId,'approved',{...teammate,authSessionId:sessionId})).rejects.toMatchObject({status:403})
    await db.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[memberSession])
    await expect(service.resolve(state.approvalId,'approved',teammate)).rejects.toMatchObject({status:403})
    await db.query('UPDATE auth_sessions SET revoked_at=NULL,expires_at=clock_timestamp()-interval \'1 second\' WHERE id=$1',[memberSession])
    await expect(service.resolve(state.approvalId,'approved',teammate)).rejects.toMatchObject({status:403})
    await db.query('UPDATE auth_sessions SET expires_at=clock_timestamp()+interval \'1 hour\' WHERE id=$1',[memberSession])
    await expect(service.resolve(state.approvalId,'rejected',teammate)).resolves.toMatchObject({status:'rejected'})
  })
  it('rechecks conversation access and membership for reads and decisions', async () => {
    const {state} = await request()
    await db.query('UPDATE sessions SET visibility=\'personal\' WHERE id=$1',[destination])
    expect(await canReadExternalApproval(member,state.approvalId)).toBe(false)
    await expect(service.resolve(state.approvalId,'approved',teammate)).rejects.toMatchObject({status:404})
    await db.query('UPDATE sessions SET visibility=\'workspace\' WHERE id=$1',[destination])
    await db.query('DELETE FROM workspace_members WHERE user_id=$1',[member])
    expect(await canReadExternalApproval(member,state.approvalId)).toBe(false)
    await expect(service.resolve(state.approvalId,'approved',teammate)).rejects.toMatchObject({status:404})
    await db.query('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,\'member\')',[source.workspaceId,member])
    await expect(service.resolve(state.approvalId,'rejected',teammate)).resolves.toMatchObject({status:'rejected'})
  })
  it('does not accept a source bearer or bare direct store call as decision authority', async () => {
    const {source:s,state} = await request()
    expect(await store.decide(s,state.approvalId,member,'approved')).toBeNull()
    for (const bad of [{...teammate,human:false},{...teammate,origin:'model' as const},{...teammate,origin:'delegated' as const},{...teammate,grantAlways:true}]) {
      await expect(service.resolve(state.approvalId,'approved',bad)).rejects.toMatchObject({status:403})
    }
    expect((await store.read(s,state.externalRequestId))?.status).toBe('pending')
  })
})
