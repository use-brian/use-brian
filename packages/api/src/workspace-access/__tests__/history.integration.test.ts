import {randomUUID} from 'node:crypto'
import express from 'express'
import request from 'supertest'
import {afterAll,describe,expect,it} from 'vitest'
import {getPool,getAppPool} from '../../db/client.js'
import {createDbWorkspaceGroupStore} from '../../db/workspace-group-store.js'
import {workspaceAccessRoutes} from '../../routes/workspace-access.js'
import {getWorkspaceAccess,getWorkspaceAccessHistory,getWorkspaceAccessRequest,executeDepartmentAccessCommand} from '../service.js'
import {createWorkspaceAccessTools} from '../tools.js'
import type {ToolContext} from '@use-brian/core'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
async function fixture(){
  const workspaceId=randomUUID(),owner=randomUUID(),member=randomUUID(),other=randomUUID(),requester=randomUUID()
  for(const id of [owner,member,other,requester])await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'History fixture',$2)",[workspaceId,owner])
  for(const id of [owner,member,other,requester])await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,team_scope_mode) VALUES($1,$2,$3,'assigned')",[workspaceId,id,id===owner?'owner':'member'])
  const target=await createDbWorkspaceGroupStore().createTeam(owner,workspaceId,{name:'Research',key:'research'})
  async function seed(count:number,beneficiary=member,offset=0){
    await pool.query(`WITH inserted AS (
      INSERT INTO workspace_access_requests(workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,target_team_id,reason,starts_at,expires_at,created_at,request_expires_at,payload_hash,policy_revision,status,decided_by,decided_at)
      SELECT $1,$2,'member',$3,$4,'History item '||n,now(),now()+interval '1 day',
        '2030-01-01T00:00:00Z'::timestamptz+(n+$7)*interval '1 microsecond','2030-01-02T00:00:00Z'::timestamptz,
        repeat('a',64),1,'approved',$5,now() FROM generate_series(1,$6::int) n RETURNING *
    ) INSERT INTO workspace_access_grants(workspace_id,request_id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,approved_by,created_at)
      SELECT workspace_id,id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,decided_by,created_at FROM inserted`,[workspaceId,requester,beneficiary,target.id,owner,count,offset])
  }
  const appFor=(actor:string)=>{const app=express();app.use(express.json());app.use((req,_res,next)=>{req.userId=actor;next()});app.use('/api',workspaceAccessRoutes());return app}
  return{workspaceId,owner,member,other,requester,target,seed,appFor}
}
describe('[COMP:api/workspace-access] authorized request and grant history',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  it('traverses beyond the former window with microsecond ordering and no duplicates',async()=>{
    const f=await fixture();await f.seed(503)
    for(const kind of ['requests','grants'] as const){
      const seen:string[]=[];let after:string|undefined,revision:string|undefined
      do{
        const page=await getWorkspaceAccessHistory(f.workspaceId,f.member,kind,{after,expectedPolicyRevision:revision})
        expect(page[kind].length).toBeLessThanOrEqual(50)
        expect(page[kind==='requests'?'grants':'requests']).toEqual([])
        seen.push(...page[kind].map(row=>row.id));after=page.nextCursor??undefined;revision=after?page.policyRevision:undefined
      }while(after)
      const expected=(await pool.query(`SELECT id FROM workspace_access_${kind} WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC`,[f.workspaceId])).rows.map(row=>row.id)
      expect(seen).toEqual(expected);expect(new Set(seen).size).toBe(503)
    }
    const overview=await getWorkspaceAccess(f.workspaceId,f.member)
    expect(overview.requests).toHaveLength(50);expect(overview.grants).toHaveLength(50)
    expect(overview.nextRequestCursor).toBe(overview.requests[49].id)
    expect(overview.nextGrantCursor).toBe(overview.grants[49].id)
  })
  it('filters invisible rows before limiting and does not expose requester-only grants',async()=>{
    const f=await fixture();await f.seed(2);await f.seed(55,f.other,100)
    const page=await getWorkspaceAccessHistory(f.workspaceId,f.member,'requests')
    expect(page.requests).toHaveLength(2);expect(page.nextCursor).toBeNull()
    const grantPage=await getWorkspaceAccessHistory(f.workspaceId,f.member,'grants')
    expect(grantPage.grants).toHaveLength(2);expect(grantPage.nextCursor).toBeNull()
    expect((await getWorkspaceAccessHistory(f.workspaceId,f.requester,'requests')).requests).toHaveLength(50)
    expect((await getWorkspaceAccessHistory(f.workspaceId,f.requester,'grants')).grants).toEqual([])
    expect((await getWorkspaceAccessHistory(f.workspaceId,f.owner,'grants')).grants).toHaveLength(50)
  })
  it('rejects foreign, hidden and missing cursors identically and rechecks membership and policy',async()=>{
    const f=await fixture(),foreign=await fixture();await f.seed(51);await f.seed(1,f.other,100);await foreign.seed(1)
    const page=await getWorkspaceAccessHistory(f.workspaceId,f.member,'requests')
    const hidden=(await getWorkspaceAccessHistory(f.workspaceId,f.other,'requests')).requests[0].id
    const outside=(await getWorkspaceAccessHistory(foreign.workspaceId,foreign.member,'requests')).requests[0].id
    for(const after of [hidden,outside,randomUUID()])await expect(getWorkspaceAccessHistory(f.workspaceId,f.member,'requests',{after,expectedPolicyRevision:page.policyRevision})).rejects.toMatchObject({code:'access_history_changed',status:409})
    await pool.query('UPDATE workspace_access_policies SET revision=revision+1 WHERE workspace_id=$1',[f.workspaceId])
    await expect(getWorkspaceAccessHistory(f.workspaceId,f.member,'requests',{after:page.nextCursor!,expectedPolicyRevision:page.policyRevision})).rejects.toMatchObject({code:'access_history_changed'})
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.member])
    await expect(getWorkspaceAccessHistory(f.workspaceId,f.member,'requests')).rejects.toMatchObject({code:'not_found'})
  })
  it('uses a deterministic ID tiebreaker and does not repeat newer inserts',async()=>{
    const f=await fixture();await f.seed(51)
    const page=await getWorkspaceAccessHistory(f.workspaceId,f.member,'requests')
    await f.seed(2,f.member,0)
    await expect(getWorkspaceAccessHistory(f.workspaceId,f.member,'requests',{after:page.nextCursor!,expectedPolicyRevision:page.policyRevision})).rejects.toMatchObject({code:'access_history_changed'})
    const current=await getWorkspaceAccess(f.workspaceId,f.member)
    const next=await getWorkspaceAccessHistory(f.workspaceId,f.member,'requests',{after:page.nextCursor!,expectedPolicyRevision:current.policyRevision})
    expect(next.requests.every(row=>!page.requests.some(old=>old.id===row.id))).toBe(true)
    const ids=(await pool.query('SELECT id FROM workspace_access_requests WHERE workspace_id=$1 AND (created_at,id)<(SELECT created_at,id FROM workspace_access_requests WHERE id=$2) ORDER BY created_at DESC,id DESC',[f.workspaceId,page.nextCursor])).rows.map(row=>row.id)
    expect(next.requests.map(row=>row.id)).toEqual(ids)
  })
  it('confirms and applies an old request through the native saved-review path',async()=>{
    const f=await fixture();await f.seed(51)
    const id=randomUUID()
    await pool.query(`INSERT INTO workspace_access_requests(id,workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,target_team_id,reason,starts_at,expires_at,created_at,request_expires_at,payload_hash,policy_revision)
      VALUES($1,$2,$3,'member',$3,$4,'Review older project request',now(),now()+interval '1 day','2029-12-31T23:59:59Z','2030-01-02T00:00:00Z',repeat('b',64),1)`,[id,f.workspaceId,f.member,f.target.id])
    await executeDepartmentAccessCommand(f.workspaceId,f.owner,{type:'access.request.assign',requestId:id})
    const view=await getWorkspaceAccess(f.workspaceId,f.owner)
    expect(view.requests.some(row=>row.id===id)).toBe(false)
    const selected=await getWorkspaceAccessRequest(f.workspaceId,f.owner,id)
    const tool=createWorkspaceAccessTools()[2],context={workspaceId:f.workspaceId,workspaceActorUserId:f.owner} as ToolContext
    const intent={command:{type:'access.request.decide',requestId:id,expectedVersion:selected.request.version,payloadHash:selected.request.payloadHash,policyRevision:selected.policyRevision,decision:'rejected'},expectedPolicyRevision:selected.policyRevision,idempotencyKey:randomUUID()}
    expect((await tool.describeConfirmation!(intent,context))?.join(' ')).toContain('Review older project request')
    expect((await tool.execute(intent,context)).isError).not.toBe(true)
    expect((await getWorkspaceAccessRequest(f.workspaceId,f.owner,id)).request.status).toBe('rejected')
  })
  it('serves identical HTTP/native pages, validates shapes and reads old decisions directly',async()=>{
    const f=await fixture();await f.seed(51)
    const view=await getWorkspaceAccess(f.workspaceId,f.member)
    const query={after:view.nextRequestCursor!,expectedPolicyRevision:view.policyRevision}
    const response=await request(f.appFor(f.member)).get(`/api/workspaces/${f.workspaceId}/access/requests`).query(query)
    expect(response.status).toBe(200);expect(response.headers['cache-control']).toBe('no-store');expect(response.body.requests).toHaveLength(1)
    const context={workspaceId:f.workspaceId,workspaceActorUserId:f.member} as ToolContext
    const result=await createWorkspaceAccessTools()[0].execute({history:'requests',...query},context)
    expect((result.data as {requests:unknown[]}).requests).toEqual(response.body.requests)
    const selected=await getWorkspaceAccessRequest(f.workspaceId,f.owner,response.body.requests[0].id)
    expect(selected.request.id).toBe(response.body.requests[0].id)
    await expect(getWorkspaceAccessRequest(f.workspaceId,f.other,selected.request.id)).rejects.toMatchObject({code:'not_found'})
    for(const invalid of [{after:query.after},{expectedPolicyRevision:view.policyRevision},{after:'bad',expectedPolicyRevision:'1'},{limit:500},{after:query.after,expectedPolicyRevision:'0'}])expect((await request(f.appFor(f.member)).get(`/api/workspaces/${f.workspaceId}/access/requests`).query(invalid)).status).toBe(400)
  })
})
