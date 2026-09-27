import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it,vi} from 'vitest'
import type {ToolContext} from '@use-brian/core'
import {getPool,getAppPool} from '../../db/client.js'
import {createDbWorkspaceGroupStore} from '../../db/workspace-group-store.js'
import {executeDepartmentAccessCommand as execute} from '../service.js'
import {explainWorkspaceAccess,getWorkspaceAccessEvents} from '../access-inspection.js'
import {createWorkspaceAccessTools} from '../tools.js'
// Projection tests exercise existing canonical grants. Separate real readiness
// coverage keeps this incomplete release gated; this mock is not certification.
vi.mock('../readiness.js',()=>({getDepartmentalReadinessSystem:async()=>({ready:true,enforcementVersion:2,requiredEnforcementVersion:2,missingCapabilities:[]})}))
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
async function fixture(){
  const workspaceId=randomUUID(),owner=randomUUID(),member=randomUUID(),outsider=randomUUID()
  for(const id of [owner,member,outsider])await pool.query('INSERT INTO users(id,auth_provider_id,name) VALUES($1::uuid,$1::text,$2)',[id,id===owner?'Fixture owner':'Fixture member'])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Inspection fixture',$2)",[workspaceId,owner])
  for(const id of [owner,member,outsider])await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,team_scope_mode) VALUES($1,$2,$3,'assigned')",[workspaceId,id,id===owner?'owner':'member'])
  const groups=createDbWorkspaceGroupStore()
  const team=await groups.createTeam(owner,workspaceId,{name:'Research',key:'research'})
  await execute(workspaceId,owner,{type:'department.configure',teamId:team.id,directoryVisibility:'workspace',requestable:true})
  async function grant(){
    const requested=await execute(workspaceId,member,{type:'access.request.create',targetTeamId:team.id,beneficiaryKind:'member',beneficiaryId:member,reason:'Review requirements',days:30,ongoing:false})
    const r=requested.requests.find(row=>row.status==='pending')!
    const approved=await execute(workspaceId,owner,{type:'access.request.decide',requestId:r.id,expectedVersion:r.version,payloadHash:r.payloadHash,policyRevision:requested.policyRevision,decision:'approved'})
    return approved.grants.find(row=>row.requestId===r.id)!
  }
  return{workspaceId,owner,member,outsider,team,groups,grant}
}
describe('[COMP:api/workspace-access] current authority explanations and audit',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  it('keeps independent grants visible after revocation and never turns a read grant into editing',async()=>{
    const f=await fixture(),first=await f.grant(),second=await f.grant()
    await execute(f.workspaceId,f.owner,{type:'department.member.set',teamId:f.team.id,userId:f.member,enabled:true})
    const before=await explainWorkspaceAccess(f.workspaceId,f.member,{targetTeamId:f.team.id,action:'edit'})
    expect(before.example.matchesScope).toBe(true)
    expect(before.paths.filter(path=>path.kind==='read_grant').map(path=>path.grantId).sort()).toEqual([first.id,second.id].sort())
    expect(before.paths.find(path=>path.kind==='membership')?.targetTeamIds).toContain(f.team.id)
    await execute(f.workspaceId,f.member,{type:'access.grant.revoke',grantId:first.id,reason:'No longer needed'})
    await execute(f.workspaceId,f.owner,{type:'department.member.set',teamId:f.team.id,userId:f.member,enabled:false})
    const after=await explainWorkspaceAccess(f.workspaceId,f.member,{targetTeamId:f.team.id,action:'edit'})
    expect(after.paths.map(path=>path.grantId)).toEqual([second.id])
    expect(after.readTeamIds).toEqual([f.team.id]);expect(after.mutationTeamIds).toEqual([])
    expect(after.example).toMatchObject({matchesScope:false,resourceAuthorizationRequired:true})
    expect((await explainWorkspaceAccess(f.workspaceId,f.member,{targetTeamId:f.team.id})).example.matchesScope).toBe(true)
  })
  it('explains Team-beneficiary grants only for current direct members',async()=>{
    const f=await fixture(),beneficiary=await f.groups.createTeam(f.owner,f.workspaceId,{name:'Delivery',key:'delivery'})
    await pool.query("UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.outsider])
    const requested=await execute(f.workspaceId,f.owner,{type:'access.request.create',targetTeamId:f.team.id,beneficiaryKind:'team',beneficiaryId:beneficiary.id,reason:'Shared review',days:30,ongoing:false})
    const r=requested.requests[0]
    await execute(f.workspaceId,f.outsider,{type:'access.request.decide',requestId:r.id,expectedVersion:r.version,payloadHash:r.payloadHash,policyRevision:requested.policyRevision,decision:'approved'})
    expect((await explainWorkspaceAccess(f.workspaceId,f.member,{})).paths).toEqual([])
    await execute(f.workspaceId,f.owner,{type:'department.member.set',teamId:beneficiary.id,userId:f.member,enabled:true})
    const explanation=await explainWorkspaceAccess(f.workspaceId,f.member,{targetTeamId:f.team.id,action:'edit'})
    expect(explanation.paths.find(path=>path.kind==='team_read_grant')).toMatchObject({sourceTeamId:beneficiary.id,targetTeamIds:[f.team.id]})
    expect(explanation.example.matchesScope).toBe(false)
    await execute(f.workspaceId,f.owner,{type:'department.member.set',teamId:beneficiary.id,userId:f.member,enabled:false})
    expect((await explainWorkspaceAccess(f.workspaceId,f.member,{})).paths).toEqual([])
  })
  it('preserves trusted role and sensitivity gates, without claiming resource permission',async()=>{
    const f=await fixture()
    const owner=await explainWorkspaceAccess(f.workspaceId,f.owner,{targetTeamId:f.team.id,action:'edit',sensitivity:'confidential'})
    expect(owner.readTeamIds).toBeNull();expect(owner.mutationTeamIds).toBeNull();expect(owner.example.matchesScope).toBe(true)
    expect(owner.paths.map(path=>path.kind)).toEqual(['trusted_role'])
    await f.grant()
    const member=await explainWorkspaceAccess(f.workspaceId,f.member,{targetTeamId:f.team.id,sensitivity:'confidential'})
    expect(member.clearance).toBe('internal');expect(member.example.matchesScope).toBe(false)
    expect((await explainWorkspaceAccess(f.workspaceId,f.member,{})).example.matchesScope).toBe(true)
  })
  it('refuses another member and hidden/foreign references with the same not-found result',async()=>{
    const f=await fixture(),hidden=await f.groups.createTeam(f.owner,f.workspaceId,{name:'Hidden audience',key:'hidden'})
    const assistantId=randomUUID()
    await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name) VALUES($1,$2,$3,'Hidden assistant')",[assistantId,f.workspaceId,f.owner])
    for(const input of [{memberId:f.owner},{memberId:randomUUID()},{targetTeamId:hidden.id},{targetTeamId:randomUUID()},{contextTeamId:hidden.id},{assistantId},{assistantId:randomUUID()},{contextProjectId:randomUUID()}]){
      await expect(explainWorkspaceAccess(f.workspaceId,f.member,input)).rejects.toMatchObject({code:'not_found',status:404})
    }
    const projection=await explainWorkspaceAccess(f.workspaceId,f.member,{})
    expect(JSON.stringify(projection)).not.toContain(hidden.id)
    expect(projection.choices.assistants).not.toContainEqual(expect.objectContaining({id:assistantId}))
    expect((await explainWorkspaceAccess(f.workspaceId,f.owner,{memberId:f.member})).memberId).toBe(f.member)
  })
  it('intersects the selected assistant and context with the human without owner substitution',async()=>{
    const f=await fixture();await f.grant()
    const assistantId=randomUUID()
    await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,clearance,team_scope_mode,compartments) VALUES($1,$2,$3,'Fixture assistant','confidential','assigned',NULL)",[assistantId,f.workspaceId,f.owner])
    let explanation=await explainWorkspaceAccess(f.workspaceId,f.owner,{memberId:f.member,assistantId,targetTeamId:f.team.id})
    expect(explanation.choices.assistants).toContainEqual({id:assistantId,name:'Fixture assistant'})
    expect(explanation.readTeamIds).toEqual([]);expect(explanation.example.matchesScope).toBe(false)
    await execute(f.workspaceId,f.owner,{type:'department.assistant.set',teamId:f.team.id,assistantId,enabled:true})
    explanation=await explainWorkspaceAccess(f.workspaceId,f.owner,{memberId:f.member,assistantId,contextTeamId:f.team.id,targetTeamId:f.team.id})
    expect(explanation.readTeamIds).toEqual([f.team.id]);expect(explanation.mutationTeamIds).toEqual([])
    expect(explanation.clearance).toBe('internal')
    await expect(explainWorkspaceAccess(f.workspaceId,f.owner,{expectedPolicyRevision:'1'})).rejects.toMatchObject({code:'access_policy_conflict'})
  })
  it('omits expired, scheduled and revoked grants using server time',async()=>{
    const f=await fixture(),g=await f.grant()
    // Seed historical and scheduled approved tuples in this disposable fixture;
    // immutable payload triggers remain enabled throughout.
    await pool.query(`WITH r AS (
      INSERT INTO workspace_access_requests(workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,target_team_id,reason,starts_at,expires_at,payload_hash,policy_revision,status,decided_by,decided_at)
      SELECT $1,$2,'member',$2,$3,'Interval fixture',now()+n*interval '1 day',now()+(n+1)*interval '1 day',repeat('a',64),1,'approved',$4,now()
      FROM unnest(ARRAY[-2,2]) n RETURNING *
    ) INSERT INTO workspace_access_grants(workspace_id,request_id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,approved_by)
      SELECT workspace_id,id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,decided_by FROM r`,[f.workspaceId,f.member,f.team.id,f.owner])
    await pool.query("UPDATE workspace_access_grants SET revoked_at=now(),revoked_by=$2,revocation_reason='fixture revocation' WHERE id=$1",[g.id,f.owner])
    const value=await explainWorkspaceAccess(f.workspaceId,f.member,{targetTeamId:f.team.id})
    expect(value.paths).toEqual([]);expect(value.example.matchesScope).toBe(false)
  })
  it('filters audit before pagination, omits raw content and rejects invisible anchors',async()=>{
    const f=await fixture(),hidden=await f.groups.createTeam(f.owner,f.workspaceId,{name:'Hidden audience',key:'hidden'})
    await f.grant()
    const authorized=await getWorkspaceAccessEvents(f.workspaceId,f.member)
    expect(authorized.events.some(event=>event.kind==='access.request.decide')).toBe(true)
    expect(authorized.events.every(event=>!('changes' in event))).toBe(true)
    const secretEvent=(await pool.query<{id:string}>(`INSERT INTO workspace_access_events(workspace_id,actor_user_id,kind,subject_id,policy_revision,changes) VALUES($1,$2,'department.configure',$3,1,$4) RETURNING id`,[f.workspaceId,f.owner,hidden.id,JSON.stringify({body:'hidden fixture text'})])).rows[0].id
    await pool.query(`INSERT INTO workspace_access_events(workspace_id,actor_user_id,kind,subject_id,policy_revision,changes) SELECT $1,$2,'department.configure',$3,1,'{}' FROM generate_series(1,55)`,[f.workspaceId,f.owner,hidden.id])
    const member=await getWorkspaceAccessEvents(f.workspaceId,f.member)
    expect(member.events.map(event=>event.id)).toEqual(authorized.events.map(event=>event.id))
    expect(member.nextCursor).toBeNull();expect(JSON.stringify(member)).not.toContain(hidden.id)
    const admin=await getWorkspaceAccessEvents(f.workspaceId,f.owner)
    expect(admin.events).toHaveLength(50);expect(admin.nextCursor).toBeTruthy();expect(JSON.stringify(admin)).not.toContain('hidden fixture text')
    const older=await getWorkspaceAccessEvents(f.workspaceId,f.owner,{after:admin.nextCursor!,expectedPolicyRevision:admin.policyRevision})
    expect(older.events.length).toBeGreaterThan(0);expect(older.events.some(event=>admin.events.some(a=>a.id===event.id))).toBe(false)
    for(const after of [secretEvent,randomUUID()])await expect(getWorkspaceAccessEvents(f.workspaceId,f.member,{after,expectedPolicyRevision:member.policyRevision})).rejects.toMatchObject({code:'access_history_changed'})
  })
  it('uses the same live projections from native tools and refuses programmatic actors',async()=>{
    const f=await fixture(),tool=createWorkspaceAccessTools()[0]
    const context={workspaceId:f.workspaceId,workspaceActorUserId:f.member,userId:f.owner} as ToolContext
    const response=await tool.execute({explain:{targetTeamId:f.team.id,action:'edit'}},context)
    expect(response.data).toMatchObject({memberId:f.member,example:{matchesScope:false}})
    expect((await tool.execute({history:'events'},context)).data).toMatchObject({events:[]})
    expect((await tool.execute({explain:{}},{...context,programmaticPrincipal:{} as never})).isError).toBe(true)
  })
})
