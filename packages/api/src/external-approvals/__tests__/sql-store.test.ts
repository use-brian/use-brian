/** Real SQL against an ephemeral in-memory PostgreSQL engine; no live DB or env discovery. */
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest'
import { createHash } from 'node:crypto'
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
const source:ExternalApprovalSource = {id:'00000000-0000-4000-8000-000000000004',tokenSha256:createHash('sha256').update('unit-test-token').digest('hex'),workspaceId:'00000000-0000-4000-8000-000000000001',assistantId:'00000000-0000-4000-8000-000000000002',approverUserId:'00000000-0000-4000-8000-000000000003',channelType:'web',channelId:'queue'}
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
    CREATE TABLE auth_sessions(id uuid PRIMARY KEY,user_id uuid,auth_version integer DEFAULT 0,expires_at timestamptz,revoked_at timestamptz);
    CREATE TABLE workspace_members(workspace_id uuid,user_id uuid,role text DEFAULT 'admin');
    CREATE TABLE assistants(id uuid PRIMARY KEY,workspace_id uuid);
    CREATE FUNCTION assistant_placement_visible(uuid,uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true';
    CREATE FUNCTION pg_advisory_xact_lock(bigint) RETURNS void LANGUAGE sql AS 'SELECT';
    CREATE TABLE pending_approvals(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid,kind text,approver_user_id uuid,originating_assistant_id uuid,
      tool_name text,arguments jsonb,approval_payload jsonb,delivery_channel_type text,delivery_channel_id text,expires_at timestamptz,
      status text DEFAULT 'pending',responded_at timestamptz,responded_by uuid,resolution_origin text);
  `)
  await db.query('INSERT INTO users(id) VALUES($1)',[source.approverUserId])
  await db.query('INSERT INTO workspaces VALUES($1)',[source.workspaceId])
  await db.query('INSERT INTO auth_sessions(id,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval \'1 hour\')',[sessionId,source.approverUserId])
  await db.query('INSERT INTO workspace_members(workspace_id,user_id) VALUES($1,$2)',[source.workspaceId,source.approverUserId])
  await db.query('INSERT INTO assistants VALUES($1,$2)',[source.assistantId,source.workspaceId])
  await db.exec(readFileSync(new URL('../../../migrations/8240_external_human_approvals.sql',import.meta.url),'utf8'))
  await db.exec(readFileSync(new URL('../../../migrations/8241_workspace_external_approval_sources.sql',import.meta.url),'utf8'))
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
