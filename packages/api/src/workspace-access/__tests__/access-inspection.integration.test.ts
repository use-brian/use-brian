import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it,vi} from 'vitest'
import type {ToolContext} from '@use-brian/core'
import {runWithAgentAccess} from '../../db/agent-access-context.js'
import {executeOrganizationCommand} from '../../db/org-chart-store.js'
import {getPool,getAppPool} from '../../db/client.js'
import {createDbWorkspaceGroupStore} from '../../db/workspace-group-store.js'
import {executeDepartmentAccessCommand as execute} from '../service.js'
import {explainWorkspaceAccess,getWorkspaceAccessEvents,getWorkspaceDepartmentRegistry} from '../access-inspection.js'
import {createWorkspaceAccessTools} from '../tools.js'
// Projection tests exercise existing canonical grants. Separate real readiness
// coverage keeps this incomplete release gated; this mock is not certification.
// This suite asserts the legacy (pre-v2) model, which workspaces.department_read_v2=false still
// serves as the cutover's rollback path (migration 650, decision D22); its workspaces are pinned to it.
vi.mock('../readiness.js',()=>({getDepartmentalReadinessSystem:async()=>({ready:true,enforcementVersion:2,requiredEnforcementVersion:2,missingCapabilities:[]})}))
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
async function fixture(){
  const workspaceId=randomUUID(),owner=randomUUID(),member=randomUUID(),outsider=randomUUID()
  for(const id of [owner,member,outsider])await pool.query('INSERT INTO users(id,auth_provider_id,name) VALUES($1::uuid,$1::text,$2)',[id,id===owner?'Fixture owner':'Fixture member'])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Inspection fixture',$2,false)",[workspaceId,owner])
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
  it('shares an expiring registry without hidden assignment counts, names or emails',async()=>{
    const f=await fixture(),hidden=await f.groups.createTeam(f.owner,f.workspaceId,{name:'Private operations',key:'private-operations'}),assistantId=randomUUID()
    await execute(f.workspaceId,f.owner,{type:'department.read_bundle.set',teamId:f.team.id,readAll:false,groupIds:[hidden.id]})
    await pool.query("INSERT INTO assistants(id,workspace_id,name) VALUES($1,$2,'Unpublished assistant')",[assistantId,f.workspaceId])
    await execute(f.workspaceId,f.owner,{type:'department.assistant.set',teamId:f.team.id,assistantId,enabled:true})
    const published=await executeOrganizationCommand(f.workspaceId,f.owner,{type:'org.unit.save',name:'Published research',parentId:null,teamId:f.team.id,directoryVisibility:'workspace',position:0})
    await executeOrganizationCommand(f.workspaceId,f.owner,{type:'org.unit.save',name:'Private structure',parentId:null,teamId:hidden.id,directoryVisibility:'members',position:1})
    const member=await getWorkspaceDepartmentRegistry(f.workspaceId,f.member)
    expect(member).toMatchObject({canAdminister:false,people:[{id:f.member}],assistants:[],requestPolicy:{defaultDays:30,maxDays:90,ongoingAdminOnly:true}})
    expect(member.teams).toHaveLength(1)
    expect(member.teams[0]).toMatchObject({id:f.team.id,memberIds:[],assistantIds:[],readGrantGroupIds:[],orgUnits:[{id:published.units[0].id,name:'Published research'}]})
    expect(member.validForMs).toBeGreaterThan(0);expect(member.validForMs).toBeLessThanOrEqual(30000)
    const wire=JSON.stringify(member)
    for(const forbidden of ['Private operations','Private structure','Unpublished assistant','memberCount','email',hidden.compartmentKey!])expect(wire).not.toContain(forbidden)
    const owner=await getWorkspaceDepartmentRegistry(f.workspaceId,f.owner)
    expect(owner.canAdminister).toBe(true);expect(owner.teams.find(team=>team.id===f.team.id)?.readGrantGroupIds).toContain(hidden.id)
    expect(owner.assistants).toContainEqual({id:assistantId,name:'Unpublished assistant'})
    const native=await createWorkspaceAccessTools()[0].execute({registry:true},{workspaceId:f.workspaceId,workspaceActorUserId:f.member,userId:f.owner} as ToolContext)
    expect(native.data).toMatchObject({teams:member.teams,people:member.people,assistants:member.assistants,policyRevision:member.policyRevision})
    await executeOrganizationCommand(f.workspaceId,f.owner,{type:'org.unit.save',id:published.units[0].id,expectedVersion:published.units[0].version,name:'Published research',parentId:null,teamId:f.team.id,directoryVisibility:'members',position:0})
    expect((await getWorkspaceDepartmentRegistry(f.workspaceId,f.member)).teams[0].orgUnits).toEqual([])
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.member])
    await expect(getWorkspaceDepartmentRegistry(f.workspaceId,f.member)).rejects.toMatchObject({code:'not_found'})
    await expect(getWorkspaceDepartmentRegistry(f.workspaceId,f.owner,{unexpected:true})).rejects.toMatchObject({code:'invalid_command'})
  })
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
  it('intersects native inspection with the running ceiling and current authority independently',async()=>{
    const f=await fixture(),tool=createWorkspaceAccessTools()[0],assistantId=randomUUID()
    await execute(f.workspaceId,f.owner,{type:'department.member.set',teamId:f.team.id,userId:f.member,enabled:true})
    await pool.query("INSERT INTO assistants(id,workspace_id,name,clearance,team_scope_mode,project_scope_mode) VALUES($1,$2,'Broad inspection fixture','confidential','all','all')",[assistantId,f.workspaceId])
    await pool.query("INSERT INTO assistant_members(assistant_id,user_id,role) VALUES($1,$2,'member')",[assistantId,f.member])
    // Directory visibility is independent of assistant membership/content scope.
    const chart=await executeOrganizationCommand(f.workspaceId,f.owner,{type:'org.unit.save',name:'Published fixture',parentId:null,teamId:null,directoryVisibility:'workspace',position:0})
    await executeOrganizationCommand(f.workspaceId,f.owner,{type:'org.placement.save',unitId:chart.units[0].id,userId:null,assistantId,isPrimary:true,reportsToUserId:null,accountableUserId:null})
    const context={workspaceId:f.workspaceId,workspaceActorUserId:f.member,userId:f.owner} as ToolContext
    const ceiling={workspaceId:f.workspaceId,userId:f.member,clearance:'public',compartments:[f.team.compartmentKey!],mutationCompartments:[],projectIds:[]}
    const inspect=(selection:Record<string,unknown>)=>runWithAgentAccess(ceiling,()=>tool.execute({explain:{assistantId,...selection}},context))
    const allowed=await inspect({targetTeamId:f.team.id,sensitivity:'public'})
    expect(allowed.data).toMatchObject({clearance:'public',readTeamIds:[f.team.id],mutationTeamIds:[],projectIds:[],example:{matchesScope:true}})
    expect((await inspect({targetTeamId:f.team.id,sensitivity:'internal'})).data).toMatchObject({example:{matchesScope:false}})
    expect((await inspect({targetTeamId:f.team.id,sensitivity:'public',action:'edit'})).data).toMatchObject({example:{matchesScope:false}})
    // A new grant changes current human permissions without widening this turn.
    const other=await f.groups.createTeam(f.owner,f.workspaceId,{name:'Operations',key:'operations'})
    await execute(f.workspaceId,f.owner,{type:'department.member.set',teamId:other.id,userId:f.member,enabled:true})
    expect((await explainWorkspaceAccess(f.workspaceId,f.member,{assistantId,targetTeamId:other.id})).example.matchesScope).toBe(true)
    expect((await inspect({targetTeamId:other.id,sensitivity:'public'})).data).toMatchObject({readTeamIds:[f.team.id],example:{matchesScope:false}})
    // Conversely, the retained starting ceiling cannot restore a removed path.
    await execute(f.workspaceId,f.owner,{type:'department.member.set',teamId:f.team.id,userId:f.member,enabled:false})
    expect((await inspect({targetTeamId:f.team.id,sensitivity:'public'})).data).toMatchObject({readTeamIds:[],mutationTeamIds:[],example:{matchesScope:false}})
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
