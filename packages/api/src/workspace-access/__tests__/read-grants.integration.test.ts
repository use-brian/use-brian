import request from 'supertest'
import { memoryRoutes } from '../../routes/memories.js'
import { createTestApp } from '../../routes/__tests__/helpers.js'
import { adjustMemoryDecision } from '../../db/memory-verifications-store.js'
import { pinAccessCeiling } from '@use-brian/core'
import { resolveTurnScopeSystem,resolveLiveAccessCeilingSystem } from '../../context-scope/resolve-turn-scope.js'
import { createAuthorityLease,runWithAuthorityLease,executeWithCurrentAuthority } from '../../context-scope/authority-lease.js'
import { createMemory,getMemoryById,updateMemory,deleteMemory,listUnverifiedByWorkspace,countUnverifiedByWorkspace } from '../../db/memories.js'
import { randomUUID } from 'node:crypto'
import { afterAll,describe,expect,it } from 'vitest'
import { projectionLifetime } from '../projection-lifetime.js'
import { getPool,getAppPool,runWithAgentAccess,queryWithRLS } from '../../db/client.js'
import { resolveWorkspaceViewpoint } from '../../db/workspace-viewpoint.js'
import { createDbContextScopeStore } from '../../db/context-scope-store.js'
import { createEntity,updateEntity } from '../../db/entities-store.js'
import { createDbWorkspaceGroupStore } from '../../db/workspace-group-store.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
async function fixture(){
  const workspaceId=randomUUID(),owner=randomUUID(),member=randomUUID(),other=randomUUID()
  for(const id of [owner,member,other])await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await pool.query(`INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Access fixture',$2)`,[workspaceId,owner])
  for(const id of [owner,member,other])await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role,team_scope_mode) VALUES($1,$2,$3,'assigned')`,[workspaceId,id,id===owner?'owner':'member'])
  const groups=createDbWorkspaceGroupStore()
  const finance=await groups.createTeam(owner,workspaceId,{name:'Finance',key:'finance'})
  const research=await groups.createTeam(owner,workspaceId,{name:'Research',key:'research'})
  const delivery=await groups.createTeam(owner,workspaceId,{name:'Delivery',key:'delivery'})
  await groups.setTeamReadBundle(owner,finance.id,{readAll:false,compartmentKeys:[finance.compartmentKey!,research.compartmentKey!]})
  async function grant(input:{kind?:'member'|'team';beneficiary?:string;approver?:string;expired?:boolean;expiresIn?:string}={}){
    const id=randomUUID(),kind=input.kind??'member',beneficiary=input.beneficiary??member,approver=input.approver??owner
    await pool.query(`INSERT INTO workspace_access_requests(id,workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,target_team_id,reason,starts_at,expires_at,payload_hash,policy_revision,status,decided_by,decided_at)
      VALUES($1,$2,$3,$4,$5,$6,'Fixture request',now()-interval '2 days',now()+$7::interval,$8,1,'approved',$9,now())`,[id,workspaceId,member,kind,beneficiary,finance.id,input.expired?'-1 day':input.expiresIn??'28 days','a'.repeat(64),approver])
    const result=await pool.query<{id:string}>(`INSERT INTO workspace_access_grants(workspace_id,request_id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,approved_by)
      SELECT workspace_id,id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,decided_by FROM workspace_access_requests WHERE id=$1 RETURNING id`,[id])
    return{requestId:id,id:result.rows[0].id}
  }
  async function reach(userId=member){return(await pool.query('SELECT effective_member_team_compartments($1,$2) AS mutation,effective_member_read_compartments($1,$2) AS read',[userId,workspaceId])).rows[0] as{mutation:string[]|null;read:string[]|null}}
  const assistantId=randomUUID()
  await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind,clearance,team_scope_mode) VALUES($1,$2,$3,'Fixture primary','primary','confidential','all')",[assistantId,workspaceId,owner])
  const assistant={id:assistantId,workspaceId,kind:'primary' as const,clearance:'confidential' as const,compartments:null,teamScopeMode:'all' as const}
  const input={userId:member,assistant,workspaceId}
  return{workspaceId,owner,member,other,groups,finance,research,delivery,grant,reach,assistantId,assistant,input}
}
describe('[COMP:api/workspace-access] database read grants and immutable authority',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  it('adds only the target compartment to read reach without importing its foreign bundle or changing mutation reach',async()=>{
    const f=await fixture();await f.grant()
    expect(await f.reach()).toEqual({mutation:[],read:[f.finance.compartmentKey]})
    expect(await f.reach(f.other)).toEqual({mutation:[],read:[]})
    expect(await f.reach(f.owner)).toEqual({mutation:null,read:null})
  })
  it('honors expiry and revocation at query time without cleanup jobs',async()=>{
    const f=await fixture();await f.grant({expired:true});expect((await f.reach()).read).toEqual([])
    const grant=await f.grant();expect((await f.reach()).read).toEqual([f.finance.compartmentKey])
    await pool.query(`UPDATE workspace_access_grants SET revoked_at=now(),revoked_by=$2 WHERE id=$1`,[grant.id,f.owner])
    expect((await f.reach()).read).toEqual([])
    await expect(pool.query('UPDATE workspace_access_grants SET revoked_at=NULL,revoked_by=NULL WHERE id=$1',[grant.id])).rejects.toThrow('access_revocation_immutable')
  })
  it('covers current and future direct Team members without transitive beneficiary reach',async()=>{
    const f=await fixture()
    // An approver cannot belong to the beneficiary Team.
    await f.groups.removeMember(f.owner,f.delivery.id,f.owner)
    await f.grant({kind:'team',beneficiary:f.delivery.id})
    expect((await f.reach()).read).toEqual([])
    await f.groups.addMember(f.owner,f.delivery.id,f.member)
    expect(((await f.reach()).read ?? []).sort()).toEqual([f.delivery.compartmentKey,f.finance.compartmentKey].sort())
    expect((await f.reach()).mutation).toEqual([f.delivery.compartmentKey])
    await f.groups.addMember(f.owner,f.research.id,f.other)
    await f.groups.setTeamReadBundle(f.owner,f.research.id,{readAll:false,compartmentKeys:[f.research.compartmentKey!,f.delivery.compartmentKey!]})
    expect((await f.reach(f.other)).read).not.toContain(f.finance.compartmentKey)
    await f.groups.removeMember(f.owner,f.delivery.id,f.member)
    expect((await f.reach()).read).toEqual([])
  })
  it('resolves real read-only grant reach and refuses canonical source updates, deletes and direct writes',async()=>{
    const f=await fixture()
    const memory=await createMemory({workspaceId:f.workspaceId,assistantId:f.assistantId,userId:null,createdByUserId:f.owner,scope:'workspace',summary:'Finance source',sensitivity:'internal',compartments:[f.finance.compartmentKey!]})
    expect(await getMemoryById((await resolveTurnScopeSystem(f.input)).access,memory.id)).toBeNull()
    await f.grant()
    const scope=await resolveTurnScopeSystem(f.input)
    expect(scope.access).toMatchObject({clearance:'internal',compartments:[f.finance.compartmentKey],mutationCompartments:[]})
    await runWithAgentAccess(pinAccessCeiling(scope.access),async()=>{
      expect(await getMemoryById(scope.access,memory.id)).toMatchObject({id:memory.id})
      expect((await queryWithRLS(f.member,'SELECT id FROM memories WHERE id=$1',[memory.id])).rows).toHaveLength(1)
      expect(await updateMemory(memory.id,{summary:'Unauthorized edit'},scope.access)).toBeNull()
      await expect(deleteMemory(memory.id)).rejects.toMatchObject({code:'scope_operation_denied'})
      expect((await queryWithRLS(f.member,"UPDATE memories SET summary='Unauthorized SQL edit' WHERE id=$1 RETURNING id",[memory.id])).rows).toEqual([])
      await expect(createMemory({workspaceId:f.workspaceId,assistantId:f.assistantId,userId:f.member,createdByUserId:f.member,summary:'Unauthorized direct write',sensitivity:'internal',compartments:[f.finance.compartmentKey!]})).rejects.toMatchObject({code:'scope_operation_denied'})
    })
    expect((await pool.query('SELECT summary FROM memories WHERE id=$1',[memory.id])).rows[0].summary).toBe('Finance source')
    const source=(await pool.query("SELECT read_scope_source($1,'memory',$2) AS source",[f.workspaceId,memory.id])).rows[0].source
    const derived=await runWithAgentAccess(pinAccessCeiling(scope.access),()=>createMemory({workspaceId:f.workspaceId,assistantId:f.assistantId,userId:f.member,createdByUserId:f.member,summary:'Protected derived explanation',sensitivity:'public',compartments:[],derivation:{producer:'fixture:read-grant',sources:[source]}}))
    expect(derived).toMatchObject({compartments:[f.finance.compartmentKey],sensitivity:'internal'})
  })
  it.each(['departments','simple'])('preserves protected read-grant derivation without granting mutation in ready %s',async mode=>{
    const f=await fixture()
    const memory=await createMemory({workspaceId:f.workspaceId,assistantId:f.assistantId,userId:null,createdByUserId:f.owner,summary:'Read-only source',sensitivity:'internal',compartments:[f.finance.compartmentKey!]})
    const grant=await f.grant()
    await pool.query("UPDATE workspace_access_policies SET setup_state='ready',access_mode=$2,default_department_id=$3 WHERE workspace_id=$1",[f.workspaceId,mode,f.research.id])
    const scope=await resolveTurnScopeSystem(f.input)
    const source=(await pool.query("SELECT read_scope_source($1,'memory',$2) AS source",[f.workspaceId,memory.id])).rows[0].source
    const create=(extra:string[]=[])=>runWithAgentAccess(pinAccessCeiling(scope.access),()=>createMemory({
      workspaceId:f.workspaceId,assistantId:f.assistantId,userId:f.member,createdByUserId:f.member,summary:'Protected derivative',
      sensitivity:'public',compartments:extra,derivation:{producer:'ready-read-grant',sources:[source]},
    }))
    expect(await create()).toMatchObject({compartments:[f.finance.compartmentKey],sensitivity:'internal'})
    await expect(create([f.delivery.compartmentKey!])).rejects.toMatchObject({code:mode==='simple'?'access_mode_destination_conflict':'context_not_available'})
    await expect(runWithAgentAccess(pinAccessCeiling(scope.access),()=>createMemory({workspaceId:f.workspaceId,assistantId:f.assistantId,userId:f.member,createdByUserId:f.member,summary:'Direct source edit intent',sensitivity:'internal',compartments:[f.finance.compartmentKey!]}))).rejects.toMatchObject({code:'context_not_available'})
    await pool.query('UPDATE workspace_access_grants SET revoked_at=now(),revoked_by=$2 WHERE id=$1',[grant.id,f.owner])
    await expect(create()).rejects.toMatchObject({code:'context_not_available'})
    expect((await pool.query('SELECT count(*)::int n FROM memories WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(2)
    expect((await pool.query('SELECT summary FROM memories WHERE id=$1',[memory.id])).rows[0].summary).toBe('Read-only source')
  })
  it('keeps read grants read-only through real Memory HTTP actions',async()=>{
    const f=await fixture()
    await pool.query("UPDATE assistants SET kind='standard' WHERE id=$1",[f.assistantId])
    const memory=await createMemory({workspaceId:f.workspaceId,assistantId:f.assistantId,userId:f.member,createdByUserId:f.member,scope:'shared',summary:'Department source',sensitivity:'internal',compartments:[f.finance.compartmentKey!]})
    const app=createTestApp('/api/assistants/:assistantId/memories',memoryRoutes(),{userId:f.member})
    const path=`/api/assistants/${f.assistantId}/memories/${memory.id}`
    expect((await request(app).get(path)).status).toBe(404)
    await f.grant()
    expect((await request(app).get(path)).status).toBe(200)
    expect((await request(app).patch(path).send({summary:'Forbidden'})).status).toBe(404)
    expect((await request(app).post(`${path}/scope`).send({scope:'workspace'})).status).toBe(404)
    expect((await request(app).post(`${path}/adjust`).send({summary:'Forbidden'})).status).toBe(404)
    expect((await request(app).post(`${path}/verify`).send({})).status).toBe(404)
    expect((await request(app).delete(path)).status).toBe(404)
    expect((await pool.query('SELECT summary,valid_to FROM memories WHERE id=$1',[memory.id])).rows[0]).toEqual({summary:'Department source',valid_to:null})
    expect(Number((await pool.query('SELECT count(*) AS n FROM memory_verifications WHERE workspace_id=$1',[f.workspaceId])).rows[0].n)).toBe(0)
    expect(Number((await pool.query('SELECT count(*) AS n FROM brain_row_versions WHERE row_id=$1',[memory.id])).rows[0].n)).toBe(0)
  })
  it('supports authorized adjustment, scope changes and deletion through the Memory screen',async()=>{
    const f=await fixture();await f.groups.addMember(f.owner,f.finance.id,f.member)
    await pool.query("UPDATE assistants SET kind='standard' WHERE id=$1",[f.assistantId])
    const memory=await createMemory({workspaceId:f.workspaceId,assistantId:f.assistantId,userId:f.member,createdByUserId:f.member,scope:'shared',summary:'Editable source',sensitivity:'internal',compartments:[f.finance.compartmentKey!]})
    const app=createTestApp('/api/assistants/:assistantId/memories',memoryRoutes(),{userId:f.member})
    const base=`/api/assistants/${f.assistantId}/memories`
    const edited=await request(app).post(`${base}/${memory.id}/adjust`).send({summary:'Authorized edit'})
    expect(edited.status,JSON.stringify(edited.body)).toBe(200)
    const promoted=await request(app).post(`${base}/${edited.body.memory.id}/scope`).send({scope:'workspace'})
    expect(promoted.status,JSON.stringify(promoted.body)).toBe(200)
    const personal=await request(app).post(`${base}/${promoted.body.memory.id}/scope`).send({scope:'user'})
    expect(personal.status,JSON.stringify(personal.body)).toBe(200)
    expect(personal.body.memory).toMatchObject({workspaceId:f.workspaceId,compartments:[f.finance.compartmentKey],scope:'shared'})
    expect((await request(app).delete(`${base}/${personal.body.memory.id}`)).status).toBe(204)
  })
  it('rechecks current membership when a retained human context attempts a mutation',async()=>{
    const f=await fixture();await f.groups.addMember(f.owner,f.finance.id,f.member)
    const memory=await createMemory({workspaceId:f.workspaceId,assistantId:f.assistantId,userId:null,createdByUserId:f.owner,scope:'workspace',summary:'Retained context source',sensitivity:'internal',compartments:[f.finance.compartmentKey!]})
    const ctx=(await resolveTurnScopeSystem(f.input)).access
    await f.groups.removeMember(f.owner,f.finance.id,f.member)
    expect(await updateMemory(memory.id,{summary:'Stale edit'},ctx)).toBeNull()
    expect(await deleteMemory(memory.id,undefined,undefined,ctx)).toBe(false)
    expect(await adjustMemoryDecision({memoryId:memory.id,workspaceId:f.workspaceId,verifiedBy:f.member,access:ctx,updates:{summary:'Stale adjustment'},verifications:[]})).toBeNull()
  })
  it('checks current destination reach and preserves lineage on authorized derived edits',async()=>{
    const f=await fixture();await f.groups.addMember(f.owner,f.delivery.id,f.member)
    const memory=await createMemory({workspaceId:f.workspaceId,assistantId:f.assistantId,userId:null,createdByUserId:f.owner,scope:'workspace',summary:'Editable delivery source',sensitivity:'internal',compartments:[f.delivery.compartmentKey!]})
    const input=await createMemory({workspaceId:f.workspaceId,assistantId:f.assistantId,userId:null,createdByUserId:f.owner,scope:'workspace',summary:'Delivery reference',sensitivity:'internal',compartments:[f.delivery.compartmentKey!]})
    const ctx=(await resolveTurnScopeSystem(f.input)).access
    expect(await updateMemory(memory.id,{compartments:[f.finance.compartmentKey!]},{...ctx,compartments:null,mutationCompartments:null})).toBeNull()
    const source=(await pool.query("SELECT read_scope_source($1,'memory',$2) AS source",[f.workspaceId,input.id])).rows[0].source
    const updated=await updateMemory(memory.id,{summary:'Derived authorized edit',derivation:{producer:'fixture:authorized-edit',sources:[source]}},ctx)
    expect(updated).toMatchObject({summary:'Derived authorized edit',compartments:[f.delivery.compartmentKey]})
    expect(Number((await pool.query('SELECT count(*) AS n FROM scope_derivations WHERE resource_id=$1',[updated!.id])).rows[0].n)).toBe(1)
    await updateMemory(input.id,{summary:'Changed source'})
    expect((await pool.query('SELECT scope_held FROM memories WHERE id=$1',[updated!.id])).rows[0].scope_held).toBe(true)
  })
  it('denies direct confirmation-receipt edits after a membership removal',async()=>{
    const f=await fixture();await f.groups.addMember(f.owner,f.finance.id,f.member)
    const memory=await createMemory({workspaceId:f.workspaceId,assistantId:f.assistantId,userId:null,createdByUserId:f.owner,scope:'workspace',summary:'Private source',sensitivity:'internal',compartments:[f.finance.compartmentKey!]})
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.member])
    expect(await adjustMemoryDecision({memoryId:memory.id,workspaceId:f.workspaceId,verifiedBy:f.member,updates:{summary:'Unauthorized'},verifications:[{action:'edit_summary',modelValue:'Private source',userValue:'Unauthorized'}]})).toBeNull()
    expect(Number((await pool.query('SELECT count(*) AS n FROM memory_verifications WHERE workspace_id=$1',[f.workspaceId])).rows[0].n)).toBe(0)
  })
  it('filters unverified lists, counts and pagination by the current viewer',async()=>{
    const f=await fixture()
    const memory=await createMemory({workspaceId:f.workspaceId,assistantId:f.assistantId,userId:null,createdByUserId:f.owner,scope:'workspace',summary:'Review source',sensitivity:'internal',compartments:[f.finance.compartmentKey!]})
    const denied=(await resolveTurnScopeSystem(f.input)).access
    expect(await listUnverifiedByWorkspace(denied,1)).toEqual([])
    expect(await countUnverifiedByWorkspace(denied)).toBe(0)
    await f.grant()
    const allowed=(await resolveTurnScopeSystem(f.input)).access
    expect((await listUnverifiedByWorkspace(allowed,1)).map(row=>row.id)).toEqual([memory.id])
    expect(await countUnverifiedByWorkspace(allowed)).toBe(1)
    await pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[memory.id])
    expect(await countUnverifiedByWorkspace(allowed)).toBe(0)
  })
  it('retains assistant and active-Team limits separately for reads and mutations',async()=>{
    const f=await fixture();await f.grant();await f.groups.addMember(f.owner,f.delivery.id,f.member)
    const denied=await resolveTurnScopeSystem({...f.input,assistant:{...f.assistant,teamScopeMode:'legacy',compartments:[f.delivery.compartmentKey!]}})
    expect(denied.access).toMatchObject({compartments:[f.delivery.compartmentKey],mutationCompartments:[f.delivery.compartmentKey]})
    const finance=await resolveTurnScopeSystem({...f.input,key:{contextGroupId:f.finance.id}})
    expect(finance.access).toMatchObject({compartments:[f.finance.compartmentKey],mutationCompartments:[]})
    expect(finance.writeCompartments).toEqual([f.finance.compartmentKey])
    const delivery=await resolveTurnScopeSystem({...f.input,key:{contextGroupId:f.delivery.id}})
    expect(delivery.access).toMatchObject({compartments:[f.delivery.compartmentKey],mutationCompartments:[f.delivery.compartmentKey]})
    const publicAssistant=await resolveTurnScopeSystem({...f.input,memberMode:'assistant',assistant:{...f.assistant,teamScopeMode:'legacy',compartments:[f.delivery.compartmentKey!]}})
    expect(publicAssistant.access).toMatchObject({compartments:[f.delivery.compartmentKey],mutationCompartments:[f.delivery.compartmentKey]})
  })
  it('keeps the Brain explorer within assigned Teams and read grants instead of treating its legacy NULL column as universe',async()=>{
    const f=await fixture(),memory=await createMemory({workspaceId:f.workspaceId,assistantId:f.assistantId,userId:null,createdByUserId:f.owner,summary:'Finance explorer source',sensitivity:'internal',compartments:[f.finance.compartmentKey!]})
    const before=(await resolveWorkspaceViewpoint(f.member,f.workspaceId))!
    expect(before).toMatchObject({compartments:[],mutationCompartments:[]})
    expect(await getMemoryById(before,memory.id)).toBeNull()
    const grant=await f.grant(),after=(await resolveWorkspaceViewpoint(f.member,f.workspaceId))!
    expect(after).toMatchObject({compartments:[f.finance.compartmentKey],mutationCompartments:[]})
    expect(await getMemoryById(after,memory.id)).toMatchObject({id:memory.id})
    expect(await updateMemory(memory.id,{summary:'Forbidden explorer edit'},after)).toBeNull()
    await pool.query('UPDATE workspace_access_grants SET revoked_at=now(),revoked_by=$2 WHERE id=$1',[grant.id,f.owner])
    expect(await getMemoryById((await resolveWorkspaceViewpoint(f.member,f.workspaceId))!,memory.id)).toBeNull()
  })
  it('exposes the granted Team in the context picker without disclosing its foreign read bundle',async()=>{
    const f=await fixture(),store=createDbContextScopeStore()
    expect(await store.listTeams(f.member,f.workspaceId)).toEqual([])
    const grant=await f.grant()
    const teams=await store.listTeams(f.member,f.workspaceId)
    expect(teams).toHaveLength(1)
    expect(teams[0]).toMatchObject({id:f.finance.id,readBundle:[f.finance.compartmentKey]})
    expect(JSON.stringify(teams)).not.toContain(f.research.compartmentKey)
    await pool.query('UPDATE workspace_access_grants SET revoked_at=now(),revoked_by=$2 WHERE id=$1',[grant.id,f.owner])
    expect(await store.listTeams(f.member,f.workspaceId)).toEqual([])
  })
  it('allows canonical entity reads under a read grant but does not convert them into update authority',async()=>{
    const f=await fixture();await f.grant()
    const entity=await createEntity({workspaceId:f.workspaceId,createdByUserId:f.owner,kind:'person',displayName:'Finance reference',source:'user',sensitivity:'internal',compartments:[f.finance.compartmentKey!]})
    const scope=await resolveTurnScopeSystem(f.input)
    await runWithAgentAccess(pinAccessCeiling(scope.access),async()=>{
      expect(await updateEntity(f.member,entity.id,{},scope.access)).toMatchObject({id:entity.id})
      expect(await updateEntity(f.member,entity.id,{displayName:'Unauthorized replacement'},scope.access)).toBeNull()
    })
    expect((await pool.query('SELECT display_name FROM entities WHERE id=$1',[entity.id])).rows[0].display_name).toBe('Finance reference')
  })
  it('invalidates the executing lease on a grant revocation and never revives it after reapproval',async()=>{
    const f=await fixture(),grant=await f.grant(),scope=await resolveTurnScopeSystem(f.input)
    const lease=createAuthorityLease(pinAccessCeiling(scope.access),()=>resolveLiveAccessCeilingSystem(f.input))
    const execute=<T>(fn:()=>Promise<T>)=>runWithAgentAccess(pinAccessCeiling(scope.access),()=>runWithAuthorityLease(lease,()=>executeWithCurrentAuthority(fn)))
    await expect(execute(async()=>{
      await pool.query('UPDATE workspace_access_grants SET revoked_at=now(),revoked_by=$2 WHERE id=$1',[grant.id,f.owner])
      return 'Withheld response'
    })).rejects.toMatchObject({reason:'authority_changed',operationMayHaveExecuted:true})
    await f.grant()
    await expect(execute(async()=> 'Must not resume')).rejects.toMatchObject({reason:'authority_changed'})
    expect((await resolveTurnScopeSystem(f.input)).access.mutationCompartments).toEqual([])
  })
  it('expires runtime grant authority by server time without a cleanup job',async()=>{
    const f=await fixture();await f.grant({expiresIn:'1 second'})
    const scope=await resolveTurnScopeSystem(f.input)
    expect(scope.access.compartments).toEqual([f.finance.compartmentKey])
    const lease=createAuthorityLease(pinAccessCeiling(scope.access),()=>resolveLiveAccessCeilingSystem(f.input))
    await pool.query('SELECT pg_sleep(1.05)')
    await expect(lease.assertCurrent()).rejects.toMatchObject({reason:'authority_changed'})
    expect((await resolveTurnScopeSystem(f.input)).access.compartments).toEqual([])
  })
  it('retains ordinary mutation rights when a read grant adds another department',async()=>{
    const f=await fixture();await f.groups.addMember(f.owner,f.delivery.id,f.member)
    const before=await resolveTurnScopeSystem(f.input);await f.grant()
    const after=await resolveTurnScopeSystem(f.input)
    expect(after.access.compartments?.sort()).toEqual([f.finance.compartmentKey,f.delivery.compartmentKey].sort())
    expect(after.access.mutationCompartments).toEqual(before.access.mutationCompartments)
    expect(pinAccessCeiling(before.access).compartments).toEqual([f.delivery.compartmentKey])
    expect((await resolveTurnScopeSystem({...f.input,userId:f.owner})).access).toMatchObject({compartments:null,mutationCompartments:null})
  })
  it('bounds directory cache lifetime by a visible grant expiry without exposing another member grant',async()=>{
    const f=await fixture();await f.grant({expiresIn:'5 seconds'});
    const client=await pool.connect();
    try {
      const ttl=await projectionLifetime(client,f.workspaceId,f.member);
      expect(ttl).toBeGreaterThan(0);expect(ttl).toBeLessThanOrEqual(5_000);
      const other=await projectionLifetime(client,f.workspaceId,f.other);
      expect(other).toBeGreaterThan(29_000);expect(other).toBeLessThanOrEqual(30_000);
    } finally{client.release();}
  });
  it('rejects self approval and immutable payload changes in the database',async()=>{
    const f=await fixture();await expect(f.grant({approver:f.member})).rejects.toThrow('independent_approver_required')
    const grant=await f.grant()
    await expect(pool.query(`UPDATE workspace_access_requests SET beneficiary_id=$2 WHERE id=$1`,[grant.requestId,f.other])).rejects.toThrow('access_payload_immutable')
    await expect(pool.query(`UPDATE workspace_access_requests SET decided_by=$2 WHERE id=$1`,[grant.requestId,f.other])).rejects.toThrow('access_decision_immutable')
    await expect(pool.query(`UPDATE workspace_access_grants SET target_team_id=$2 WHERE id=$1`,[grant.id,f.research.id])).rejects.toThrow('access_payload_immutable')
  })
})
